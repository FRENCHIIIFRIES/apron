// Writes assets/icon.ico (16-256 px) from the same drawing the app uses at runtime.
const fs = require('fs');
const path = require('path');
const { icoFile } = require('../src/icon');

const out = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, icoFile());
console.log('wrote', out);
