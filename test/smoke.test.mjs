// End-to-end smoke test against the example site: run, lint, diff, inspect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { serveExample } from "../example/serve.mjs";

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin/flowshot.mjs");
const EXAMPLE = path.join(ROOT, "example");

async function flowshot(args, env) {
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
    // public: 5 images × 2 viewports; mobile-nav: 1 image × 1 viewport
    assert.equal(summary.captured, 11);
    assert.equal(summary.missing.length, 0);

    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.captures.length, 11);
    assert.ok(manifest.captures.every((capture) => capture.width > 0 && capture.height > 0));
    assert.ok(manifest.captures.some((capture) => capture.path === "mobile/signup/02_email-taken.png"));
    const html = await readFile(path.join(outDir, "index.html"), "utf8");
    assert.match(html, /Email taken/);
    assert.match(html, /flowshot demo/);

    const lint = JSON.parse((await flowshot(["lint", "--json"], env)).stdout);
    assert.equal(lint.ok, true, JSON.stringify(lint.problems));

    // Second run: everything should be unchanged.
    await flowshot(["run", "--only", "public", "--viewport", "mobile", "--no-viewer", "--quiet"], env);
    const diff = JSON.parse((await flowshot(["diff", "--json"], env)).stdout);
    assert.equal(diff.compared, 5);
    assert.equal(diff.changed, 0, JSON.stringify(diff.results.filter((r) => r.status !== "same")));

    const inspect = JSON.parse((await flowshot(["inspect", "public/01_home", "--viewport", "mobile", "--tile", "400", "--json"], env)).stdout);
    assert.equal(inspect.width, 390);
    assert.ok(inspect.pieces.length >= 2);

    const list = JSON.parse((await flowshot(["list", "--json"], env)).stdout);
    assert.deepEqual(list.scenarios.map((scenario) => scenario.id), ["public", "mobile-nav"]);
  } finally {
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
});

test("defineScenario validates steps and flows", async () => {
  const { defineScenario } = await import("../dist/index.js");
  assert.throws(() => defineScenario({ id: "Bad Id", capture() {} }), /id must match/);
  assert.throws(() => defineScenario({ id: "x" }), /capture\(\) function or steps/);
  assert.throws(() => defineScenario({ id: "x", steps: [{ id: "a" }, { id: "b", from: "zzz" }] }), /unknown step/);
  const scenario = defineScenario({ id: "ok", steps: [{ id: "a", image: "a.png" }, { id: "b", image: "b.png", via: "next" }] });
  assert.equal(scenario.flows[0].id, "ok");
  assert.deepEqual(scenario.flows[0].edges, [["a", "b", "next"]]);
  assert.ok(scenario.flows[0].nodes[0].x < scenario.flows[0].nodes[1].x);
});
