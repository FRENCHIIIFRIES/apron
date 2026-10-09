// Quick launcher (Ctrl+Alt+Space): apps from the Start menu, files on your Desktop,
// websites, plus prefixes for asking Claude, notes and to-dos.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { feedLink } = require('./calendar');

const PREFIXES = [
  { re: /^(shot|screenshot)\s+/i, kind: 'askshot', hint: 'Ask AI about the screenshot' },
  { re: /^(\?\?|ask screen\s+)/i, kind: 'askscreen', hint: 'Ask AI about my screen' },
  { re: /^(\?|ask\s+)/i, kind: 'ask', hint: 'Ask AI' },
  { re: /^(tr|translate)\s+/i, kind: 'translate', hint: 'Translate' },
  { re: /^(cards|flashcards)$/i, kind: 'cards', hint: 'Study flashcards', bare: true },
  { re: /^(n|note)\s+/i, kind: 'note', hint: 'Save note' },
  { re: /^(t|todo)\s+/i, kind: 'todo', hint: 'Add to-do' },
  { re: /^(g|google)\s+/i, kind: 'search', hint: 'Search Google' },
];

function walk(dir, exts, out, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out, depth + 1);
    else if (exts.test(e.name)) out.push(full);
  }
}

// Microsoft Store apps (Claude, WhatsApp, Arc...) have no .lnk files; main fills this from
// Get-StartApps and they open through shell:AppsFolder.
let storeApps = [];
function setStoreApps(list) {
  storeApps = Array.isArray(list) ? list : [];
}

/** Start menu shortcuts + Store apps + Desktop items, de-duplicated by name. */
function buildIndex() {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const apps = [];
  for (const r of roots) walk(r, /\.(lnk|url)$/i, apps);
  const items = new Map();
  for (const file of apps) {
    const name = path.basename(file).replace(/\.(lnk|url)$/i, '');
    if (/uninstall|readme|help|documentation|website|release notes/i.test(name)) continue;
    if (!items.has(name.toLowerCase())) items.set(name.toLowerCase(), { name, path: file, type: 'app' });
  }
  for (const a of storeApps) {
    if (!a || !a.Name || !/^[\w.\-]+![\w.\-]+$/.test(a.AppID || '')) continue;
    const key = a.Name.toLowerCase();
    if (/uninstall|readme|help/i.test(a.Name) || items.has(key)) continue;
    items.set(key, { name: a.Name, path: `shell:AppsFolder\\${a.AppID}`, type: 'app', store: true });
  }
  for (const desk of [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'OneDrive', 'Desktop')]) {
    let entries = [];
    try {
      entries = fs.readdirSync(desk, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || /^desktop\.ini$/i.test(e.name)) continue;
      const name = e.name.replace(/\.(lnk|url)$/i, '');
      const key = name.toLowerCase();
      if (!items.has(key)) items.set(key, { name, path: path.join(desk, e.name), type: e.isDirectory() ? 'folder' : /\.(lnk|url)$/i.test(e.name) ? 'app' : 'file' });
    }
  }
  return [...items.values()];
}

function score(name, q) {
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80 - n.length / 100;
  const words = n.split(/[\s\-_.]+/);
  if (words.some((w) => w.startsWith(q))) return 60 - n.length / 100;
  const initials = words.map((w) => w[0]).join('');
  if (initials.startsWith(q)) return 50;
  if (n.includes(q)) return 40 - n.indexOf(q) / 10;
  return 0;
}

const looksLikeUrl = (s) => /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s);

/** Up to 6 results for what's typed so far. */
function search(index, input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  // A pasted calendar link (ManageBac, Google iCal, .ics): add it to Apron or to Google Calendar.
  const feed = feedLink(raw);
  if (feed) {
    return [
      { kind: 'addfeed', title: feed.kind === 'homework' ? `Add ${feed.source} to Apron` : `Add ${feed.source} to Apron's calendar`, hint: feed.kind === 'homework' ? 'Due dates' : 'Calendar', url: raw },
      { kind: 'gsub', title: 'Add to Google Calendar', hint: 'Subscribe', url: raw },
    ];
  }
  for (const p of PREFIXES) {
    if (p.re.test(raw)) {
      if (p.bare) return [{ kind: p.kind, title: p.hint, hint: '' }];
      const rest = raw.replace(p.re, '').trim();
      return rest ? [{ kind: p.kind, title: rest, hint: p.hint }] : [{ kind: 'hint', title: `${p.hint}…`, hint: 'keep typing' }];
    }
  }
  const results = [];
  if (looksLikeUrl(raw)) results.push({ kind: 'url', title: raw, hint: 'Open website', url: /^https?:/i.test(raw) ? raw : `https://${raw}` });
  const q = raw.toLowerCase();
  const apps = index
    .map((it) => ({ it, s: score(it.name, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(({ it }) => ({ kind: 'open', title: it.name, hint: it.type === 'app' ? 'App' : it.type === 'folder' ? 'Folder' : 'File', path: it.path }));
  results.push(...apps);
  if (raw.includes('?') || raw.split(/\s+/).length >= 4) results.push({ kind: 'ask', title: raw, hint: 'Ask AI' });
  results.push({ kind: 'search', title: raw, hint: 'Search Google' });
  return results.slice(0, 6);
}

module.exports = { buildIndex, search, score, looksLikeUrl, setStoreApps };
