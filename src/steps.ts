// Declarative scenarios: `steps` instead of a hand-written `capture()`.
//
// Each step navigates and/or acts on one shared page, optionally takes a
// screenshot, and becomes a node in an auto-generated flow. Edges come from
// `from`/`via` (default: the previous step), and positions from a simple
// layered layout unless a step gives `x`/`y`.

import type { CaptureContext, Flow, FlowEdge, Scenario, Step } from "./types.js";

// Step helpers that only read structural fields do not care about State.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStep = Step<any>;

export function validateSteps(scenarioId: string, steps: AnyStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError(`Scenario "${scenarioId}": steps must be a non-empty array`);
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step?.id) throw new TypeError(`Scenario "${scenarioId}": every step needs an id`);
    if (ids.has(step.id)) throw new TypeError(`Scenario "${scenarioId}": duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const from of ([] as string[]).concat(step.from ?? [])) {
      if (from && !ids.has(from)) throw new TypeError(`Scenario "${scenarioId}": step "${step.id}" comes from unknown step "${from}"`);
    }
  }
}

/** Build the `capture(ctx)` that walks the steps on one page. */
export function captureFromSteps<State>(scenario: Scenario<State>): (ctx: CaptureContext<State>) => Promise<void> {
  return async function capture(ctx) {
    const pageOptions = typeof scenario.page === "function" ? await scenario.page(ctx) : scenario.page ?? {};
    const page = await ctx.newPage(pageOptions);
    if (scenario.prepare) await scenario.prepare(page, ctx);
    for (const step of scenario.steps ?? []) {
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
export function edgesFromSteps(steps: AnyStep[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  steps.forEach((step, index) => {
    if (step.from === null) return;
    const previous = steps[index - 1];
    const sources = step.from === undefined ? (previous ? [previous.id] : []) : ([] as string[]).concat(step.from);
    for (const from of sources) edges.push([from, step.id, step.via ?? ""]);
  });
  return edges;
}

/**
 * Layered layout: depth = longest path from a root; nodes of one depth share
 * a column and are spread evenly down it. Returns positions in %.
 */
export function layoutSteps(steps: AnyStep[], edges: FlowEdge[]): Record<string, { x: number; y: number }> {
  const ids = steps.map((step) => step.id);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, to] of edges) incoming.get(to)?.push(from);

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: treat as root
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map(resolve)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  ids.forEach(resolve);

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)?.push(id);
  }
  const columnCount = Math.max(...columns.keys()) + 1;
  const positions: Record<string, { x: number; y: number }> = {};
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
export function flowFromSteps<State>(scenario: Scenario<State>): Flow {
  const steps: AnyStep[] = scenario.steps ?? [];
  const edges = edgesFromSteps(steps);
  const positions = layoutSteps(steps, edges);
  const columnSizes = new Map<number, number>();
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
      x: step.x ?? positions[step.id]?.x ?? 50,
      y: step.y ?? positions[step.id]?.y ?? 50,
    })),
    edges,
  };
}
