// Browser-side viewer, compiled by tsconfig.client.json into a plain script
// and inlined into index.html after `const DATA = …` (see build.ts).

const initialFlow = DATA.flows[0];
const initialNode = initialFlow?.nodes[0];
const initialViewport = DATA.viewports[0];
if (!initialFlow || !initialNode || !initialViewport) throw new Error("viewer: no flows or viewports");
const firstFlow: ViewerFlow = initialFlow;
const firstNode: ViewerFlowNode = initialNode;
const firstViewport = initialViewport;

type ViewMode = "diagram" | "grid" | "compare";
type ImageMode = "before" | "after" | "diff";

interface ViewerState {
  flow: string;
  viewport: string;
  node: string;
  view: ViewMode;
  image: ImageMode;
  changedOnly: boolean;
}

interface ReviewItem {
  flow: ViewerFlow;
  node: ViewerFlowNode;
  result: ViewerDiffResult;
}

function flowViewports(flow: ViewerFlow): string[] {
  return flow.viewports || DATA.viewports.map((viewport) => viewport.name);
}

function stateFromHash(): ViewerState {
  // Keep the old `#grid` link working while moving to structured hash params.
  const params = new URLSearchParams(location.hash === "#grid" ? "view=grid" : location.hash.slice(1));
  const flow = DATA.flows.find((item) => item.id === params.get("flow")) ?? firstFlow;
  const node = flow.nodes.find((item) => item.id === params.get("node")) ?? flow.nodes[0];
  const allowedViewports = flowViewports(flow);
  const requestedViewport = params.get("viewport");
  const viewport = requestedViewport && allowedViewports.includes(requestedViewport)
    ? requestedViewport
    : (allowedViewports[0] ?? firstViewport.name);
  const requestedView = params.get("view");
  const requestedImage = params.get("image");
  return {
    flow: flow.id,
    viewport,
    node: node?.id ?? firstNode.id,
    view: requestedView === "grid" || requestedView === "compare" ? requestedView : "diagram",
    image: requestedImage === "before" || requestedImage === "diff" ? requestedImage : "after",
    changedOnly: params.get("filter") === "changed",
  };
}

const state = stateFromHash();
const label = (key: string): string => DATA.labels[key] ?? key;
const captureSet = new Set(DATA.captures.map((capture) => capture.path));
const diffByPath = new Map(DATA.diffResults.map((result) => [result.path, result]));

const element = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`viewer: missing #${id}`);
  return found;
};

const currentFlow = (): ViewerFlow => DATA.flows.find((flow) => flow.id === state.flow) ?? firstFlow;
const currentNode = (): ViewerFlowNode => {
  const flow = currentFlow();
  return flow.nodes.find((node) => node.id === state.node) ?? (flow.nodes[0] as ViewerFlowNode);
};
const imagePath = (node: ViewerFlowNode, viewport = state.viewport): string | null => (node.image ? `${viewport}/${node.image}` : null);
const hasImage = (node: ViewerFlowNode, viewport = state.viewport): boolean => Boolean(node.image) && captureSet.has(imagePath(node, viewport) ?? "");
const diffFor = (node: ViewerFlowNode, viewport = state.viewport): ViewerDiffResult | undefined => diffByPath.get(imagePath(node, viewport) ?? "");
const needsReview = (result: ViewerDiffResult | undefined): boolean => Boolean(result && result.status !== "same");

function syncHash(): void {
  const params = new URLSearchParams({
    flow: state.flow,
    node: state.node,
    viewport: state.viewport,
    view: state.view,
  });
  if (state.image !== "after") params.set("image", state.image);
  if (state.changedOnly) params.set("filter", "changed");
  history.replaceState(null, "", `${location.pathname}${location.search}#${params}`);
}

function badge(text: string, kind: string): HTMLSpanElement {
  const item = document.createElement("span");
  item.className = `status-badge is-${kind}`;
  item.textContent = text;
  return item;
}

function diffLabel(result: ViewerDiffResult): string {
  if (result.status === "changed") return label("changed");
  if (result.status === "new") return label("newCapture");
  if (result.status === "error") return label("diffError");
  return result.status;
}

