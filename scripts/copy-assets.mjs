// Copy non-TS viewer assets into dist/ after tsc.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await mkdir(path.join(root, "dist/viewer"), { recursive: true });
for (const file of ["template.html", "viewer.css"]) {
  await copyFile(path.join(root, "src/viewer", file), path.join(root, "dist/viewer", file));
}
