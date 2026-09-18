// Globals available to client.ts inside the generated index.html.
// `DATA` is injected by build.ts (see ViewerData there).

interface ViewerFlowNode {
  id: string;
  title: string;
  condition?: string;
  image?: string;
  note?: string;
  x: number;
  y: number;
}

interface ViewerFlow {
  id: string;
  title: string;
  description?: string;
  viewports?: string[];
  diagramHeight?: number;
  nodes: ViewerFlowNode[];
  edges?: Array<[string, string, string?]>;
}

interface ViewerCapture {
  id: string;
  path: string;
  scenario: string;
  viewport: string;
  url: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
}

interface ViewerData {
  flows: ViewerFlow[];
  viewports: Array<{ name: string; width: number; height: number; label: string }>;
  captures: ViewerCapture[];
  labels: Record<string, string>;
  generatedAt: string;
}

declare const DATA: ViewerData;