function appendDiffBadge(root: HTMLElement, result: ViewerDiffResult | undefined): void {
  if (result && result.status !== "same") root.append(badge(diffLabel(result), result.status));
}

function flowStatusBadges(flow: ViewerFlow): HTMLElement[] {
  const status = DATA.flowStatuses[flow.id];
  if (!status) return [];
  const badges: HTMLElement[] = [];
  if (status.changed) badges.push(badge(`${status.changed} ${label("changed")}`, "changed"));
  if (status.new) badges.push(badge(`${status.new} ${label("newCapture")}`, "new"));
  if (status.errors) badges.push(badge(`${status.errors} ${label("diffError")}`, "error"));
  if (status.missing) badges.push(badge(`${status.missing} ${label("missingCount")}`, "missing"));
  if (status.failures) badges.push(badge(`${status.failures} ${label("failedCount")}`, "failed"));
  return badges;
}

function flowNeedsReview(flow: ViewerFlow): boolean {
  const status = DATA.flowStatuses[flow.id];
  return Boolean(status && status.changed + status.new + status.errors > 0);
}

function renderHealthSummary(): void {
  const root = element("health-summary");
  const changed = DATA.diffResults.filter((result) => result.status === "changed").length;
  const added = DATA.diffResults.filter((result) => result.status === "new").length;
  const errors = DATA.diffResults.filter((result) => result.status === "error").length;
  const missing = Object.values(DATA.flowStatuses).reduce((sum, status) => sum + status.missing, 0);
  const failures = Object.values(DATA.flowStatuses).reduce((sum, status) => sum + status.failures, 0);
  const items: HTMLElement[] = [];
  if (changed) items.push(badge(`${changed} ${label("changed")}`, "changed"));
  if (added) items.push(badge(`${added} ${label("newCapture")}`, "new"));
  if (errors) items.push(badge(`${errors} ${label("diffError")}`, "error"));
  if (missing) items.push(badge(`${missing} ${label("missingCount")}`, "missing"));
  if (failures) items.push(badge(`${failures} ${label("failedCount")}`, "failed"));
  root.replaceChildren(...items);
}

function renderNavigation(): void {
  const flows = state.changedOnly ? DATA.flows.filter(flowNeedsReview) : DATA.flows;
  const buttons = flows.map((flow) => {
    const button = document.createElement("button");
    button.className = "flow-button";
    button.type = "button";
    button.setAttribute("aria-current", String(flow.id === state.flow));
    const title = document.createElement("span");
    title.className = "flow-button-title";
    title.textContent = flow.title;
    const small = document.createElement("small");
    small.textContent = label("screens").replace("{n}", String(flow.nodes.length));
    const badges = document.createElement("span");
    badges.className = "flow-button-badges";
    badges.append(...flowStatusBadges(flow));
    button.append(title, small, badges);
    button.onclick = () => {
      state.flow = flow.id;
      state.node = flow.nodes[0]?.id ?? state.node;
      const allowed = flowViewports(flow);
      if (!allowed.includes(state.viewport)) state.viewport = allowed[0] ?? state.viewport;
      commit();
    };
    return button;
  });
  document.querySelector(".flow-list")?.replaceChildren(...buttons);
}

function searchableText(flow: ViewerFlow, node: ViewerFlowNode): string {
  const paths = flowViewports(flow).map((viewport) => imagePath(node, viewport)).filter((entry): entry is string => Boolean(entry));
  const captures = DATA.captures.filter((capture) => paths.includes(capture.path));
  return [flow.title, flow.description, node.title, node.condition, node.image, ...paths, ...captures.map((capture) => capture.url)].filter(Boolean).join(" ").toLocaleLowerCase();
}

