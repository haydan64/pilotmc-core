const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'log');

const originalConsole = {
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
};

let currentLogDate = null;
let currentLogStream = null;
let fileLoggingErrorReported = false;

function serialize(value) {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getLogStream(timestamp) {
  const logDate = timestamp.slice(0, 10);
  if (currentLogStream && currentLogDate === logDate) return currentLogStream;

  if (currentLogStream) {
    currentLogStream.end();
    currentLogStream = null;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  currentLogDate = logDate;
  currentLogStream = fs.createWriteStream(path.join(LOG_DIR, `app-${logDate}.log`), {
    flags: 'a',
    encoding: 'utf8'
  });
  currentLogStream.on('error', (err) => {
    if (fileLoggingErrorReported) return;
    fileLoggingErrorReported = true;
    originalConsole.error(`[${new Date().toISOString()}] [ERROR] [Log] Failed to write log file: ${err.message}`);
  });
  return currentLogStream;
}

function writeToFile(line, timestamp) {
  try {
    getLogStream(timestamp).write(`${line}\n`);
  } catch (err) {
    if (fileLoggingErrorReported) return;
    fileLoggingErrorReported = true;
    originalConsole.error(`[${new Date().toISOString()}] [ERROR] [Log] Failed to write log file: ${err.message}`);
  }
}

function write(level, origin, data) {
  const safeOrigin = origin || 'System';
  const timestamp = new Date().toISOString();
  const message = data.map(serialize).join(' ');
  const line = `[${timestamp}] [${level.toUpperCase()}] [${safeOrigin}] ${message}`;
  const writer = originalConsole[level] || originalConsole.log;
  writer(line);
  writeToFile(line, timestamp);
}

module.exports = {
  debug(origin, ...data) {
    write('debug', origin, data);
  },
  error(origin, ...data) {
    write('error', origin, data);
  },
  info(origin, ...data) {
    write('info', origin, data);
  },
  warn(origin, ...data) {
    write('warn', origin, data);
  }
};
