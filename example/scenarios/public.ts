import { defineScenario } from "@keyhole-koro/flowshot";

// Declarative: steps generate both the capture and the flow diagram.
export default defineScenario({
  id: "public",
  order: 1,
  title: "Public pages",
  description: "From the landing page to a confirmed sign-up, with both ways it can fail.",
  steps: [
    { id: "home", title: "Home", condition: "Landing page", goto: "/", image: "public/01_home.png" },
    { id: "pricing", title: "Pricing", condition: "Click “See pricing”", via: "See pricing",
      act: async (page) => { await page.getByRole("link", { name: "See pricing" }).click(); await page.waitForURL(/pricing/); },
      image: "public/02_pricing.png" },
    { id: "signup", title: "Sign up", condition: "Choose the Pro plan", via: "Choose Pro",
      act: async (page) => { await page.getByRole("link", { name: "Choose Pro" }).click(); await page.waitForURL(/signup/); },
      image: "signup/01_form.png" },
    { id: "taken", title: "Email taken", condition: "Submit a registered email", via: "Sign up", from: "signup",
      act: async (page) => {
        await page.getByLabel("Work email").fill("taken@example.com");
        await page.getByLabel("Password").fill("password123");
        await page.getByTestId("signup-submit").click();
      },
      waitFor: "signup-error",
      image: "signup/02_email-taken.png" },
    { id: "short", title: "Password too short", condition: "Submit a 4-character password", via: "Sign up", from: "signup",
      goto: "/signup.html?plan=pro",
      act: async (page) => {
        await page.getByLabel("Work email").fill("new@example.com");
        await page.getByLabel("Password").fill("kite");
        await page.getByTestId("signup-submit").click();
      },
      waitFor: "password-error",
      image: "signup/03_password-short.png" },
    { id: "done", title: "Check your inbox", condition: "Submit a new email and a valid password", via: "Sign up", from: "signup",
      goto: "/signup.html?plan=pro",
      act: async (page) => {
        await page.getByLabel("Work email").fill("new@example.com");
        await page.getByLabel("Password").fill("paperkite-2026");
        await page.getByTestId("signup-submit").click();
      },
      waitFor: "signup-done",
      image: "signup/04_done.png" },
    { id: "inbox", title: "Email client", condition: "Open the confirmation link", from: "done", note: "External; not captured." },
  ],
});
