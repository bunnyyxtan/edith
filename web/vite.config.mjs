import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const page = (path) => fileURLToPath(new URL(path, import.meta.url));
const contentRoutes = new Set(["/docs", "/docs/getting-started", "/docs/agents", "/docs/payments", "/terms", "/privacy", "/cookies"]);
const rewriteContentRoute = (req, _res, next) => {
  const url = new URL(req.url, "http://localhost");
  if (contentRoutes.has(url.pathname)) req.url = `${url.pathname}/index.html${url.search}`;
  next();
};

export default defineConfig({
  root: page("."),
  plugins: [{ name: "edith-content-routes", configureServer(server) { server.middlewares.use(rewriteContentRoute); }, configurePreviewServer(server) { server.middlewares.use(rewriteContentRoute); } }],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4030", "/demo": "http://127.0.0.1:4030" } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", rollupOptions: { input: {
    site: page("index.html"), app: page("app/index.html"),
    docs: page("docs/index.html"), gettingStarted: page("docs/getting-started/index.html"),
    agentsGuide: page("docs/agents/index.html"), paymentsGuide: page("docs/payments/index.html"),
    terms: page("terms/index.html"), privacy: page("privacy/index.html"), cookies: page("cookies/index.html"),
  } } },
});
