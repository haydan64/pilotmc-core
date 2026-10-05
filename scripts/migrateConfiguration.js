// Migrate a deployment without copying credentials into the configuration document.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const { schema, defaults, assertConfig } = require('../configuration/schema');
function merge(value, node) {
  if (node.type === 'object' && node.properties) return Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, merge(value?.[key], child)]));
  if (node.type === 'array') return Array.isArray(value) ? value.map(item => merge(item, node.items)) : [];
  return value === undefined ? defaults(node) : value;
}
function updateEnv(file, values, parse) {
  const source = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : '';
  const current = parse(source);
  let output = source;
  for (const [key, value] of Object.entries(values)) {
    const raw = String(value);
    const quote = raw.includes("'") ? '"' : "'";
    if (raw.includes(quote) || /[\r\n]/.test(raw)) throw new Error(`Unsupported newline or quote in local ${key} value`);
    const line = `${key}=${quote}${raw}${quote}`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    output = expression.test(output) ? output.replace(expression, () => line) : `${output.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(file, output, { mode: 0o600 });
  return current;
}
function migrate(deployment) {
  const root = path.resolve(deployment); const core = path.join(root,'pilotmc-core');
  const localRequire = createRequire(path.join(core,'Backend','package.json')); const { parse } = localRequire('dotenv');
  const readEnv = file => fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
  const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
  const discordFile=path.join(core,'Discord','.env'); const websiteFile=path.join(core,'Website','.env'); const backendFile=path.join(core,'Backend','database','.env');
  const discordEnv=readEnv(discordFile), websiteEnv=readEnv(websiteFile), backendEnv=readEnv(backendFile);
  const discord=readJson(path.join(core,'Discord','botConfig.json'));
  const listingFile=path.join(core,'Discord','serverListings.json'); const listings=fs.existsSync(listingFile)?readJson(listingFile):[];
  const config=defaults(); config.discord=merge({...discord,guildId:discordEnv.DISCORD_GUILD_ID||'',clientId:discordEnv.DISCORD_CLIENT_ID||''},schema.properties.discord);
  if(discordEnv.DISCORD_BDS_LOG_CHANNEL_ID)config.discord.channels.bdsLog=discordEnv.DISCORD_BDS_LOG_CHANNEL_ID;
  config.website=merge({siteName:websiteEnv.SITE_NAME||'PilotMC',siteShortName:websiteEnv.SITE_SHORT_NAME||websiteEnv.SITE_NAME||'PilotMC',siteDescription:websiteEnv.SITE_DESCRIPTION||'',publicUrl:websiteEnv.PUBLIC_URL||websiteEnv.WEBSITE_PUBLIC_URL||'',discordRedirectUri:websiteEnv.DISCORD_REDIRECT_URI||'',discordClientId:websiteEnv.DISCORD_CLIENT_ID||'',discordGuildId:websiteEnv.DISCORD_GUILD_ID||'',logoUrl:websiteEnv.SITE_LOGO_PATH?'/assets/brand-logo.png':'',faviconUrl:websiteEnv.SITE_FAVICON_PATH?'/favicon.ico':''},schema.properties.website);
  if(config.website.discordClientId===config.discord.clientId)config.website.discordClientId='';
  if(config.website.discordGuildId===config.discord.guildId)config.website.discordGuildId='';
  config.backend=merge({agentTimeoutMs:Number(backendEnv.AGENT_TIMEOUT_MS||10000),discordAuthTimeoutMs:Number(backendEnv.DISCORD_AUTH_TIMEOUT_MS||5000)},schema.properties.backend);
  const tokenMap=JSON.parse(backendEnv.CONFIG_SERVICE_TOKENS||'{}');
  const getToken=id=>tokenMap[id]||(tokenMap[id]=crypto.randomBytes(32).toString('hex'));
  const instanceDeployments=[];
  const minecraft=path.join(root,'Minecraft');
  if(fs.existsSync(minecraft))for(const item of fs.readdirSync(minecraft,{withFileTypes:true})){
    if(!item.isDirectory())continue;const directory=path.join(minecraft,item.name);const env=readEnv(path.join(directory,'.env'));
    if(env.SERVER_KEY)instanceDeployments.push({directory,env,mc:readJson(path.join(directory,'mc','mcConfig.json'))});
  }
  config.servers=(discord.minecraftServers||[]).map(server=>{
    const instance=instanceDeployments.find(item=>item.env.SERVER_KEY===server.key);const listing=listings.find(item=>item.key===server.key);
    return merge({...server,allowlist:server.allowlist||{autoAllowlist:Boolean(server.autoAllowlistOnSetMinecraftUsername),requiredRoleIds:discord.roles?.member?[discord.roles.member]:[],blockedRoleIds:[],requireDiscordMembership:true,removeOnDiscordLeave:true},listing:{...listing,enabled:Boolean(listing)},instance:instance?.mc},schema.properties.servers.items);
  });
  assertConfig(config);
  // Preserve originals before provisioning bootstrap credentials.
  const archive=path.join(root,'private-branding','configuration-migration-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(archive,{recursive:true});
  for(const[file,name]of [[discordFile,'discord.env'],[websiteFile,'website.env'],[backendFile,'backend.env'],[path.join(core,'Discord','botConfig.json'),'botConfig.json'],[listingFile,'serverListings.json']])if(fs.existsSync(file))fs.copyFileSync(file,path.join(archive,name));
  for(const instance of instanceDeployments){const folder=path.join(archive,instance.env.SERVER_KEY);fs.mkdirSync(folder);fs.copyFileSync(path.join(instance.directory,'.env'),path.join(folder,'instance.env'));const mcFile=path.join(instance.directory,'mc','mcConfig.json');if(fs.existsSync(mcFile))fs.copyFileSync(mcFile,path.join(folder,'mcConfig.json'));}
  const seedFile=path.join(core,'Backend','config.initial.json');fs.writeFileSync(seedFile,JSON.stringify(config,null,2),{mode:0o600});
  updateEnv(discordFile,{BACKEND_CONFIG_TOKEN:getToken('discord')},parse);updateEnv(websiteFile,{BACKEND_CONFIG_TOKEN:getToken('website')},parse);
  for(const instance of instanceDeployments){
    const values={BACKEND_CONFIG_TOKEN:getToken(`instance:${instance.env.SERVER_KEY}`)};
    if(instance.mc.backupDirectory)values.BACKUP_DIRECTORY=instance.mc.backupDirectory;
    if(instance.mc.sevenZipPath)values.SEVEN_ZIP_PATH=instance.mc.sevenZipPath;
    updateEnv(path.join(instance.directory,'.env'),values,parse);
  }
  updateEnv(backendFile,{CONFIG_SERVICE_TOKENS:JSON.stringify(tokenMap)},parse);
  return {seedFile,archive,serverCount:config.servers.length,services:Object.keys(tokenMap)};
}
if(require.main===module){if(!process.argv[2])throw new Error('Usage: node scripts/migrateConfiguration.js <deployment-root>');const result=migrate(process.argv[2]);console.log(JSON.stringify(result));}
module.exports={migrate,merge,updateEnv};
