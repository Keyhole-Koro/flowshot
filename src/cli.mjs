// CLI entry. Output is plain text by default and JSON with `--json`, so both
// people and LLM agents can consume it.

import { parseArgs } from "node:util";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { loadScenarios } from "./scenario.mjs";
import { runScenarios } from "./runner.mjs";
import { buildViewer, collectFlows, missingImages } from "./viewer/build.mjs";
import { readManifest, MANIFEST_FILE } from "./manifest.mjs";
import { DIFF_DIR, PREVIOUS_DIR, diffCaptures, listPngs, tile } from "./diff.mjs";
import { crop, readPng, writePng } from "./png.mjs";
import { mkdir } from "node:fs/promises";

const HELP = `flowshot — scenario-driven screenshot capture and flow viewer

Usage:
  flowshot run     [--only <id,...>] [--viewport <name,...>] [--fail-fast] [--no-viewer]
  flowshot viewer                       Rebuild index.html from manifest.json
  flowshot list    [--json]             List scenarios, viewports and captures
  flowshot lint    [--json]             Check flows against captures and scenario ids
  flowshot diff    [--against <dir>] [--only <id,...>] [--viewport <name,...>] [--threshold 0.0005] [--json]
                                        Compare captures with the previous run (or <dir>); writes .diff/ images
  flowshot inspect <capture> [--viewport <name>] [--crop x,y,w,h] [--tile <height>] [--json]
                                        Crop or tile a capture into readable pieces under .inspect/
  flowshot init    [--skills-dir .claude/skills]
                                        Write a starter config and copy the bundled agent skills
  flowshot help

Options:
  -c, --config <file>   Config file (default: flowshot.config.mjs in cwd)
      --json            Machine-readable output (list, lint, run summary)
      --quiet           Suppress progress output

Environment:
  BASE_URL, OUT_DIR, CHROMIUM_EXECUTABLE_PATH override the config file.
`;

