// Tiny server for the example site: static pages plus a fake API with
// sessions, so scenarios can seed data and sign in. `node example/serve.ts [port]`.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };

interface Account { plan: "free" | "pro"; usedGb: number; limitGb: number; handoffs: { name: string; client: string; files: number; size: string; status: string }[] }

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

const SAMPLE_HANDOFFS: Account["handoffs"] = [
  { name: "Brand film — final cut", client: "North Studio", files: 3, size: "2.5 GB", status: "Approved" },
  { name: "Spring campaign stills", client: "Oak & Pine", files: 48, size: "1.2 GB", status: "Viewed" },
  { name: "Podcast ep. 12 stems", client: "Loud Room", files: 9, size: "740 MB", status: "Sent" },
  { name: "Raw footage from the shoot", client: "North Studio", files: 0, size: "—", status: "Waiting for upload" },
];

export function serveExample(port = 0, root = ROOT): Promise<{ server: Server; url: string }> {
  const sessions = new Map<string, Account>();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    // POST /api/sessions { plan } → { token }: what a scenario's setup() calls to seed an account.
    if (pathname === "/api/sessions" && request.method === "POST") {
      const { plan = "pro" } = await readJson(request);
      const token = randomUUID();
      sessions.set(token, plan === "free"
        ? { plan: "free", usedGb: 1.9, limitGb: 2, handoffs: SAMPLE_HANDOFFS.slice(0, 2) }
        : { plan: "pro", usedGb: 4.4, limitGb: 50, handoffs: SAMPLE_HANDOFFS });
      return sendJson(response, 201, { token });
    }
    if (pathname === "/api/handoffs") {
      const token = /(?:^|; )session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
      const account = token ? sessions.get(token) : undefined;
      return account ? sendJson(response, 200, account) : sendJson(response, 401, { error: "signed out" });
    }
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    try {
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actualPort}` });
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serveExample(Number(process.argv[2] ?? 4173));
  console.log(`example site at ${url}`);
}
