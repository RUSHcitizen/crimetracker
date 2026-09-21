/**
 * Generates the PWA icons.
 *
 * Written by hand rather than pulled from a library: the icon is four circles and a dot,
 * and a raw PNG encoder for that is about sixty lines — considerably less than the
 * dependency it would otherwise take. Run with `node scripts/make-icons.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The mark: concentric range rings with a bright return at the centre. */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    // Source-over, so overlapping strokes blend instead of clipping.
    const sa = a / 255;
    buf[i] = Math.round(buf[i] * (1 - sa) + r * sa);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - sa) + g * sa);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - sa) + b * sa);
    buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * sa + buf[i + 3] * (1 - sa)));
  };

  // Background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = 0x06;
      buf[i + 1] = 0x08;
      buf[i + 2] = 0x0b;
      buf[i + 3] = 255;
    }
  }

  const rings = [0.2, 0.34, 0.47];
  const stroke = Math.max(1, size * 0.016);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.hypot(dx, dy) / (size / 2);

      for (let k = 0; k < rings.length; k++) {
        const target = rings[k];
        const edge = Math.abs(d - target) * (size / 2);
        if (edge < stroke) {
          const a = (1 - edge / stroke) * (k === 0 ? 190 : k === 1 ? 130 : 85);
          put(x, y, 0xff, 0xb0, 0x00, a);
        }
      }

      // Crosshair ticks at the cardinal points.
      const onAxis = Math.abs(dx) < stroke * 0.55 || Math.abs(dy) < stroke * 0.55;
      if (onAxis && d > 0.53 && d < 0.66) put(x, y, 0xe6, 0xea, 0xf0, 150);

      // Centre return.
      const core = d * (size / 2);
      if (core < size * 0.055) {
        const a = 255 * (1 - core / (size * 0.055)) ** 0.5;
        put(x, y, 0xff, 0xd0, 0x7a, Math.min(255, a + 90));
      }
    }
  }
  return buf;
}

mkdirSync('public', { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(`public/icon-${size}.png`, encodePng(size, size, draw(size)));
  console.log(`public/icon-${size}.png`);
}
