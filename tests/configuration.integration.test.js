const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {defaults,schema,project}=require('../configuration/schema');
const {createConfigStore,registerConfigurationRoutes}=require('../Backend/configuration');
test('PostgreSQL configuration revisions, conflicts, history, admin checks and scoped downloads', {skip:!process.env.PILOTMC_INTEGRATION_ENV},async()=>{
  require('dotenv').config({path:process.env.PILOTMC_INTEGRATION_ENV,quiet:true});
  const {Pool}=require('pg');const express=require('express');
  const connection={connectionString:process.env.DATABASE_URL,host:process.env.PGHOST,port:process.env.PGPORT?Number(process.env.PGPORT):undefined,user:process.env.PGUSER,password:process.env.PGPASSWORD,database:process.env.PGDATABASE,ssl:process.env.PGSSL==='true'?{rejectUnauthorized:false}:undefined};
  const adminPool=new Pool(connection);const name='pilotmc_config_test_'+crypto.randomBytes(6).toString('hex');
  await adminPool.query(`CREATE SCHEMA ${name}`);
  const pool=new Pool({...connection,options:`-c search_path=${name}`});let server;let website;
  try{
    const migration=fs.readFileSync(path.join(__dirname,'../Backend/database/migrations/001-central-configuration.sql'),'utf8').split('\n').filter(line=>!line.startsWith('\\')&&!line.startsWith('GRANT ')).join('\n').replace(/public\./g,`${name}.`);
    await pool.query(migration);
    await pool.query('CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,event_type TEXT,target_type TEXT,target_id TEXT,details JSONB)');
    const store=createConfigStore({pool,query:(...args)=>pool.query(...args)});const config=defaults();const minecraft=defaults(schema.properties.servers.items);minecraft.key='test';minecraft.name='Test';config.servers=[minecraft];config.discord.roles.admin='123456789012345678';
    await store.initialize(config);assert.equal((await store.read()).revision,1);
    const changed=structuredClone(config);changed.website.siteName='Updated';
    const results=await Promise.allSettled([store.save(changed,1,'admin'),store.save(changed,1,'other')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.statusCode,409);
    assert.equal((await store.history()).length,2);assert.equal((await store.revision(1)).website.siteName,'PilotMC');
    assert.equal((await pool.query('SELECT COUNT(*) FROM audit_events')).rows[0].count,'1');
    const invalid=structuredClone(config);invalid.website.secret='bad';await assert.rejects(store.save(invalid,2,'admin'),/unknown setting/);assert.equal((await store.read()).revision,2);
    const tokens={discord:'discord-only-token',website:'website-only-token','instance:test':'instance-only-token'};process.env.CONFIG_SERVICE_TOKENS=JSON.stringify(tokens);
    const app=express();app.use(express.json());const auth=(req,res,next)=>req.get('authorization')==='Bearer test-api-token'?next():res.sendStatus(401);
    const route=handler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);
    registerConfigurationRoutes({app,store,requireApiToken:auth,asyncRoute:route,requestDiscordAdminCheck:async actor=>({allowed:actor==='admin'})});
    app.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url+'/api/admin/configuration',{headers:{Authorization:'Bearer test-api-token','X-Actor-Id':'nonadmin','X-Config-Service-Token':'website-only-token'}})).status,403);
    assert.equal((await fetch(url+'/api/configuration/discord',{headers:{Authorization:'Bearer website-only-token'}})).status,401);
    const websiteSnapshot=await(await fetch(url+'/api/configuration/website?activeRevision=1',{headers:{Authorization:'Bearer website-only-token'}})).json();assert.deepEqual(websiteSnapshot.config,project(changed,'website'));assert.equal(websiteSnapshot.config.servers,undefined);
    assert.equal((await fetch(url+'/api/configuration/instance?serverKey=other',{headers:{Authorization:'Bearer instance-only-token'}})).status,401);
    const statuses=await store.statuses();assert.equal(statuses[0].activeRevision,1);assert.equal(statuses[0].fetchedRevision,2);
    assert.equal((await fetch(url+'/api/admin/configuration',{headers:{Authorization:'Bearer test-api-token','X-Actor-Id':'admin'}})).status,403);
    const admin=await(await fetch(url+'/api/admin/configuration',{headers:{Authorization:'Bearer test-api-token','X-Actor-Id':'admin','X-Config-Service-Token':'website-only-token'}})).json();assert.equal(admin.revision,2);assert.ok(admin.schema);assert.equal(admin.config.CONFIG_SERVICE_TOKENS,undefined);
    const {registerAdminRoutes}=require('../Website/adminRoutes');const {renderTemplate}=require('../Website/template');
    process.env.SESSION_SECRET='configuration-integration-session-secret';process.env.BACKEND_CONFIG_TOKEN=tokens.website;
    const web=express();web.use(express.json());
    async function upstream(route,options={}){
      const response=await fetch(url+route,{method:options.method||'GET',headers:{Authorization:'Bearer test-api-token','X-Actor-Id':options.actor?.id||'','Content-Type':'application/json',...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined});
      const data=await response.json();if(!response.ok){const err=new Error(data.error);err.statusCode=response.status;throw err;}return data;
    }
    registerAdminRoutes({app:web,privateDir:path.join(__dirname,'../Website/private'),requireSession:(req,res,next)=>{const id=req.get('x-test-session');if(!id)return res.sendStatus(401);req.user={id,username:id};next();},checkAdminAccess:async id=>({allowed:id==='admin'}),fetchBackendJson:upstream,sendBackendJson:upstream,renderTemplate,Log:{warn(){}},config:{siteTemplateValues:()=>({})}});
    website=web.listen(0,'127.0.0.1');await new Promise(resolve=>website.once('listening',resolve));const webUrl=`http://127.0.0.1:${website.address().port}`;
    assert.equal((await fetch(webUrl+'/admin/api/configuration')).status,401);
    assert.equal((await fetch(webUrl+'/admin/api/configuration',{headers:{'X-Test-Session':'member'}})).status,403);
    const editor=await(await fetch(webUrl+'/admin/api/configuration',{headers:{'X-Test-Session':'admin'}})).json();assert.ok(editor.csrfToken);
    const oldVersion=await fetch(webUrl+'/admin/api/configuration/history/1',{headers:{'X-Test-Session':'admin'}});assert.equal(oldVersion.status,200);assert.equal((await oldVersion.json()).config.website.siteName,'PilotMC');
    const body=JSON.stringify({config:changed,expectedRevision:2});
    assert.equal((await fetch(webUrl+'/admin/api/configuration',{method:'PUT',headers:{'X-Test-Session':'admin','Content-Type':'application/json'},body})).status,403);
    const save=await fetch(webUrl+'/admin/api/configuration',{method:'PUT',headers:{'X-Test-Session':'admin','Content-Type':'application/json','X-Config-CSRF':editor.csrfToken},body});assert.equal(save.status,200);assert.equal((await save.json()).revision,3);
    const conflict=await fetch(webUrl+'/admin/api/configuration',{method:'PUT',headers:{'X-Test-Session':'admin','Content-Type':'application/json','X-Config-CSRF':editor.csrfToken},body});assert.equal(conflict.status,409);
    const {updateEnv}=require('../scripts/migrateConfiguration');const tempFile=path.join(require('os').tmpdir(),'pilotmc-env-test-'+crypto.randomBytes(5).toString('hex'));
    try{const parse=require('dotenv').parse;updateEnv(tempFile,{CONFIG_SERVICE_TOKENS:JSON.stringify(tokens),BACKUP_DIRECTORY:'C:\\Server Files\\backups'},parse);const parsed=parse(fs.readFileSync(tempFile));assert.deepEqual(JSON.parse(parsed.CONFIG_SERVICE_TOKENS),tokens);assert.equal(parsed.BACKUP_DIRECTORY,'C:\\Server Files\\backups');}finally{if(fs.existsSync(tempFile))fs.unlinkSync(tempFile);}

  }finally{if(website)await new Promise(resolve=>website.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));await pool.end();if(!/^pilotmc_config_test_[a-f0-9]+$/.test(name))throw new Error('Unsafe cleanup schema');await adminPool.query(`DROP SCHEMA ${name} CASCADE`);await adminPool.end();}
});
