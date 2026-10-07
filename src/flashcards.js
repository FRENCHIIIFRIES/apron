// Flashcards from your Obsidian notes, quizzed during Pomodoro breaks.
// A card is any line written as `question :: answer` (the same syntax as the
// Obsidian Spaced Repetition plugin's single-line cards).
const fs = require('fs');
const path = require('path');

const MAX_FILES = 3000;
const MAX_CARDS = 1000;

/** `question :: answer` lines in a Markdown document. */
function parseCards(markdown, source = '') {
  const cards = [];
  let inCode = false;
  for (const raw of String(markdown).split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) inCode = !inCode;
    if (inCode) continue;
    const line = raw.replace(/^\s*[-*+]\s+/, '').trim();
    const m = line.match(/^(.+?)\s:{2,3}\s(.+)$/);
    if (m && m[1].length <= 300 && m[2].length <= 500) cards.push({ q: m[1].trim(), a: m[2].trim(), source });
  }
  return cards;
}

function scan(folder) {
  const cards = [];
  let files = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || files > MAX_FILES || cards.length > MAX_CARDS) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .obsidian, .trash, .git
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(e.name)) {
        files++;
        try {
          cards.push(...parseCards(fs.readFileSync(full, 'utf8'), e.name.replace(/\.md$/i, '')));
        } catch {
          // unreadable note: skip
        }
      }
    }
  };
  if (folder) walk(folder, 0);
  return { cards: cards.slice(0, MAX_CARDS), files };
}

module.exports = { scan, parseCards };
