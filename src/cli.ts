// CLI entry. Output is plain text by default and JSON with `--json`, so both
// people and LLM agents can consume it.

import { access, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { DIFF_DIR, PREVIOUS_DIR, diffCaptures, listPngs, tile } from "./diff.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import { crop, readPng, writePng } from "./png.js";
import { runScenarios } from "./runner.js";
import { loadScenarios } from "./scenario.js";
import type { Config, DiffResult, Logger } from "./types.js";
import { buildViewer, collectFlows, missingImages } from "./viewer/build.js";

const HELP = `flowshot — scenario-driven screenshot capture and flow viewer

Usage:
  flowshot run     [--only <id,...>] [--viewport <name,...>] [--fail-fast] [--no-viewer] [--json]
  flowshot viewer                       Rebuild index.html from manifest.json
  flowshot list    [--json]             List scenarios, viewports and captures
  flowshot lint    [--json]             Check flows against captures and scenario ids
  flowshot diff    [--against <dir>] [--only <id,...>] [--viewport <name,...>] [--threshold 0.0005] [--json]
                                        Compare captures with the previous run (or <dir>); writes .diff/ images
  flowshot inspect <capture> [--viewport <name>] [--crop x,y,w,h] [--tile <height>] [--json]
                                        Crop or tile a capture into readable pieces under .inspect/
  flowshot init    [--skills-dir .claude/skills] [--force]
                                        Write a starter config and copy the bundled agent skills
  flowshot help

Options:
  -c, --config <file>   Config file (default: flowshot.config.{ts,mjs,js} in cwd)
      --json            Machine-readable output
      --quiet           Suppress progress output

Environment:
  BASE_URL, OUT_DIR, CHROMIUM_EXECUTABLE_PATH override the config file.
`;

const OPTIONS = {
  config: { type: "string", short: "c" },
  only: { type: "string" },
  viewport: { type: "string" },
  "fail-fast": { type: "boolean", default: false },
  "no-viewer": { type: "boolean", default: false },
  against: { type: "string" },
  threshold: { type: "string" },
  crop: { type: "string" },
  tile: { type: "string" },
  "skills-dir": { type: "string" },
  force: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function makeLog(quiet: boolean): Logger {
  return {
    info: quiet ? () => {} : (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  };
}

const list = (value: string | undefined): string[] => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []);

const formatRatio = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function commandRun(config: Config, values: Values, log: Logger): Promise<void> {
  const scenarios = await loadScenarios(config);
  const { manifest, captures, failures } = await runScenarios(scenarios, config, {
    only: list(values.only),
    viewports: list(values.viewport),
    keepGoing: !values["fail-fast"],
    log,
  });

  const viewer = values["no-viewer"] ? null : await buildViewer({ scenarios, config, log });

  const summary = {
    outDir: config.outDir,
    captured: captures.length,
    total: manifest.captures.length,
    failures: failures.map((failure) => ({ scenario: failure.scenario, viewport: failure.viewport, url: failure.url, message: failure.cause instanceof Error ? failure.cause.message : String(failure.cause) })),
    missing: viewer?.missing ?? [],
  };
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    log.info(`\n${captures.length} captured, ${manifest.captures.length} in manifest → ${path.relative(process.cwd(), config.outDir) || "."}/`);
    if (summary.missing.length) log.warn(`${summary.missing.length} flow node(s) have no capture yet (run \`flowshot lint\` for details)`);
    for (const failure of failures) log.error(`FAILED ${failure.message}`);
  }
  if (failures.length) process.exitCode = 1;
}

async function commandViewer(config: Config, log: Logger): Promise<void> {
  const scenarios = await loadScenarios(config);
  const { missing } = await buildViewer({ scenarios, config, log });
  if (missing.length) log.warn(`${missing.length} flow node(s) have no capture yet (run \`flowshot lint\` for details)`);
}

async function commandList(config: Config, values: Values): Promise<void> {
  const scenarios = await loadScenarios(config);
  const manifest = await readManifest(config.outDir);
  const data = {
    baseUrl: config.baseUrl,
    outDir: config.outDir,
    viewports: config.viewports.map(({ name, width, height }) => ({ name, width, height })),
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      viewports: scenario.viewports ?? null,
      flows: scenario.flows.map((flow) => flow.id),
      file: scenario.file ? path.relative(config.rootDir, scenario.file) : null,
    })),
    captures: manifest?.captures ?? [],
    generatedAt: manifest?.generatedAt ?? null,
  };
  if (values.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`baseUrl:   ${data.baseUrl}`);
  console.log(`outDir:    ${data.outDir}`);
  console.log(`viewports: ${data.viewports.map((viewport) => `${viewport.name} (${viewport.width}x${viewport.height})`).join(", ")}`);
  console.log(`\nscenarios:`);
  for (const scenario of data.scenarios) {
    const extras = [scenario.viewports ? `viewports=${scenario.viewports.join(",")}` : null, scenario.flows.length ? `flows=${scenario.flows.join(",")}` : null].filter(Boolean);
    console.log(`  ${scenario.id.padEnd(22)} ${scenario.title}${extras.length ? `  [${extras.join(" ")}]` : ""}`);
  }
  if (manifest) {
    console.log(`\ncaptures (${manifest.captures.length}, ${manifest.generatedAt}):`);
    for (const capture of manifest.captures) console.log(`  ${capture.path}  ${capture.width}x${capture.height}  ${capture.scenario}`);
  } else {
    console.log(`\nno ${MANIFEST_FILE} yet — run \`flowshot run\``);
  }
}

