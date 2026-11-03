import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const page = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: page("."),
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4030", "/demo": "http://127.0.0.1:4030" } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", rollupOptions: { input: { site: page("index.html"), app: page("app/index.html") } } },
});
