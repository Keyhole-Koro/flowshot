// Regenerate the README images in docs/ from the example site.
// `npm run docs:images` (needs `npm run build` and Chromium for Playwright).
//
// Every image is made from real captures and real CLI output. The diff and
// agent images tell one story: capture the site, drop the `min-width: 0` that
// keeps the hero's share-link card inside a phone screen, re-capture, and let
// `flowshot diff` find the overflow.
import { execFile } from "node:child_process";
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { serveExample } from "../example/serve.ts";

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = path.join(ROOT, "example");
const DOCS = path.join(ROOT, "docs");

const tmp = await mkdtemp(path.join(os.tmpdir(), "flowshot-docs-"));
const site = path.join(tmp, "site");
const outDir = path.join(tmp, "out");
await cp(path.join(EXAMPLE, "site"), site, { recursive: true });
const { server, url } = await serveExample(0, site);
const env = { ...process.env, BASE_URL: url, OUT_DIR: outDir };
const flowshot = async (args: string[]) => {
  const { stdout } = await run(process.execPath, [path.join(ROOT, "bin/flowshot.js"), ...args], { cwd: EXAMPLE, env }).catch((error) => error);
  // Print paths as they would read with the default outDir.
  const relative = path.relative(EXAMPLE, outDir);
  return String(stdout).replaceAll(relative + path.sep, "output/").replaceAll(relative, "output/")
    .replaceAll(outDir + path.sep, "").replaceAll(url, "http://localhost:4173");
};
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const file = (relative: string) => pathToFileURL(path.join(outDir, relative)).href;
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const PAGE_STYLE = "margin:0;padding:16px;background:#fff;font:14px system-ui,sans-serif;color:#17162b;display:flex;gap:12px;align-items:flex-start;width:max-content";
const LABEL_STYLE = "font-family:ui-monospace,monospace;font-size:12px;color:#5d5b78";

/** Render `body` (inner HTML of a flex row) and save the row as docs/<name>. */
async function render(browser: Browser, name: string, body: string) {
  const html = path.join(tmp, `${name}.html`);
  await writeFile(html, `<!doctype html><meta charset="utf-8"><body style="${PAGE_STYLE}">${body}</body>`);
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(html).href);
  await page.locator("body").screenshot({ path: path.join(DOCS, name) });
  await page.close();
}

interface Shot { src: string; title: string; how?: string; width?: number; height?: number; top?: number; extra?: string }

/** Captures side by side, each with a title and how it was reached. */
function strip(shots: Shot[]): string {
  return shots.map(({ src, title, how, width = 300, height = 520, top = 0, extra = "" }) => `<figure style="margin:0;width:${width}px">
    <figcaption style="margin-bottom:8px"><b>${title}</b>${how ? `<br><span style="${LABEL_STYLE}">${how}</span>` : ""}</figcaption>
    <div style="position:relative;height:${height}px;overflow:hidden;border:1px solid #e4e2f0;border-radius:8px">
      <img style="display:block;width:${width}px;margin-top:-${top}px" src="${src}">${extra}</div></figure>`).join("");
}

async function viewerShot(name: string, flowTitle: string, viewport: string, select: { node?: string; grid?: boolean }, size = { width: 1280, height: 860 }) {
  const viewer = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await viewer.goto(file("index.html"));
  await viewer.locator(".flow-button", { hasText: flowTitle }).click();
  await viewer.locator(`[data-viewport=${viewport}]`).click();
  if (select.grid) await viewer.locator("[data-view=grid]").click();
  if (select.node) await viewer.locator(".node", { hasText: select.node }).click();
  await viewer.waitForTimeout(300);
  await viewer.screenshot({ path: path.join(DOCS, name) });
  await viewer.close();
}

