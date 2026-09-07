// Explicit, isolated browser QA: node saas/tests/email-operations.browser-qa.mjs
// All API calls are synthetic and intercepted. The ephemeral server serves files only.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), "appscreen-email-review-ui-"));
const user = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const original = {
  id, workspaceId: workspace, status: "bounced", errorCode: "EMAIL_BOUNCED", attempts: 2,
  createdAt: "2026-09-05T10:00:00Z", updatedAt: "2026-09-05T10:05:00Z",
  deliveryVersion: 3, reviewVersion: 0, reviewState: "open", previousReviewStale: false,
};
let incident = { ...original }, behavior = "uncertain", denied = false, queueFailure = false;
const writes = [], apiHits = [], unexpected = [], pageErrors = [];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://test").pathname;
  if (path.startsWith("/api/")) {
    unexpected.push(path);
    response.writeHead(500).end();
    return;
  }
  const file = path.startsWith("/saas/") ? path : path === "/img/icon.png" ? path : "/saas/index.html";
  if (file.includes("..") || (!/^\/saas\/[a-z0-9./-]+$/i.test(file) && file !== "/img/icon.png")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(repo, file));
    response.writeHead(200, { "Content-Type": ({ ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" })[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem("qa-bootstrapped")) {
      sessionStorage.setItem("appscreen.dev.token", "synthetic-local-test");
      sessionStorage.setItem("qa-bootstrapped", "true");
    }
  });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    apiHits.push({ path: url.pathname, method: request.method() });
    const send = (json, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
    const forbid = () => send({ error: { code: "OPERATOR_REQUIRED", message: "No access" } }, 403);
    if (url.pathname === "/api/config") return send({ auth: { provider: "development" }, mcp: {}, plans: [] });
    if (url.pathname === "/api/session") return send({ user: { id: user, email: "staff@example.test" }, workspace: { id: workspace, name: "Isolated staff QA" }, credits: 0, operator: true });
    if (url.pathname === "/api/notifications") return send({ notifications: [], unreadCount: 0, nextCursor: null });
    if (url.pathname === "/api/notifications/unread-count") return send({ unreadCount: 0 });
    if (url.pathname === "/api/projects") return send({ projects: [] });
    if (url.pathname === "/api/operator/overview") return send({});
    if (url.pathname === "/api/operator/email") return denied ? forbid() : send({ sendingEnabled: false, openIncidents: 1, reviewRequired: 0, oldestPendingSeconds: 300, counts: [] });
    if (url.pathname === "/api/operator/email/incidents") {
      if (denied) return forbid();
      if (queueFailure) return send({ error: { code: "REQUEST_FAILED", message: "Unavailable" } }, 500);
      const filter = url.searchParams.get("state");
      const visible = incident && (filter === "all" || (filter === "reviewed" ? incident.reviewState === "closed-no-resend" : incident.reviewState !== "closed-no-resend"));
      return send({ incidents: visible ? [{ ...incident, recipient: "PRIVATE_RECIPIENT", body: "PRIVATE_BODY", reason: "PRIVATE_REASON", providerId: "PRIVATE_PROVIDER" }] : [], nextCursor: null });
    }
    if (url.pathname === `/api/operator/email/incidents/${id}/review`) {
      const body = request.postDataJSON();
      writes.push(body);
      if (behavior === "uncertain") return route.abort("failed");
      if (behavior === "stale") return send({ error: { code: "EMAIL_INCIDENT_CHANGED", message: "Changed" } }, 409);
      if (behavior === "forbidden") return forbid();
      return send({ incident: { ...original, reviewState: body.disposition, reviewVersion: body.expectedReviewVersion + 1, deliveryVersion: body.expectedDeliveryVersion } });
    }
    unexpected.push(request.url());
    return send({ error: { code: "UNEXPECTED" } }, 500);
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const ready = () => page.locator('[data-email-action="review"]').waitFor();
  const continueReview = async (reason, disposition = "investigating") => {
    await page.locator('[data-email-action="review"]').click();
    await page.locator("#email-review-disposition").selectOption(disposition);
    await page.locator("#email-review-reason").fill(reason);
    await page.getByRole("button", { name: "Continue to confirmation", exact: true }).click();
  };
  const confirm = async (retry = false) => {
    await page.locator("#email-review-confirmed").check();
    await page.getByRole("button", { name: retry ? "Retry record review" : "Record review", exact: true }).click();
  };
  const pendingCount = () => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("appscreen.email-review:")).length);
  await page.goto(origin + "/app/operator/email");
  await ready();
  await page.screenshot({ path: join(artifacts, "desktop.png"), fullPage: true });
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.goto(origin + "/app/operator/email");
  await mobile.locator('[data-email-action="review"]').waitFor();
  await mobile.screenshot({ path: join(artifacts, "mobile.png"), fullPage: true });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile has no horizontal overflow");
  const targets = await mobile.locator("#email-operations-area button,#email-operations-area select").evaluateAll((elements) => elements.map((element) => ({ label: element.textContent, height: element.getBoundingClientRect().height })));
  assert.ok(targets.every((target) => target.height >= 44), JSON.stringify(targets));
  await mobile.locator('[data-email-action="review"]').click();
  await mobile.locator("#email-review-reason").fill("Synthetic mobile confirmation review.");
  await mobile.getByRole("button", { name: "Continue to confirmation", exact: true }).click();
  await mobile.screenshot({ path: join(artifacts, "mobile-confirmation.png"), fullPage: false });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile dialog has no overflow");
  const dialogLayout = await mobile.locator("#modal").evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const primary = dialog.querySelector('button[type="submit"]').getBoundingClientRect();
    return {
      inside: bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
      primaryVisible: primary.top >= 0 && primary.bottom <= innerHeight,
      focused: dialog.contains(document.activeElement),
      controls: [...dialog.querySelectorAll("button")].every((button) => button.getBoundingClientRect().height >= 44),
    };
  });
  assert.deepEqual(dialogLayout, { inside: true, primaryVisible: true, focused: true, controls: true });
  await mobile.close();
  assert.doesNotMatch(await page.locator("#email-operations-area").innerText(), /PRIVATE_/);
  const reason = "Synthetic staff review only. No actual delivery action.";
  await continueReview(reason, "closed-no-resend");
  assert.equal(writes.length, 0, "confirmation is required before writes");
  assert.equal(await page.locator("#email-review-confirmed").evaluate((element) => element === document.activeElement), true, "confirmation focus");
  await page.screenshot({ path: join(artifacts, "confirmation.png"), fullPage: false });
  await confirm();
  await page.getByRole("button", { name: "Retry record review", exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(await page.locator('#email-review-reason,[data-email-action="edit"]').count(), 0, "uncertain payload cannot be edited");
  await page.screenshot({ path: join(artifacts, "uncertain.png"), fullPage: false });
  await page.getByRole("button", { name: "Close · keep pending review", exact: true }).click();
  await page.getByRole("link", { name: "Campaigns", exact: true }).click();
  await page.waitForURL("**/app");
  incident = { ...original, deliveryVersion: 4, reviewVersion: 1, reviewState: "closed-no-resend" };
  await page.goto(origin + "/app/operator/email");
  await page.getByRole("button", { name: "Check review 33333333", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Check review 33333333", exact: true }).click();
  assert.match(await page.locator("#email-review-form").innerText(), /evidence 3 · review 0/);
  assert.ok((await page.locator("#email-review-form").innerText()).includes(reason));
  behavior = "success";
  await confirm(true);
  await page.getByRole("heading", { name: "Staff review recorded", exact: true }).waitFor();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1], "retry across navigation + reload preserves exact request even when incident is absent");
  assert.equal(await pendingCount(), 0);
  await page.getByRole("button", { name: "Reload queue", exact: true }).last().click();
  await page.locator("#email-incident-filter").selectOption("reviewed");
  await ready();
  assert.match(await page.locator("#email-operations-area").innerText(), /Closed · no resend/);
  await continueReview("Changed staff decision on current evidence.");
  behavior = "stale";
  await confirm();
  await page.waitForFunction(() => document.querySelector("#email-review-feedback")?.textContent.includes("The delivery evidence or staff review changed"));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.locator('[data-email-action="review"]').isDisabled(), true, "stale new review is native disabled");
  assert.match(await page.locator("#email-queue-feedback").innerText(), /Reload/);
  await page.waitForFunction(() => document.activeElement?.matches('[data-email-action="reload"]'));
  queueFailure = true;
  await page.locator('[data-email-action="reload"]').click();
  await page.waitForFunction(() => document.querySelector("#email-queue-feedback")?.textContent.includes("could not be loaded"));
  assert.equal(await page.locator("#email-queue-feedback").evaluate((element) => element === document.activeElement), true, "queue error receives focus");
  queueFailure = false;
  incident = { ...original };
  await page.locator("#email-incident-filter").selectOption("open");
  await ready();
  await continueReview("Unconfirmed review retained until sign out.");
  behavior = "uncertain";
  await confirm();
  await page.getByRole("button", { name: "Close · keep pending review", exact: true }).click();
  assert.equal(await pendingCount(), 1);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login");
  assert.equal(await pendingCount(), 0, "sign-out clears staff notes");
  await page.evaluate(() => sessionStorage.setItem("appscreen.dev.token", "synthetic-local-test"));
  await page.goto(origin + "/app/operator/email");
  await ready();
  denied = true;
  await page.locator('[data-email-action="reload"]').click();
  await page.getByRole("heading", { name: "Operator access denied", exact: true }).waitFor();
  assert.equal(await page.locator('[data-email-action="review"]').count(), 0);
  assert.deepEqual(unexpected, [], "no unmocked API or external requests");
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ artifacts, result: "PASS", mockedWrites: writes.length, mockedApiRequests: apiHits.length, unmockedRequests: unexpected.length, pageErrors }, null, 2));
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
