const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schema,defaults,assertConfig,project } = require('../configuration/schema');
function configured() { const value=defaults(); const server=defaults(schema.properties.servers.items); server.key='survival';server.name='Survival';value.servers.push(server);return value; }
test('configuration validates role policies, server identity and prohibits unknown settings',()=>{
  const value=configured();assertConfig(value);
  value.servers[0].allowlist.blockedRoleIds=['bad'];assert.throws(()=>assertConfig(value),/invalid format/);
  value.servers[0].allowlist.blockedRoleIds=[];value.discord.token='secret';assert.throws(()=>assertConfig(value),/unknown setting/);delete value.discord.token;
  value.servers.push(structuredClone(value.servers[0]));assert.throws(()=>assertConfig(value),/unique/);
});
test('service projections exclude unrelated settings and unknown servers',()=>{
  const value=configured();value.discord.applicationIntro='PRIVATE APP INTRO';
  assert.equal(project(value,'website').applicationIntro,undefined);
  const instance=project(value,'instance','survival');assert.equal(instance.discord,undefined);assert.equal(instance.instance.backupFrequencyMinutes,60);
  assert.throws(()=>project(value,'instance','missing'),/not configured/);
  assert.equal(project(value,'discord').minecraftServers[0].key,'survival');
});
test('invalid configuration does not replace last-valid cache; offline startup works; auth revocation does not',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pilotmc-config-test-'));
  const file=path.resolve(__dirname,'../configuration/client');
  function fresh(){delete require.cache[file];return require(file);}
  const snapshot={revision:2,serviceId:'website',config:project(configured(),'website')};
  const env={BACKEND_CONFIG_TOKEN:'configuration-read-token',BACKEND_URL:'http://backend.test'};
  const response=value=>({ok:true,json:async()=>value});
  try{
    let downloaded=snapshot;let client=fresh();const handle=await client.initialize({service:'website',directory,env,poll:false,log:{warn(){}},fetchImpl:async()=>response(downloaded)});
    assert.equal(client.getActiveRevision(),2);
    const cached=fs.readFileSync(handle.cachePath,'utf8');
    downloaded={...snapshot,revision:3,config:{...snapshot.config,password:'secret'}};assert.equal(await handle.refresh(),null);assert.equal(fs.readFileSync(handle.cachePath,'utf8'),cached);
    downloaded={...snapshot,revision:3};await handle.refresh();assert.equal(client.getActiveRevision(),2);assert.equal(JSON.parse(fs.readFileSync(handle.cachePath)).snapshot.revision,3);
    client=fresh();await client.initialize({service:'website',directory,env,poll:false,log:{warn(){}},fetchImpl:async()=>{throw new Error('offline');}});assert.equal(client.getActiveRevision(),3);
    client=fresh();await assert.rejects(client.initialize({service:'website',directory,env,poll:false,fetchImpl:async()=>({ok:false,status:401})}),/HTTP 401/);
    client=fresh();await assert.rejects(client.initialize({service:'website',directory,env:{...env,BACKEND_URL:'http://other.test'},poll:false,fetchImpl:async()=>{throw new Error('offline');}}),/different backend/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('instance caches reject another server identity',()=>{
  const {validateSnapshot}=require('../configuration/client');
  assert.throws(()=>validateSnapshot({revision:1,serviceId:'instance:survival',config:project(configured(),'instance','survival')},'instance','instance:other'),/identity/);
});

test('listing embeds reject unknown nested fields and unsafe image URLs',()=>{
  const value=configured();value.servers[0].listing.message.embeds=[{footer:{text:'Footer',secret:'hidden'}}];assert.throws(()=>assertConfig(value),/invalid embed footer/);
  value.servers[0].listing.message.embeds=[{fields:[null]}];assert.throws(()=>assertConfig(value),/invalid embed field/);
  value.servers[0].listing.message.embeds=[{image:{url:'javascript:alert(1)'}}];assert.throws(()=>assertConfig(value),/invalid embed image url/);
});