function renderSearchResults(): void {
  const input = element("search-input") as HTMLInputElement;
  const root = element("search-results");
  const flowList = document.querySelector<HTMLElement>(".flow-list");
  const query = input.value.trim().toLocaleLowerCase();
  root.hidden = !query;
  if (flowList) flowList.hidden = Boolean(query);
  if (!query) {
    root.replaceChildren();
    return;
  }
  const matches = DATA.flows.flatMap((flow) => flow.nodes.map((node) => ({ flow, node })))
    .filter(({ flow, node }) => searchableText(flow, node).includes(query))
    .filter(({ flow, node }) => !state.changedOnly || flowViewports(flow).some((viewport) => needsReview(diffFor(node, viewport))))
    .slice(0, 100);
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = label("noMatches");
    root.replaceChildren(empty);
    return;
  }
  const buttons = matches.map(({ flow, node }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    const title = document.createElement("strong");
    title.textContent = node.title;
    const context = document.createElement("small");
    context.textContent = `${flow.title}${node.image ? ` · ${node.image}` : ""}`;
    button.append(title, context);
    button.onclick = () => {
      state.flow = flow.id;
      state.node = node.id;
      const allowed = flowViewports(flow);
      const changedViewport = allowed.find((viewport) => needsReview(diffFor(node, viewport)));
      if (!allowed.includes(state.viewport) || (state.changedOnly && !needsReview(diffFor(node)))) state.viewport = changedViewport ?? allowed[0] ?? state.viewport;
      state.view = "diagram";
      input.value = "";
      commit();
      input.blur();
    };
    return button;
  });
  root.replaceChildren(...buttons);
}