try {
  await flowshot(["run", "--quiet"]);

  // The viewer, on two flows.
  await viewerShot("viewer.png", "Public pages", "mobile", { node: "Password too short" });
  await viewerShot("viewer-dashboard.png", "Dashboard states", "pc", { node: "Couldn’t load" });

  // One page, every state: the viewer's “All screens” grid.
  await viewerShot("states.png", "Dashboard states", "mobile", { grid: true }, { width: 1680, height: 690 });

  // Every way the sign-up form ends.
  await render(browser, "signup.png", strip([
    { src: file("mobile/signup/01_form.png"), title: "Sign up", how: "click “Choose Pro”", height: 500 },
    { src: file("mobile/signup/02_email-taken.png"), title: "Email taken", how: "taken@example.com", height: 500 },
    { src: file("mobile/signup/03_password-short.png"), title: "Password too short", how: "password “kite”", height: 500 },
    { src: file("mobile/signup/04_done.png"), title: "Check your inbox", how: "new email, valid password", height: 500 },
  ]));

  // The same pages on every viewport.
  await render(browser, "viewports.png", strip([
    { src: file("pc/public/02_pricing.png"), title: "pc", how: "1440 × 1000", width: 860, height: 430 },
    { src: file("mobile/public/02_pricing.png"), title: "mobile", how: "390 × 844", width: 240, height: 430 },
  ]));

  // Phone-only screens.
  await render(browser, "menu.png", strip([
    { src: file("mobile/mobile-nav/01_closed.png"), title: "Menu closed", how: "open / on a phone", height: 420 },
    { src: file("mobile/mobile-nav/02_open.png"), title: "Menu open", how: "tap ☰", height: 420 },
  ]));

  // Break the mobile layout and diff, as the README's opening example shows.
  const css = path.join(site, "style.css");
  await writeFile(css, (await readFile(css, "utf8")).replaceAll(" min-width: 0;", ""));
  await flowshot(["run", "--only", "public", "--viewport", "mobile", "--no-viewer", "--quiet"]);
  console.log((await flowshot(["diff", "--only", "public"])).split("\n").filter((line) => !line.startsWith("baseline")).join("\n"));

  // A recorded Claude Code session (docs/agent-session.json: prompt, tool
  // calls and replies from `claude -p --output-format stream-json`) rendered
  // as a terminal.
  const session = JSON.parse(await readFile(path.join(DOCS, "agent-session.json"), "utf8")) as { kind: string; name?: string; text: string }[];
  const inline = (text: string) => escape(text)
    .replace(/\*\*(.+?)\*\*/g, '<b style="color:#fff">$1</b>')
    .replace(/`([^`]+)`/g, '<span style="color:#f5c27a">$1</span>');
  const lines = session.map((entry) => {
    if (entry.kind === "prompt") return `<div style="color:#fff;margin-bottom:14px"><span style="color:#9d8cff">&gt;</span> ${escape(entry.text)}</div>`;
    if (entry.kind === "tool") {
      const label = entry.name === "Skill" ? `Skill(${entry.text})` : entry.name === "Read" ? `Read(${entry.text})` : `Bash(${entry.text})`;
      return `<div style="margin:6px 0"><span style="color:#5fd38d">⏺</span> <b style="color:#fff">${escape(label)}</b></div>`;
    }
    if (entry.kind === "meta") return `<div style="margin-top:14px;color:#8b88a8">${escape(entry.text)}</div>`;
    return `<div style="margin:10px 0;white-space:pre-wrap"><span style="color:#fff">⏺</span> ${inline(entry.text)}</div>`;
  });
  await render(browser, "agent.png", `<div style="width:860px;padding:20px 22px;border-radius:10px;background:#16152a;color:#d9d6f2;font:13px/1.55 ui-monospace,monospace">${lines.join("")}</div>`);

  // The diff image is flowshot's own output: the region crop `diff` wrote.
  await copyFile(path.join(outDir, ".diff/mobile/public/01_home.region-1.png"), path.join(DOCS, "diff.png"));
  console.log("wrote docs/*.png");
} finally {
  await browser.close();
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
