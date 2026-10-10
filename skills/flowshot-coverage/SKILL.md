---
name: flowshot-coverage
description: Survey the app for screens and states that flowshot does not capture yet — pages, modals, error and empty states, role or plan variants — and report what is missing, ranked. Use when asked what flowshot should capture, whether the captures cover the app, before writing a batch of scenarios, or after a large feature lands.
---

# Find screens flowshot does not capture yet

The goal is a ranked list of **user-visible screens and states that no
capture shows**, each with enough detail that `flowshot-scenario` can turn it
into a scenario. This is a survey: read, compare, report. Do not write
scenarios unless asked.

## 1. Know what is already captured

```bash
npx flowshot list --json   # scenarios, viewports, capture paths
npx flowshot lint          # should be ok before you start
```

Then read the scenario files (`flowshot list` prints each one's file). For
every capture note **what it actually shows**: the path it opens (`goto`),
the actions before the shot (`act`, clicks, route mocks), and the seeded
state (which user, role, plan, data). A capture path name is a hint, not
proof — `02_error.png` may show only one of several errors.

If captures exist, look at a few with `npx flowshot inspect <path> --tile 1200`
when the code leaves it unclear what is on screen.

## 2. Enumerate the app's screens

Find how this app defines its pages; don't assume a framework. Typical
places:

- **File-based routing**: `app/` or `pages/` (Next, Nuxt, Astro),
  `src/routes/` (SvelteKit, TanStack, Remix/React Router v7), generated
  route trees (`routeTree.gen.ts`, `.svelte-kit/`, `.nuxt/`).
- **Code-based routing**: `createBrowserRouter`/`<Route>`, `vue-router`
  `routes: [...]`, Angular `Routes`, a hand-written `switch (pathname)`.
- **Server-rendered**: Express/Hono/Fastify `app.get(...)` that render HTML,
  Rails `config/routes.rb`, Django `urls.py`, Laravel `routes/web.php`.
- **Redirect-only and API routes** are not screens; skip them, but note
  where a redirect lands on a screen that has a distinct message (e.g.
  `?error=expired`).

List each route with its parameters and who can reach it (anonymous,
signed in, a role, a plan, a share link holder).

## 3. Enumerate the states inside each screen

Routes are the easy part; most gaps are states. For each screen, read the
page component and what it renders conditionally:

- **Dialogs and overlays**: modals, drawers, confirm dialogs, menus with
  meaningful content, toasts/banners that carry instructions.
- **Errors**: each distinct error message the user can see — validation,
  expired/invalid tokens, permission denied, not found, rate limits, server
  failure. Search for the app's error codes or message catalog and map each
  to the screen that shows it.
- **Empty, loading, and full**: zero items, first-run onboarding, long
  lists, very long text that may wrap or overflow.
- **Who is looking**: role, plan/billing state, owner vs. guest, verified vs.
  unverified, 2FA on/off, feature flags.
- **Multi-step flows**: each step of a wizard, upload, checkout, or
  sign-up, including the step after success.
- **Outside the browser page** if the project captures them: emails, push
  notifications, PDFs, print views.

Prefer evidence over guesses: a branch in the code, a test id, a message
string, an error code. Cite `file:line` for each state you list.

Reading every page top to bottom is slow on a large app. Narrow first:

- Start with the largest page components (`wc -l`), where most branches live.
- Grep before reading: `role="alert"`, `role="status"`, `role="dialog"`,
  `data-testid=`, `setError(`, union types of states (`type X = "a" | "b"`),
  and `switch`/ternaries on a status field. Read only around the hits.
- Find who decides a state (`deriveState`, a `status === …` chain) and read
  that once instead of every place that renders it.

Check that a state is **reachable** before listing it. A branch the server
never lets happen (a file type it rejects, a status nothing writes) is dead
code, not a missing capture — report it separately as a finding.

## 4. Compare and rank

Match each screen/state from 2–3 against the captures from 1. Classify:

- **Missing** — no capture shows it.
- **Partial** — captured on one viewport only, or for one role/variant of
  several, or only the first of several errors.
- **Skip** — deliberately not worth capturing (internal admin tools the
  project excludes, dev-only pages, pure redirects, unreachable branches).
  Say why.

Also look at what the existing captures actually show: a capture can be
"covered" but wrong (an error banner caused by fake seed data, a blank
area). List those as **Wrong** with the cause.

Rank missing items by what a reviewer would most regret not seeing:

1. Screens on the main paths (sign-up, the core task, payment) and their
   errors.
2. States that are hard to reach by hand (expired links, billing failures,
   permission edges) — these are where screenshots save the most time.
3. Restyled-only or rarely seen screens last.

## 5. Report

A table per area, then the top items:

| screen / state | reach it by | evidence | status | suggested capture |
| --- | --- | --- | --- | --- |
| Reset link expired | `/reset-password?token=<expired>` | `reset-password.tsx:42` | missing | `auth/reset/04_expired.png` in `password-reset-errors` |

For each suggestion say how to produce the state cheaply — a seed helper, a
`page.route()` mock, a query parameter — and which existing scenario it
fits, or that it needs a new one. End with the 3–5 items you would capture
first. If the project keeps a list of intentional exclusions (README,
config comment), honour it and mention items you added to it only when the
user agrees.
