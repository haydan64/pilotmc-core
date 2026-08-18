const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'botConfig.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'botConfig.example.json');

function loadBotConfig() {
  try {
    const selectedPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
    return JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
  } catch {
    return {};
  }
}

function listMinecraftServers() {
  const botConfig = loadBotConfig();
  return Array.isArray(botConfig.minecraftServers) ? botConfig.minecraftServers : [];
}

function getMinecraftServer(serverKey) {
  return listMinecraftServers().find((server) => server.key === serverKey) || null;
}

function getAutoAllowlistServers() {
  return listMinecraftServers().filter((server) => server.autoAllowlistOnSetMinecraftUsername);
}

function addMinecraftServerOption(builder) {
  return builder.addStringOption((opt) => {
    opt.setName('server').setDescription('Minecraft server').setRequired(true);
    for (const server of listMinecraftServers()) {
      opt.addChoices({ name: server.name, value: server.key });
    }
    return opt;
  });
}

module.exports = {
  loadBotConfig,
  listMinecraftServers,
  getMinecraftServer,
  getAutoAllowlistServers,
  addMinecraftServerOption
};
