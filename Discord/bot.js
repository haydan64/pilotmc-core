const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const configuration = require('../configuration/client');
async function start() {
  await configuration.initialize({ service: 'discord', directory: __dirname, log: require('./log') });
  const settings = configuration.getActiveConfig();
  if (settings) { process.env.DISCORD_GUILD_ID = settings.guildId; process.env.DISCORD_CLIENT_ID = settings.clientId; }
  return require('./botRuntime').start();
}
if (require.main === module) start().catch(err => { require('./log').error('Startup', err.message); process.exitCode = 1; });
module.exports = { start, get client() { return require('./botRuntime').client; } };
