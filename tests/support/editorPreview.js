// Local-only fixture for exercising the real editor, authorization proxy, and PostgreSQL store.
const express=require('express');const {Pool}=require('pg');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const root=path.resolve(__dirname,'../..');const {defaults,schema}=require('../../configuration/schema');const {createConfigStore,registerConfigurationRoutes}=require('../../Backend/configuration');
const {registerAdminRoutes}=require('../../Website/adminRoutes');const {renderTemplate}=require('../../Website/template');
async function start(){
  if(!process.env.PILOTMC_INTEGRATION_ENV)throw new Error('PILOTMC_INTEGRATION_ENV must point to a dedicated local test database');
  require('dotenv').config({path:process.env.PILOTMC_INTEGRATION_ENV,quiet:true});
  const pool=new Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,database:process.env.PGDATABASE});
  const name='pilotmc_config_preview_'+crypto.randomBytes(5).toString('hex');await pool.query(`CREATE SCHEMA ${name}`);
  const connection=new Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,database:process.env.PGDATABASE,options:`-c search_path=${name}`});
  const migration=fs.readFileSync(path.join(root,'Backend/database/migrations/001-central-configuration.sql'),'utf8').split('\n').filter(line=>!line.startsWith('\\')&&!line.startsWith('GRANT ')).join('\n').replace(/public\./g,`${name}.`);await connection.query(migration);
  await connection.query('CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,event_type TEXT,target_type TEXT,target_id TEXT,details JSONB)');
  const store=createConfigStore({pool:connection,query:(...args)=>connection.query(...args)});const config=defaults();config.discord.roles.admin='123456789012345678';
  const minecraft=defaults(schema.properties.servers.items);minecraft.key='survival';minecraft.name='Survival';config.servers=[minecraft];await store.initialize(config);
  process.env.CONFIG_SERVICE_TOKENS=JSON.stringify({website:'preview-config-token'});process.env.BACKEND_CONFIG_TOKEN='preview-config-token';
  const api=express();api.use(express.json());registerConfigurationRoutes({app:api,store,requireApiToken:(req,res,next)=>req.get('authorization')==='Bearer preview-api'?next():res.sendStatus(401),asyncRoute:handler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next),requestDiscordAdminCheck:async id=>({allowed:id==='preview-admin'})});api.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));const backend=api.listen(3340,'127.0.0.1');
  const app=express();app.use(express.json());process.env.SESSION_SECRET='local-preview-only-session-secret';
  async function backendJson(route,options={}){const response=await fetch('http://127.0.0.1:3340'+route,{method:options.method||'GET',headers:{Authorization:'Bearer preview-api','X-Actor-Id':options.actor?.id||'','X-Config-Service-Token':'preview-config-token','Content-Type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});const body=await response.json();if(!response.ok){const err=new Error(body.error);err.statusCode=response.status;throw err;}return body;}
  registerAdminRoutes({app,privateDir:path.join(root,'Website/private'),requireSession:(req,res,next)=>{req.user={id:'preview-admin',username:'Preview Admin'};next();},checkAdminAccess:async()=>({allowed:true}),fetchBackendJson:backendJson,sendBackendJson:backendJson,renderTemplate,Log:console,config:{siteTemplateValues:()=>({siteName:'PilotMC',siteShortName:'PilotMC'})}});
  const website=app.listen(3309,'127.0.0.1',()=>console.log('Editor preview ready: http://127.0.0.1:3309/admin/configuration'));
  const shutdown=async()=>{website.close();backend.close();await connection.end();if(!/^pilotmc_config_preview_[a-f0-9]+$/.test(name))throw new Error('Invalid preview schema');await pool.query(`DROP SCHEMA ${name} CASCADE`);await pool.end();process.exit(0);};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
start().catch(err=>{console.error(err.message);process.exitCode=1;});
