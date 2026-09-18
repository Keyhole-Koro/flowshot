// `manifest.json`: the machine-readable index of everything captured.
//
// The viewer and the CLI (`list`, `diff`, `inspect`) read this instead of
// walking the output directory, and it is the entry point for an LLM that
// cannot open the HTML viewer.

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureEntry, Config, Manifest, ManifestFailure } from "./types.js";

export const MANIFEST_FILE = "manifest.json";
const MANIFEST_VERSION = 1;

/** Read the PNG header for dimensions without decoding the image. */
export async function pngSize(file: string): Promise<{ width: number; height: number } | null> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    if (header.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

export async function readManifest(outDir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path.join(outDir, MANIFEST_FILE), "utf8")) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface WriteManifestInput {
  config: Config;
  captures: CaptureEntry[];
  ranScenarios: string[];
  /** `null` = every viewport ran. */
  ranViewports?: string[] | null;
  failures: ManifestFailure[];
}

/**
 * Write the manifest. Captures outside this run's scenario × viewport
 * selection are carried over from the previous manifest, so `run --only x
 * --viewport mobile` keeps the rest of the index intact.
 */
export async function writeManifest(outDir: string, { config, captures, ranScenarios, ranViewports = null, failures }: WriteManifestInput): Promise<Manifest> {
  const previous = await readManifest(outDir);
  const ran = (entry: CaptureEntry) => ranScenarios.includes(entry.scenario) && (!ranViewports || ranViewports.includes(entry.viewport));
  const kept = (previous?.captures ?? []).filter((entry) => !ran(entry));
  const merged = [...kept, ...captures].sort((a, b) => a.path.localeCompare(b.path));

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    viewports: config.viewports.map(({ name, width, height }) => ({ name, width, height })),
    scenarios: [...new Set([...(previous?.scenarios ?? []), ...ranScenarios])].sort(),
    failures: failures.map(({ scenario, viewport, message, url }) => ({ scenario, viewport, message, url })),
    captures: merged,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

/** Capture id: the path without extension. */
export function captureId(relativePath: string): string {
  return relativePath.replace(/\.png$/i, "");
}
