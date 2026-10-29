import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const backendPort = env.PORT ?? "3000"
  return {
    root: "web",
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": `http://localhost:${backendPort}`,
      },
    },
    build: {
      outDir: "../dist/web",
      emptyOutDir: true,
    },
  }
})
