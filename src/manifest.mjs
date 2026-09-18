// `manifest.json`: the machine-readable index of everything captured.
//
// The viewer and the CLI (`list`, `diff`, `inspect`) read this instead of
// walking the output directory, and it is the entry point for an LLM that
// cannot open the HTML viewer.

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILE = "manifest.json";
const MANIFEST_VERSION = 1;

/** Read the PNG header for dimensions without decoding the image. */
export async function pngSize(file) {
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

export async function readManifest(outDir) {
  try {
    return JSON.parse(await readFile(path.join(outDir, MANIFEST_FILE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Write the manifest. Captures from scenarios that were *not* part of this
 * run are carried over from the previous manifest, so `run --only x` keeps
 * the rest of the index intact.
 */
export async function writeManifest(outDir, { config, captures, ranScenarios, failures }) {
  const previous = await readManifest(outDir);
  const kept = (previous?.captures ?? []).filter((entry) => !ranScenarios.includes(entry.scenario));
  const merged = [...kept, ...captures].sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
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

/** Capture id: the path without viewport prefix and extension. */
export function captureId(relativePath) {
  return relativePath.replace(/\.png$/i, "");
}
