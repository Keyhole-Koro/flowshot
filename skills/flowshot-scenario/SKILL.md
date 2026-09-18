---
name: flowshot-scenario
description: Add or change a flowshot scenario so a new screen, state, or user path is captured on every viewport and shown in the flow viewer. Use when a page, route, modal, error state, or navigation path was added or renamed, or when `flowshot lint` reports missing or unreferenced captures.
---

# Add or change a flowshot scenario

A scenario is one file under the `scenarios` glob in `flowshot.config.ts (or .mjs)`
(`npx flowshot list` prints each scenario's file). It prepares state once,
captures once per viewport, and declares the flows (transition diagrams) the
viewer shows. **Capture and flow are edited together**: a screenshot nobody
can find in a flow, or a flow node with no screenshot, both fail
`flowshot lint`.

## Choose the shape

**Linear or tree-shaped path on one page → `steps`.** flowshot generates the
`capture()` and the flow (nodes, edges, layout) from the list:

```ts
import { defineScenario } from "@keyhole-koro/flowshot";

export default defineScenario({
  id: "password-reset",
  title: "Password reset",
  description: "From the login link to the confirmation.",
  // optional: page options for the shared page, e.g. { cookies: state.cookies }
  page: ({ state }) => ({}),
  // optional: route mocks etc. on the shared page before the first step
  async prepare(page) {
    await page.route("**/api/auth/password-reset/request", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  },
  steps: [
    { id: "login", title: "Login", condition: "Forgot-password link", goto: "/login", image: "auth/reset/01_login.png" },
    { id: "request", title: "Request", condition: "Enter email", via: "Forgot password",
      act: async (page) => { await page.getByRole("link", { name: "Forgot password" }).click(); await page.waitForURL(/forgot/); },
      image: "auth/reset/02_request.png" },
    { id: "sent", title: "Email sent", via: "Submit", act: async (page) => { /* fill + submit */ }, waitFor: "reset-sent", image: "auth/reset/03_sent.png" },
    { id: "inbox", title: "Email client", from: "sent", note: "External; not captured." },
  ],
});
```

- `goto` opens a path (string, or `(state) => string`); `act(page, ctx)`
  clicks/fills; `waitFor` is a test id or `(page, ctx) => …`; `image` is the
  capture path **without** the viewport prefix. A step without `image` is a
  transition-only node — give it a `note`.
- Edges: default from the previous step; `from: "id"` / `from: ["a", "b"]`
  / `from: null` override; `via` labels the edge.
- Layout is automatic (columns by depth). Override a node with `x`/`y` (%).
- `flow: { title, description, diagramHeight, viewports }` tweaks the
  generated flow; extra hand-written `flows` can coexist.

**Several actors, contexts, or seeded users → `capture(ctx)` + `flows`.**

```ts
export default defineScenario({
  id: "sharing",
  title: "Sharing",
  async setup({ baseUrl }) {            // once per scenario; return state
    const owner = await seedUser();      // your project's helper
    return { owner };
  },
  async capture({ state, newPage, goto, shoot }) {   // once per viewport
    const page = await newPage({ cookies: state.owner.cookies });
    await goto(page, "/dashboard");
    await shoot(page, "app/workspace/01_dashboard.png");
  },
  flows: [{
    id: "sharing",
    title: "Sharing",
    nodes: [{ id: "dashboard", title: "Dashboard", condition: "After login", image: "app/workspace/01_dashboard.png", x: 25, y: 50 }],
    edges: [],
  }],
});
```

`ctx` gives `newContext`/`newPage` (sized for the viewport; `cookies`
shorthand), `goto(page, path)` (networkidle by default), `shoot(page, path,
{ fullPage })`, plus `viewport`, `state`, `baseUrl`, `config`, `log`.
Contexts are closed for you.

## Conventions

- Capture paths: `<area>/<group>/<NN>_<name>.png`, two-digit order, kebab
  case. Keep the same path when a screen is only restyled so diffs stay
  meaningful; use a new number for a genuinely new screen.
- Scenario id: `[a-z0-9-]`; `order` (number) controls run and viewer order.
- Files are `.ts` (or `.mts` when the project's `package.json` has no
  `"type": "module"`) when the project runs Node ≥ 22.18 — types are stripped
  at run time, so use `import type` for types and no `enum`/parameter
  properties; otherwise `.mjs`. Match what the project already uses.
- Prefer seeding state (DB, API) over clicking through long paths; prefer
  `page.route()` mocks for error states that are hard to provoke.
- Selectors: `getByTestId` / `getByRole` / `getByLabel`. Check the `data-testid`
  exists in the source before using it.
- PC-only screens: `viewports: ["pc"]` on the scenario, the flow, or a step.
- A screen that needs the app's own client-side data to render: rely on the
  project's `beforeShoot` hook in the config, or add a `waitFor`.

## Verify before you finish

```bash
npx flowshot run --only <id> --no-viewer   # exit 0, no FAILED lines
npx flowshot lint                          # ok
npx flowshot inspect <path> --tile 1200    # read what you captured, both viewports
```

Then mention the new capture ids and flow in your report. If the project
documents its scenarios (a README table, a policy doc that names capture
files), update that too.
