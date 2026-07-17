// Writes icon.png: 256x256 RGBA, blue circle + white paper plane.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 256, H = 256;
const BLUE = [42, 171, 238, 255], WHITE = [255, 255, 255, 255], NONE = [0, 0, 0, 0];

// Point-in-triangle via sign of cross products.
function inTri(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Paper-plane: big triangle + fold triangle (classic Telegram silhouette).
const BODY = [[70, 128], [196, 74], [150, 186]];
const FOLD = [[110, 146], [150, 186], [116, 172]];

const rows = [];
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(1 + W * 4); // filter byte 0 + RGBA
  for (let x = 0; x < W; x++) {
    const dx = x - 128, dy = y - 128;
    let px = NONE;
    if (dx * dx + dy * dy <= 120 * 120) {
      px = inTri(x, y, ...BODY) && !inTri(x, y, ...FOLD) ? WHITE : BLUE;
    }
    row.set(px, 1 + x * 4);
  }
  rows.push(row);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../icon.png', import.meta.url), png);
console.log(`icon.png ${png.length} bytes`);
