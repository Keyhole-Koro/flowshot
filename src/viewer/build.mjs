// Builds `index.html`: a single self-contained page that maps flows
// (transition diagrams) to the captured images.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE, readManifest } from "../manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_LABELS = {
  flows: "Flows",
  viewportsLabel: "Viewport",
  diagram: "Flow diagram",
  screens: "{n} screens",
  sameFlow: "Screens in this flow",
  openOriginal: "Open full size",
  noImage: "No capture (transition target)",
  transitionOnly: "This node is a transition target and has no screenshot.",
  missingImage: "Not captured yet: {path}",
  size: "Size",
  url: "URL",
  capturedAt: "Captured",
  scenario: "Scenario",
  unassigned: "Other captures",
  unassignedDescription: "Captures that no flow references.",
  generatedAt: "Generated",
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** Flows declared by scenarios, in scenario order. */
export function collectFlows(scenarios) {
  const flows = [];
  for (const scenario of scenarios) {
    for (const flow of scenario.flows ?? []) {
      if (flows.some((existing) => existing.id === flow.id)) throw new Error(`Duplicate flow id "${flow.id}" (scenario ${scenario.id})`);
      flows.push({ ...flow, scenario: scenario.id });
    }
  }
  return flows;
}

/** Images in the manifest that no flow node references, as a grid flow. */
function unassignedFlow(flows, captures, labels) {
  const referenced = new Set(flows.flatMap((flow) => flow.nodes.map((node) => node.image).filter(Boolean)));
  const ids = [...new Set(captures.map((capture) => capture.id))].filter((id) => !referenced.has(`${id}.png`)).sort();
  if (ids.length === 0) return null;
  const columns = 6;
  const rows = Math.ceil(ids.length / columns);
  return {
    id: "__unassigned",
    title: labels.unassigned,
    description: labels.unassignedDescription,
    diagramHeight: Math.max(200, rows * 80 + 40),
    nodes: ids.map((id, index) => ({
      id: `u${index}`,
      title: path.basename(id),
      condition: path.dirname(id),
      image: `${id}.png`,
      x: ((index % columns) + 0.5) * (100 / columns),
      y: ((Math.floor(index / columns) + 0.5) / rows) * 100,
    })),
    edges: [],
  };
}

/**
 * Write `<outDir>/index.html`.
 *
 * @param {object} options
 * @param {object[]} options.scenarios Loaded scenarios (for their flows).
 * @param {object} options.config Loaded config.
 * @param {object} [options.log]
 */
export async function buildViewer({ scenarios, config, log = { info() {} } }) {
  const manifest = await readManifest(config.outDir);
  if (!manifest) throw new Error(`${path.join(config.outDir, MANIFEST_FILE)} not found. Run \`flowshot run\` first.`);

  const labels = { ...DEFAULT_LABELS, ...(config.viewer.labels ?? {}) };
  const flows = collectFlows(scenarios);
  const extra = unassignedFlow(flows, manifest.captures, labels);
  if (extra) flows.push(extra);
  if (flows.length === 0) throw new Error("No flows to show: declare `flows` on at least one scenario.");

  const data = {
    flows,
    viewports: manifest.viewports.map((viewport) => ({
      ...viewport,
      label: config.viewer.viewportLabels?.[viewport.name] ?? viewport.name,
    })),
    captures: manifest.captures,
    labels,
    generatedAt: manifest.generatedAt,
  };

  const [css, js, template] = await Promise.all([
    readFile(path.join(HERE, "viewer.css"), "utf8"),
    readFile(path.join(HERE, "viewer.js"), "utf8"),
    readFile(path.join(HERE, "template.html"), "utf8"),
  ]);

  const viewportButtons = data.viewports
    .map((viewport, index) => `<button type="button" data-viewport="${escapeHtml(viewport.name)}" aria-pressed="${index === 0}">${escapeHtml(viewport.label)}</button>`)
    .join("");

  const html = template
    .replaceAll("{{lang}}", escapeHtml(config.viewer.lang))
    .replaceAll("{{title}}", escapeHtml(config.viewer.title))
    .replaceAll("{{subtitle}}", escapeHtml(config.viewer.subtitle))
    .replaceAll("{{generatedAt}}", escapeHtml(`${labels.generatedAt}: ${new Date(manifest.generatedAt).toLocaleString()}`))
    .replaceAll("{{viewportButtons}}", viewportButtons)
    .replaceAll("{{labels.flows}}", escapeHtml(labels.flows))
    .replaceAll("{{labels.viewportsLabel}}", escapeHtml(labels.viewportsLabel))
    .replaceAll("{{labels.diagram}}", escapeHtml(labels.diagram))
    .replaceAll("{{labels.sameFlow}}", escapeHtml(labels.sameFlow))
    .replaceAll("{{labels.openOriginal}}", escapeHtml(labels.openOriginal))
    .replace("/*{{css}}*/", css)
    .replace("/*{{data}}*/", `const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};`)
    .replace("/*{{js}}*/", js);

  const output = path.join(config.outDir, "index.html");
  await writeFile(output, html, "utf8");
  log.info(`saved ${path.relative(process.cwd(), output)} (${manifest.captures.length} captures, ${flows.length} flows)`);
  return { output, flows, missing: missingImages(flows, manifest) };
}

/** Flow nodes whose image is absent from the manifest, per viewport. */
export function missingImages(flows, manifest) {
  const present = new Set(manifest.captures.map((capture) => capture.path));
  const missing = [];
  for (const flow of flows) {
    if (flow.id === "__unassigned") continue;
    const viewports = flow.viewports || manifest.viewports.map((viewport) => viewport.name);
    for (const node of flow.nodes) {
      if (!node.image) continue;
      for (const viewport of viewports) {
        const file = `${viewport}/${node.image}`;
        if (!present.has(file)) missing.push({ flow: flow.id, node: node.id, path: file });
      }
    }
  }
  return missing;
}
