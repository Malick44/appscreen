import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHTML,
  safeURL,
  localReturnPath,
  formatCredits,
  validateFileMetadata,
  getPreviews,
  normalizePlans,
  planPrice,
  TERMINAL_STATES,
  jobState,
  stageLabel,
} from "../utils.mjs";

test("customer text is escaped before HTML interpolation", () => {
  assert.equal(
    escapeHTML('<img src=x onerror="alert(1)">&\''),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;",
  );
  assert.equal(escapeHTML(null), "");
});
test("download and preview URLs reject executable, protocol-relative, and credential URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "//evil.test",
    "/\\evil.test",
    "https://name:secret@example.test/a",
    "/x\nLocation: evil",
    "blob:somewhere",
  ])
    assert.equal(safeURL(value), "", value);
  assert.equal(
    safeURL("/api/media/123?token=opaque"),
    "/api/media/123?token=opaque",
  );
  assert.equal(
    safeURL("https://storage.example.test/a.png"),
    "https://storage.example.test/a.png",
  );
});
test("sign-in return target stays local", () => {
  assert.equal(localReturnPath("/editor?project=abc"), "/editor?project=abc");
  for (const value of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "\n/app",
    null,
  ])
    assert.equal(localReturnPath(value), "/app");
});
test("missing credits are not presented as zero; zero is valid", () => {
  assert.equal(formatCredits(undefined), "—");
  assert.equal(formatCredits({}), "—");
  assert.equal(formatCredits({ available: 0 }), "0");
  assert.equal(formatCredits({ available: 10, reserved: 2 }), "10");
});
test("upload admission rejects unsupported, empty, and oversized files", () => {
  assert.match(
    validateFileMetadata({ type: "image/svg+xml", size: 20 }),
    /PNG or JPEG/,
  );
  assert.match(validateFileMetadata({ type: "image/png", size: 0 }), /empty/);
  assert.match(
    validateFileMetadata({ type: "image/jpeg", size: 16 * 1024 * 1024 }),
    /15 MB/,
  );
  assert.equal(validateFileMetadata({ type: "image/png", size: 5000 }), null);
});
test("configured prices only; unavailable pricing is never fabricated", () => {
  assert.equal(
    planPrice({ id: "pro", priceAmount: null }),
    "Pricing is being prepared",
  );
  assert.equal(
    planPrice({ priceLabel: "Configured amount" }),
    "Configured amount",
  );
  assert.equal(normalizePlans({ pro: { name: "Pro" } })[0].id, "pro");
});
test("preview records normalize without inventing output", () => {
  assert.deepEqual(
    getPreviews({ result: { previews: [{ sceneId: "s1", url: "/one.png" }] } }),
    [{ sceneId: "s1", url: "/one.png" }],
  );
  assert.deepEqual(getPreviews({}), []);
  assert.equal(TERMINAL_STATES.has("failed"), true);
  assert.equal(TERMINAL_STATES.has("cancelling"), false);
});
test("cancellation feedback remains pending until the worker acknowledges it", () => {
  assert.equal(
    jobState({ status: "running", cancelRequested: true }),
    "cancelling",
  );
  assert.equal(
    stageLabel({
      status: "running",
      stage: "analyzing",
      cancelRequested: true,
    }),
    "Stopping generation",
  );
  assert.equal(
    jobState({ status: "cancelled", cancelRequested: true }),
    "cancelled",
  );
});

test("an exported draft needing QA review is not described as missing input", () => {
  assert.equal(
    stageLabel({
      status: "needs-input",
      stage: "needs-input",
      result: { revisionId: "draft-1", artifacts: [{ name: "campaign.zip" }] },
    }),
    "Your draft needs a review",
  );
  assert.equal(
    stageLabel({ status: "needs-input", stage: "needs-input" }),
    "A little more information is needed",
  );
});
