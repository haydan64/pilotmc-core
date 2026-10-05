const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
async function start() {
  const configuration = require('../configuration/client');
  await configuration.initialize({ service: 'website', directory: __dirname, log: require('./log') });
  const settings = configuration.getActiveConfig();
  if (settings) {
    const mapping = { siteName: 'SITE_NAME', siteShortName: 'SITE_SHORT_NAME', siteDescription: 'SITE_DESCRIPTION', publicUrl: 'PUBLIC_URL', discordRedirectUri: 'DISCORD_REDIRECT_URI', discordClientId: 'DISCORD_CLIENT_ID', discordGuildId: 'DISCORD_GUILD_ID' };
    for (const [key, variable] of Object.entries(mapping)) process.env[variable] = settings[key];
  }
  require('./mainRuntime');
}
start().catch(err => { require('./log').error('Startup', err.message); process.exitCode = 1; });
