// Minimal PNG codec: enough to read what Playwright writes (8-bit RGB/RGBA,
// non-interlaced) and to write RGBA. No dependencies, so `diff` and
// `inspect` work anywhere the runner does.

import { readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import type { RgbaImage } from "./types.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG file to `{ width, height, data }` where `data` is RGBA
 * (Uint8Array, 4 bytes per pixel).
 */
export async function readPng(file: string): Promise<RgbaImage> {
  const buffer = await readFile(file);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file}: not a PNG`);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`${file}: only 8-bit PNGs are supported (got ${bitDepth}-bit)`);
  if (interlace !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number | undefined>)[colorType];
  if (!channels) throw new Error(`${file}: unsupported color type ${colorType} (palette PNGs are not supported)`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position] ?? 0;
    position += 1;
    const line = new Uint8Array(raw.buffer, raw.byteOffset + position, stride);
    const current = new Uint8Array(stride);
    position += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (current[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      let value = line[i] ?? 0;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      current[i] = value & 0xff;
    }
    // Expand to RGBA.
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = row + x * 4;
      if (channels === 1) {
        out[dst] = out[dst + 1] = out[dst + 2] = current[src] ?? 0;
        out[dst + 3] = 255;
      } else if (channels === 2) {
        out[dst] = out[dst + 1] = out[dst + 2] = current[src] ?? 0;
        out[dst + 3] = current[src + 1] ?? 0;
      } else if (channels === 3) {
        out[dst] = current[src] ?? 0;
        out[dst + 1] = current[src + 1] ?? 0;
        out[dst + 2] = current[src + 2] ?? 0;
        out[dst + 3] = 255;
      } else {
        out[dst] = current[src] ?? 0;
        out[dst + 1] = current[src + 1] ?? 0;
        out[dst + 2] = current[src + 2] ?? 0;
        out[dst + 3] = current[src + 3] ?? 0;
      }
    }
    previous = current;
  }
  return { width, height, data: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Encode RGBA pixels as a PNG file. */
export async function writePng(file: string, { width, height, data }: RgbaImage): Promise<void> {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const png = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  await writeFile(file, png);
}

/** Copy a rectangle out of an RGBA image (clamped to its bounds). */
export function crop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const x0 = Math.max(0, Math.min(image.width, x));
  const y0 = Math.max(0, Math.min(image.height, y));
  const w = Math.max(0, Math.min(image.width - x0, width));
  const h = Math.max(0, Math.min(image.height - y0, height));
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const src = ((y0 + row) * image.width + x0) * 4;
    data.set(image.data.subarray(src, src + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}
