import test from "node:test";
import assert from "node:assert/strict";
import {
  deletionStatusMarkup,
  lifecycleActionKey,
  completeLifecycleAction,
  deletionCancellationTarget,
  deletionCurrentStatus,
} from "../lifecycle.mjs";

test("deletion requests remain explicit pending requests, never fake erasure or billing changes", () => {
  const data = {
    status: "pending",
    requestId: "r1",
    activeRequest: {
      requestId: "r1",
      status: "pending",
      confirmationVerified: true,
      canCancel: true,
    },
    pendingCount: 2,
  };
  const html = deletionStatusMarkup(data);
  assert.match(html, /Deletion request pending/);
  assert.match(html, /does not automatically erase/);
  assert.match(html, /Keep my data/);
  assert.match(html, /older duplicates/);
  assert.doesNotMatch(html, /data-action="request-deletion"/);
  assert.equal(deletionCancellationTarget(data), "r1");
  assert.throws(() => deletionCancellationTarget({ status: "none" }));
});

test("an earlier cancellation receipt cannot hide a newer active deletion request", () => {
  const data = {
    status: "cancelled",
    request: { requestId: "old", status: "cancelled" },
    activeRequest: {
      requestId: "new",
      status: "pending",
      confirmationVerified: true,
      canCancel: true,
    },
    pendingCount: 1,
    replayed: true,
  };
  const html = deletionStatusMarkup(data);
  assert.equal(deletionCurrentStatus(data), "pending");
  assert.match(html, /<h2>Deletion request pending<\/h2>/);
  assert.match(html, /newer deletion request is still active/);
  assert.doesNotMatch(html, /<h2>Deletion request cancelled/);
  assert.equal(deletionCancellationTarget(data), "new");
});
test("unavailable lifecycle status exposes refresh, not an unverified destructive action", () => {
  const html = deletionStatusMarkup({ unavailable: "<offline>" });
  assert.match(html, /&lt;offline&gt;/);
  assert.match(html, /Refresh account status/);
  assert.doesNotMatch(html, /data-action="request-deletion"/);
});
test("lifecycle keys survive an uncertain retry but rotate for a new target request", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let counter = 0;
  const next = () => "key-" + ++counter;
  const first = lifecycleActionKey(storage, "workspace", "cancel", "r1", next);
  assert.equal(
    lifecycleActionKey(storage, "workspace", "cancel", "r1", next)
      .idempotencyKey,
    first.idempotencyKey,
  );
  const second = lifecycleActionKey(storage, "workspace", "cancel", "r2", next);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  completeLifecycleAction(storage, first);
  assert.equal(
    lifecycleActionKey(storage, "workspace", "cancel", "r2", next)
      .idempotencyKey,
    second.idempotencyKey,
  );
  completeLifecycleAction(storage, second);
  assert.notEqual(
    lifecycleActionKey(storage, "workspace", "cancel", "r2", next)
      .idempotencyKey,
    second.idempotencyKey,
  );
});