interface LintProblem {
  kind: string;
  message: string;
  [key: string]: unknown;
}

async function commandLint(config: Config, values: Values): Promise<void> {
  const problems: LintProblem[] = [];
  let scenarios: Awaited<ReturnType<typeof loadScenarios>> = [];
  try {
    scenarios = await loadScenarios(config);
  } catch (error) {
    problems.push({ kind: "scenario", message: error instanceof Error ? error.message : String(error) });
  }
  let flows: ReturnType<typeof collectFlows> = [];
  try {
    flows = collectFlows(scenarios);
  } catch (error) {
    problems.push({ kind: "flow", message: error instanceof Error ? error.message : String(error) });
  }
  const manifest = await readManifest(config.outDir);
  if (manifest) {
    for (const entry of missingImages(flows, manifest)) {
      problems.push({ kind: "missing-capture", message: `flow ${entry.flow} / node ${entry.node}: ${entry.path} is not in the manifest`, ...entry });
    }
    const referenced = new Set(flows.flatMap((flow) => flow.nodes.map((node) => node.image).filter(Boolean)));
    for (const id of new Set(manifest.captures.map((capture) => capture.id))) {
      if (!referenced.has(`${id}.png`)) problems.push({ kind: "unreferenced-capture", message: `${id}.png is captured but no flow shows it`, id });
    }
    for (const failure of manifest.failures ?? []) {
      problems.push({ ...failure, kind: "last-run-failure", message: `${failure.scenario}${failure.viewport ? ` (${failure.viewport})` : ""}: ${failure.message}` });
    }
  } else {
    problems.push({ kind: "no-manifest", message: `no ${MANIFEST_FILE} in ${config.outDir}; run \`flowshot run\` first` });
  }

  if (values.json) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
  } else if (problems.length === 0) {
    console.log("ok: every flow node has a capture and every capture is referenced");
  } else {
    for (const problem of problems) console.log(`${problem.kind.padEnd(22)} ${problem.message}`);
    console.log(`\n${problems.length} problem(s)`);
  }
  if (problems.some((problem) => problem.kind !== "unreferenced-capture")) process.exitCode = 1;
}

function describeDiff(result: DiffResult): string {
  if (result.status === "changed") {
    const size = result.sizeChanged && result.baselineSize && result.size ? ` (size ${result.baselineSize.width}x${result.baselineSize.height} → ${result.size.width}x${result.size.height})` : "";
    const region = result.bounds ? `  region ${result.bounds.x},${result.bounds.y} ${result.bounds.width}x${result.bounds.height}` : "";
    return `${formatRatio(result.ratio ?? 0)} changed${size}${region}  → ${result.diffImage ?? ""}`;
  }
  if (result.status === "new") return "no baseline";
  return result.message ?? "";
}

