# flowshot

Scenario-driven screenshot capture and flow viewer for web apps — built so that
both people and LLM agents can verify UI changes at real viewport widths.

- **Scenarios** describe how to reach a screen (seed data, mock APIs, click
  through) and what to capture. One browser, one `setup` per scenario, one
  `capture` per viewport.
- **Flows** map captures onto transition diagrams so a reviewer can see *why*
  a screen appears, not just what it looks like.
- **`manifest.json`** indexes every capture (path, viewport, size, URL, time)
  so tools — including an LLM that cannot open the HTML viewer — can find,
  compare and inspect screens.
- **Viewer** is a single self-contained `index.html`: flow diagram, PC/mobile
  toggle, gallery, and missing-capture markers.

## Install

```bash
npm install --save-dev flowshot playwright
npx playwright install chromium
```

`playwright` is a peer dependency; flowshot uses whatever version your
project has.

## Quick start

`flowshot.config.mjs` in your project root:

```js
export default {
  baseUrl: "http://localhost:3000",
  outDir: "output/captures",
  scenarios: ["captures/scenarios/*.mjs"],
  viewports: [
    { name: "pc", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
  ],
};
```

`captures/scenarios/public.mjs`:

```js
import { defineScenario } from "flowshot";

export default defineScenario({
  id: "public",
  title: "Public pages",
  async capture({ newPage, goto, shoot }) {
    const page = await newPage();
    await goto(page, "/");
    await shoot(page, "public/01_home.png");
    await goto(page, "/pricing");
    await shoot(page, "public/02_pricing.png");
  },
  flows: [
    {
      id: "public",
      title: "Public pages",
      nodes: [
        { id: "home", title: "Home", condition: "Landing", image: "public/01_home.png", x: 25, y: 50 },
        { id: "pricing", title: "Pricing", condition: "Click “Pricing”", image: "public/02_pricing.png", x: 70, y: 50 },
      ],
      edges: [["home", "pricing", "Pricing"]],
    },
  ],
});
```

Then, with your app running:

```bash
npx flowshot run            # captures every scenario × viewport, writes manifest.json + index.html
npx flowshot run --only public --viewport mobile
npx flowshot list --json    # scenarios, viewports and captures as JSON
npx flowshot lint           # flow nodes without captures, captures without flows, last-run failures
npx flowshot viewer         # rebuild index.html from manifest.json only
```

Open `output/captures/index.html` in a browser.

## Scenario API

```js
defineScenario({
  id,               // [a-z0-9-], unique; used by --only and the manifest
  title, description,
  viewports,        // optional subset of config viewport names
  async setup({ config, baseUrl, log }) {},        // once per scenario → state
  async capture(ctx) {},                           // once per viewport
  async teardown({ config, baseUrl, state, log }) {},
  flows: [ { id, title, description, viewports?, diagramHeight?, nodes, edges } ],
});
```

`capture(ctx)` receives:

| helper | what it does |
| --- | --- |
| `ctx.newContext({ cookies, ...playwrightOptions })` | Browser context sized for the current viewport. `cookies: [{ name, value }]` are added for `baseUrl`. Contexts are closed for you. |
| `ctx.newPage(options)` | `newContext` + `newPage`. |
| `ctx.goto(page, "/path", options)` | `page.goto(baseUrl + path)`, `waitUntil: "networkidle"` by default. |
| `ctx.shoot(page, "dir/01_name.png", { fullPage = true })` | Saves `<outDir>/<viewport>/dir/01_name.png` and records it in the manifest. Waits for fonts and `settleMs` first. |
| `ctx.viewport`, `ctx.state`, `ctx.baseUrl`, `ctx.config`, `ctx.log`, `ctx.browser` | Plain data. |

Flow nodes reference images by the path passed to `shoot` (without the
viewport prefix); the viewer resolves the viewport at display time. A node
without `image` is a transition target (e.g. “redirect back”); give it a
`note` to explain.

## Config

| key | default | notes |
| --- | --- | --- |
| `baseUrl` | `http://localhost:3000` | env `BASE_URL` overrides |
| `outDir` | `output/captures` | env `OUT_DIR` overrides; relative to the config file |
| `scenarios` | `["flowshot/scenarios/*.mjs"]` | globs (`*`, `**`) or file paths |
| `viewports` | pc 1440×1000, mobile 390×844 | `{ name, width, height, isMobile?, hasTouch? }` |
| `settleMs` | `600` | quiet time before each screenshot |
| `beforeShoot` | `null` | `async (page, { viewport, scenario, path })` hook, e.g. wait for client-side data |
| `warmUp` | `[]` | routes to visit once before capturing (on-demand dev servers) |
| `launch` | `{ args: ["--no-sandbox"] }` | `chromium.launch()` options; env `CHROMIUM_EXECUTABLE_PATH` sets `executablePath` |
| `viewer.title`, `viewer.subtitle`, `viewer.lang` | `flowshot` / … / `en` | |
| `viewer.viewportLabels` | viewport names | `{ pc: "PC", mobile: "Mobile" }` |
| `viewer.labels` | English | every UI string in the viewer, for localisation |

## Output

```
output/captures/
  manifest.json          # { version, generatedAt, baseUrl, viewports, scenarios, failures, captures[] }
  index.html             # the viewer
  pc/<dir>/<name>.png
  mobile/<dir>/<name>.png
```

`run --only <id>` replaces only that scenario's entries in the manifest, so
partial re-captures keep the index whole. Failures do not abort the run by
default (`--fail-fast` to change); they are listed at the end, in the
manifest, and the exit code is 1.

## Working with an LLM agent

The CLI is designed to be driven by an agent verifying its own UI changes:

1. `flowshot list --json` → find the capture id for the screen you touched.
2. `flowshot run --only <scenario> --viewport mobile` → re-capture just that.
3. Read the PNG (crop tall pages), or diff against the previous capture.
4. `flowshot lint --json` → nothing missing, nothing orphaned.

Skills for Claude Code that package this loop live in `skills/` (coming).

## Roadmap

- `flowshot diff` — pixel diff against a previous run or a git ref
- `flowshot inspect` — crop / tile tall captures for image-reading agents
- Auto layout for flows declared from capture steps
- Bundled Claude Code skills: verify, scenario, triage

## License

MIT
