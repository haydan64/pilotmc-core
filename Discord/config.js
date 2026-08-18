const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'botConfig.json');
const examplePath = path.join(__dirname, 'botConfig.example.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadBotConfig() {
  if (fs.existsSync(configPath)) return readJson(configPath);
  if (fs.existsSync(examplePath)) return readJson(examplePath);
  return {};
}

module.exports = loadBotConfig();
