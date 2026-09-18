// Tiny static server for the example site. `node example/serve.ts [port]`.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };

export function serveExample(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
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
