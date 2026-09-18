// Runs scenarios: one browser, one `setup` per scenario, one `capture` per
// viewport, and a manifest at the end.

import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PREVIOUS_DIR } from "./diff.js";
import { captureId, pngSize, writeManifest } from "./manifest.js";
import type { CaptureContext, CaptureEntry, Config, Logger, Manifest, NewContextOptions, Scenario, ShootOptions, Viewport } from "./types.js";

const noopLog: Logger = { info() {}, warn() {}, error() {} };

export class ScenarioError extends Error {
  scenario: string;
  viewport: string | null;
  url: string | null;
  override cause: unknown;

  constructor(scenario: string, viewport: string | null, cause: unknown, url: string | null) {
    const where = viewport ? `${scenario} (${viewport})` : scenario;
    const at = url ? ` at ${url}` : "";
    super(`Scenario ${where} failed${at}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ScenarioError";
    this.scenario = scenario;
    this.viewport = viewport;
    this.url = url;
    this.cause = cause;
  }
}

/**
 * Wait for the page to be visually stable: fonts loaded and `settleMs` of
 * quiet so transitions finish. `networkidle` is the caller's job (goto).
 */
export async function settle(page: Page, settleMs: number): Promise<void> {
  // String form: this module is compiled without the DOM lib.
  await page.evaluate("document.fonts ? document.fonts.ready : null").catch(() => {});
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

function contextOptions(viewport: Viewport, extra: Omit<NewContextOptions, "cookies"> = {}) {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: Boolean(viewport.isMobile),
    hasTouch: Boolean(viewport.hasTouch),
    ...extra,
  };
}

async function keepPrevious(config: Config, file: string, backedUp: Set<string>): Promise<void> {
  if (backedUp.has(file)) return;
  backedUp.add(file);
  try {
    await access(file);
  } catch {
    return;
  }
  const previous = path.join(config.outDir, PREVIOUS_DIR, path.relative(config.outDir, file));
  await mkdir(path.dirname(previous), { recursive: true });
  await copyFile(file, previous);
}

interface ContextInput<State> {
  browser: Browser;
  config: Config;
  scenario: Scenario<State>;
  viewport: Viewport;
  state: State;
  log: Logger;
  captures: CaptureEntry[];
  backedUp: Set<string>;
}

type TrackedContext<State> = CaptureContext<State> & { closeAll(): Promise<void> };

/**
 * Build the helper object handed to `capture()` for one scenario × viewport.
 * It tracks contexts and last navigated URLs so failures can be explained.
 */
function createCaptureContext<State>({ browser, config, scenario, viewport, state, log, captures, backedUp }: ContextInput<State>): TrackedContext<State> {
  const contexts = new Set<BrowserContext>();
  let lastUrl: string | null = null;

  const track = (context: BrowserContext) => {
    contexts.add(context);
    context.on("page", (page) =>
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) lastUrl = frame.url();
      }),
    );
    return context;
  };

  const ctx: TrackedContext<State> = {
    browser,
    config,
    baseUrl: config.baseUrl,
    viewport,
    state,
    log,
    scenario,

    url: (pathname) => (/^https?:\/\//.test(pathname) ? pathname : `${config.baseUrl}${pathname}`),

    async newContext({ cookies, ...options } = {}) {
      const context = track(await browser.newContext(contextOptions(viewport, options)));
      if (cookies?.length) {
        await context.addCookies(cookies.map((cookie) => ({ url: config.baseUrl, ...cookie })));
      }
      return context;
    },

    async newPage(options) {
      const context = await ctx.newContext(options);
      return context.newPage();
    },

    async goto(page, pathname, options = {}) {
      return page.goto(ctx.url(pathname), { waitUntil: "networkidle", ...options });
    },

    async shoot(page, relativePath, { fullPage = true, settle: shouldSettle = true, ...options }: ShootOptions = {}) {
      const relative = relativePath.replace(/^\/+/, "");
      const file = path.join(config.outDir, viewport.name, relative);
      await mkdir(path.dirname(file), { recursive: true });
      // Keep the version we are about to overwrite so `flowshot diff` can compare.
      await keepPrevious(config, file, backedUp);
      if (config.beforeShoot) await config.beforeShoot(page, { viewport, scenario: scenario.id, path: relative });
      if (shouldSettle) await settle(page, config.settleMs);
      await page.screenshot({ path: file, fullPage, ...options });
      const size = await pngSize(file);
      captures.push({
        id: captureId(relative),
        path: path.relative(config.outDir, file).split(path.sep).join("/"),
        scenario: scenario.id,
        viewport: viewport.name,
        url: page.url(),
        width: size?.width ?? null,
        height: size?.height ?? null,
        capturedAt: new Date().toISOString(),
      });
      log.info(`  saved ${path.relative(process.cwd(), file)}`);
      return file;
    },

    get lastUrl() {
      return lastUrl;
    },

    async closeAll() {
      for (const context of contexts) await context.close().catch(() => {});
      contexts.clear();
    },
  };
  return ctx;
}

async function warmUp(browser: Browser, config: Config, log: Logger): Promise<void> {
  if (!config.warmUp?.length) return;
  log.info(`warming up ${config.warmUp.length} route(s)...`);
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const route of config.warmUp) {
    await page.goto(`${config.baseUrl}${route}`, { waitUntil: "networkidle" }).catch(() => {});
  }
  await context.close();
}

export interface RunOptions {
  /** Scenario ids to run; default all. */
  only?: string[];
  /** Viewport names to run; default all. */
  viewports?: string[];
  /** Continue after a scenario fails (default true). */
  keepGoing?: boolean;
  log?: Logger;
}

export interface RunResult {
  manifest: Manifest;
  captures: CaptureEntry[];
  failures: ScenarioError[];
}

/** Run scenarios and write the manifest. */
export async function runScenarios(scenarios: Scenario[], config: Config, { only, viewports, keepGoing = true, log = noopLog }: RunOptions = {}): Promise<RunResult> {
  const selected = only?.length ? scenarios.filter((scenario) => only.includes(scenario.id)) : scenarios;
  if (only?.length) {
    const missing = only.filter((id) => !scenarios.some((scenario) => scenario.id === id));
    if (missing.length) throw new Error(`Unknown scenario id(s): ${missing.join(", ")}. Known: ${scenarios.map((s) => s.id).join(", ")}`);
  }
  const viewportFilter = viewports?.length ? viewports : null;
  if (viewportFilter) {
    const missing = viewportFilter.filter((name) => !config.viewports.some((viewport) => viewport.name === name));
    if (missing.length) throw new Error(`Unknown viewport(s): ${missing.join(", ")}. Known: ${config.viewports.map((v) => v.name).join(", ")}`);
  }

  await mkdir(config.outDir, { recursive: true });
  const captures: CaptureEntry[] = [];
  const failures: ScenarioError[] = [];
  const backedUp = new Set<string>();
  const browser = await chromium.launch(config.launch);

  try {
    await warmUp(browser, config, log);

    for (const scenario of selected) {
      log.info(`\n== ${scenario.id}: ${scenario.title} ==`);
      const scenarioViewports = config.viewports.filter(
        (viewport) => (!scenario.viewports || scenario.viewports.includes(viewport.name)) && (!viewportFilter || viewportFilter.includes(viewport.name)),
      );
      if (scenarioViewports.length === 0) {
        log.warn(`  skipped: no matching viewport`);
        continue;
      }

      let state: unknown;
      try {
        state = scenario.setup ? await scenario.setup({ config, baseUrl: config.baseUrl, log }) : undefined;
      } catch (cause) {
        const failure = new ScenarioError(scenario.id, null, cause, null);
        failures.push(failure);
        log.error(`  ${failure.message}`);
        if (!keepGoing) throw failure;
        continue;
      }

      for (const viewport of scenarioViewports) {
        log.info(`-- ${viewport.name} (${viewport.width}x${viewport.height})`);
        const ctx = createCaptureContext({ browser, config, scenario, viewport, state, log, captures, backedUp });
        try {
          await scenario.capture(ctx);
        } catch (cause) {
          const failure = new ScenarioError(scenario.id, viewport.name, cause, ctx.lastUrl);
          failures.push(failure);
          log.error(`  ${failure.message}`);
          if (!keepGoing) throw failure;
        } finally {
          await ctx.closeAll();
        }
      }

      if (scenario.teardown) {
        await scenario.teardown({ config, baseUrl: config.baseUrl, state, log }).catch((cause: unknown) => log.warn(`  teardown failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    }
  } finally {
    await browser.close();
  }

  const manifest = await writeManifest(config.outDir, {
    config,
    captures,
    ranScenarios: selected.map((scenario) => scenario.id),
    ranViewports: viewportFilter,
    failures: failures.map(({ scenario, viewport, message, url }) => ({ scenario, viewport, message, url })),
  });
  return { manifest, captures, failures };
}
