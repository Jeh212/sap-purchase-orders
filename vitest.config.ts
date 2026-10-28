import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    passWithNoTests: true,
    reporters: ["verbose"],
    outputFile: {
      json: "out/test/results.json",
    },
  },
})
