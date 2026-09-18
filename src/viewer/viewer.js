// Browser-side viewer. `DATA` is injected by build.mjs:
// { flows, viewports, captures, labels, generatedAt }
/* global DATA */

const state = {
  flow: DATA.flows[0].id,
  viewport: DATA.viewports[0].name,
  node: DATA.flows[0].nodes[0].id,
};

const captureSet = new Set(DATA.captures.map((capture) => capture.path));
const element = (id) => document.getElementById(id);
const currentFlow = () => DATA.flows.find((flow) => flow.id === state.flow);
const currentNode = () => currentFlow().nodes.find((node) => node.id === state.node);
const imagePath = (node, viewport = state.viewport) => (node.image ? `${viewport}/${node.image}` : null);
const hasImage = (node) => Boolean(node.image) && captureSet.has(imagePath(node));

function flowViewports(flow) {
  return flow.viewports || DATA.viewports.map((viewport) => viewport.name);
}

function renderNavigation() {
  const buttons = DATA.flows.map((flow) => {
    const button = document.createElement("button");
    button.className = "flow-button";
    button.type = "button";
    button.setAttribute("aria-current", String(flow.id === state.flow));
    const small = document.createElement("small");
    small.textContent = DATA.labels.screens.replace("{n}", String(flow.nodes.length));
    button.append(flow.title, small);
    button.onclick = () => {
      state.flow = flow.id;
      state.node = flow.nodes[0].id;
      if (!flowViewports(flow).includes(state.viewport)) state.viewport = flowViewports(flow)[0];
      render();
    };
    return button;
  });
  document.querySelector(".flow-list").replaceChildren(...buttons);
}

function renderEdge(root, positions, [from, to, label]) {
  const a = positions.get(from);
  const b = positions.get(to);
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
  if (label) {
    const text = document.createElement("span");
    text.className = "edge-label";
    text.textContent = label;
    text.style.left = `${(a.x + b.x) / 2}px`;
    text.style.top = `${(a.y + b.y) / 2}px`;
    root.append(text);
  }
}

function renderDiagram() {
  const flow = currentFlow();
  const root = element("diagram");
  root.style.height = `${flow.diagramHeight || 330}px`;
  root.replaceChildren();
  const bounds = root.getBoundingClientRect();
  const positions = new Map(flow.nodes.map((node) => [node.id, { x: (node.x / 100) * bounds.width, y: (node.y / 100) * bounds.height }]));

  (flow.edges || []).forEach((edge) => renderEdge(root, positions, edge));

  flow.nodes.forEach((node) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node" + (node.image && !hasImage(node) ? " is-missing" : "");
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

function selectNode(id) {
  state.node = id;
  renderDiagram();
  renderDetail();
}

function renderMetadata(node, image) {
  const capture = DATA.captures.find((entry) => entry.path === image);
  const dl = element("capture-meta");
  dl.replaceChildren();
  if (!capture) return;
  const rows = [
    [DATA.labels.size, `${capture.width} × ${capture.height}`],
    [DATA.labels.url, capture.url || ""],
    [DATA.labels.capturedAt, capture.capturedAt ? new Date(capture.capturedAt).toLocaleString() : ""],
    [DATA.labels.scenario, capture.scenario],
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

function renderDetail() {
  const node = currentNode();
  const image = imagePath(node);
  const original = element("open-original");
  element("node-title").textContent = node.title;
  element("node-condition").textContent = node.condition || "";
  element("image-path").textContent = image || DATA.labels.noImage;

  const preview = element("preview");
  preview.replaceChildren();
  if (image && hasImage(node)) {
    const link = document.createElement("a");
    link.className = "preview-link";
    link.href = image;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = DATA.labels.openOriginal;
    const img = new Image();
    img.src = image;
    img.alt = `${node.title} (${state.viewport})`;
    link.append(img);
    preview.append(link);
    original.href = image;
    original.hidden = false;
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-preview";
    empty.textContent = image ? DATA.labels.missingImage.replace("{path}", image) : node.note || DATA.labels.transitionOnly;
    preview.append(empty);
    original.removeAttribute("href");
    original.hidden = true;
  }
  renderMetadata(node, image);

  const gallery = element("gallery");
  const thumbnails = currentFlow().nodes.filter((item) => item.image).map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(item.id === node.id));
    button.onclick = () => selectNode(item.id);
    const img = new Image();
    img.src = imagePath(item);
    img.alt = "";
    const label = document.createElement("span");
    label.textContent = item.title;
    button.append(img, label);
    return button;
  });
  gallery.replaceChildren(...thumbnails);
}

function render() {
  const flow = currentFlow();
  const allowed = flowViewports(flow);
  if (!allowed.includes(state.viewport)) state.viewport = allowed[0];
  element("flow-title").textContent = flow.title;
  element("flow-description").textContent = flow.description || "";
  document.querySelectorAll("[data-viewport]").forEach((button) => {
    button.disabled = !allowed.includes(button.dataset.viewport);
    button.setAttribute("aria-pressed", String(button.dataset.viewport === state.viewport));
  });
  renderNavigation();
  renderDiagram();
  renderDetail();
}

document.querySelectorAll("[data-viewport]").forEach((button) => {
  button.onclick = () => {
    state.viewport = button.dataset.viewport;
    render();
  };
});
window.addEventListener("resize", renderDiagram);
render();
