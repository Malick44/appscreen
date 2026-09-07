import test from "node:test";
import assert from "node:assert/strict";
import {
  emailIncidentFilter, normalizeEmailIncident, normalizeEmailIncidents,
  normalizeEmailReport, createEmailReviewStore, clearEmailReviewStorage,
  createEmailReview, emailOperationsMarkup, emailIncidentMarkup, emailReviewMarkup,
} from "../email-operations.mjs";

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const incident = (extra = {}) => ({
  id: ID, workspaceId: WORKSPACE, status: "bounced", errorCode: "EMAIL_BOUNCED",
  attempts: 2, createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:05:00.000Z",
  deliveryVersion: 3, reviewVersion: 0, reviewState: "open", previousReviewStale: false,
  ...extra,
});
const reason = "Reviewed current delivery evidence. No resend requested.";
const decision = { disposition: "closed-no-resend", reason };
const key = () => "review-key-1111";
const receipt = (extra = {}) => ({ incident: incident({ reviewState: "closed-no-resend", reviewVersion: 1, ...extra }) });
const view = (extra = {}) => ({
  filter: "open", incidents: [incident()], nextCursor: null, report: null,
  pending: [], loading: false, ...extra,
});
function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}
const store = (value = storage(), user = USER, workspace = WORKSPACE) =>
  createEmailReviewStore(value, user, workspace);

test("incident metadata is allowlisted; private content never enters markup", () => {
  const dirty = incident({ recipient: "private@example.test", reason: "PRIVATE_REASON", body: "PRIVATE_BODY", providerId: "PRIVATE_PROVIDER", name: "PRIVATE_NAME" });
  assert.deepEqual(normalizeEmailIncident(dirty), incident());
  const html = emailIncidentMarkup(dirty);
  assert.doesNotMatch(html, /PRIVATE_|private@example/);
  assert.match(html, /Delivery evidence/);
  assert.match(html, /Staff decision/);
  assert.match(html, /Evidence version/);
  assert.match(html, /separate from delivery/);
  assert.equal(normalizeEmailIncident(incident({ errorCode: null })).errorCode, null);
  for (const override of [
    { id: "<script>" }, { workspaceId: "bad" }, { status: "delivered" },
    { reviewState: "resolved" }, { deliveryVersion: 0 }, { reviewVersion: -1 },
    { attempts: 1.2 }, { errorCode: "<img onerror=alert(1)>" },
    { updatedAt: "invalid" }, { previousReviewStale: "true" },
  ]) assert.throws(() => normalizeEmailIncident(incident(override)));
});

test("list and report validate bounds and keep current incident filters distinct", () => {
  assert.deepEqual(normalizeEmailIncidents({ incidents: [incident()], nextCursor: "a_B-12" }).incidents, [incident()]);
  for (const data of [{}, { incidents: [incident()], nextCursor: "?bad" },
    { incidents: [incident(), incident()], nextCursor: null }]) assert.throws(() => normalizeEmailIncidents(data));
  assert.equal(emailIncidentFilter("history"), "open");
  assert.equal(emailIncidentFilter("reviewed"), "reviewed");
  assert.deepEqual(normalizeEmailReport({ sendingEnabled: false, openIncidents: 4, reviewRequired: 2,
    oldestPendingSeconds: 10, counts: [], recipients: ["private"] }), {
    sendingEnabled: false, openIncidents: 4, reviewRequired: 2, oldestPendingSeconds: 10,
  });
  assert.throws(() => normalizeEmailReport({ counts: [] }));
  assert.match(emailOperationsMarkup(view({ filter: "all" })), /not a full delivery history/);
  assert.match(emailOperationsMarkup(view({ incidents: [], filter: "reviewed" })), /No closed reviews for current evidence/);
  assert.match(emailIncidentMarkup(incident({ previousReviewStale: true })), /New delivery evidence reopened/);
});

test("explicit confirmation precedes the single frozen write and exact receipt", async () => {
  const writes = [], persisted = store();
  let complete;
  const review = createEmailReview(async (path, options) => {
    writes.push({ path, ...options });
    assert.equal(persisted.list().length, 1, "save retry before dispatch");
    return new Promise((resolve) => { complete = resolve; });
  }, persisted, incident(), key);
  assert.equal(review.snapshot().phase, "draft");
  review.prepare(decision);
  await review.record(false);
  assert.equal(writes.length, 0);
  const saving = review.record(true);
  assert.equal(review.snapshot().phase, "saving");
  review.prepare({ disposition: "investigating", reason: "Changed while saving" });
  await review.record(true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { ...decision, expectedDeliveryVersion: 3, expectedReviewVersion: 0,
    idempotencyKey: key(), confirmation: "RECORD EMAIL REVIEW" });
  assert.equal(writes[0].path, `/api/operator/email/incidents/${ID}/review`);
  complete(receipt());
  assert.equal((await saving).phase, "saved");
  assert.equal(persisted.list().length, 0);
  await review.record(true);
  assert.equal(writes.length, 1);
});

test("reason validation and editable pre-confirmation decisions never write", () => {
  const review = createEmailReview(() => assert.fail("no writes"), store(), incident(), key);
  for (const values of [{ ...decision, reason: "short" }, { ...decision, reason: "a".repeat(1001) }, { ...decision, disposition: "resolve" }])
    assert.throws(() => review.prepare(values));
  review.prepare(decision);
  assert.equal(review.edit().phase, "draft");
  review.prepare({ disposition: "investigating", reason: "Different review decision." });
  assert.equal(review.snapshot().payload.disposition, "investigating");
});

