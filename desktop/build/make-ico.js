// Pack the rendered PNGs into a single multi-resolution Windows .ico
// (PNG-compressed entries, Vista+). No external dependencies.
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "_icons");
const sizes = [256, 128, 64, 48, 32, 16];
const imgs = sizes
  .map((s) => ({ size: s, file: path.join(dir, `icon-${s}.png`) }))
  .filter((i) => fs.existsSync(i.file))
  .map((i) => ({ size: i.size, data: fs.readFileSync(i.file) }));

if (!imgs.length) { console.error("no PNGs found in", dir); process.exit(1); }

const count = imgs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type = icon
header.writeUInt16LE(count, 4);  // image count

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
imgs.forEach((img, i) => {
  const e = i * 16;
  const dim = img.size >= 256 ? 0 : img.size;  // 0 means 256 in ICO
  entries.writeUInt8(dim, e + 0);   // width
  entries.writeUInt8(dim, e + 1);   // height
  entries.writeUInt8(0, e + 2);     // palette
  entries.writeUInt8(0, e + 3);     // reserved
  entries.writeUInt16LE(1, e + 4);  // color planes
  entries.writeUInt16LE(32, e + 6); // bits per pixel
  entries.writeUInt32LE(img.data.length, e + 8);  // size of PNG
  entries.writeUInt32LE(offset, e + 12);          // offset
  offset += img.data.length;
});

const ico = Buffer.concat([header, entries, ...imgs.map((i) => i.data)]);
fs.writeFileSync(path.join(__dirname, "icon.ico"), ico);
console.log(`icon.ico written: ${ico.length} bytes, sizes ${imgs.map((i) => i.size).join("/")}`);