async function commandDiff(config: Config, values: Values): Promise<void> {
  const manifest = await readManifest(config.outDir);
  if (!manifest) throw new Error(`no ${MANIFEST_FILE} in ${config.outDir}; run \`flowshot run\` first`);
  const baselineDir = values.against ? path.resolve(config.rootDir, values.against) : path.join(config.outDir, PREVIOUS_DIR);
  const only = list(values.only);
  const viewports = list(values.viewport);
  let captures = manifest.captures;
  if (only.length) captures = captures.filter((capture) => only.includes(capture.scenario));
  if (viewports.length) captures = captures.filter((capture) => viewports.includes(capture.viewport));
  if (!values.against) {
    // Without a baseline dir, only captures overwritten in the last run have a previous version.
    const previous = new Set(await listPngs(baselineDir));
    captures = captures.filter((capture) => previous.has(capture.path));
  }
  const threshold = values.threshold ? Number(values.threshold) : 0.0005;
  const results = await diffCaptures({ outDir: config.outDir, baselineDir, captures, threshold });
  const count = (status: DiffResult["status"]) => results.filter((result) => result.status === status).length;
  const summary = {
    baseline: baselineDir,
    compared: results.length,
    changed: count("changed"),
    same: count("same"),
    new: count("new"),
    errors: count("error"),
    diffDir: path.join(config.outDir, DIFF_DIR),
    results,
  };
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`baseline: ${path.relative(process.cwd(), baselineDir) || "."}`);
  if (results.length === 0) {
    console.log("nothing to compare (no previous versions of these captures)");
    return;
  }
  for (const result of results) {
    if (result.status === "same") continue;
    console.log(`${result.status.padEnd(8)} ${result.path}  ${describeDiff(result)}`);
  }
  console.log(`\n${summary.compared} compared: ${summary.changed} changed, ${summary.same} same, ${summary.new} new${summary.errors ? `, ${summary.errors} errors` : ""}`);
}

async function commandInspect(config: Config, values: Values, positionals: string[]): Promise<void> {
  const target = positionals[1];
  if (!target) throw new Error("inspect needs a capture id or path, e.g. `flowshot inspect app/billing/01_overview --viewport mobile`");
  const manifest = await readManifest(config.outDir);
  const viewport = values.viewport ?? config.viewports[0]?.name ?? "pc";
  let relative = target.replace(/^\/+/, "");
  if (!relative.endsWith(".png")) relative += ".png";
  // Accept ids (`app/x/01_y`), viewport paths (`mobile/app/x/01_y.png`) and
  // helper trees (`.diff/...`, `.previous/...`).
  const viewportPrefix = new RegExp(`^(${config.viewports.map((v) => v.name).join("|")})/`);
  if (!relative.startsWith(".") && !viewportPrefix.test(relative)) relative = `${viewport}/${relative}`;
  const file = path.join(config.outDir, relative);
  const entry = manifest?.captures.find((capture) => capture.path === relative) ?? null;

  const image = await readPng(file).catch((error: unknown) => {
    throw new Error(`cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}. Known captures: run \`flowshot list\``);
  });
  const outDir = path.join(config.outDir, ".inspect");
  await mkdir(outDir, { recursive: true });
  const base = relative.replace(/\.png$/, "").replace(/[\\/]/g, "__");
  const pieces: Array<{ file: string; x: number; y: number; width: number; height: number }> = [];

  if (values.crop) {
    const [x, y, w, h] = values.crop.split(",").map(Number);
    if (x === undefined || y === undefined || w === undefined || h === undefined || [x, y, w, h].some(Number.isNaN)) throw new Error("--crop expects x,y,w,h");
    const piece = crop(image, x, y, w, h);
    const output = path.join(outDir, `${base}__crop_${x}_${y}_${w}x${h}.png`);
    await writePng(output, piece);
    pieces.push({ file: output, x, y, width: piece.width, height: piece.height });
  } else {
    const tileHeight = values.tile ? Number(values.tile) : 1200;
    for (const [index, part] of tile(image, { tileHeight }).entries()) {
      const output = path.join(outDir, `${base}__tile${String(index + 1).padStart(2, "0")}_y${part.y}.png`);
      await writePng(output, part.image);
      pieces.push({ file: output, x: 0, y: part.y, width: part.image.width, height: part.image.height });
    }
  }

  const summary = { path: relative, width: image.width, height: image.height, url: entry?.url ?? null, scenario: entry?.scenario ?? null, capturedAt: entry?.capturedAt ?? null, pieces };
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`${relative}  ${image.width}x${image.height}${entry?.url ? `  ${entry.url}` : ""}`);
  for (const piece of pieces) console.log(`  ${path.relative(process.cwd(), piece.file)}  (y=${piece.y}, ${piece.width}x${piece.height})`);
}

