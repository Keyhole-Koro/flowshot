// Declarative scenarios: `steps` instead of a hand-written `capture()`.
//
// Each step navigates and/or acts on one shared page, optionally takes a
// screenshot, and becomes a node in an auto-generated flow. Edges come from
// `from`/`via` (default: the previous step), and positions from a simple
// layered layout unless a step gives `x`/`y`.

/**
 * @typedef {object} Step
 * @property {string} id
 * @property {string} [title] Node title (default id).
 * @property {string} [condition] Shown under the title: how to reach this screen.
 * @property {string|((state: unknown) => string)} [goto] Path to open before acting.
 * @property {object} [gotoOptions] Passed to `page.goto`.
 * @property {(page: import("playwright").Page, ctx: object) => Promise<void>} [act]
 * @property {string|((page, ctx) => Promise<void>)} [waitFor] test id to wait for, or a function.
 * @property {string} [image] Capture path (without viewport). Omit for a transition-only node.
 * @property {object} [shoot] Options for `ctx.shoot`.
 * @property {string|string[]|null} [from] Predecessor id(s). Default previous step; `null` for none.
 * @property {string} [via] Edge label.
 * @property {string[]} [viewports] Only run for these viewports.
 * @property {string} [note] Explanation for a node without image.
 * @property {number} [x] @property {number} [y] Manual position (%).
 */

export function validateSteps(scenarioId, steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError(`Scenario "${scenarioId}": steps must be a non-empty array`);
  const ids = new Set();
  for (const step of steps) {
    if (!step?.id) throw new TypeError(`Scenario "${scenarioId}": every step needs an id`);
    if (ids.has(step.id)) throw new TypeError(`Scenario "${scenarioId}": duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const from of [].concat(step.from ?? [])) {
      if (from && !ids.has(from)) throw new TypeError(`Scenario "${scenarioId}": step "${step.id}" comes from unknown step "${from}"`);
    }
  }
}

/** Build the `capture(ctx)` that walks the steps on one page. */
export function captureFromSteps(scenario) {
  return async function capture(ctx) {
    const pageOptions = typeof scenario.page === "function" ? await scenario.page(ctx) : scenario.page ?? {};
    const page = await ctx.newPage(pageOptions);
    if (scenario.prepare) await scenario.prepare(page, ctx);
    for (const step of scenario.steps) {
      if (step.viewports && !step.viewports.includes(ctx.viewport.name)) continue;
      ctx.log.info(`  step ${step.id}`);
      if (step.goto) {
        const target = typeof step.goto === "function" ? step.goto(ctx.state, ctx) : step.goto;
        await ctx.goto(page, target, step.gotoOptions);
      }
      if (step.act) await step.act(page, ctx);
      if (typeof step.waitFor === "string") await page.getByTestId(step.waitFor).waitFor();
      else if (typeof step.waitFor === "function") await step.waitFor(page, ctx);
      if (step.image) await ctx.shoot(page, step.image, step.shoot);
    }
  };
}

/** Edges as `[from, to, label]` from `from`/`via`, defaulting to a chain. */
export function edgesFromSteps(steps) {
  const edges = [];
  steps.forEach((step, index) => {
    if (step.from === null) return;
    const sources = step.from === undefined ? (index > 0 ? [steps[index - 1].id] : []) : [].concat(step.from);
    for (const from of sources) edges.push([from, step.id, step.via ?? ""]);
  });
  return edges;
}

/**
 * Layered layout: depth = longest path from a root; nodes of one depth share
 * a column and are spread evenly down it. Returns `{ id: { x, y } }` in %.
 */
export function layoutSteps(steps, edges) {
  const ids = steps.map((step) => step.id);
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const [from, to] of edges) incoming.get(to).push(from);

  const depth = new Map();
  const visiting = new Set();
  const resolve = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0; // cycle: treat as root
    visiting.add(id);
    const parents = incoming.get(id);
    const value = parents.length ? Math.max(...parents.map(resolve)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  ids.forEach(resolve);

  const columns = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(id);
  }
  const columnCount = Math.max(...columns.keys()) + 1;
  const positions = {};
  for (const [d, members] of columns) {
    members.forEach((id, index) => {
      positions[id] = {
        x: Math.round(((d + 0.5) / columnCount) * 1000) / 10,
        y: Math.round(((index + 0.5) / members.length) * 1000) / 10,
      };
    });
  }
  return positions;
}

/** The flow generated from `steps` (id = scenario id unless `flow.id` given). */
export function flowFromSteps(scenario) {
  const steps = scenario.steps;
  const edges = edgesFromSteps(steps);
  const positions = layoutSteps(steps, edges);
  const columnSizes = new Map();
  for (const { x } of Object.values(positions)) columnSizes.set(x, (columnSizes.get(x) ?? 0) + 1);
  const rows = Math.max(1, ...columnSizes.values());
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    diagramHeight: Math.max(330, rows * 90 + 60),
    ...(scenario.flow ?? {}),
    nodes: steps.map((step) => ({
      id: step.id,
      title: step.title ?? step.id,
      condition: step.condition ?? "",
      image: step.image,
      note: step.note,
      x: step.x ?? positions[step.id].x,
      y: step.y ?? positions[step.id].y,
    })),
    edges,
  };
}
