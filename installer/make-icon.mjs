// Makes the installer's Windows icon from the site's own (the cartridge in the pages' favicon):
// an .ico holding PNGs at the sizes Windows asks for. Run by installer/package.ps1:
//   node installer/make-icon.mjs <out.ico>

import fs from 'node:fs';
import sharp from 'sharp';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="3" y="1" width="10" height="14" rx="1" fill="#f4d35e"/><rect x="5" y="3" width="6" height="5" fill="#16132b"/></svg>`;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const out = process.argv[2];
if (!out) throw new Error('Usage: node installer/make-icon.mjs <out.ico>');

const pngs = await Promise.all(SIZES.map((size) => sharp(Buffer.from(SVG), { density: (72 * size) / 16 }).resize(size, size).png().toBuffer()));
// ICONDIR, then an ICONDIRENTRY per image, then the images.
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const at = 6 + 16 * i;
  const size = SIZES[i];
  header.writeUInt8(size >= 256 ? 0 : size, at);
  header.writeUInt8(size >= 256 ? 0 : size, at + 1);
  header.writeUInt16LE(1, at + 4);   // colour planes
  header.writeUInt16LE(32, at + 6);  // bits per pixel
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
fs.writeFileSync(out, Buffer.concat([header, ...pngs]));
