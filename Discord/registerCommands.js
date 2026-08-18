const path = require('path');
const { REST, Routes } = require('discord.js');
const { loadCommands } = require('./loadCommands');
const { loadModules } = require('./moduleLoader');
const Log = require('./log');

async function registerCommands(commands) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !clientId || !guildId) {
    Log.warn('Register Commands', 'Missing Discord token, client ID, or guild ID. Commands will not be registered.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const payload = Array.from(commands.values()).map((cmd) => cmd.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const modules = await loadModules();
  const moduleCommandPaths = modules.flatMap((mod) => mod.commandPaths || []);
  const commands = loadCommands([
    path.join(__dirname, 'commands'),
    ...moduleCommandPaths
  ]);
  await registerCommands(commands);
}

main().catch((err) => {
  Log.error('Register Commands', 'Failed to register commands:', err);
  process.exitCode = 1;
});
