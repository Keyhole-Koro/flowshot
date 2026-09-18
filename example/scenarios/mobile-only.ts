import { defineScenario } from "@keyhole-koro/flowshot";

// Imperative: hand-written capture() with an explicit flow, one viewport only.
export default defineScenario({
  id: "mobile-nav",
  order: 2,
  title: "Mobile navigation",
  viewports: ["mobile"],
  async capture({ newPage, goto, shoot }) {
    const page = await newPage();
    await goto(page, "/pricing.html");
    await shoot(page, "mobile-nav/01_pricing.png", { fullPage: false });
  },
  flows: [
    {
      id: "mobile-nav",
      title: "Mobile navigation",
      description: "Above-the-fold view of the pricing page on a phone.",
      viewports: ["mobile"],
      nodes: [{ id: "pricing", title: "Pricing (fold)", condition: "Open /pricing.html", image: "mobile-nav/01_pricing.png", x: 50, y: 50 }],
      edges: [],
    },
  ],
});