/** Node >= 22.18 / 23.6 runs .ts files directly (type stripping). */
function supportsTypeStripping(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

const STARTER_CONFIG = (ts: boolean) => `// flowshot configuration. See https://github.com/Keyhole-Koro/flowshot#config
${ts ? 'import { defineConfig } from "flowshot";\n\nexport default defineConfig({' : "export default {"}
  baseUrl: "http://localhost:3000",
  outDir: "output/captures",
  scenarios: ["flowshot/scenarios/*.${ts ? "ts" : "mjs"}"],
  viewports: [
    { name: "pc", width: 1440, height: 1000, isMobile: false, hasTouch: false },
    { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
  ],
  // Routes to open once before capturing (on-demand dev servers paint blank the first time).
  warmUp: [],
  // Wait for client-side rendering before each screenshot, e.g.:
  // beforeShoot: async (page) => { await page.waitForFunction(() => document.body.innerText.length > 80).catch(() => {}); },
  viewer: { title: "My app", subtitle: "Screen capture viewer", lang: "en" },
${ts ? "});" : "};"}
`;

const STARTER_SCENARIO = `import { defineScenario } from "flowshot";

export default defineScenario({
  id: "public",
  title: "Public pages",
  steps: [
    { id: "home", title: "Home", condition: "Landing page", goto: "/", image: "public/01_home.png" },
  ],
});
`;

/** Write a starter config/scenario (if absent) and copy the bundled skills. */
async function commandInit(config: Config, values: Values, log: Logger): Promise<void> {
  const cwd = process.cwd();
  const created: string[] = [];

  if (!config.configFile) {
    const ts = supportsTypeStripping();
    const ext = ts ? "ts" : "mjs";
    const configFile = path.join(cwd, `flowshot.config.${ext}`);
    await writeFile(configFile, STARTER_CONFIG(ts), "utf8");
    created.push(configFile);
    const scenarioFile = path.join(cwd, `flowshot/scenarios/public.${ext}`);
    await mkdir(path.dirname(scenarioFile), { recursive: true });
    await writeFile(scenarioFile, STARTER_SCENARIO, "utf8");
    created.push(scenarioFile);
  } else {
    log.info(`config exists: ${path.relative(cwd, config.configFile)} (kept)`);
  }

  // dist/cli.js → ../skills
  const skillsSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const skillsTarget = path.resolve(cwd, values["skills-dir"] ?? ".claude/skills");
  for (const entry of await readdir(skillsSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetDir = path.join(skillsTarget, entry.name);
    await mkdir(targetDir, { recursive: true });
    for (const file of await readdir(path.join(skillsSource, entry.name))) {
      const target = path.join(targetDir, file);
      if ((await exists(target)) && !values.force) {
        log.info(`skill exists: ${path.relative(cwd, target)} (use --force to overwrite)`);
        continue;
      }
      await copyFile(path.join(skillsSource, entry.name, file), target);
      created.push(target);
    }
  }

  for (const file of created) log.info(`created ${path.relative(cwd, file)}`);
  if (values.json) console.log(JSON.stringify({ created: created.map((file) => path.relative(cwd, file)) }, null, 2));
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const log = makeLog(Boolean(values.quiet || values.json));
  const config = await loadConfig({ configPath: values.config ?? null });

  switch (command) {
    case "run":
      return commandRun(config, values, log);
    case "viewer":
      return commandViewer(config, log);
    case "list":
      return commandList(config, values);
    case "lint":
      return commandLint(config, values);
    case "diff":
      return commandDiff(config, values);
    case "inspect":
      return commandInspect(config, values, positionals);
    case "init":
      return commandInit(config, values, log);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}
