import { defineConfig } from "@keyhole-koro/flowshot";

export default defineConfig({
  baseUrl: "http://127.0.0.1:4173",
  outDir: "output",
  scenarios: ["scenarios/*.ts"],
  viewer: { title: "Example", subtitle: "flowshot demo" },
});
