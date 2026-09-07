import test from "node:test";
import assert from "node:assert/strict";
import {
  operatorOverviewMarkup,
  operatorJobMarkup,
  parseCreditAdjustment,
  creditReviewMarkup,
  creditReceiptMarkup,
} from "../operator.mjs";

const id = "dd04ee25-4058-499b-a502-bc28023c418f";
test("operator views render only allowed operational fields, never nested private job content", () => {
  const privateValue = "PRIVATE_CONTENT_SENTINEL";
  const job = {
    id,
    kind: "<img onerror=1>",
    status: "failed",
    errorCode: "PROVIDER_ERROR",
    input: { prompt: privateValue },
    result: { screenshots: privateValue },
    error: { message: privateValue },
  };
  const overview = operatorOverviewMarkup({
    jobs: [job],
    support: [{ id, kind: "support", message: privateValue }],
    secret: privateValue,
  });
  const detail = operatorJobMarkup({
    job,
    events: [{ stage: "checking", prompt: privateValue }],
    usage: [{ stage: "planning", outputText: privateValue }],
  });
  for (const html of [overview, detail]) {
    assert.equal(html.includes(privateValue), false);
    assert.equal(html.includes("<img onerror"), false);
    assert.match(html, /&lt;img onerror=1&gt;/);
  }
});
test("operator adjustments require a UUID, bounded nonzero integer and documented reason", () => {
  const valid = {
    workspaceId: id,
    amount: "-5",
    reason: "Documented QA correction.",
  };
  assert.deepEqual(parseCreditAdjustment(valid), { ...valid, amount: -5 });
  for (const amount of ["0", "1.5", "1001", "-1001", "NaN", ""])
    assert.throws(() => parseCreditAdjustment({ ...valid, amount }));
  assert.throws(() =>
    parseCreditAdjustment({ ...valid, workspaceId: "all-workspaces" }),
  );
  assert.throws(() => parseCreditAdjustment({ ...valid, reason: "short" }));
});
test("operator confirmation discloses exact target and requires a typed approval", () => {
  const html = creditReviewMarkup({
    workspaceId: id,
    amount: -5,
    reason: "<unsafe>",
  });
  assert.match(html, /ADJUST CREDITS/);
  assert.match(html, /-5 credits/);
  assert.match(html, new RegExp(id));
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /Apply credit adjustment/);
});
test("credit receipt does not infer a balance or render unexpected response properties", () => {
  const html = creditReceiptMarkup({
    receipt: {
      id,
      workspaceId: id,
      amount: 5,
      createdAt: "2026-09-04T12:30:00Z",
      internalSecret: "PRIVATE",
    },
    balance: 999,
  });
  assert.equal(html.includes("PRIVATE"), false);
  assert.equal(html.includes("999"), false);
  assert.match(html, /No resulting balance has been inferred/);
});
