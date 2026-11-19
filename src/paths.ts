// Output path containment. Capture paths come from scenarios and the
// manifest; every file flowshot writes or deletes for them must stay inside
// the directory it belongs to.

import path from "node:path";

/**
 * Resolve `relative` against `root` and return the absolute path. Throws when
 * the result is `root` itself or lies outside it (`..` segments, absolute
 * paths).
 */
export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  const fromBase = path.relative(base, resolved);
  if (!fromBase || fromBase === ".." || fromBase.startsWith(`..${path.sep}`) || path.isAbsolute(fromBase)) {
    throw new Error(`Path ${JSON.stringify(relative)} resolves outside ${base}`);
  }
  return resolved;
}
