const fs = require('fs');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplate(filePath, values = {}) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g, (match, key) => String(values[key] ?? ''));
  html = html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => escapeHtml(values[key] ?? ''));
  return html;
}

module.exports = {
  escapeHtml,
  renderTemplate
};