const OPTIONS = {
  config: { type: "string", short: "c" },
  only: { type: "string" },
  viewport: { type: "string" },
  "fail-fast": { type: "boolean", default: false },
  against: { type: "string" },
  threshold: { type: "string" },
  crop: { type: "string" },
  tile: { type: "string" },
  "skills-dir": { type: "string" },
  force: { type: "boolean", default: false },
  "no-viewer": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

function makeLog(quiet) {
  return {
    info: quiet ? () => {} : (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  };
}

const list = (value) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []);

async function commandRun(config, values, log) {
  const scenarios = await loadScenarios(config);
  const { manifest, captures, failures } = await runScenarios(scenarios, config, {
    only: list(values.only),
    viewports: list(values.viewport),
    keepGoing: !values["fail-fast"],
    log,
  });

  let viewer = null;
  if (!values["no-viewer"]) {
    viewer = await buildViewer({ scenarios, config, log });
  }

  const summary = {
    outDir: config.outDir,
    captured: captures.length,
    total: manifest.captures.length,
    failures: failures.map((failure) => ({ scenario: failure.scenario, viewport: failure.viewport, url: failure.url, message: failure.cause?.message ?? String(failure.cause) })),
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

async function commandViewer(config, values, log) {
  const scenarios = await loadScenarios(config);
  const { missing } = await buildViewer({ scenarios, config, log });
  if (missing.length) log.warn(`${missing.length} flow node(s) have no capture yet (run \`flowshot lint\` for details)`);
}

async function commandList(config, values) {
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
      flows: (scenario.flows ?? []).map((flow) => flow.id),
      file: path.relative(config.rootDir, scenario.file),
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

async function commandLint(config, values) {
  const problems = [];
  let scenarios = [];
  try {
    scenarios = await loadScenarios(config);
  } catch (error) {
    problems.push({ kind: "scenario", message: error.message });
  }
  let flows = [];
  try {
    flows = collectFlows(scenarios);
  } catch (error) {
    problems.push({ kind: "flow", message: error.message });
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
      problems.push({ kind: "last-run-failure", message: `${failure.scenario}${failure.viewport ? ` (${failure.viewport})` : ""}: ${failure.message}`, ...failure });
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

function formatRatio(ratio) {
  return `${(ratio * 100).toFixed(2)}%`;
}

async function commandDiff(config, values) {
  const manifest = await readManifest(config.outDir);
  if (!manifest) throw new Error(`no ${MANIFEST_FILE} in ${config.outDir}; run \`flowshot run\` first`);
  const baselineDir = values.against ? path.resolve(config.rootDir, values.against) : path.join(config.outDir, PREVIOUS_DIR);
  const only = list(values.only);
  const viewports = list(values.viewport);
  let captures = manifest.captures;
  if (only.length) captures = captures.filter((capture) => only.includes(capture.scenario));
  if (viewports.length) captures = captures.filter((capture) => viewports.includes(capture.viewport));
  if (!values.against) {
    // Without a baseline dir, only captures that were overwritten in the last run have a previous version.
    const previous = new Set(await listPngs(baselineDir));
    captures = captures.filter((capture) => previous.has(capture.path));
  }
  const threshold = values.threshold ? Number(values.threshold) : 0.0005;
  const results = await diffCaptures({ outDir: config.outDir, baselineDir, captures, threshold });
  const changed = results.filter((result) => result.status === "changed");
  const summary = {
    baseline: baselineDir,
    compared: results.length,
    changed: changed.length,
    same: results.filter((result) => result.status === "same").length,
    new: results.filter((result) => result.status === "new").length,
    errors: results.filter((result) => result.status === "error").length,
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
    const detail =
      result.status === "changed"
        ? `${formatRatio(result.ratio)} changed${result.sizeChanged ? ` (size ${result.baselineSize.width}x${result.baselineSize.height} → ${result.size.width}x${result.size.height})` : ""}${result.bounds ? `  region ${result.bounds.x},${result.bounds.y} ${result.bounds.width}x${result.bounds.height}` : ""}  → ${result.diffImage}`
        : result.status === "new"
          ? "no baseline"
          : result.message;
    console.log(`${result.status.padEnd(8)} ${result.path}  ${detail}`);
  }
  console.log(`\n${summary.compared} compared: ${summary.changed} changed, ${summary.same} same, ${summary.new} new${summary.errors ? `, ${summary.errors} errors` : ""}`);
}

async function commandInspect(config, values, positionals) {
  const target = positionals[1];
  if (!target) throw new Error("inspect needs a capture id or path, e.g. `flowshot inspect app/billing/01_overview --viewport mobile`");
  const manifest = await readManifest(config.outDir);
  const viewport = values.viewport ?? config.viewports[0].name;
  let relative = target.replace(/^\/+/, "");
  if (!relative.endsWith(".png")) relative += ".png";
  // Accept ids (`app/x/01_y`), viewport paths (`mobile/app/x/01_y.png`) and
  // helper trees (`.diff/...`, `.previous/...`).
  if (!relative.startsWith(".") && !new RegExp(`^(${config.viewports.map((v) => v.name).join("|")})/`).test(relative)) relative = `${viewport}/${relative}`;
  const file = path.join(config.outDir, relative);
  const entry = manifest?.captures.find((capture) => capture.path === relative) ?? null;

  const image = await readPng(file).catch((error) => {
    throw new Error(`cannot read ${relative}: ${error.message}${manifest ? `. Known captures: run \`flowshot list\`` : ""}`);
  });
  const outDir = path.join(config.outDir, ".inspect");
  await mkdir(outDir, { recursive: true });
  const base = relative.replace(/\.png$/, "").replace(/[\/]/g, "__");
  const pieces = [];

  if (values.crop) {
    const [x, y, w, h] = values.crop.split(",").map(Number);
    if ([x, y, w, h].some(Number.isNaN)) throw new Error("--crop expects x,y,w,h");
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

const STARTER_CONFIG = `// flowshot configuration. See https://github.com/Keyhole-Koro/flowshot#config
export default {
  baseUrl: "http://localhost:3000",
  outDir: "output/captures",
  scenarios: ["flowshot/scenarios/*.mjs"],
  viewports: [
    { name: "pc", width: 1440, height: 1000, isMobile: false, hasTouch: false },
    { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
  ],
  // Routes to open once before capturing (on-demand dev servers paint blank the first time).
  warmUp: [],
  // Wait for client-side rendering before each screenshot, e.g.:
  // beforeShoot: async (page) => { await page.waitForFunction(() => document.body.innerText.length > 80).catch(() => {}); },
  viewer: { title: "My app", subtitle: "Screen capture viewer", lang: "en" },
};
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
async function commandInit(config, values, log) {
  const { copyFile, readdir, writeFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const cwd = process.cwd();
  const created = [];

  if (!config.configFile) {
    const configFile = path.join(cwd, "flowshot.config.mjs");
    await writeFile(configFile, STARTER_CONFIG, "utf8");
    created.push(configFile);
    const scenarioFile = path.join(cwd, "flowshot/scenarios/public.mjs");
    await mkdir(path.dirname(scenarioFile), { recursive: true });
    await writeFile(scenarioFile, STARTER_SCENARIO, "utf8");
    created.push(scenarioFile);
  } else {
    log.info(`config exists: ${path.relative(cwd, config.configFile)} (kept)`);
  }

  const skillsSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const skillsTarget = path.resolve(cwd, values["skills-dir"] ?? ".claude/skills");
  for (const entry of await readdir(skillsSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const targetDir = path.join(skillsTarget, entry.name);
    await mkdir(targetDir, { recursive: true });
    for (const file of await readdir(path.join(skillsSource, entry.name))) {
      const target = path.join(targetDir, file);
      const exists = await import("node:fs/promises").then((fs) => fs.access(target).then(() => true, () => false));
      if (exists && !values.force) {
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

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const log = makeLog(values.quiet || values.json);
  const config = await loadConfig({ configPath: values.config ?? null });

  switch (command) {
    case "run":
      return commandRun(config, values, log);
    case "viewer":
      return commandViewer(config, values, log);
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
