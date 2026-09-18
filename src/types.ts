// Public types. Everything a config or scenario file can reference lives here.

import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions, Page } from "playwright";

export interface Viewport {
  name: string;
  width: number;
  height: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ViewerLabels {
  flows: string;
  viewportsLabel: string;
  diagram: string;
  /** `{n}` is replaced with the node count. */
  screens: string;
  sameFlow: string;
  openOriginal: string;
  noImage: string;
  transitionOnly: string;
  /** `{path}` is replaced with the missing capture path. */
  missingImage: string;
  size: string;
  url: string;
  capturedAt: string;
  scenario: string;
  unassigned: string;
  unassignedDescription: string;
  generatedAt: string;
}

export interface ViewerConfig {
  title: string;
  subtitle: string;
  lang: string;
  viewportLabels?: Record<string, string>;
  labels?: Partial<ViewerLabels>;
}

/** What `flowshot.config.mjs` may export. Every field is optional. */
export interface UserConfig {
  baseUrl?: string;
  outDir?: string;
  /** Glob patterns (`*`, `**`) or file paths, relative to the config file. */
  scenarios?: string | string[];
  viewports?: Viewport[];
  /** Quiet time before each screenshot, in ms. */
  settleMs?: number;
  /** Runs before every screenshot, e.g. to wait for client-side data. */
  beforeShoot?: ((page: Page, info: { viewport: Viewport; scenario: string; path: string }) => Promise<void>) | null;
  /** Routes to open once, without a session, before capturing. */
  warmUp?: string[];
  /** Options for `chromium.launch()`. */
  launch?: LaunchOptions;
  viewer?: Partial<ViewerConfig>;
}

/** Resolved config: defaults applied, paths absolute. */
export interface Config extends Required<Omit<UserConfig, "viewer" | "beforeShoot" | "scenarios">> {
  scenarios: string[];
  beforeShoot: UserConfig["beforeShoot"];
  viewer: ViewerConfig;
  /** Directory of the config file (or cwd when there is none). */
  rootDir: string;
  configFile: string | null;
}

export interface FlowNode {
  id: string;
  title: string;
  condition?: string;
  /** Capture path without the viewport prefix. Omit for a transition-only node. */
  image?: string;
  /** Shown instead of a preview for a node without image. */
  note?: string;
  /** Position in percent of the diagram. */
  x: number;
  y: number;
}

/** `[from, to, label]` */
export type FlowEdge = [string, string, string?];

export interface Flow {
  id: string;
  title: string;
  description?: string;
  /** Restrict to these viewport names (default: all). */
  viewports?: string[];
  diagramHeight?: number;
  nodes: FlowNode[];
  edges?: FlowEdge[];
}

export interface ShootOptions {
  fullPage?: boolean;
  /** Skip the fonts/settle wait. */
  settle?: boolean;
  [key: string]: unknown;
}

export interface NewContextOptions extends BrowserContextOptions {
  /** Cookies added for `baseUrl`. */
  cookies?: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>;
}

/** Helpers handed to `capture()` for one scenario × viewport. */
export interface CaptureContext<State = unknown> {
  browser: Browser;
  config: Config;
  baseUrl: string;
  viewport: Viewport;
  state: State;
  log: Logger;
  scenario: Scenario<State>;
  /** Absolute URL for a path. */
  url(pathname: string): string;
  /** Browser context sized for this viewport. Closed for you. */
  newContext(options?: NewContextOptions): Promise<BrowserContext>;
  /** `newContext` + `newPage`. */
  newPage(options?: NewContextOptions): Promise<Page>;
  /** `page.goto(baseUrl + path)`, `networkidle` by default. */
  goto(page: Page, pathname: string, options?: Parameters<Page["goto"]>[1]): Promise<unknown>;
  /** Screenshot to `<outDir>/<viewport>/<relativePath>` and record it. */
  shoot(page: Page, relativePath: string, options?: ShootOptions): Promise<string>;
  /** Last main-frame URL seen in any tracked context. */
  readonly lastUrl: string | null;
}

export interface SetupContext {
  config: Config;
  baseUrl: string;
  log: Logger;
}

export interface TeardownContext<State = unknown> extends SetupContext {
  state: State;
}

export interface Step<State = unknown> {
  id: string;
  title?: string;
  condition?: string;
  /** Path to open before acting. */
  goto?: string | ((state: State, ctx: CaptureContext<State>) => string);
  gotoOptions?: Parameters<Page["goto"]>[1];
  act?: (page: Page, ctx: CaptureContext<State>) => Promise<void>;
  /** Test id to wait for, or a function. */
  waitFor?: string | ((page: Page, ctx: CaptureContext<State>) => Promise<void>);
  /** Capture path without viewport. Omit for a transition-only node. */
  image?: string;
  shoot?: ShootOptions;
  /** Predecessor id(s); default previous step; `null` for none. */
  from?: string | string[] | null;
  /** Edge label. */
  via?: string;
  viewports?: string[];
  note?: string;
  x?: number;
  y?: number;
}

export interface ScenarioDefinition<State = unknown> {
  /** `[a-z0-9-]`, unique. */
  id: string;
  title?: string;
  description?: string;
  /** Sort key for run and viewer order (default 0, then file path). */
  order?: number;
  /** Viewport names to capture (default all). */
  viewports?: string[];
  setup?: (ctx: SetupContext) => Promise<State> | State;
  capture?: (ctx: CaptureContext<State>) => Promise<void>;
  teardown?: (ctx: TeardownContext<State>) => Promise<void>;
  flows?: Flow[];
  /** Declarative alternative to `capture`. */
  steps?: Step<State>[];
  /** Options for the page that steps share. */
  page?: NewContextOptions | ((ctx: CaptureContext<State>) => NewContextOptions | Promise<NewContextOptions>);
  /** Runs on the shared page before the first step. */
  prepare?: (page: Page, ctx: CaptureContext<State>) => Promise<void>;
  /** Overrides for the flow generated from `steps`. */
  flow?: Partial<Omit<Flow, "nodes" | "edges">>;
}

export interface Scenario<State = unknown> extends ScenarioDefinition<State> {
  title: string;
  description: string;
  flows: Flow[];
  capture: (ctx: CaptureContext<State>) => Promise<void>;
  /** Set once the scenario was loaded from disk. */
  file?: string;
  readonly __flowshot: true;
}

export interface CaptureEntry {
  /** Path without viewport prefix and extension. */
  id: string;
  /** Path relative to `outDir`, forward slashes. */
  path: string;
  scenario: string;
  viewport: string;
  url: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
}

export interface ManifestFailure {
  scenario: string;
  viewport: string | null;
  message: string;
  url: string | null;
}

export interface Manifest {
  version: number;
  generatedAt: string;
  baseUrl: string;
  viewports: Array<Pick<Viewport, "name" | "width" | "height">>;
  scenarios: string[];
  failures: ManifestFailure[];
  captures: CaptureEntry[];
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type DiffStatus = "changed" | "same" | "new" | "error";

export interface DiffResult {
  path: string;
  scenario: string;
  viewport: string;
  status: DiffStatus;
  ratio?: number;
  changedPixels?: number;
  sizeChanged?: boolean;
  size?: { width: number; height: number };
  baselineSize?: { width: number; height: number };
  bounds?: { x: number; y: number; width: number; height: number } | null;
  /** Path of the highlight image relative to `outDir`. */
  diffImage?: string | null;
  message?: string;
}
