// Quick notes: appended to a Markdown file. Defaults to "Apron Inbox.md" in your open
// Obsidian vault (found via Obsidian's own config), else Documents\Apron Notes.md.
const fs = require('fs');
const os = require('os');
const path = require('path');

function obsidianVault() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'obsidian', 'obsidian.json'), 'utf8'));
    const vaults = Object.values(cfg.vaults || {}).filter((v) => v.path && fs.existsSync(v.path));
    vaults.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || (b.ts || 0) - (a.ts || 0));
    return vaults[0] ? vaults[0].path : null;
  } catch {
    return null;
  }
}

/** Where notes go, and a friendly description of it. */
function target(config) {
  if (config.notesFile) return { file: config.notesFile, label: config.notesFile };
  const vault = obsidianVault();
  if (vault) return { file: path.join(vault, 'Apron Inbox.md'), label: `Obsidian · ${path.basename(vault)} / Apron Inbox.md` };
  const file = path.join(os.homedir(), 'Documents', 'Apron Notes.md');
  return { file, label: file };
}

function append(config, text, now = new Date()) {
  const t = String(text || '').trim();
  if (!t) return null;
  const { file, label } = target(config);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  let add = '';
  if (!existing.includes(`## ${day}`)) add += `${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}## ${day}\n\n`;
  add += `- ${time} ${t.replace(/\r?\n/g, ' ')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, add);
  return label;
}

module.exports = { append, target, obsidianVault };
