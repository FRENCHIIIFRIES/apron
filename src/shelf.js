// The shelf: drop files on the notch to keep them handy, drag them out again later (into
// Classroom, an email, another folder). Only paths are stored; files are never copied.
const fs = require('fs');
const path = require('path');

const MAX = 12;

function describe(p) {
  try {
    const st = fs.statSync(p);
    return { path: p, name: path.basename(p), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size };
  } catch {
    return null;
  }
}

/** file: where the list is kept; onChange(list of { path, name, dir, size }). */
function shelfStore(file, onChange) {
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(file, 'utf8')).map(describe).filter(Boolean);
  } catch {
    items = [];
  }
  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(items.map((i) => i.path)));
    } catch {
      // keep it in memory
    }
    onChange(items);
  };
  onChange(items);
  return {
    add(paths) {
      const fresh = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p)).map(describe).filter(Boolean);
      if (!fresh.length) return 0;
      const known = new Set(fresh.map((i) => i.path.toLowerCase()));
      items = [...fresh, ...items.filter((i) => !known.has(i.path.toLowerCase()))].slice(0, MAX);
      save();
      return fresh.length;
    },
    remove(p) {
      items = items.filter((i) => i.path !== p);
      save();
    },
    clear() {
      items = [];
      save();
    },
    /** Only paths on the shelf can be opened or dragged out. */
    has: (p) => items.some((i) => i.path === p),
    list: () => items,
  };
}

module.exports = { shelfStore };
