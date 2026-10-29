import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["web/**", "node_modules/**", "dist/**"],
    isolate: true,
    passWithNoTests: true,
    reporters: ["verbose"],
    outputFile: {
      json: "out/test/results.json",
    },
  },
})
