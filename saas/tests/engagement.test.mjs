import test from "node:test";
import assert from "node:assert/strict";
import {
  inboxHref,
  normalizeNotifications,
  inboxMarkup,
  supportListMarkup,
  supportConversationMarkup,
  supportAccessMarkup,
  parseSupportReply,
  parseSupportStatus,
  supportReviewMarkup,
  supportErrorMessage,
  createActionIntent,
} from "../engagement.mjs";

const id = "de741f90-39e7-4a09-947a-e5ea17f1cf3f";
const workspace = "b203601f-ef14-49b2-a7d0-4d8f0238c667";
const detail = () => ({
  case: {
    id,
    workspaceId: workspace,
    status: "pending",
    version: 2,
    canReply: true,
    createdAt: "2026-09-04T12:00:00Z",
  },
  messages: [
    {
      id: "initial",
      author: "customer",
      body: "A useful test report.",
      createdAt: "2026-09-04T12:00:00Z",
    },
  ],
  allowedActions: { followUp: true },
  allowedTransitions: [
    "in-progress",
    "waiting-on-customer",
    "escalated",
    "resolved",
  ],
});
test("inbox links admit only known customer destinations, never executable or staff URLs", () => {
  for (const path of [
    `/app/projects/${id}`,
    `/app/support/${id}`,
    "/app/billing",
  ])
    assert.equal(inboxHref(path), path);
  for (const path of [
    "javascript:alert(1)",
    "//evil.test",
    "https://example.test/app/billing",
    "/app/operator",
    `/app/support/${id}?returnTo=//evil.test`,
    "/app/support/../../operator",
    `/app/support/${id}\\evil`,
    null,
  ])
    assert.equal(inboxHref(path), "");
});
test("inbox displays escaped updates and does not invent an empty or read state from a broken contract", () => {
  assert.throws(() =>
    normalizeNotifications({ notifications: [], unreadCount: null }),
  );
  assert.throws(() => normalizeNotifications({ unreadCount: 0 }));
  const data = normalizeNotifications({
    notifications: [
      {
        id,
        title: "<img onerror=1>",
        message: "<script>unsafe</script>",
        href: "javascript:alert(1)",
        readAt: null,
      },
    ],
    unreadCount: 1,
  });
  const html = inboxMarkup(data);
  assert.doesNotMatch(html, /<img|<script|href="javascript/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Unread/);
  assert.match(html, /Mark as read/);
  assert.match(html, /does not resolve its underlying issue/);
  assert.match(html, /dated history of in-app updates, not email/);
  assert.match(html, /past failure can remain here after recovery/);
});
test("support queue is metadata-only even when a response includes private fields", () => {
  const privateValue = "PRIVATE_NOTE_SENTINEL";
  const cases = [
    {
      ...detail().case,
      body: privateValue,
      requester: { email: privateValue },
      internalNotes: [{ body: privateValue }],
    },
  ];
  for (const staff of [false, true]) {
    const html = supportListMarkup({ cases, nextCursor: null }, { staff });
    assert.doesNotMatch(html, /PRIVATE_NOTE_SENTINEL/);
    assert.equal(html.includes(workspace), staff);
  }
  assert.throws(() => supportListMarkup({}));
});
test("customer support views cannot expose staff notes, staff IDs, requester identity, or internal-message bodies", () => {
  const data = detail();
  data.requester = { userId: "PRIVATE_USER_ID", email: "PRIVATE_EMAIL" };
  data.internalNotes = [
    { body: "PRIVATE_INTERNAL_NOTE", staffUserId: "PRIVATE_STAFF_ID" },
  ];
  data.messages.push({
    author: "support",
    visibility: "internal",
    body: "PRIVATE_HIDDEN_BODY",
  });
  data.messages.push({
    author: "support",
    body: '<img src=x onerror="alert(1)">',
  });
  const html = supportConversationMarkup(data);
  assert.doesNotMatch(html, /PRIVATE_|<img|<script/);
  assert.doesNotMatch(html, new RegExp(workspace));
  assert.match(html, /&lt;img/);
  assert.match(html, /AppScreen support/);
});
test("staff detail requires an explicit reason gate and retains a separate private-note region", () => {
  const gate = supportAccessMarkup(id);
  assert.match(gate, /access is audited/);
  assert.match(gate, /has not loaded its messages/);
  assert.match(gate, /minlength="10" maxlength="500"/);
  assert.doesNotMatch(gate, /support-reply-form/);
  const data = detail();
  data.internalNotes = [
    { body: "Internal <unsafe>", staffUserId: "DO_NOT_RENDER_ID" },
  ];
  const html = supportConversationMarkup(data, { staff: true });
  assert.match(html, /Staff only/);
  assert.match(html, /Internal &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /DO_NOT_RENDER_ID/);
});
test("reply availability respects historical and resolved staff transitions", () => {
  const data = detail();
  data.case = { ...data.case, status: "resolved" };
  data.allowedTransitions = ["in-progress"];
  assert.match(supportConversationMarkup(data), /support-reply-form/);
  assert.doesNotMatch(
    supportConversationMarkup(data, { staff: true }),
    /support-reply-form/,
  );
  data.case.canReply = false;
  data.allowedActions.followUp = false;
  assert.doesNotMatch(supportConversationMarkup(data), /support-reply-form/);
});
test("support writes validate allowed transitions, current version, and required escalation notes", () => {
  assert.deepEqual(parseSupportReply({ message: " Thanks " }, detail()), {
    message: "Thanks",
    expectedVersion: 2,
  });
  assert.throws(() => parseSupportReply({ message: " " }, detail()));
  assert.throws(() =>
    parseSupportReply({ message: "okay" }, { case: { id, version: 0 } }),
  );
  assert.throws(() => parseSupportStatus({ status: "escalated" }, detail()));
  assert.throws(() => parseSupportStatus({ status: "pending" }, detail()));
  assert.deepEqual(
    parseSupportStatus(
      { status: "escalated", internalNote: "Requires renderer investigation." },
      detail(),
    ),
    {
      status: "escalated",
      internalNote: "Requires renderer investigation.",
      expectedVersion: 2,
    },
  );
  const legacy = detail();
  legacy.case.status = "requires-review";
  legacy.allowedTransitions = ["in-progress"];
  assert.throws(() => parseSupportStatus({ status: "in-progress" }, legacy));
});
test("staff send and status change require a separate reviewed confirmation, with escaped text", () => {
  const reply = supportReviewMarkup("reply", id, {
    message: "<script>bad</script>",
  });
  assert.match(reply, /type="checkbox" name="confirmed" required/);
  assert.match(reply, /customer-visible reply/);
  assert.doesNotMatch(reply, /<script>/);
  const status = supportReviewMarkup("status", id, {
    status: "escalated",
    internalNote: "Private <note>",
  });
  assert.match(status, /staff only/);
  assert.match(status, /Private &lt;note&gt;/);
});
test("uncertain retries retain intent keys and success clears only the matching intent", () => {
  let sequence = 0;
  const intent = createActionIntent(() => `qa-intent-${++sequence}`);
  const payload = { message: "Original message", expectedVersion: 4 };
  const first = intent.prepare(payload);
  assert.equal(intent.prepare(payload).idempotencyKey, first.idempotencyKey);
  first.message = "Changed by caller";
  assert.equal(intent.prepare(payload).message, "Original message");
  const second = intent.prepare({
    ...payload,
    message: "New intended message",
  });
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  intent.complete(first.idempotencyKey);
  assert.equal(
    intent.prepare({ ...payload, message: "New intended message" })
      .idempotencyKey,
    second.idempotencyKey,
  );
  intent.complete(second.idempotencyKey);
  assert.notEqual(
    intent.prepare({ ...payload, message: "New intended message" })
      .idempotencyKey,
    second.idempotencyKey,
  );
  assert.match(
    supportErrorMessage({ code: "CONNECTION_FAILED" }),
    /Retry unchanged/,
  );
  assert.match(
    supportErrorMessage({ code: "SUPPORT_VERSION_CONFLICT" }),
    /text is still here/,
  );
});
