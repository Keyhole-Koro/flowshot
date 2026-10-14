// Pixel comparison between the current captures and a baseline directory.
//
// `flowshot run` keeps the overwritten version of every capture under
// `<outDir>/.previous/`, so `flowshot diff` with no arguments answers "what
// changed in the last run?". `--against <dir>` compares with any other tree
// with the same layout (e.g. captures from another branch).

import { access, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { crop, readPng, writePng } from "./png.js";
import type { CaptureEntry, DiffResult, RgbaImage } from "./types.js";

export const PREVIOUS_DIR = ".previous";
export const DIFF_DIR = ".diff";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export interface PixelComparison {
  changedPixels: number;
  totalPixels: number;
  ratio: number;
  sizeChanged: boolean;
  overlap: { width: number; height: number };
  /** Highlight image: red changed pixels over a faded copy of `current`. */
  image: RgbaImage;
  /** 1 per changed pixel, row-major over `image`'s width × height. */
  mask: Uint8Array;
}

/**
 * Compare two RGBA images. A pixel counts as changed when any channel differs
 * by more than `tolerance`. Areas outside the smaller image count as changed.
 */
export function comparePixels(current: RgbaImage, baseline: RgbaImage, { tolerance = 16 }: { tolerance?: number } = {}): PixelComparison {
  const width = Math.max(current.width, baseline.width);
  const height = Math.max(current.height, baseline.height);
  const overlapWidth = Math.min(current.width, baseline.width);
  const overlapHeight = Math.min(current.height, baseline.height);
  const out = new Uint8Array(width * height * 4);
  const mask = new Uint8Array(width * height);
  let changed = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dst = (y * width + x) * 4;
      const inCurrent = x < current.width && y < current.height;
      const inBaseline = x < baseline.width && y < baseline.height;
      if (inCurrent) {
        const src = (y * current.width + x) * 4;
        // Faded greyscale of the current image as background.
        const grey = 255 - (255 - ((current.data[src] ?? 0) * 0.299 + (current.data[src + 1] ?? 0) * 0.587 + (current.data[src + 2] ?? 0) * 0.114)) * 0.35;
        out[dst] = out[dst + 1] = out[dst + 2] = grey;
        out[dst + 3] = 255;
      } else {
        out[dst] = 245;
        out[dst + 1] = 245;
        out[dst + 2] = 245;
        out[dst + 3] = 255;
      }
      let differs: boolean;
      if (inCurrent && inBaseline) {
        const a = (y * current.width + x) * 4;
        const b = (y * baseline.width + x) * 4;
        const c = current.data;
        const d = baseline.data;
        differs =
          Math.abs((c[a] ?? 0) - (d[b] ?? 0)) > tolerance ||
          Math.abs((c[a + 1] ?? 0) - (d[b + 1] ?? 0)) > tolerance ||
          Math.abs((c[a + 2] ?? 0) - (d[b + 2] ?? 0)) > tolerance ||
          Math.abs((c[a + 3] ?? 0) - (d[b + 3] ?? 0)) > tolerance;
      } else {
        differs = true;
      }
      if (differs) {
        changed += 1;
        mask[y * width + x] = 1;
        // Area only one of the images covers (the page grew or shrank): light red.
        const both = inCurrent && inBaseline;
        out[dst] = both ? 230 : 250;
        out[dst + 1] = both ? 40 : 190;
        out[dst + 2] = both ? 60 : 195;
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
    mask,
  };
}

export interface Region { x: number; y: number; width: number; height: number }

const CELL = 8;
/** Changes closer than this many cells are reported as one region. */
const MERGE_CELLS = 3;
const MAX_REGIONS = 8;

/**
 * Group changed pixels into separate regions: mark 8px cells that contain a
 * change, join cells within MERGE_CELLS of each other, and box each group.
 * Returns the largest MAX_REGIONS in reading order, plus how many were left out.
 */
export function findRegions(mask: Uint8Array, width: number, height: number): { regions: Region[]; omitted: number } {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const count = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) count[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]! += 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const groups: Array<Region & { pixels: number }> = [];
  for (let start = 0; start < count.length; start += 1) {
    if (!count[start] || seen[start]) continue;
    seen[start] = 1;
    const stack = [start];
    let minC = cols, minR = rows, maxC = -1, maxR = -1, pixels = 0;
    while (stack.length) {
      const cell = stack.pop()!;
      const c = cell % cols;
      const r = Math.floor(cell / cols);
      pixels += count[cell]!;
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      for (let dr = -MERGE_CELLS; dr <= MERGE_CELLS; dr += 1) {
        for (let dc = -MERGE_CELLS; dc <= MERGE_CELLS; dc += 1) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const next = nr * cols + nc;
          if (count[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    const x = minC * CELL;
    const y = minR * CELL;
    groups.push({ x, y, width: Math.min(width, (maxC + 1) * CELL) - x, height: Math.min(height, (maxR + 1) * CELL) - y, pixels });
  }
  const kept = groups.sort((a, b) => b.pixels - a.pixels).slice(0, MAX_REGIONS);
  const regions = kept.sort((a, b) => a.y - b.y || a.x - b.x).map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }));
  return { regions, omitted: groups.length - kept.length };
}

/** Overall box around every region, or null. */
function union(regions: Region[]): Region | null {
  if (!regions.length) return null;
  const x = Math.min(...regions.map((r) => r.x));
  const y = Math.min(...regions.map((r) => r.y));
  const right = Math.max(...regions.map((r) => r.x + r.width));
  const bottom = Math.max(...regions.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Plain-language notes about size: horizontal overflow against the viewport
 * width, and how much taller or shorter the page got.
 */
export function sizeNotes(current: { width: number; height: number }, baseline: { width: number; height: number }, viewportWidth?: number): string[] {
  const notes: string[] = [];
  if (viewportWidth) {
    const now = current.width - viewportWidth;
    const before = baseline.width - viewportWidth;
    if (now > 0) notes.push(`overflows the ${viewportWidth}px viewport by ${now}px (horizontal scroll)${before > 0 ? `; was ${before}px` : ""}`);
    else if (before > 0) notes.push(`no longer overflows the ${viewportWidth}px viewport (was ${before}px wider)`);
  } else if (current.width !== baseline.width) {
    notes.push(`width ${baseline.width} → ${current.width}px`);
  }
  const grew = current.height - baseline.height;
  if (grew) notes.push(`page is ${Math.abs(grew)}px ${grew > 0 ? "taller" : "shorter"}`);
  return notes;
}

const GAP = 12;
const BACKDROP = [226, 230, 235] as const;
const BOX = [37, 99, 235] as const;

function blank(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BACKDROP[0]; data[i + 1] = BACKDROP[1]; data[i + 2] = BACKDROP[2]; data[i + 3] = 255;
  }
  return { width, height, data };
}

function blit(target: RgbaImage, source: RgbaImage, left: number, top: number): void {
  for (let row = 0; row < source.height; row += 1) {
    const y = top + row;
    if (y < 0 || y >= target.height) continue;
    const from = row * source.width * 4;
    const w = Math.min(source.width, target.width - left);
    target.data.set(source.data.subarray(from, from + w * 4), (y * target.width + left) * 4);
  }
}

function outline(target: RgbaImage, box: Region, left: number, top: number, thickness = 2): void {
  const put = (x: number, y: number) => {
    if (x < left || y < 0 || x >= target.width || y >= target.height) return;
    const i = (y * target.width + x) * 4;
    target.data[i] = BOX[0]; target.data[i + 1] = BOX[1]; target.data[i + 2] = BOX[2]; target.data[i + 3] = 255;
  };
  const x0 = left + box.x - thickness, y0 = top + box.y - thickness;
  const x1 = left + box.x + box.width + thickness - 1, y1 = top + box.y + box.height + thickness - 1;
  for (let t = 0; t < thickness; t += 1) {
    for (let x = x0; x <= x1; x += 1) { put(x, y0 + t); put(x, y1 - t); }
    for (let y = y0; y <= y1; y += 1) { put(x0 + t, y); put(x1 - t, y); }
  }
}

/** Dashed vertical line at `x`, marking the viewport's right edge. */
function edge(target: RgbaImage, x: number): void {
  for (let y = 0; y < target.height; y += 1) {
    if (y % 12 >= 7) continue;
    for (let dx = 0; dx < 2; dx += 1) {
      const i = (y * target.width + x + dx) * 4;
      target.data[i] = 214; target.data[i + 1] = 40; target.data[i + 2] = 40; target.data[i + 3] = 255;
    }
  }
}

/**
 * Three panels side by side — before | after | changes — with every region
 * boxed in blue on each. All panels share the coordinates of the region list.
 * When a panel is wider than `viewportWidth`, a dashed red line marks where
 * the screen ends.
 */
export function composeDiff(baseline: RgbaImage, current: RgbaImage, highlight: RgbaImage, regions: Region[], viewportWidth?: number): RgbaImage {
  const panel = { width: highlight.width, height: highlight.height };
  const out = blank(panel.width * 3 + GAP * 2, panel.height);
  [baseline, current, highlight].forEach((image, index) => {
    const left = index * (panel.width + GAP);
    blit(out, image, left, 0);
    for (const region of regions) outline(out, region, left, 0);
    const overflowing = index === 0 ? baseline.width : current.width;
    if (viewportWidth && overflowing > viewportWidth) edge(out, left + viewportWidth);
  });
  return out;
}

export interface DiffOptions {
  outDir: string;
  baselineDir: string;
  captures: CaptureEntry[];
  /** Changed-pixel ratio above which a capture counts as changed. */
  threshold?: number;
  tolerance?: number;
  writeImages?: boolean;
  /** Viewport widths by name, to report horizontal overflow. */
  viewportWidths?: Record<string, number>;
}

/** Padding around a region in its cropped image. */
const REGION_PAD = 24;
const REGION_MAX_HEIGHT = 900;
const REGION_MAX_WIDTH = 900;

/**
 * Diff every capture in `captures` (manifest entries) against `baselineDir`.
 * Writes highlighted diff images under `<outDir>/.diff/<path>` for changed
 * captures.
 */
export async function diffCaptures({ outDir, baselineDir, captures, threshold = 0.0005, tolerance = 16, writeImages = true, viewportWidths = {} }: DiffOptions): Promise<DiffResult[]> {
  const results: DiffResult[] = [];
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
      const { regions, omitted } = changed ? findRegions(result.mask, result.image.width, result.image.height) : { regions: [], omitted: 0 };
      const entry: DiffResult = {
        path: capture.path,
        scenario: capture.scenario,
        viewport: capture.viewport,
        status: changed ? "changed" : "same",
        ratio: Number(result.ratio.toFixed(5)),
        changedPixels: result.changedPixels,
        sizeChanged: result.sizeChanged,
        size: { width: current.width, height: current.height },
        baselineSize: { width: baseline.width, height: baseline.height },
        bounds: changed ? union(regions) : null,
        regions: regions.map((region) => ({ ...region, image: null })),
        omittedRegions: omitted,
        notes: changed ? sizeNotes(current, baseline, viewportWidths[capture.viewport]) : [],
        diffImage: null,
      };
      if (changed && writeImages) {
        const diffFile = path.join(outDir, DIFF_DIR, capture.path);
        await mkdir(path.dirname(diffFile), { recursive: true });
        // Drop region images from an earlier diff of this capture.
        const stem = path.basename(diffFile, ".png");
        for (const old of await readdir(path.dirname(diffFile))) {
          if (old.startsWith(`${stem}.region-`)) await rm(path.join(path.dirname(diffFile), old));
        }
        const composite = composeDiff(baseline, current, result.image, regions, viewportWidths[capture.viewport]);
        await writePng(diffFile, composite);
        entry.diffImage = path.relative(outDir, diffFile).split(path.sep).join("/");
        // One small before | after | changes strip per region, so a reader can
        // look at each change without cropping the full-page composite.
        const panelWidth = result.image.width;
        for (const [index, region] of regions.entries()) {
          const top = Math.max(0, region.y - REGION_PAD);
          const height = Math.min(REGION_MAX_HEIGHT, region.height + REGION_PAD * 2, result.image.height - top);
          const left = Math.max(0, region.x - REGION_PAD);
          const width = Math.min(REGION_MAX_WIDTH, region.width + REGION_PAD * 2, panelWidth - left);
          const strip = blank(width * 3 + GAP * 2, height);
          for (let panel = 0; panel < 3; panel += 1) {
            blit(strip, crop(composite, panel * (panelWidth + GAP) + left, top, width, height), panel * (width + GAP), 0);
          }
          const regionFile = diffFile.replace(/\.png$/, `.region-${index + 1}.png`);
          await writePng(regionFile, strip);
          entry.regions![index]!.image = path.relative(outDir, regionFile).split(path.sep).join("/");
        }
      }
      results.push(entry);
    } catch (error) {
      results.push({ path: capture.path, scenario: capture.scenario, viewport: capture.viewport, status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Split a tall image into tiles of `tileHeight` with `overlap` rows shared. */
export function tile(image: RgbaImage, { tileHeight = 1200, overlap = 40 }: { tileHeight?: number; overlap?: number } = {}): Array<{ y: number; image: RgbaImage }> {
  const tiles: Array<{ y: number; image: RgbaImage }> = [];
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
export async function listPngs(directory: string, relative = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listPngs(path.join(directory, entry.name), next)));
    else if (entry.isFile() && entry.name.endsWith(".png")) files.push(next);
  }
  return files.sort();
}
