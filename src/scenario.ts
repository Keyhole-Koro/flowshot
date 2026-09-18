// Scenario definition and loading.
//
// A scenario is one unit of capture: it prepares state once (`setup`), then
// runs `capture` once per viewport with helpers bound to that viewport. It may
// also declare viewer `flows` (transition diagrams) that reference the images
// it, or other scenarios, produce.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureFromSteps, flowFromSteps, validateSteps } from "./steps.js";
import type { Config, Flow, Scenario, ScenarioDefinition } from "./types.js";

const SCENARIO_ID = /^[a-z0-9][a-z0-9-]*$/;

function validateFlow(scenarioId: string, flow: Flow): void {
  if (!flow.id) throw new TypeError(`Scenario "${scenarioId}": every flow needs an id`);
  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) throw new TypeError(`Flow "${flow.id}" needs at least one node`);
  const ids = new Set(flow.nodes.map((node) => node.id));
  for (const [from, to] of flow.edges ?? []) {
    if (!ids.has(from) || !ids.has(to)) throw new TypeError(`Flow "${flow.id}": edge ${from} -> ${to} references an unknown node`);
  }
}

/**
 * Validate and normalise a scenario. Files `export default defineScenario({...})`.
 * With `steps`, a `capture()` and a flow are generated unless given.
 */
export function defineScenario<State = unknown>(definition: ScenarioDefinition<State>): Scenario<State> {
  if (!definition || typeof definition !== "object") throw new TypeError("defineScenario expects an object");
  if (!SCENARIO_ID.test(definition.id ?? "")) throw new TypeError(`Scenario id must match ${SCENARIO_ID}: ${JSON.stringify(definition.id)}`);

  const normalized = {
    title: definition.id,
    description: "",
    ...definition,
    flows: [...(definition.flows ?? [])],
    __flowshot: true as const,
  } as Scenario<State>;

  if (definition.steps) {
    validateSteps(definition.id, definition.steps);
    if (!definition.capture) normalized.capture = captureFromSteps(normalized);
    const generated = flowFromSteps(normalized);
    if (!normalized.flows.some((flow) => flow.id === generated.id)) normalized.flows = [generated, ...normalized.flows];
  }
  if (typeof normalized.capture !== "function") throw new TypeError(`Scenario "${definition.id}" needs a capture() function or steps`);
  for (const flow of normalized.flows) validateFlow(definition.id, flow);
  return normalized;
}

// Minimal glob: supports `*` (within a segment) and `**` (any depth).
function globToRegExp(pattern: string): RegExp {
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

async function walk(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Resolve `config.scenarios` (glob patterns or file paths, relative to
 * `config.rootDir`) and import each file. Sorted by `order`, then path.
 */
export async function loadScenarios(config: Config): Promise<Scenario[]> {
  const patterns = config.scenarios;
  const files = new Set<string>();
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

  const scenarios: Scenario[] = [];
  for (const file of [...files].sort()) {
    const module = (await import(pathToFileURL(file).href)) as { default?: Scenario };
    const scenario = module.default;
    if (!scenario?.__flowshot) throw new Error(`${file} must \`export default defineScenario({...})\``);
    if (scenarios.some((existing) => existing.id === scenario.id)) throw new Error(`Duplicate scenario id "${scenario.id}" in ${file}`);
    scenarios.push({ ...scenario, file });
  }
  if (scenarios.length === 0) throw new Error(`No scenarios matched ${JSON.stringify(patterns)} under ${config.rootDir}`);
  return scenarios.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.file ?? "").localeCompare(b.file ?? ""));
}
