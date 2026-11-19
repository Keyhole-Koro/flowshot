// Fast unit tests that need no browser. They run against the built package
// (`npm run build` first), like the smoke test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildViewer,
  comparePixels,
  crop,
  defineScenario,
  diffCaptures,
  edgesFromSteps,
  layoutSteps,
  loadConfig,
  missingImages,
  readManifest,
  readPng,
  tile,
  writeManifest,
  writePng,
} from "../dist/index.js";
import type { CaptureEntry, Config, Manifest, RgbaImage } from "../dist/index.js";
import { parseConcurrency } from "../dist/config.js";
import { resolveInside } from "../dist/paths.js";
import { cookiesFor } from "../dist/runner.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin/flowshot.js");

/** Run the CLI in `cwd`; resolves with the exit code instead of rejecting. */
async function flowshot(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, BASE_URL: "", OUT_DIR: "", ...env }, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (failed.killed) throw new Error(`flowshot ${args.join(" ")} timed out`);
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function tempDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flowshot-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Solid image, optionally with one differing pixel. */
function solid(width: number, height: number, rgba: [number, number, number, number] = [255, 255, 255, 255]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

/** Image whose red channel encodes the row, so crops can be checked. */
function rows(width: number, height: number): RgbaImage {
  const image = solid(width, height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) image.data[(y * width + x) * 4] = y % 256;
  return image;
}

function capture(pathname: string, scenario = "s"): CaptureEntry {
  const [viewport = "", ...rest] = pathname.split("/");
  return { id: rest.join("/").replace(/\.png$/, ""), path: pathname, scenario, viewport, url: "http://x/", width: 1, height: 1, capturedAt: "2026-01-01T00:00:00.000Z" };
}

/** Run `fn` with environment variables set (or removed with `undefined`), then restore them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

const NO_ENV = { BASE_URL: undefined, OUT_DIR: undefined, CHROMIUM_EXECUTABLE_PATH: undefined };

test("parseConcurrency accepts auto and 1..32 only", () => {
  assert.equal(parseConcurrency("auto"), "auto");
  assert.equal(parseConcurrency("4"), 4);
  assert.equal(parseConcurrency(32), 32);
  for (const bad of ["0", "33", "1.5", "-1", "x", "", 0, 2.5, null, undefined]) {
    assert.throws(() => parseConcurrency(bad), /concurrency must be/, String(bad));
  }
});

test("loadConfig: defaults, file merge, env overrides and path resolution", async (t) => {
  const dir = await tempDir(t);
  const defaults = await withEnv(NO_ENV, () => loadConfig({ cwd: dir }));
  assert.equal(defaults.configFile, null);
  assert.equal(defaults.rootDir, dir);
  assert.equal(defaults.baseUrl, "http://localhost:3000");
  assert.equal(defaults.outDir, path.join(dir, "output/captures"));
  assert.equal(defaults.concurrency, "auto");
  assert.deepEqual(defaults.launch.args, ["--no-sandbox"]);

  await writeFile(path.join(dir, "flowshot.config.mjs"), `export default {
    baseUrl: "http://example.test:8080///",
    outDir: "shots",
    scenarios: "s/*.mjs",
    concurrency: "3",
    launch: { headless: true },
    viewer: { title: "T" },
  };\n`);
  const fromFile = await withEnv(NO_ENV, () => loadConfig({ cwd: dir }));
  assert.equal(fromFile.configFile, path.join(dir, "flowshot.config.mjs"));
  assert.equal(fromFile.baseUrl, "http://example.test:8080");
  assert.equal(fromFile.outDir, path.join(dir, "shots"));
  assert.deepEqual(fromFile.scenarios, ["s/*.mjs"]);
  assert.equal(fromFile.concurrency, 3);
  // Nested objects merge with the defaults instead of replacing them.
  assert.deepEqual(fromFile.launch, { args: ["--no-sandbox"], headless: true });
  assert.deepEqual(fromFile.viewer, { title: "T", subtitle: "Screen capture viewer", lang: "en" });

  const overridden = await withEnv({ BASE_URL: "http://ci.test/", OUT_DIR: "elsewhere", CHROMIUM_EXECUTABLE_PATH: "/opt/chrome" }, () => loadConfig({ cwd: dir }));
  assert.equal(overridden.baseUrl, "http://ci.test");
  assert.equal(overridden.outDir, path.join(dir, "elsewhere"));
  assert.equal(overridden.launch.executablePath, "/opt/chrome");

  await assert.rejects(loadConfig({ cwd: dir, configPath: "missing.mjs" }), /Config file not found/);
  await writeFile(path.join(dir, "bad.mjs"), `export default { concurrency: 0 };\n`);
  await assert.rejects(withEnv(NO_ENV, () => loadConfig({ cwd: dir, configPath: "bad.mjs" })), /concurrency must be/);
});

test("writePng and readPng round-trip RGBA pixels", async (t) => {
  const dir = await tempDir(t);
  const image = rows(7, 300);
  image.data[3] = 10; // a translucent pixel survives too
  const file = path.join(dir, "a.png");
  await writePng(file, image);
  const back = await readPng(file);
  assert.equal(back.width, 7);
  assert.equal(back.height, 300);
  assert.deepEqual(back.data, image.data);
  await writeFile(path.join(dir, "not.png"), "hello");
  await assert.rejects(readPng(path.join(dir, "not.png")), /not a PNG/);
});

test("crop clamps the rectangle to the image", () => {
  const image = rows(10, 10);
  const inside = crop(image, 2, 3, 4, 5);
  assert.equal(inside.width, 4);
  assert.equal(inside.height, 5);
  assert.equal(inside.data[0], 3);
  const clamped = crop(image, 8, 8, 10, 10);
  assert.deepEqual([clamped.width, clamped.height], [2, 2]);
  const negative = crop(image, -5, -5, 3, 3);
  assert.deepEqual([negative.width, negative.height], [3, 3]);
  assert.equal(negative.data[0], 0);
  const outside = crop(image, 20, 20, 5, 5);
  assert.deepEqual([outside.width, outside.height, outside.data.length], [0, 0, 0]);
});

test("comparePixels: same, changed within tolerance, and size change", () => {
  const a = solid(10, 10);
  const same = comparePixels(a, solid(10, 10));
  assert.equal(same.changedPixels, 0);
  assert.equal(same.ratio, 0);
  assert.equal(same.sizeChanged, false);

  const b = solid(10, 10);
  b.data[0] = 255 - 10; // within the default tolerance of 16
  b.data[(5 * 10 + 5) * 4 + 1] = 0; // clearly different
  const changed = comparePixels(a, b);
  assert.equal(changed.changedPixels, 1);
  assert.equal(changed.ratio, 0.01);
  assert.equal(changed.mask[5 * 10 + 5], 1);
  assert.equal(comparePixels(a, b, { tolerance: 5 }).changedPixels, 2);

  const taller = comparePixels(solid(10, 12), a);
  assert.equal(taller.sizeChanged, true);
  assert.equal(taller.changedPixels, 20);
  assert.deepEqual(taller.overlap, { width: 10, height: 10 });
  assert.deepEqual([taller.image.width, taller.image.height], [10, 12]);
});

test("tile splits tall images with overlap and keeps short ones whole", () => {
  const short = rows(4, 100);
  assert.deepEqual(tile(short, { tileHeight: 100 }).map((part) => part.y), [0]);
  const tall = rows(4, 250);
  const parts = tile(tall, { tileHeight: 100, overlap: 20 });
  assert.deepEqual(parts.map((part) => part.y), [0, 80, 160]);
  assert.deepEqual(parts.map((part) => part.image.height), [100, 100, 90]);
  assert.equal(parts[1]?.image.data[0], 80);
  assert.deepEqual(tile(rows(4, 2500)).map((part) => part.y), [0, 1160, 2320]);
});

test("writeManifest carries over captures outside this run's selection", async (t) => {
  const dir = await tempDir(t);
  const config = await withEnv(NO_ENV, () => loadConfig({ cwd: dir }));
  await writeManifest(dir, {
    config,
    captures: [capture("pc/a/1.png", "a"), capture("mobile/a/1.png", "a"), capture("pc/b/1.png", "b")],
    ranScenarios: ["a", "b"],
    failures: [{ scenario: "b", viewport: "pc", message: "boom", url: null }],
  });
  const second = await writeManifest(dir, {
    config,
    captures: [capture("mobile/a/2.png", "a")],
    ranScenarios: ["a"],
    ranViewports: ["mobile"],
    failures: [],
  });
  assert.deepEqual(second.captures.map((entry) => entry.path), ["mobile/a/2.png", "pc/a/1.png", "pc/b/1.png"]);
  assert.deepEqual(second.scenarios, ["a", "b"]);
  assert.deepEqual(second.failures, []);
  assert.deepEqual(second.viewports.map((viewport) => viewport.name), ["pc", "mobile"]);
  assert.deepEqual(await readManifest(dir), second);
  assert.equal(await readManifest(path.join(dir, "none")), null);
});

test("missingImages reports flow nodes without a capture per viewport", () => {
  const manifest: Manifest = {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    baseUrl: "http://x",
    viewports: [{ name: "pc", width: 1, height: 1 }, { name: "mobile", width: 1, height: 1 }],
    scenarios: ["s"],
    failures: [],
    captures: [capture("pc/a.png"), capture("mobile/a.png"), capture("pc/b.png")],
  };
  const missing = missingImages([
    { id: "f", title: "F", nodes: [{ id: "a", title: "A", image: "a.png", x: 0, y: 0 }, { id: "b", title: "B", image: "b.png", x: 0, y: 0 }, { id: "t", title: "T", x: 0, y: 0 }] },
    { id: "only-pc", title: "P", viewports: ["pc"], nodes: [{ id: "c", title: "C", image: "c.png", x: 0, y: 0 }] },
    { id: "__unassigned", title: "U", nodes: [{ id: "z", title: "Z", image: "z.png", x: 0, y: 0 }] },
  ], manifest);
  assert.deepEqual(missing, [
    { flow: "f", node: "b", path: "mobile/b.png" },
    { flow: "only-pc", node: "c", path: "pc/c.png" },
  ]);
});

test("edgesFromSteps and layoutSteps", () => {
  const steps = [{ id: "a" }, { id: "b", via: "next" }, { id: "c", from: "a" }, { id: "d", from: ["b", "c"] }, { id: "e", from: null }];
  const edges = edgesFromSteps(steps);
  assert.deepEqual(edges, [["a", "b", "next"], ["a", "c", ""], ["b", "d", ""], ["c", "d", ""]]);
  const positions = layoutSteps(steps, edges);
  // Columns by depth: {a, e}, {b, c}, {d}.
  assert.deepEqual(positions, {
    a: { x: 16.7, y: 25 },
    e: { x: 16.7, y: 75 },
    b: { x: 50, y: 25 },
    c: { x: 50, y: 75 },
    d: { x: 83.3, y: 50 },
  });
  // A cycle does not hang.
  assert.ok(layoutSteps([{ id: "x" }, { id: "y" }], [["x", "y"], ["y", "x"]]));
});

async function viewerFixture(dir: string, viewer: Partial<Config["viewer"]>, flowTitle = "Flow"): Promise<string> {
  const base = await withEnv(NO_ENV, () => loadConfig({ cwd: dir }));
  const config: Config = { ...base, outDir: dir, viewer: { ...base.viewer, ...viewer } };
  await writeManifest(dir, { config, captures: [capture("pc/s/1.png"), capture("mobile/s/1.png")], ranScenarios: ["s"], failures: [] });
  const scenario = defineScenario({ id: "s", title: flowTitle, steps: [{ id: "one", title: flowTitle, image: "s/1.png" }] });
  const { output } = await buildViewer({ scenarios: [scenario], config });
  return readFile(output, "utf8");
}

test("buildViewer escapes config text and keeps DATA inside its script", async (t) => {
  const dir = await tempDir(t);
  const evil = `<script>alert("x")</script>'`;
  const html = await viewerFixture(dir, {
    title: evil,
    subtitle: `"><img src=x onerror=alert(1)>`,
    lang: `en"><script>alert(2)</script>`,
    viewportLabels: { pc: `<b>PC</b>` },
    labels: { flows: `</nav><script>alert(3)</script>`, before: `"onmouseover="alert(4)` },
  }, `</script><script>alert(5)</script>`);

  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>PC<\/b>/);
  assert.match(html, /<title>&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&#39; — &quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/title>/);
  assert.match(html, /<html lang="en&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;">/);
  assert.match(html, /data-viewport="pc" aria-pressed="true">&lt;b&gt;PC&lt;\/b&gt;<\/button>/);
  assert.ok(!html.includes(`"onmouseover="`));
  // `<` inside DATA is escaped, so a flow title cannot close the script element.
  assert.match(html, /\\u003c\/script>\\u003cscript>alert\(5\)/);
  assert.equal(html.match(/<\/script>/g)?.length, html.match(/<script>/g)?.length);
});

const fileExists = (file: string) => access(file).then(() => true, () => false);

test("resolveInside keeps paths inside the root", () => {
  const root = path.join(os.tmpdir(), "flowshot-root");
  assert.equal(resolveInside(root, "a/b.png"), path.join(root, "a/b.png"));
  assert.equal(resolveInside(root, "pc/../mobile/x.png"), path.join(root, "mobile/x.png"));
  assert.equal(resolveInside(root, "..x/y.png"), path.join(root, "..x/y.png"));
  for (const bad of ["../x.png", "pc/../../x", "/abs/x.png", "", ".", "pc/.."]) {
    assert.throws(() => resolveInside(root, bad), /resolves outside/, bad);
  }
});

test("diffCaptures refuses capture paths that leave outDir", async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, "w/out");
  const baselineDir = path.join(dir, "b1/b2");
  // Two different images where `../../x.png` points from outDir and baselineDir.
  await mkdir(path.join(dir, "b1"), { recursive: true });
  await writePng(path.join(dir, "x.png"), solid(4, 4, [0, 0, 0, 255]));
  await writePng(path.join(dir, "b1/x.png"), solid(4, 4));
  // An old region image next to where the escaping diff would be written.
  await mkdir(path.join(dir, "w"), { recursive: true });
  await writeFile(path.join(dir, "w/x.region-1.png"), "keep");
  // A normal capture still diffs as before.
  await mkdir(path.join(outDir, "pc"), { recursive: true });
  await mkdir(path.join(baselineDir, "pc"), { recursive: true });
  await writePng(path.join(outDir, "pc/a.png"), solid(4, 4, [0, 0, 0, 255]));
  await writePng(path.join(baselineDir, "pc/a.png"), solid(4, 4));

  const results = await diffCaptures({ outDir, baselineDir, captures: [capture("pc/../../x.png"), { ...capture("pc/a.png"), path: "../../x.png" }, capture("pc/a.png")] });
  assert.deepEqual(results.map((result) => result.status), ["error", "error", "changed"]);
  assert.match(results[1]?.message ?? "", /resolves outside/);
  assert.equal(await fileExists(path.join(dir, "w/x.png")), false);
  assert.equal(await readFile(path.join(dir, "w/x.region-1.png"), "utf8"), "keep");
  assert.equal(results[2]?.diffImage, ".diff/pc/a.png");
  assert.equal(await fileExists(path.join(outDir, ".diff/pc/a.png")), true);
});

test("tile rejects heights that would not advance", () => {
  const image = rows(4, 250);
  for (const tileHeight of [30, 40, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => tile(image, { tileHeight }), RangeError, String(tileHeight));
  }
  assert.throws(() => tile(image, { tileHeight: 100, overlap: -1 }), RangeError);
  assert.throws(() => tile(image, { tileHeight: 100, overlap: Number.NaN }), RangeError);
  assert.equal(tile(image, { tileHeight: 41 }).length, 210);
  assert.equal(tile(image, { tileHeight: 10, overlap: 0 }).length, 25);
});

test("CLI rejects invalid --tile, --crop and --threshold values", async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, "out");
  await mkdir(path.join(outDir, "pc"), { recursive: true });
  await writePng(path.join(outDir, "pc/x.png"), rows(4, 250));
  const env = { OUT_DIR: outDir };

  for (const value of ["0", "30", "40", "abc", "1e3", "-100"]) {
    const result = await flowshot(dir, ["inspect", "x", `--tile=${value}`], env);
    assert.notEqual(result.code, 0, `--tile ${value}`);
    assert.match(result.stderr, /--tile expects an integer height greater than 40/, `--tile ${value}`);
  }
  for (const value of ["1,2,3", "a,b,c,d", "0,0,0,10", "0,0,10,-1", "0,0,1.5,2", "0,0,1,2,3"]) {
    const result = await flowshot(dir, ["inspect", "x", `--crop=${value}`], env);
    assert.notEqual(result.code, 0, `--crop ${value}`);
    assert.match(result.stderr, /--crop expects x,y,w,h/, `--crop ${value}`);
  }
  for (const value of ["abc", "-0.1", "2", "NaN", " "]) {
    const result = await flowshot(dir, ["diff", `--threshold=${value}`], env);
    assert.notEqual(result.code, 0, `--threshold ${value}`);
    assert.match(result.stderr, /--threshold expects a number from 0 to 1/, `--threshold ${value}`);
  }

  // Valid values behave as before.
  const tiled = await flowshot(dir, ["inspect", "x", "--tile", "100", "--json"], env);
  assert.equal(tiled.code, 0, tiled.stderr);
  assert.deepEqual(JSON.parse(tiled.stdout).pieces.map((piece: { y: number }) => piece.y), [0, 60, 120, 180]);
  const cropped = await flowshot(dir, ["inspect", "pc/x", "--crop=-2,10,3,500", "--tile", "abc", "--json"], env);
  assert.equal(cropped.code, 0, cropped.stderr);
  assert.deepEqual(JSON.parse(cropped.stdout).pieces.map(({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => [x, y, width, height]), [[-2, 10, 3, 240]]);
  const diffed = await flowshot(dir, ["diff", "--threshold", "0.5"], env);
  assert.match(diffed.stderr, /no manifest\.json/);
});

test("cookiesFor scopes cookies to baseUrl without clashing with domain/path", () => {
  const base = "http://app.test:3000/sub";
  assert.deepEqual(cookiesFor(base, [{ name: "a", value: "1" }]), [{ url: base, name: "a", value: "1" }]);
  assert.deepEqual(cookiesFor(base, [{ name: "b", value: "2", domain: ".other.test", path: "/x" }]), [{ name: "b", value: "2", domain: ".other.test", path: "/x" }]);
  assert.deepEqual(cookiesFor(base, [{ name: "c", value: "3", domain: "app.test" }]), [{ name: "c", value: "3", domain: "app.test", path: "/" }]);
  assert.deepEqual(cookiesFor(base, [{ name: "d", value: "4", path: "/admin" }]), [{ name: "d", value: "4", path: "/admin", domain: "app.test" }]);
  assert.deepEqual(cookiesFor(base, [{ name: "e", value: "5", url: "https://x.test/" }]), [{ name: "e", value: "5", url: "https://x.test/" }]);
  // Every result is either url-only or a domain/path pair, as Playwright requires.
  const mixed: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }> = [{ name: "a", value: "1" }, { name: "c", value: "3", domain: "app.test" }, { name: "d", value: "4", path: "/p" }];
  for (const cookie of cookiesFor(base, mixed)) {
    assert.ok(cookie.url ? !cookie.domain && !cookie.path : Boolean(cookie.domain && cookie.path), JSON.stringify(cookie));
  }
});
