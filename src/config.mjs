// Configuration loading and defaults.
//
// A project describes itself in `flowshot.config.mjs` (default export). Every
// field is optional; the defaults below are meant for a local dev server.

import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_VIEWPORTS = [
  { name: "pc", width: 1440, height: 1000, isMobile: false, hasTouch: false },
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
];

const DEFAULTS = {
  baseUrl: "http://localhost:3000",
  outDir: "output/captures",
  viewports: DEFAULT_VIEWPORTS,
  scenarios: ["flowshot/scenarios/*.mjs"],
  // Milliseconds to wait after the page settles before taking a screenshot,
  // so CSS transitions and web fonts finish.
  settleMs: 600,
  // Optional `async (page, { viewport, scenario, path }) => {}` run before every
  // screenshot, e.g. to wait for client-side data to render.
  beforeShoot: null,
  // Options passed to `chromium.launch()`.
  launch: { args: ["--no-sandbox"] },
  // Routes to visit once, without a session, before capturing. Dev servers
  // that compile on demand (Vite) otherwise return a blank first paint.
  warmUp: [],
  viewer: { title: "flowshot", subtitle: "Screen capture viewer", lang: "en" },
};

const CONFIG_CANDIDATES = ["flowshot.config.mjs", "flowshot.config.js"];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the project config. `configPath` overrides discovery; otherwise the
 * first candidate in `cwd` wins. Missing file = all defaults.
 *
 * Environment variables `BASE_URL`, `OUT_DIR` and `CHROMIUM_EXECUTABLE_PATH`
 * override the file so CI and one-off runs need no edits.
 */
export async function loadConfig({ cwd = process.cwd(), configPath = null } = {}) {
  let file = configPath ? path.resolve(cwd, configPath) : null;
  if (!file) {
    for (const candidate of CONFIG_CANDIDATES) {
      const resolved = path.join(cwd, candidate);
      if (await exists(resolved)) {
        file = resolved;
        break;
      }
    }
  } else if (!(await exists(file))) {
    throw new Error(`Config file not found: ${file}`);
  }

  const fromFile = file ? (await import(pathToFileURL(file).href)).default ?? {} : {};
  const merged = {
    ...DEFAULTS,
    ...fromFile,
    launch: { ...DEFAULTS.launch, ...(fromFile.launch ?? {}) },
    viewer: { ...DEFAULTS.viewer, ...(fromFile.viewer ?? {}) },
  };

  if (process.env.BASE_URL) merged.baseUrl = process.env.BASE_URL;
  if (process.env.OUT_DIR) merged.outDir = process.env.OUT_DIR;
  if (process.env.CHROMIUM_EXECUTABLE_PATH) merged.launch.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;

  merged.baseUrl = merged.baseUrl.replace(/\/+$/, "");
  merged.rootDir = file ? path.dirname(file) : cwd;
  merged.outDir = path.resolve(merged.rootDir, merged.outDir);
  merged.configFile = file;
  return merged;
}
