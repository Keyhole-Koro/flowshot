// End-to-end smoke test against the example site: run, lint, diff, inspect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { serveExample } from "../example/serve.ts";

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin/flowshot.js");
const EXAMPLE = path.join(ROOT, "example");

async function flowshot(args: string[], env: Record<string, string>) {
  return run(process.execPath, [CLI, ...args], { cwd: EXAMPLE, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
}

test("example project: run → lint → diff → inspect", { timeout: 180_000 }, async () => {
  const { server, url } = await serveExample();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "flowshot-"));
  const env = { BASE_URL: url, OUT_DIR: outDir };
  try {
    const first = await flowshot(["run", "--json"], env);
    const summary = JSON.parse(first.stdout);
    assert.equal(summary.failures.length, 0, JSON.stringify(summary.failures));
    // public: 6 images × 2 viewports; dashboard: 6 × 2; mobile-nav: 2 × 1
    assert.equal(summary.captured, 26);
    assert.equal(summary.missing.length, 0);

    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.captures.length, 26);
    assert.ok(manifest.captures.every((capture: { width: number; height: number }) => capture.width > 0 && capture.height > 0));
    assert.ok(manifest.captures.some((capture: { path: string }) => capture.path === "mobile/signup/02_email-taken.png"));
    assert.ok(manifest.captures.some((capture: { path: string }) => capture.path === "mobile/dashboard/05_error.png"));
    const html = await readFile(path.join(outDir, "index.html"), "utf8");
    assert.match(html, /Email taken/);
    assert.match(html, /flowshot demo/);
    assert.match(html, /data-view="grid"/);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const viewerUrl = pathToFileURL(path.join(outDir, "index.html"));
      viewerUrl.hash = "flow=dashboard&node=error&viewport=mobile&view=grid";
      await page.goto(viewerUrl.href);
      await assert.doesNotReject(page.locator("#grid-view").waitFor({ state: "visible" }));
      assert.equal(await page.locator("#flow-title").textContent(), "Dashboard states");
      assert.equal(await page.locator('[data-viewport="mobile"]').getAttribute("aria-pressed"), "true");

      await page.locator(".flow-button").filter({ hasText: "Public pages" }).click();
      assert.equal(new URL(page.url()).hash, "#flow=public&node=home&viewport=mobile&view=grid");
      await page.locator(".card").filter({ hasText: "Email taken" }).click();
      assert.equal(new URL(page.url()).hash, "#flow=public&node=taken&viewport=mobile&view=diagram");
      await page.reload();
      assert.equal(await page.locator("#node-title").textContent(), "Email taken");
      assert.equal(await page.locator("#image-path").textContent(), "mobile/signup/02_email-taken.png");
    } finally {
      await browser.close();
    }

    const lint = JSON.parse((await flowshot(["lint", "--json"], env)).stdout);
    assert.equal(lint.ok, true, JSON.stringify(lint.problems));

    // Second run: everything should be unchanged.
    await flowshot(["run", "--only", "public", "--viewport", "mobile", "--no-viewer", "--quiet"], env);
    const diff = JSON.parse((await flowshot(["diff", "--json"], env)).stdout);
    assert.equal(diff.compared, 6);
    assert.equal(diff.changed, 0, JSON.stringify(diff.results.filter((r: { status: string }) => r.status !== "same")));

    const inspect = JSON.parse((await flowshot(["inspect", "public/01_home", "--viewport", "mobile", "--tile", "400", "--json"], env)).stdout);
    assert.equal(inspect.width, 390);
    assert.ok(inspect.pieces.length >= 2);

    const list = JSON.parse((await flowshot(["list", "--json"], env)).stdout);
    assert.deepEqual(list.scenarios.map((scenario: { id: string }) => scenario.id), ["public", "dashboard", "mobile-nav"]);
  } finally {
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
});

test("defineScenario validates steps and flows", async () => {
  const { defineScenario } = await import("../dist/index.js");
  assert.throws(() => defineScenario({ id: "Bad Id", async capture() {} }), /id must match/);
  assert.throws(() => defineScenario({ id: "x" }), /capture\(\) function or steps/);
  assert.throws(() => defineScenario({ id: "x", steps: [{ id: "a" }, { id: "b", from: "zzz" }] }), /unknown step/);
  const scenario = defineScenario({ id: "ok", steps: [{ id: "a", image: "a.png" }, { id: "b", image: "b.png", via: "next" }] });
  const flow = scenario.flows[0];
  assert.ok(flow);
  assert.equal(flow.id, "ok");
  assert.deepEqual(flow.edges, [["a", "b", "next"]]);
  const [a, b] = flow.nodes;
  assert.ok(a && b && a.x < b.x);
});

test("diff splits changes into regions and describes size changes", async () => {
  const { findRegions, sizeNotes } = await import("../dist/index.js");
  const width = 200;
  const height = 300;
  const mask = new Uint8Array(width * height);
  const paint = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) mask[y * width + x] = 1;
  };
  paint(10, 10, 20, 10);   // header
  paint(15, 24, 5, 5);     // close to the header: same region
  paint(100, 200, 40, 30); // far below: its own region
  const { regions, omitted } = findRegions(mask, width, height);
  assert.equal(regions.length, 2);
  assert.equal(omitted, 0);
  assert.deepEqual(regions[0], { x: 8, y: 8, width: 24, height: 24 });
  assert.ok(regions[1] && regions[1].y >= 192 && regions[1].x <= 100);

  assert.deepEqual(sizeNotes({ width: 453, height: 1428 }, { width: 390, height: 1460 }, 390),
    ["overflows the 390px viewport by 63px (horizontal scroll)", "page is 32px shorter"]);
  assert.deepEqual(sizeNotes({ width: 390, height: 900 }, { width: 420, height: 900 }, 390),
    ["no longer overflows the 390px viewport (was 30px wider)"]);
});
