// CLI entry. Output is plain text by default and JSON with `--json`, so both
// people and LLM agents can consume it.

import { parseArgs } from "node:util";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { loadScenarios } from "./scenario.mjs";
import { runScenarios } from "./runner.mjs";
import { buildViewer, collectFlows, missingImages } from "./viewer/build.mjs";
import { readManifest, MANIFEST_FILE } from "./manifest.mjs";

const HELP = `flowshot — scenario-driven screenshot capture and flow viewer

Usage:
  flowshot run     [--only <id,...>] [--viewport <name,...>] [--fail-fast] [--no-viewer]
  flowshot viewer                       Rebuild index.html from manifest.json
  flowshot list    [--json]             List scenarios, viewports and captures
  flowshot lint    [--json]             Check flows against captures and scenario ids
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
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}
