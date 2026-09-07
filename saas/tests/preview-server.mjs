// Visual-only test harness. No account, project, AI, payment, or persistence APIs.
// Run: node saas/tests/preview-server.mjs, then inspect http://127.0.0.1:8021.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../..", import.meta.url));
const pages = new Set([
  "/",
  "/pricing",
  "/help",
  "/privacy",
  "/terms",
  "/login",
  "/signup",
  "/recover",
  "/reset-password",
]);
const files = new Set([
  "saas/index.html",
  "saas/app.js",
  "saas/api.js",
  "saas/session.js",
  "saas/utils.mjs",
  "saas/styles.css",
  "img/icon.png",
]);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
http
  .createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1:8021");
    if (url.pathname === "/api/config") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          auth: { provider: "unconfigured" },
          aiEnabled: false,
          billingEnabled: false,
          plans: [],
          visualFixture: true,
        }),
      );
      return;
    }
    const relative = pages.has(url.pathname)
      ? "saas/index.html"
      : url.pathname.slice(1);
    if (!files.has(relative)) {
      response.writeHead(404);
      response.end("Visual-only preview: this endpoint is not implemented.");
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        types[path.extname(relative)] || "application/octet-stream",
      );
      response.end(await readFile(path.join(root, relative)));
    } catch {
      response.writeHead(404);
      response.end("File missing");
    }
  })
  .listen(8021, "127.0.0.1", () =>
    console.log(
      "Visual-only AppScreen preview: http://127.0.0.1:8021 (no backend)",
    ),
  );
