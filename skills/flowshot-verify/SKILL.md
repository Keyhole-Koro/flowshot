---
name: flowshot-verify
description: Verify a UI change at real viewport widths with flowshot — re-capture the affected screens, diff against the previous run, read the changed regions, and report. Use after editing CSS, layout, or page components, or when asked whether a screen looks right on PC/mobile.
---

# Verify a UI change with flowshot

flowshot captures screens per scenario × viewport into `output/captures/`
(or the `outDir` in `flowshot.config.ts (or .mjs)`) and indexes them in
`manifest.json`. You cannot open the HTML viewer; use the CLI and read PNGs.

Every command below is `npx flowshot …` run from the project root. The app
must already be running at `baseUrl` (see the project's launch skill or
README); flowshot does not start it.

## Loop

1. **Find the screens you touched.**
   `npx flowshot list --json` → `scenarios[]` (id, title, flows) and
   `captures[]` (path, scenario, viewport, url, width, height).
   Match by `url` (the route you changed) or by path keywords. Note the
   scenario ids; that is the unit you re-run.

2. **Re-capture only those.**
   `npx flowshot run --only <scenario>[,<scenario>] [--viewport mobile] --no-viewer`
   Use `--viewport` when the change is width-specific. The overwritten
   versions are kept in `.previous/` automatically.
   A non-zero exit means a scenario failed; the message names the scenario,
   viewport and last URL — see `flowshot-triage`.

3. **Diff.**
   `npx flowshot diff --only <scenario> [--json]`
   Each changed capture reports the changed-pixel ratio, a bounding `region
   x,y WxH`, a size change if any, and a highlight image under `.diff/`
   (red = changed pixels over a faded copy of the current capture).

4. **Read the change, not the whole page.**
   Captures are full-page and often thousands of pixels tall; read them in
   pieces:
   - `npx flowshot inspect <path> --crop x,y,w,h` around the reported region
     (pad by ~40px). Do this for both the current capture and its
     `.diff/<path>` twin.
   - `npx flowshot inspect <path> --tile 1200` to walk a whole page.
   Output files land in `.inspect/`; read them with your image tool.

5. **Judge.**
   - Expected change in the expected region → verified.
   - Change outside the region you meant to touch, or on a viewport you did
     not expect → investigate before reporting.
   - Dynamic content (timestamps, generated ids, seeded emails) shows up as
     small scattered diffs; ignore those, but say so.
   - Size change on a full-page capture means content grew or shrank — check
     that nothing overflows or gets clipped, especially at mobile width.

6. **Close the loop.**
   `npx flowshot lint` must print `ok` (every flow node captured, nothing
   orphaned). If you added a screen, add it to a scenario — see
   `flowshot-scenario`.

## Report

State exactly what you verified, e.g.:

> Verified `app` on pc and mobile. `mobile/admin/02_audit.png` changed in
> region 0,574 390x420 as intended (email now truncates with an ellipsis);
> other diffs are timestamps. `flowshot lint`: ok.

Do not claim a screen is fine without having read its capture (or its diff)
for the viewport in question.

## Answering "does screen X work on mobile?" without a prior change

1. `npx flowshot run --only <scenario> --viewport mobile --no-viewer`
2. `npx flowshot inspect <path> --tile 1200` for each capture of interest.
3. Look for: horizontal overflow (content cut at the right edge), overlapping
   text and icons, unreadable tables (horizontal scroll is acceptable if the
   wrapper is scrollable; text running under other elements is not), tap
   targets that collapsed to zero width.
4. Cross-check suspicious spots against the CSS: `@media (max-width: …)`
   blocks for the classes in the affected component. A common cause of text
   overflowing at small widths is `overflow: hidden; text-overflow: ellipsis`
   on an element that becomes `display: inline` under a mobile rule.

## Do not

- Do not re-run every scenario when one will do; a full run is slow.
- Do not edit source files while a capture is running — dev servers that
  restart on file changes drop requests mid-run and you get login pages.
- Do not read a 390×8000 PNG in one go; crop or tile it.
