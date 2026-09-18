import { defineScenario } from "@keyhole-koro/flowshot";

// Declarative: steps generate both the capture and the flow diagram.
export default defineScenario({
  id: "public",
  order: 1,
  title: "Public pages",
  description: "Home to pricing to sign-up, including the error state.",
  steps: [
    { id: "home", title: "Home", condition: "Landing page", goto: "/", image: "public/01_home.png" },
    { id: "pricing", title: "Pricing", condition: "Click “See pricing”", via: "See pricing",
      act: async (page) => { await page.getByRole("link", { name: "See pricing" }).click(); await page.waitForURL(/pricing/); },
      image: "public/02_pricing.png" },
    { id: "signup", title: "Sign up", condition: "Choose a plan", via: "Choose",
      act: async (page) => { await page.getByRole("link", { name: "Choose" }).last().click(); await page.waitForURL(/signup/); },
      image: "signup/01_form.png" },
    { id: "taken", title: "Email taken", condition: "Submit a registered email", via: "Sign up", from: "signup",
      act: async (page) => {
        await page.getByLabel("Email").fill("taken@example.com");
        await page.getByLabel("Password").fill("password123");
        await page.getByTestId("signup-submit").click();
      },
      waitFor: "signup-error",
      image: "signup/02_email-taken.png" },
    { id: "done", title: "Check your inbox", condition: "Submit a new email", via: "Sign up", from: "signup",
      act: async (page) => {
        await page.getByLabel("Email").fill("new@example.com");
        await page.getByTestId("signup-submit").click();
      },
      waitFor: "signup-done",
      image: "signup/03_done.png" },
    { id: "inbox", title: "Email client", condition: "Open the confirmation link", from: "done", note: "External; not captured." },
  ],
});
