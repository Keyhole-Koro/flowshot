// Scenario definition and loading.
//
// A scenario is one unit of capture: it prepares state once (`setup`), then
// runs `capture` once per viewport with helpers bound to that viewport. It may
// also declare viewer `flows` (transition diagrams) that reference the images
// it, or other scenarios, produce.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureFromSteps, flowFromSteps, validateSteps } from "./steps.mjs";

const SCENARIO_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate and normalise a scenario. Returns the same object so files can
 * `export default defineScenario({...})`.
 *
 * @param {object} scenario
 * @param {string} scenario.id Unique id (`[a-z0-9-]`). Used by `--only` and in the manifest.
 * @param {string} [scenario.title]
 * @param {string} [scenario.description]
 * @param {string[]} [scenario.viewports] Names of config viewports to capture; default all.
 * @param {(ctx: object) => Promise<unknown>} [scenario.setup] Runs once before any viewport.
 * @param {(ctx: object) => Promise<void>} [scenario.capture] Runs once per viewport. Required unless `steps` is given.
 * @param {object[]} [scenario.steps] Declarative alternative to `capture` (see steps.mjs); also generates a flow.
 * @param {object|((ctx) => object)} [scenario.page] Options for the page that `steps` share (e.g. `{ cookies }`).
 * @param {(page, ctx) => Promise<void>} [scenario.prepare] Runs on the shared page before the first step (route mocks etc.).
 * @param {object} [scenario.flow] Overrides for the flow generated from `steps` (title, description, diagramHeight, viewports).
 * @param {(ctx: object) => Promise<void>} [scenario.teardown]
 * @param {object[]} [scenario.flows] Viewer flows (see viewer/build.mjs).
 * @param {number} [scenario.order] Sort key for run and viewer order (default 0, then file path).
 */
export function defineScenario(scenario) {
  if (!scenario || typeof scenario !== "object") throw new TypeError("defineScenario expects an object");
  if (!SCENARIO_ID.test(scenario.id ?? "")) throw new TypeError(`Scenario id must match ${SCENARIO_ID}: ${JSON.stringify(scenario.id)}`);
  const normalized = { title: scenario.id, description: "", flows: [], ...scenario, __flowshot: true };
  if (scenario.steps) {
    validateSteps(scenario.id, scenario.steps);
    if (!scenario.capture) normalized.capture = captureFromSteps(normalized);
    const generated = flowFromSteps(normalized);
    if (!normalized.flows.some((flow) => flow.id === generated.id)) normalized.flows = [generated, ...normalized.flows];
  }
  if (typeof normalized.capture !== "function") throw new TypeError(`Scenario "${scenario.id}" needs a capture() function or steps`);
  for (const flow of normalized.flows) {
    if (!flow.id) throw new TypeError(`Scenario "${scenario.id}": every flow needs an id`);
    if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) throw new TypeError(`Flow "${flow.id}" needs at least one node`);
    const ids = new Set(flow.nodes.map((node) => node.id));
    for (const [from, to] of flow.edges ?? []) {
      if (!ids.has(from) || !ids.has(to)) throw new TypeError(`Flow "${flow.id}": edge ${from} -> ${to} references an unknown node`);
    }
  }
  return normalized;
}

// Minimal glob: supports `*` (within a segment) and `**` (any depth).
function globToRegExp(pattern) {
  const escaped = pattern
    .split("/")
    .map((segment) => {
      if (segment === "**") return "(?:.+/)?";
      return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "/";
    })
    .join("")
    .replace(/\/$/, "");
  return new RegExp(`^${escaped}$`);
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Resolve `config.scenarios` (glob patterns or file paths, relative to
 * `config.rootDir`) and import each file. Files are loaded in path order so
 * viewer flows keep a stable order.
 */
export async function loadScenarios(config) {
  const patterns = Array.isArray(config.scenarios) ? config.scenarios : [config.scenarios];
  const files = new Set();
  for (const pattern of patterns) {
    const absolute = path.resolve(config.rootDir, pattern);
    if (!/[*?]/.test(pattern)) {
      try {
        if ((await stat(absolute)).isFile()) files.add(absolute);
        continue;
      } catch {
        throw new Error(`Scenario file not found: ${absolute}`);
      }
    }
    // Walk from the first non-glob segment.
    const segments = pattern.split("/");
    const baseIndex = segments.findIndex((segment) => /[*?]/.test(segment));
    const base = path.resolve(config.rootDir, segments.slice(0, baseIndex).join("/") || ".");
    const matcher = globToRegExp(path.resolve(config.rootDir, pattern).split(path.sep).join("/"));
    for (const file of await walk(base)) {
      if (matcher.test(file.split(path.sep).join("/"))) files.add(file);
    }
  }

  const scenarios = [];
  for (const file of [...files].sort()) {
    const module = await import(pathToFileURL(file).href);
    const scenario = module.default;
    if (!scenario?.__flowshot) throw new Error(`${file} must \`export default defineScenario({...})\``);
    if (scenarios.some((existing) => existing.id === scenario.id)) throw new Error(`Duplicate scenario id "${scenario.id}" in ${file}`);
    scenarios.push({ ...scenario, file });
  }
  if (scenarios.length === 0) throw new Error(`No scenarios matched ${JSON.stringify(patterns)} under ${config.rootDir}`);
  return scenarios.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.file.localeCompare(b.file));
}