function renderEdge(root: HTMLElement, positions: Map<string, { x: number; y: number }>, [from, to, edgeLabel]: [string, string, string?]): void {
  const a = positions.get(from);
  const b = positions.get(to);
  if (!a || !b) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const inset = Math.min(68, distance / 3);
  const edge = document.createElement("i");
  edge.className = "edge";
  edge.style.left = `${a.x + (dx / distance) * inset}px`;
  edge.style.top = `${a.y + (dy / distance) * inset}px`;
  edge.style.width = `${Math.max(8, distance - inset * 2)}px`;
  edge.style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI}deg)`;
  root.append(edge);
  if (edgeLabel) {
    const text = document.createElement("span");
    text.className = "edge-label";
    text.textContent = edgeLabel;
    text.style.left = `${(a.x + b.x) / 2}px`;
    text.style.top = `${(a.y + b.y) / 2}px`;
    root.append(text);
  }
}

function renderDiagram(): void {
  const flow = currentFlow();
  const root = element("diagram");
  root.style.height = `${flow.diagramHeight || 330}px`;
  root.replaceChildren();
  const bounds = root.getBoundingClientRect();
  const positions = new Map(flow.nodes.map((node) => [node.id, { x: (node.x / 100) * bounds.width, y: (node.y / 100) * bounds.height }]));
  (flow.edges || []).forEach((edge) => renderEdge(root, positions, edge));

  flow.nodes.forEach((node) => {
    const result = diffFor(node);
    const classes = ["node"];
    if (node.image && !hasImage(node)) classes.push("is-missing");
    if (result && result.status !== "same") classes.push(`is-${result.status}`);
    if (state.changedOnly && !needsReview(result)) classes.push("is-unmodified");
    const button = document.createElement("button");
    button.type = "button";
    button.className = classes.join(" ");
    button.setAttribute("aria-pressed", String(node.id === state.node));
    button.style.left = `${node.x}%`;
    button.style.top = `${node.y}%`;
    const title = document.createElement("span");
    title.className = "node-title";
    title.textContent = node.title;
    const condition = document.createElement("span");
    condition.className = "node-condition";
    condition.textContent = node.condition || "";
    button.append(title, condition);
    button.onclick = () => selectNode(node.id);
    root.append(button);
  });
}

function selectNode(id: string): void {
  state.node = id;
  renderDiagram();
  renderDetail();
  syncHash();
}

function renderMetadata(node: ViewerFlowNode, image: string | null): void {
  const capture = DATA.captures.find((entry) => entry.path === image);
  const dl = element("capture-meta");
  dl.replaceChildren();
  if (!capture) return;
  const rows: Array<[string, string]> = [
    [label("size"), `${capture.width} × ${capture.height}`],
    [label("url"), capture.url || ""],
    [label("capturedAt"), capture.capturedAt ? new Date(capture.capturedAt).toLocaleString() : ""],
    [label("scenario"), capture.scenario],
  ];
  for (const [term, value] of rows) {
    if (!value) continue;
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function renderDiffSummary(result: ViewerDiffResult | undefined): void {
  const root = element("diff-summary");
  root.replaceChildren();
  if (!result || result.status === "same") return;
  const line = document.createElement("div");
  appendDiffBadge(line, result);
  if (result.status === "changed" && result.ratio !== undefined) line.append(` ${(result.ratio * 100).toFixed(2)}%`);
  if (result.message) line.append(` ${result.message}`);
  root.append(line);
  const notes = [...(result.notes ?? [])];
  if (result.regions?.length) notes.push(`${result.regions.length} changed region${result.regions.length === 1 ? "" : "s"}`);
  if (result.omittedRegions) notes.push(`+${result.omittedRegions} smaller regions`);
  if (notes.length) {
    const list = document.createElement("ul");
    for (const note of notes) {
      const item = document.createElement("li");
      item.textContent = note;
      list.append(item);
    }
    root.append(list);
  }
}

function renderDetail(): void {
  const node = currentNode();
  const image = imagePath(node);
  const result = diffFor(node);
  const canCompare = result?.status === "changed" && Boolean(result.diffImage);
  if (!canCompare && state.image !== "after") state.image = "after";
  const imageToggle = element("image-toggle");
  imageToggle.hidden = !canCompare;
  imageToggle.querySelectorAll<HTMLButtonElement>("[data-image-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.imageMode === state.image));
  });
  let displayImage = image;
  if (image && canCompare && state.image === "before") displayImage = `.previous/${image}`;
  if (canCompare && state.image === "diff") displayImage = result.diffImage ?? image;

  const original = element("open-original") as HTMLAnchorElement;
  element("node-title").textContent = node.title;
  element("node-condition").textContent = node.condition || "";
  element("image-path").textContent = displayImage || label("noImage");
  renderDiffSummary(result);

  const preview = element("preview");
  preview.replaceChildren();
  if (displayImage && (state.image !== "after" || hasImage(node))) {
    const link = document.createElement("a");
    link.className = "preview-link";
    link.href = displayImage;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = label("openOriginal");
    const img = new Image();
    img.src = displayImage;
    img.alt = `${node.title} (${state.viewport}, ${label(state.image === "diff" ? "difference" : state.image)})`;
    link.append(img);
    preview.append(link);
    original.href = displayImage;
    original.hidden = false;
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-preview";
    empty.textContent = image ? label("missingImage").replace("{path}", image) : node.note || label("transitionOnly");
    preview.append(empty);
    original.removeAttribute("href");
    original.hidden = true;
  }
  renderMetadata(node, image);

  const gallery = element("gallery");
  const nodes = currentFlow().nodes.filter((item) => item.image).filter((item) => !state.changedOnly || needsReview(diffFor(item)));
  const thumbnails = nodes.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    const itemDiff = diffFor(item);
    button.className = itemDiff && itemDiff.status !== "same" ? `is-${itemDiff.status}` : "";
    button.setAttribute("aria-pressed", String(item.id === node.id));
    button.onclick = () => selectNode(item.id);
    const img = new Image();
    img.src = imagePath(item) ?? "";
    img.alt = "";
    const title = document.createElement("span");
    title.textContent = item.title;
    button.append(img, title);
    return button;
  });
  if (!thumbnails.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = label("noChanges");
    gallery.replaceChildren(empty);
  } else {
    gallery.replaceChildren(...thumbnails);
  }
}

function setView(view: string): void {
  state.view = view === "grid" || view === "compare" ? view : "diagram";
  commit();
}

function renderGrid(): void {
  const viewport = DATA.viewports.find((item) => item.name === state.viewport);
  const grid = element("grid-view");
  if (viewport) {
    grid.style.setProperty("--card-width", viewport.width <= 600 ? "210px" : "420px");
    grid.style.setProperty("--card-aspect", `${viewport.width} / ${viewport.height}`);
  }
  const nodes = currentFlow().nodes.filter((node) => node.image).filter((node) => !state.changedOnly || needsReview(diffFor(node)));
  const cards = nodes.map((node) => {
    const result = diffFor(node);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `card${result && result.status !== "same" ? ` is-${result.status}` : ""}`;
    card.onclick = () => {
      state.node = node.id;
      setView("diagram");
    };
    const head = document.createElement("span");
    head.className = "card-head";
    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = node.title;
    const condition = document.createElement("span");
    condition.className = "card-condition";
    condition.textContent = node.condition || "";
    head.append(title, condition);
    appendDiffBadge(head, result);
    const shot = document.createElement("span");
    shot.className = "card-shot";
    const image = imagePath(node) ?? "";
    if (hasImage(node)) {
      const img = new Image();
      img.src = image;
      img.alt = `${node.title} (${state.viewport})`;
      img.loading = "lazy";
      shot.append(img);
    } else {
      shot.classList.add("is-missing");
      shot.textContent = label("missingImage").replace("{path}", image);
    }
    card.append(head, shot);
    return card;
  });
  if (!cards.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = label("noChanges");
    grid.replaceChildren(empty);
  } else {
    grid.replaceChildren(...cards);
  }
}

function renderCompare(): void {
  const node = currentNode();
  const panels = flowViewports(currentFlow()).map((viewportName) => {
    const viewport = DATA.viewports.find((item) => item.name === viewportName);
    const result = diffFor(node, viewportName);
    const panel = document.createElement("article");
    panel.className = "compare-panel";
    const head = document.createElement("header");
    head.className = "compare-head";
    const title = document.createElement("span");
    title.textContent = viewport?.label ?? viewportName;
    head.append(title);
    appendDiffBadge(head, result);
    const shot = document.createElement("a");
    shot.className = "compare-shot";
    const image = imagePath(node, viewportName);
    if (image && hasImage(node, viewportName)) {
      shot.href = image;
      shot.target = "_blank";
      shot.rel = "noreferrer";
      const img = new Image();
      img.src = image;
      img.alt = `${node.title} (${viewport?.label ?? viewportName})`;
      shot.append(img);
    } else {
      shot.classList.add("is-missing");
      shot.textContent = image ? label("missingImage").replace("{path}", image) : node.note || label("transitionOnly");
    }
    panel.append(head, shot);
    return panel;
  });
  element("compare-view").replaceChildren(...panels);
}

function reviewQueue(): ReviewItem[] {
  const seen = new Set<string>();
  const queue: ReviewItem[] = [];
  for (const result of DATA.diffResults) {
    if (!needsReview(result) || seen.has(result.path)) continue;
    for (const flow of DATA.flows) {
      const node = flow.nodes.find((item) => imagePath(item, result.viewport) === result.path && flowViewports(flow).includes(result.viewport));
      if (!node) continue;
      queue.push({ flow, node, result });
      seen.add(result.path);
      break;
    }
  }
  return queue;
}

function selectReviewItem(item: ReviewItem): void {
  state.flow = item.flow.id;
  state.node = item.node.id;
  state.viewport = item.result.viewport;
  state.view = "diagram";
  state.image = item.result.status === "changed" && item.result.diffImage ? "diff" : "after";
}

function moveReview(delta: number): void {
  const queue = reviewQueue();
  if (!queue.length) return;
  const index = queue.findIndex((item) => item.flow.id === state.flow && item.node.id === state.node && item.result.viewport === state.viewport);
  const next = index < 0 ? (delta < 0 ? queue.length - 1 : 0) : (index + delta + queue.length) % queue.length;
  selectReviewItem(queue[next] as ReviewItem);
  commit();
}

function renderReviewBar(): void {
  const bar = element("review-bar");
  bar.hidden = DATA.diffResults.length === 0;
  if (bar.hidden) return;
  const counts = element("diff-counts");
  const items: HTMLElement[] = [];
  for (const status of ["changed", "new", "error"] as const) {
    const count = DATA.diffResults.filter((result) => result.status === status).length;
    if (count) items.push(badge(`${count} ${diffLabel({ status } as ViewerDiffResult)}`, status));
  }
  counts.replaceChildren(...items);
  const filter = element("changed-only") as HTMLButtonElement;
  filter.textContent = state.changedOnly ? label("allScreens") : label("changedOnly");
  filter.setAttribute("aria-pressed", String(state.changedOnly));
  const disabled = reviewQueue().length === 0;
  (element("previous-change") as HTMLButtonElement).disabled = disabled;
  (element("next-change") as HTMLButtonElement).disabled = disabled;
}

function render(): void {
  const flow = currentFlow();
  const allowed = flowViewports(flow);
  if (!allowed.includes(state.viewport)) state.viewport = allowed[0] ?? state.viewport;
  if (!flow.nodes.some((node) => node.id === state.node)) state.node = flow.nodes[0]?.id ?? state.node;
  element("flow-title").textContent = flow.title;
  element("flow-description").textContent = flow.description || "";
  document.querySelectorAll<HTMLButtonElement>("[data-viewport]").forEach((button) => {
    const name = button.dataset.viewport ?? "";
    button.disabled = !allowed.includes(name);
    button.setAttribute("aria-pressed", String(name === state.viewport));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  });
  element("diagram-view").hidden = state.view !== "diagram";
  element("grid-view").hidden = state.view !== "grid";
  element("compare-view").hidden = state.view !== "compare";
  renderNavigation();
  renderHealthSummary();
  renderReviewBar();
  renderSearchResults();
  if (state.view === "grid") renderGrid();
  else if (state.view === "compare") renderCompare();
  else {
    renderDiagram();
    renderDetail();
  }
}

function commit(): void {
  render();
  syncHash();
}

async function copyLink(): Promise<void> {
  const button = element("copy-link") as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = location.href;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  button.textContent = label("copied");
  window.setTimeout(() => { button.textContent = label("copyLink"); }, 1400);
}

function moveNode(delta: number): void {
  const nodes = currentFlow().nodes.filter((node) => node.image).filter((node) => !state.changedOnly || needsReview(diffFor(node)));
  if (!nodes.length) return;
  const index = nodes.findIndex((node) => node.id === state.node);
  state.node = (nodes[index < 0 ? 0 : (index + delta + nodes.length) % nodes.length] as ViewerFlowNode).id;
  state.view = "diagram";
  commit();
}

document.querySelectorAll<HTMLButtonElement>("[data-viewport]").forEach((button) => {
  button.onclick = () => {
    state.viewport = button.dataset.viewport ?? state.viewport;
    state.image = "after";
    commit();
  };
});
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
  button.onclick = () => setView(button.dataset.view ?? "diagram");
});
document.querySelectorAll<HTMLButtonElement>("[data-image-mode]").forEach((button) => {
  button.onclick = () => {
    const mode = button.dataset.imageMode;
    state.image = mode === "before" || mode === "diff" ? mode : "after";
    renderDetail();
    syncHash();
  };
});
element("changed-only").onclick = () => {
  state.changedOnly = !state.changedOnly;
  if (state.changedOnly && !needsReview(diffFor(currentNode()))) {
    const first = reviewQueue()[0];
    if (first) selectReviewItem(first);
  }
  commit();
};
element("previous-change").onclick = () => moveReview(-1);
element("next-change").onclick = () => moveReview(1);
element("copy-link").onclick = () => { void copyLink(); };
element("search-input").addEventListener("input", renderSearchResults);
window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
  if (event.key === "/" && !typing) {
    event.preventDefault();
    (element("search-input") as HTMLInputElement).focus();
  } else if (event.key === "Escape" && typing) {
    const input = element("search-input") as HTMLInputElement;
    input.value = "";
    input.blur();
    renderSearchResults();
  } else if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    moveNode(-1);
  } else if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    moveNode(1);
  } else if (!typing && event.key.toLocaleLowerCase() === "n" && DATA.diffResults.length) {
    moveReview(1);
  } else if (!typing && event.key.toLocaleLowerCase() === "p" && DATA.diffResults.length) {
    moveReview(-1);
  }
});
window.addEventListener("resize", () => {
  if (state.view === "diagram") renderDiagram();
});
window.addEventListener("hashchange", () => {
  Object.assign(state, stateFromHash());
  commit();
});
commit();
