// Pixel comparison between the current captures and a baseline directory.
//
// `flowshot run` keeps the overwritten version of every capture under
// `<outDir>/.previous/`, so `flowshot diff` with no arguments answers "what
// changed in the last run?". `--against <dir>` compares with any other tree
// with the same layout (e.g. captures from another branch).

import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { crop, readPng, writePng } from "./png.mjs";

export const PREVIOUS_DIR = ".previous";
export const DIFF_DIR = ".diff";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare two RGBA images. A pixel counts as changed when any channel differs
 * by more than `tolerance`. Areas outside the smaller image count as changed.
 *
 * @returns {{ changedPixels: number, totalPixels: number, ratio: number, sizeChanged: boolean, image: object }}
 */
export function comparePixels(current, baseline, { tolerance = 16 } = {}) {
  const width = Math.max(current.width, baseline.width);
  const height = Math.max(current.height, baseline.height);
  const overlapWidth = Math.min(current.width, baseline.width);
  const overlapHeight = Math.min(current.height, baseline.height);
  const out = new Uint8Array(width * height * 4);
  let changed = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dst = (y * width + x) * 4;
      const inCurrent = x < current.width && y < current.height;
      const inBaseline = x < baseline.width && y < baseline.height;
      if (inCurrent) {
        const src = (y * current.width + x) * 4;
        // Faded greyscale of the current image as background.
        const grey = 255 - ((255 - (current.data[src] * 0.299 + current.data[src + 1] * 0.587 + current.data[src + 2] * 0.114)) * 0.35);
        out[dst] = out[dst + 1] = out[dst + 2] = grey;
        out[dst + 3] = 255;
      } else {
        out[dst] = 245;
        out[dst + 1] = 245;
        out[dst + 2] = 245;
        out[dst + 3] = 255;
      }
      let differs;
      if (inCurrent && inBaseline) {
        const a = (y * current.width + x) * 4;
        const b = (y * baseline.width + x) * 4;
        differs =
          Math.abs(current.data[a] - baseline.data[b]) > tolerance ||
          Math.abs(current.data[a + 1] - baseline.data[b + 1]) > tolerance ||
          Math.abs(current.data[a + 2] - baseline.data[b + 2]) > tolerance ||
          Math.abs(current.data[a + 3] - baseline.data[b + 3]) > tolerance;
      } else {
        differs = true;
      }
      if (differs) {
        changed += 1;
        out[dst] = 230;
        out[dst + 1] = 40;
        out[dst + 2] = 60;
      }
    }
  }
  const total = width * height;
  return {
    changedPixels: changed,
    totalPixels: total,
    ratio: total ? changed / total : 0,
    sizeChanged: current.width !== baseline.width || current.height !== baseline.height,
    overlap: { width: overlapWidth, height: overlapHeight },
    image: { width, height, data: out },
  };
}

/** Bounding box of changed (red) pixels in a diff image, or null. */
function changedBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] === 230 && image.data[i + 1] === 40 && image.data[i + 2] === 60) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Diff every capture in `captures` (manifest entries) against `baselineDir`.
 * Writes highlighted diff images under `<outDir>/.diff/<path>` for changed
 * captures.
 *
 * @returns {Promise<object[]>} one result per capture:
 *   `{ path, status: "changed"|"same"|"new"|"error", ratio, changedPixels, sizeChanged, bounds, diffImage }`
 */
export async function diffCaptures({ outDir, baselineDir, captures, threshold = 0.0005, tolerance = 16, writeImages = true }) {
  const results = [];
  for (const capture of captures) {
    const currentFile = path.join(outDir, capture.path);
    const baselineFile = path.join(baselineDir, capture.path);
    if (!(await exists(baselineFile))) {
      results.push({ path: capture.path, scenario: capture.scenario, viewport: capture.viewport, status: "new" });
      continue;
    }
    try {
      const [current, baseline] = await Promise.all([readPng(currentFile), readPng(baselineFile)]);
      const result = comparePixels(current, baseline, { tolerance });
      const changed = result.ratio > threshold || result.sizeChanged;
      const entry = {
        path: capture.path,
        scenario: capture.scenario,
        viewport: capture.viewport,
        status: changed ? "changed" : "same",
        ratio: Number(result.ratio.toFixed(5)),
        changedPixels: result.changedPixels,
        sizeChanged: result.sizeChanged,
        size: { width: current.width, height: current.height },
        baselineSize: { width: baseline.width, height: baseline.height },
        bounds: changed ? changedBounds(result.image) : null,
        diffImage: null,
      };
      if (changed && writeImages) {
        const diffFile = path.join(outDir, DIFF_DIR, capture.path);
        await mkdir(path.dirname(diffFile), { recursive: true });
        await writePng(diffFile, result.image);
        entry.diffImage = path.relative(outDir, diffFile).split(path.sep).join("/");
      }
      results.push(entry);
    } catch (error) {
      results.push({ path: capture.path, scenario: capture.scenario, viewport: capture.viewport, status: "error", message: error.message });
    }
  }
  return results;
}

/** Split a tall image into tiles of `tileHeight` with `overlap` rows shared. */
export function tile(image, { tileHeight = 1200, overlap = 40 } = {}) {
  const tiles = [];
  if (image.height <= tileHeight) return [{ y: 0, image }];
  let y = 0;
  while (y < image.height) {
    tiles.push({ y, image: crop(image, 0, y, image.width, tileHeight) });
    if (y + tileHeight >= image.height) break;
    y += tileHeight - overlap;
  }
  return tiles;
}

/** PNG files under `directory`, relative paths with forward slashes. */
export async function listPngs(directory, relative = "") {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listPngs(path.join(directory, entry.name), next)));
    else if (entry.isFile() && entry.name.endsWith(".png")) files.push(next);
  }
  return files.sort();
}
