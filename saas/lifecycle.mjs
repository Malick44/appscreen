import { escapeHTML as e, formatDate } from "./utils.mjs";

export function deletionCurrentStatus(data) {
  return data?.activeRequest?.status || data?.status || "unknown";
}

export function deletionStatusMarkup(data) {
  if (!data || data.unavailable)
    return `<section class="panel"><h2>Account deletion requests</h2><p class="notice warning" role="status">${e(data?.unavailable || "Deletion status could not be loaded. Refresh before making a request.")}</p><button type="button" class="button" data-action="refresh">Refresh account status</button></section>`;
  const request = data.activeRequest || data.request;
  const currentStatus = deletionCurrentStatus(data);
  const newerActiveRequest =
    data.activeRequest &&
    data.request &&
    data.activeRequest.requestId !== data.request.requestId;
  const labels = {
    none: "No deletion request",
    pending: "Deletion request pending",
    "requires-review": "Deletion request needs review",
    cancelled: "Deletion request cancelled",
  };
  const verifiedPending =
    currentStatus === "pending" && request?.confirmationVerified;
  const cancel = data.activeRequest?.canCancel === true;
  return `<section class="panel"><h2>${labels[currentStatus] || "Deletion request status"}</h2>${newerActiveRequest ? '<p class="notice warning">This receipt belongs to an earlier action. A newer deletion request is still active and is shown below; it was not cancelled by replaying the older action.</p>' : ""}<p>${e(data.message || "Status returned by the account service.")}</p><p class="notice warning">This installation does not automatically erase account data or cancel billing. Manual fulfillment and retention-policy setup are still required. Submitting or cancelling a request does not itself change your content or subscription.</p>${request ? `<dl class="operator-details"><div><dt>Request</dt><dd><code class="operator-id">${e(request.requestId)}</code></dd></div><div><dt>Requested</dt><dd>${e(formatDate(request.requestedAt))}</dd></div><div><dt>State</dt><dd>${e(request.status)}${request.legacy ? " · earlier request" : ""}</dd></div>${request.cancelledAt ? `<div><dt>Cancelled</dt><dd>${e(formatDate(request.cancelledAt))}</dd></div>` : ""}</dl>` : ""}${data.pendingCount > 1 ? `<p class="help-text mt20">There are ${e(data.pendingCount)} pending requests for this workspace. Cancelling will cover all currently pending requests, including older duplicates.</p>` : ""}<div class="actions mt20">${verifiedPending ? '<span class="badge">Request recorded</span>' : '<button class="button danger" type="button" data-action="request-deletion">' + (currentStatus === "requires-review" || (currentStatus === "pending" && !request?.confirmationVerified) ? "Confirm deletion request" : "Request deletion") + "</button>"}${cancel ? '<button class="button" type="button" data-action="cancel-deletion">Keep my data</button>' : ""}</div><p class="help-text mt20 mb0">Download your workspace archive before requesting deletion. Cancelling a pending request does not restore anything that was previously removed through a separate process.</p></section>`;
}

export function lifecycleActionKey(
  storage,
  workspaceId,
  action,
  anchor,
  createId,
) {
  const slot = `appscreen.lifecycle.${workspaceId}.${action}`;
  const fingerprint = `${action}:${anchor || "none"}`;
  try {
    const previous = JSON.parse(storage.getItem(slot) || "null");
    if (
      previous?.fingerprint === fingerprint &&
      typeof previous.idempotencyKey === "string"
    )
      return { slot, ...previous };
  } catch {}
  const intent = { slot, fingerprint, idempotencyKey: createId() };
  try {
    storage.setItem(
      slot,
      JSON.stringify({ fingerprint, idempotencyKey: intent.idempotencyKey }),
    );
  } catch {}
  return intent;
}
export function completeLifecycleAction(storage, intent) {
  try {
    const current = JSON.parse(storage.getItem(intent.slot) || "null");
    if (current?.idempotencyKey === intent.idempotencyKey)
      storage.removeItem(intent.slot);
  } catch {}
}
export function deletionCancellationTarget(data) {
  if (!data?.activeRequest?.canCancel || !data.activeRequest.requestId)
    throw new Error(
      "No cancellable deletion request is available. Refresh the account status.",
    );
  return data.activeRequest.requestId;
}
