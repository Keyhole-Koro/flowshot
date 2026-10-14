import { defineScenario } from "@keyhole-koro/flowshot";

// Imperative: hand-written capture() with an explicit flow, one viewport only.
export default defineScenario({
  id: "mobile-nav",
  order: 3,
  title: "Mobile navigation",
  viewports: ["mobile"],
  async capture({ newPage, goto, shoot }) {
    const page = await newPage();
    await goto(page, "/");
    await shoot(page, "mobile-nav/01_closed.png", { fullPage: false });
    await page.getByRole("button", { name: "Menu" }).click();
    await shoot(page, "mobile-nav/02_open.png", { fullPage: false });
  },
  flows: [
    {
      id: "mobile-nav",
      title: "Mobile navigation",
      description: "The header collapses into a menu button on a phone.",
      viewports: ["mobile"],
      nodes: [
        { id: "closed", title: "Menu closed", condition: "Open / on a phone", image: "mobile-nav/01_closed.png", x: 25, y: 50 },
        { id: "open", title: "Menu open", condition: "Tap ☰", image: "mobile-nav/02_open.png", x: 70, y: 50 },
      ],
      edges: [["closed", "open", "Tap ☰"]],
    },
  ],
});
