// Writes assets/icon.ico from the same pill the tray uses (an .ico may hold a PNG directly).
const fs = require('fs');
const path = require('path');
const { pillPng } = require('../src/icon');

const png = pillPng(256);
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image
header.writeUInt8(0, 6); // width 256
header.writeUInt8(0, 7); // height 256
header.writeUInt16LE(1, 10); // planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);

const out = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, png]));
console.log('wrote', out);
