import { defineScenario } from "@keyhole-koro/flowshot";

// Signed-in screens and the states nobody reaches by clicking around:
// seed accounts through the app's API in setup(), sign in with a cookie,
// and rewrite API responses with page.route() for empty / error / loading.
interface State { pro: string; free: string }

async function createSession(baseUrl: string, plan: "pro" | "free"): Promise<string> {
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST", body: JSON.stringify({ plan }) });
  return ((await response.json()) as { token: string }).token;
}

export default defineScenario<State>({
  id: "dashboard",
  order: 2,
  title: "Dashboard states",
  description: "One page, six states: data, nearly full, empty, failed, loading, and the new-handoff dialog.",
  async setup({ baseUrl }) {
    return { pro: await createSession(baseUrl, "pro"), free: await createSession(baseUrl, "free") };
  },
  async capture({ newPage, goto, shoot, state }) {
    // Signed out: the page bounces to sign-up.
    const signedOut = await newPage();
    await goto(signedOut, "/dashboard.html");
    await signedOut.waitForURL(/signup/);

    // Signed in as the seeded Pro account.
    const pro = await newPage({ cookies: [{ name: "session", value: state.pro }] });
    await goto(pro, "/dashboard.html");
    await pro.getByTestId("handoff-list").waitFor();
    await shoot(pro, "dashboard/01_list.png");

    await pro.getByTestId("new-handoff").click();
    await shoot(pro, "dashboard/02_new-dialog.png", { fullPage: false });

    // A different seeded account: Free plan at 95% of its storage.
    const free = await newPage({ cookies: [{ name: "session", value: state.free }] });
    await goto(free, "/dashboard.html");
    await free.getByTestId("quota-banner").waitFor();
    await shoot(free, "dashboard/03_quota.png");

    // States the seed data cannot produce: answer the API ourselves.
    const empty = await newPage({ cookies: [{ name: "session", value: state.pro }] });
    await empty.route("**/api/handoffs", (route) =>
      route.fulfill({ json: { plan: "pro", usedGb: 0, limitGb: 50, handoffs: [] } }));
    await goto(empty, "/dashboard.html");
    await empty.getByTestId("empty").waitFor();
    await shoot(empty, "dashboard/04_empty.png");

    const failed = await newPage({ cookies: [{ name: "session", value: state.pro }] });
    await failed.route("**/api/handoffs", (route) => route.fulfill({ status: 500, body: "boom" }));
    await goto(failed, "/dashboard.html");
    await failed.getByTestId("load-error").waitFor();
    await shoot(failed, "dashboard/05_error.png");

    // Loading: hold the request open so the skeleton stays on screen.
    const loading = await newPage({ cookies: [{ name: "session", value: state.pro }] });
    await loading.route("**/api/handoffs", () => new Promise(() => {}));
    await goto(loading, "/dashboard.html", { waitUntil: "domcontentloaded" });
    await loading.getByTestId("loading").waitFor();
    await shoot(loading, "dashboard/06_loading.png");
  },
  flows: [
    {
      id: "dashboard",
      title: "Dashboard states",
      description: "Which state a signed-in user sees depends on their account and on the API.",
      nodes: [
        { id: "signed-out", title: "Signed out", condition: "No session cookie", note: "Redirected to sign-up.", x: 10, y: 15 },
        { id: "loading", title: "Loading", condition: "API has not answered yet", image: "dashboard/06_loading.png", x: 10, y: 60 },
        { id: "list", title: "Handoffs", condition: "Pro account with handoffs", image: "dashboard/01_list.png", x: 45, y: 15 },
        { id: "quota", title: "Storage almost full", condition: "Free account at ≥ 90% of 2 GB", image: "dashboard/03_quota.png", x: 45, y: 42 },
        { id: "empty", title: "No handoffs yet", condition: "Account has no handoffs", image: "dashboard/04_empty.png", x: 45, y: 69 },
        { id: "error", title: "Couldn’t load", condition: "API answers 500", image: "dashboard/05_error.png", x: 45, y: 92 },
        { id: "dialog", title: "New handoff", condition: "Click “+ New handoff”", image: "dashboard/02_new-dialog.png", x: 82, y: 40 },
      ],
      edges: [
        ["loading", "list", "200"],
        ["loading", "quota", "200, nearly full"],
        ["loading", "empty", "200, []"],
        ["loading", "error", "500"],
        ["list", "dialog", "+ New handoff"],
        ["empty", "dialog", "Create your first"],
      ],
    },
  ],
});
