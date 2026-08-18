const fs = require('fs');
const path = require('path');
const Log = require('./log');

function getCommandFiles(dir) {
  const resolvedDir = path.resolve(dir);
  if (!fs.existsSync(resolvedDir)) return [];
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolvedPath = path.join(resolvedDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getCommandFiles(resolvedPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(resolvedPath);
    }
  }
  return files;
}

function loadCommands(commandsPaths = path.join(__dirname, 'commands')) {
  const pathsToLoad = Array.isArray(commandsPaths) ? commandsPaths : [commandsPaths];
  const commandFiles = pathsToLoad.flatMap((commandsPath) => getCommandFiles(commandsPath));
  const commands = new Map();

  for (const file of commandFiles) {
    const command = require(file);
    if (!command?.data || !command?.execute) continue;
    const name = command.data.name;
    if (commands.has(name)) {
      Log.warn('Command Loader', `Duplicate command name detected: ${name}. Using definition from ${file}.`);
    }
    commands.set(name, command);
  }

  return commands;
}

module.exports = { loadCommands };