test("uncertain outcomes remain frozen across controller restoration and changed evidence", async () => {
  const persisted = store(), writes = [];
  const request = async (_, options) => {
    writes.push(options.body);
    if (writes.length === 1) throw Object.assign(new Error("network"), { status: 0 });
    return receipt(); // An exact replay returns its ORIGINAL receipt, not current evidence.
  };
  const first = createEmailReview(request, persisted, incident(), key);
  first.prepare(decision);
  assert.equal((await first.record(true)).phase, "uncertain");
  first.edit();
  first.prepare({ disposition: "investigating", reason: "Must not replace pending decision." });
  const restored = createEmailReview(request, persisted, incident({ deliveryVersion: 9, reviewVersion: 4 }), () => assert.fail("must not generate new retry key"));
  assert.equal(restored.snapshot().incident.deliveryVersion, 3);
  assert.equal((await restored.record(true)).phase, "saved");
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(persisted.list().length, 0);
});

test("malformed, current-state, wrong-workspace and wrong-disposition receipts stay uncertain", async () => {
  for (const response of [{}, receipt({ reviewVersion: 2 }), receipt({ deliveryVersion: 4 }),
    receipt({ workspaceId: USER }), receipt({ reviewState: "investigating" }), receipt({ previousReviewStale: true })]) {
    const persisted = store();
    const review = createEmailReview(async () => response, persisted, incident(), key);
    review.prepare(decision);
    assert.equal((await review.record(true)).phase, "uncertain");
    assert.equal(persisted.list().length, 1);
  }
});

test("changed or inactive evidence requires reload; role loss stops without a new key", async () => {
  for (const code of ["EMAIL_INCIDENT_CHANGED", "EMAIL_INCIDENT_NOT_ACTIVE", "EMAIL_INCIDENT_NOT_FOUND", "OPERATOR_REQUIRED"]) {
    const persisted = store(); let calls = 0;
    const review = createEmailReview(async () => { calls++; throw { code, status: code === "OPERATOR_REQUIRED" ? 403 : 409 }; }, persisted, incident(), key);
    review.prepare(decision);
    assert.equal((await review.record(true)).phase, code === "OPERATOR_REQUIRED" ? "forbidden" : "stale");
    await review.record(true);
    assert.equal(calls, 1);
    assert.equal(persisted.list().length, code === "OPERATOR_REQUIRED" ? 1 : 0);
  }
});

test("unavailable storage fails closed before dispatch; partial storage remains recoverable", async () => {
  const memory = storage();
  memory.setItem = () => { throw new Error("disabled"); };
  const review = createEmailReview(() => assert.fail("must retain key before sending"), store(memory), incident(), key);
  review.prepare(decision);
  const result = await review.record(true);
  assert.equal(result.phase, "storage-error");
  assert.match(result.message, /No new request was sent/);
  assert.equal(result.payload.idempotencyKey, key());
});

test("pending notes are scoped to staff and workspace and successful sign-out cleanup is selective", async () => {
  const memory = storage(), persisted = store(memory);
  const review = createEmailReview(async () => { throw new Error("connection"); }, persisted, incident(), key);
  review.prepare(decision);
  await review.record(true);
  assert.equal(store(memory, ID).list().length, 0);
  assert.equal(store(memory, USER, ID).list().length, 0);
  memory.setItem("unrelated-brief", "preserve");
  clearEmailReviewStorage(memory);
  assert.equal(persisted.list().length, 0);
  assert.equal(memory.getItem("unrelated-brief"), "preserve");
  memory.setItem(`appscreen.email-review:${USER}:${WORKSPACE}:${ID}`, "broken");
  assert.throws(() => persisted.list());
});

test("reason is escaped only in confirmation; pending queue contains no reason", async () => {
  const persisted = store();
  const review = createEmailReview(async () => { throw new Error("network"); }, persisted, incident(), key);
  review.prepare({ ...decision, reason: "<img src=x onerror=alert(1)> staff note" });
  const confirmation = emailReviewMarkup(review.snapshot());
  assert.match(confirmation, /&lt;img/);
  assert.doesNotMatch(confirmation, /<img/);
  assert.match(confirmation, /RECORD EMAIL REVIEW/);
  assert.match(confirmation, />Record review</);
  await review.record(true);
  const queue = emailOperationsMarkup(view({ incidents: [], pending: persisted.list() }));
  assert.match(queue, /Check review/);
  assert.doesNotMatch(queue, /staff note|onerror/);
});

test("new review controls are disabled after stale/save/load failure while pending checks remain available", () => {
  for (const extra of [{ reloadRequired: true }, { error: "Reload required" }, { loading: true }]) {
    const html = emailOperationsMarkup(view(extra));
    assert.match(html, /data-email-action="review"[^>]*disabled/);
    assert.doesNotMatch(html, /Saved reviews could not be recovered/);
  }
  const html = emailOperationsMarkup(view({ reloadRequired: true, pending: [{ incident: incident() }] }));
  assert.match(html, /data-email-action="resume" data-id="[^"]+">Check review/);
});

test("maximum incremented review receipt is accepted while expected version remains bounded", async () => {
  const review = createEmailReview(async () => receipt({ reviewVersion: 2147483647 }), store(), incident({ reviewVersion: 2147483646 }), key);
  review.prepare(decision);
  assert.equal((await review.record(true)).phase, "saved");
  const exhausted = createEmailReview(() => assert.fail(), store(), incident({ reviewVersion: 2147483647 }), key);
  assert.throws(() => exhausted.prepare(decision));
});
