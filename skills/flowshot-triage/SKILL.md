---
name: flowshot-triage
description: Diagnose a failing or wrong flowshot capture — a scenario that errors, a screenshot that shows a login page or blank content instead of the target screen, missing captures, or an unreachable app. Use when `flowshot run` exits non-zero, `flowshot lint` reports problems, or a capture does not match the screen it should show.
---

# Triage a flowshot failure

Read the failure line first. It has the shape

```
Scenario <id> (<viewport>) failed at <last URL>: <playwright message>
```

`<last URL>` is where the page actually was, which usually tells you more
than the message. `manifest.json` → `failures[]` keeps the same information
after the run.

## By symptom

### "failed at …/login" (or the capture shows a login page)

The app dropped or never accepted the session.

1. Was the app restarted mid-run? Dev servers that watch the repo (`tsx
   watch`, nodemon, Vite server restarts) restart on *any* file change,
   including files you just edited. Wait ~10s after editing, or run
   `curl -s -o /dev/null -w '%{http_code}' <baseUrl>/<a health route>` until
   it returns 200, then re-run. Do not edit files while capturing.
2. Is the session cookie for the right origin? `cookies: [{ name, value }]`
   in `newContext`/`newPage` are scoped to `baseUrl`; a `BASE_URL` override
   with a different host will not carry them.
3. Is the seeded session valid for the server's current rules? Compare the
   project's seed helper with the server's session record type (expiry,
   `authVersion`-style counters, status fields). A schema change on the
   server side silently invalidates seeds.
4. Is the app pointed at the same database the seed wrote to? Check the
   process's emulator/DB env (`FIRESTORE_EMULATOR_HOST`, `DATABASE_URL`, …)
   versus the values the seed helper uses. Two app instances (host + Docker)
   on the same port is a classic cause: `ss -ltnp | grep :<port>`.

### "Timeout … waiting for getByTestId('…')" / getByRole / getByLabel

The element did not appear.

1. Check the capture that was written just before the failure (the run
   saves partial results) or take one manually: add a `ctx.shoot(page,
   "debug/where.png")` before the failing line, or run the step in a REPL.
2. The selector may have changed: grep the source for the test id / label
   text. Labels in another language than the source string are a common
   drift.
3. Client-side auth gates return 200 HTML and redirect after hydration —
   the page you asserted on may have navigated away. Look at `<last URL>`.
4. Increase nothing blindly; a 30s timeout that expires means the state is
   wrong, not slow.

### "page.goto: Timeout … waiting until networkidle"

Something keeps a request open: a long-poll, SSE, or a route you mocked
with a promise that never resolves (used on purpose for "loading…" states).
Pass `{ waitUntil: "domcontentloaded" }` to `ctx.goto` for that step and wait
for a specific element instead.

### Blank or header-only capture

The screenshot happened before client-side data rendered.

- Use the config's `beforeShoot` hook (e.g. wait until `document.body
  .innerText.length > N`, or until a test id appears) or a step `waitFor`.
- Dev servers that compile routes on demand paint blank on first visit:
  list the route in `warmUp` in `flowshot.config.mjs`.

### "Cannot find package 'playwright'" / browser launch fails

- flowshot uses the project's `playwright`; install it (`npm i -D playwright`)
  and the browser (`npx playwright install chromium`).
- In containers without the bundled Chromium: set `CHROMIUM_EXECUTABLE_PATH`.
- Sandboxing errors as root: the default `launch.args` already include
  `--no-sandbox`; keep it.

### Seed / setup errors ("Failed to seed …", HTTP 4xx/5xx from an emulator)

`setup()` runs before any browser context. Check that the emulator or API
it talks to is up (`curl` its root) and that the payload still matches the
current schema.

### `flowshot lint` problems

- `missing-capture` — a flow node names an image that is not in the
  manifest for some viewport. Either the scenario never shoots it (add the
  `shoot`/step), the viewport is excluded (add `viewports: ["pc"]` to the flow
  or node's scenario), or the last run failed before reaching it.
- `unreferenced-capture` — a screenshot exists that no flow shows. Add a
  node, or delete the `shoot` if the screen is obsolete.
- `last-run-failure` — see above.
- `no-manifest` — nothing has been captured yet: `npx flowshot run`.

### Diff shows everything changed

- Size changed → content height changed; scroll through with `inspect
  --tile` before judging.
- Whole page tinted → a global style (font, background, theme) changed, or
  fonts had not loaded in one of the runs (`settleMs` too low for the
  machine).
- Only text differs everywhere → locale/date/timestamp content; compare
  layout, not pixels.

## When you are stuck

Reproduce the single step outside the runner with a throwaway script that
imports `playwright` directly, logs every `/api/` response status, and
prints `context.cookies()` before each navigation. Most "mysterious" failures
are a 5xx from a restarting server or a cookie that was never sent.
