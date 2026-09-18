// Runs scenarios: one browser, one `setup` per scenario, one `capture` per
// viewport, and a manifest at the end.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { captureId, pngSize, writeManifest } from "./manifest.mjs";

const noopLog = { info() {}, warn() {}, error() {} };

export class ScenarioError extends Error {
  constructor(scenario, viewport, cause, url) {
    const where = viewport ? `${scenario} (${viewport})` : scenario;
    const at = url ? ` at ${url}` : "";
    super(`Scenario ${where} failed${at}: ${cause?.message ?? cause}`);
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
export async function settle(page, settleMs) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

function contextOptions(viewport, extra = {}) {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: Boolean(viewport.isMobile),
    hasTouch: Boolean(viewport.hasTouch),
    ...extra,
  };
}

/**
 * Build the helper object handed to `capture()` for one scenario × viewport.
 * It tracks contexts and last navigated URLs so failures can be explained.
 */
function createCaptureContext({ browser, config, scenario, viewport, state, log, captures }) {
  const contexts = new Set();
  let lastUrl = null;

  const track = (context) => {
    contexts.add(context);
    context.on("page", (page) => page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) lastUrl = frame.url();
    }));
    return context;
  };

  const ctx = {
    browser,
    config,
    baseUrl: config.baseUrl,
    viewport,
    state,
    log,
    scenario,

    url: (pathname) => (/^https?:\/\//.test(pathname) ? pathname : `${config.baseUrl}${pathname}`),

    /**
     * New browser context sized for this viewport. `cookies` is a shorthand
     * for `addCookies` scoped to `baseUrl`.
     */
    async newContext({ cookies, ...options } = {}) {
      const context = track(await browser.newContext(contextOptions(viewport, options)));
      if (cookies?.length) {
        await context.addCookies(cookies.map((cookie) => ({ url: config.baseUrl, ...cookie })));
      }
      return context;
    },

    /** New context + page in one call. */
    async newPage(options) {
      const context = await ctx.newContext(options);
      return context.newPage();
    },

    /** `page.goto` relative to `baseUrl`, waiting for network idle by default. */
    async goto(page, pathname, options = {}) {
      return page.goto(ctx.url(pathname), { waitUntil: "networkidle", ...options });
    },

    /**
     * Screenshot to `<outDir>/<viewport>/<relativePath>` and record it in the
     * manifest. Full page by default.
     */
    async shoot(page, relativePath, { fullPage = true, settle: shouldSettle = true, ...options } = {}) {
      const relative = relativePath.replace(/^\/+/, "");
      const file = path.join(config.outDir, viewport.name, relative);
      await mkdir(path.dirname(file), { recursive: true });
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

async function warmUp(browser, config, log) {
  if (!config.warmUp?.length) return;
  log.info(`warming up ${config.warmUp.length} route(s)...`);
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const route of config.warmUp) {
    await page.goto(`${config.baseUrl}${route}`, { waitUntil: "networkidle" }).catch(() => {});
  }
  await context.close();
}

/**
 * Run scenarios and write the manifest.
 *
 * @param {object[]} scenarios Loaded scenarios (see scenario.mjs).
 * @param {object} config Loaded config (see config.mjs).
 * @param {object} [options]
 * @param {string[]} [options.only] Scenario ids to run; default all.
 * @param {string[]} [options.viewports] Viewport names to run; default all.
 * @param {boolean} [options.keepGoing=true] Continue after a scenario fails.
 * @param {object} [options.log] `{ info, warn, error }`.
 * @returns {Promise<{ manifest: object, captures: object[], failures: ScenarioError[] }>}
 */
export async function runScenarios(scenarios, config, { only, viewports, keepGoing = true, log = noopLog } = {}) {
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
  const captures = [];
  const failures = [];
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

      let state;
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
        const ctx = createCaptureContext({ browser, config, scenario, viewport, state, log, captures });
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
        await scenario.teardown({ config, baseUrl: config.baseUrl, state, log }).catch((cause) => log.warn(`  teardown failed: ${cause.message}`));
      }
    }
  } finally {
    await browser.close();
  }

  const manifest = await writeManifest(config.outDir, {
    config,
    captures,
    ranScenarios: selected.map((scenario) => scenario.id),
    failures,
  });
  return { manifest, captures, failures };
}
