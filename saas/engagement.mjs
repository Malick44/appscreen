import { escapeHTML as e } from "./utils.mjs";

export const SUPPORT_STATUSES = {
  pending: "Received",
  "in-progress": "In progress",
  "waiting-on-customer": "Waiting for your reply",
  escalated: "Escalated",
  resolved: "Resolved",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resourceId(value) {
  return typeof value === "string" && UUID.test(value) ? value : "";
}
export function inboxHref(value) {
  if (value === "/app/billing") return value;
  const match =
    typeof value === "string" &&
    value.match(/^\/app\/(projects|support)\/([^/?#]+)$/);
  return match && resourceId(match[2]) ? value : "";
}
export function messageTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
function badge(status, staff = false) {
  const label =
    staff && status === "waiting-on-customer"
      ? "Waiting on customer"
      : SUPPORT_STATUSES[status] || "Requires review";
  return `<span class="badge case-status">${e(label)}</span>`;
}
function reference(id) {
  return resourceId(id) ? id.slice(0, 8).toUpperCase() : "Unavailable";
}
function button(label, action, id = "", disabled = false) {
  return `<button type="button" class="button" data-action="${action}" ${id ? `data-id="${e(id)}"` : ""} ${disabled ? "disabled" : ""}>${e(label)}</button>`;
}
function pagination(nextCursor, action) {
  return nextCursor
    ? `<div class="actions mt20">${button("Load more", action)}</div>`
    : "";
}
export function normalizeNotifications(data) {
  if (
    !Array.isArray(data?.notifications) ||
    !Number.isInteger(data.unreadCount) ||
    data.unreadCount < 0
  )
    throw new Error("The inbox response was incomplete. Refresh to try again.");
  return {
    notifications: data.notifications
      .filter((item) => resourceId(item?.id))
      .map((item) => ({
        id: item.id,
        title: typeof item.title === "string" ? item.title : "Workspace update",
        message: typeof item.message === "string" ? item.message : "",
        href: inboxHref(item.href),
        createdAt: item.createdAt,
        readAt: item.readAt || null,
      })),
    unreadCount: data.unreadCount,
    nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
  };
}
export function inboxMarkup(data, unreadOnly = false) {
  return `<p class="help-text">This is a dated history of in-app updates, not email. Open the linked page for the current status; a past failure can remain here after recovery. Marking an update read does not resolve its underlying issue.</p><div class="inbox-toolbar"><label class="check"><input id="inbox-unread-only" type="checkbox" ${unreadOnly ? "checked" : ""}><span>Unread only</span></label><span class="help-text" role="status">${e(data.unreadCount)} unread</span></div>${data.notifications.length ? `<div class="notice-list">${data.notifications.map((item) => `<article class="notice-row ${!item.readAt ? "unread" : ""}"><div><div class="message-meta">${!item.readAt ? '<span class="unread-label">Unread</span>' : "<span>Read</span>"}<time>${e(messageTime(item.createdAt))}</time></div><h2>${e(item.title)}</h2><p>${e(item.message)}</p></div><div class="notice-actions">${item.href ? `<a class="button" href="${e(item.href)}" data-link>Open update</a>` : ""}${!item.readAt ? button("Mark as read", "read-notification", item.id) : ""}</div></article>`).join("")}</div>${pagination(data.nextCursor, "more-notifications")}` : `<section class="panel empty-conversation"><h2>${unreadOnly ? "You’re all caught up." : "No updates yet."}</h2><p class="mb0">${unreadOnly ? "There are no unread updates in this view." : "Campaign results, exports, payment issues, and support replies will appear here when they happen."}</p></section>`}<p id="inbox-error" class="inline-error" role="alert"></p>`;
}
export function supportFilterMarkup(selected = "", staff = false) {
  return `<div class="field support-filter"><label for="support-status-filter">Status</label><select id="support-status-filter"><option value="">All statuses</option>${Object.entries(
    SUPPORT_STATUSES,
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${selected === value ? "selected" : ""}>${e(staff && value === "waiting-on-customer" ? "Waiting on customer" : label)}</option>`,
    )
    .join("")}</select></div>`;
}
export function supportListMarkup(data, { staff = false, status = "" } = {}) {
  if (!Array.isArray(data?.cases))
    throw new Error("Support history was incomplete. Refresh to try again.");
  const items = data.cases.filter((item) => resourceId(item?.id));
  const prefix = staff ? "/app/operator/support/" : "/app/support/";
  return `${staff ? '<p class="notice">Queue metadata only. Opening a private conversation requires a recorded support reason.</p>' : '<p class="help-text">Your workspace’s support requests and replies. Messages stay inside AppScreen; this page does not confirm email delivery.</p>'}${supportFilterMarkup(status, staff)}${items.length ? `<div class="case-list">${items.map((item) => `<article class="case-row"><div><a href="${prefix}${encodeURIComponent(item.id)}" data-link class="case-link">Support request <span class="case-reference">${reference(item.id)}</span></a><p class="help-text mb0">Updated ${e(messageTime(item.updatedAt))}${staff ? `<br>Workspace <code class="operator-id">${e(resourceId(item.workspaceId) || "Unavailable")}</code>` : ""}</p></div><div class="case-list-state">${badge(item.status, staff)}<a href="${prefix}${encodeURIComponent(item.id)}" data-link class="button quiet">${staff ? "Review access" : "Open conversation"}</a></div></article>`).join("")}</div>${pagination(data.nextCursor, staff ? "more-operator-support" : "more-support")}` : `<section class="panel empty-conversation"><h2>${status ? "No requests with this status." : "No support requests yet."}</h2><p class="mb0">${staff ? "New requests will appear in this queue." : "Send a problem report when you need help with a campaign or your workspace."}</p></section>`}<p id="support-list-error" class="inline-error" role="alert"></p>`;
}
export function supportConversationMarkup(data, { staff = false } = {}) {
  const item = data?.case;
  if (!resourceId(item?.id) || !Array.isArray(data.messages))
    throw new Error(
      "The support conversation was incomplete. Refresh to try again.",
    );
  const knownMessages = data.messages.filter(
    (message) =>
      ["customer", "support"].includes(message.author) &&
      message.visibility !== "internal" &&
      typeof message.body === "string",
  );
  const transitions =
    staff && Array.isArray(data.allowedTransitions)
      ? data.allowedTransitions.filter((value) =>
          Object.hasOwn(SUPPORT_STATUSES, value),
        )
      : [];
  const replyAllowed =
    item.canReply === true &&
    data.allowedActions?.followUp === true &&
    (!staff ||
      item.status === "waiting-on-customer" ||
      transitions.includes("waiting-on-customer"));
  const replyUnavailable = staff
    ? "Move this request to In progress using the status form before sending a customer reply. Recovering a historical status also requires an internal note."
    : "This historical request requires staff review before you can reply. Start a new problem report and mention this reference.";
  return `<div class="case-heading"><div><span class="eyebrow">SUPPORT REQUEST ${reference(item.id)}</span><p class="help-text mb0">Created ${e(messageTime(item.createdAt))}</p></div>${badge(item.status, staff)}</div>${staff ? `<p class="notice warning">Private support detail · this access was recorded. Only the reply box below sends a message to the customer.</p><dl class="operator-details"><div><dt>Requester</dt><dd>${e(data.requester?.email || "Unavailable")}</dd></div><div><dt>Workspace</dt><dd><code class="operator-id">${e(resourceId(item.workspaceId) || "Unavailable")}</code></dd></div></dl>` : ""}${data.initialMessageAvailable === false ? '<p class="notice warning">The original message is unavailable in this older request. New replies can still be recorded where allowed.</p>' : ""}<section aria-label="Conversation" class="message-timeline">${knownMessages.length ? knownMessages.map((message) => `<article class="support-message ${message.author === "support" ? "from-support" : ""}"><div class="message-meta"><strong>${message.author === "support" ? "AppScreen support" : "Customer"}</strong><time>${e(messageTime(message.createdAt))}</time></div><p class="message-body">${e(message.body)}</p></article>`).join("") : '<p class="help-text">No readable messages were returned for this request.</p>'}</section>${staff && Array.isArray(data.internalNotes) && data.internalNotes.length ? `<section class="panel internal-notes"><h2>Internal notes</h2><p class="help-text">Staff only. These notes are not included in the customer conversation.</p>${data.internalNotes.map((note) => `<article><div class="message-meta"><span>Staff note</span><time>${e(messageTime(note.createdAt))}</time></div><p class="message-body">${e(note.body)}</p></article>`).join("")}</section>` : ""}${replyAllowed ? `<section class="panel mt20"><h2>${staff ? "Reply to the customer" : "Add a reply"}</h2><p class="help-text">${staff ? "This message will be visible to the customer. Review it before sending. Sending a reply moves the request to waiting on customer." : "Include the details needed to continue. Do not send passwords, access tokens, or private screenshots. A reply to a resolved request reopens it."}</p><form id="support-reply-form" data-staff="${staff}"><div class="field"><label for="support-reply">${staff ? "Customer-visible reply" : "Your message"}</label><textarea id="support-reply" name="message" required minlength="1" maxlength="3000"></textarea></div><p id="support-reply-error" class="inline-error" role="alert"></p><button class="button primary" type="submit">${staff ? "Review reply" : "Send reply"}</button></form></section>` : `<p class="notice warning">${replyUnavailable}</p>`}${
    staff
      ? `<section class="panel mt20"><h2>Update case status</h2><p class="help-text">Status changes are visible to the customer. Internal notes stay private. Escalation requires a note describing why another review is needed.</p><form id="support-status-form"><div class="field"><label for="support-next-status">New status</label><select id="support-next-status" name="status" required><option value="">Choose a status</option>${transitions
          .filter((value) => value !== item.status)
          .map(
            (value) =>
              `<option value="${value}">${e(value === "waiting-on-customer" ? "Waiting on customer" : SUPPORT_STATUSES[value])}</option>`,
          )
          .join(
            "",
          )}</select></div><div class="field"><label for="support-internal-note">Internal note (required for escalation)</label><textarea id="support-internal-note" name="internalNote" maxlength="3000"></textarea></div><p id="support-status-error" class="inline-error" role="alert"></p><button class="button" type="submit" ${transitions.filter((value) => value !== item.status).length ? "" : "disabled"}>Review status change</button></form></section>`
      : ""
  }`;
}
export function supportAccessMarkup(id, receipt = "") {
  if (!resourceId(id)) throw new Error("This support link is incomplete.");
  return `${receipt ? `<p class="notice success" role="status">${e(receipt)}</p>` : ""}<section class="panel private-access"><h2>Open private conversation</h2><p>Request ${reference(id)} may contain private customer information. Record why you need to open it. This access is audited; the queue has not loaded its messages.</p><form id="support-access-form"><div class="field"><label for="support-access-reason">Reason for accessing this request</label><textarea id="support-access-reason" name="reason" required minlength="10" maxlength="500" placeholder="For example, investigate the customer’s reported export failure."></textarea></div><p id="support-access-error" class="inline-error" role="alert"></p><button class="button" type="submit">Open private conversation</button></form></section>`;
}
export function parseSupportReply(values, detail) {
  const message = String(values.message || "").trim();
  if (message.length < 1 || message.length > 3000)
    throw new Error("Write a message between 1 and 3000 characters.");
  if (
    !resourceId(detail?.case?.id) ||
    !Number.isInteger(detail.case.version) ||
    detail.case.version < 1
  )
    throw new Error("Reload this conversation before replying.");
  return { message, expectedVersion: detail.case.version };
}
export function parseSupportStatus(values, detail) {
  const status = String(values.status || "");
  const internalNote = String(values.internalNote || "").trim();
  if (
    !Object.hasOwn(SUPPORT_STATUSES, status) ||
    !detail?.allowedTransitions?.includes(status) ||
    status === detail.case?.status
  )
    throw new Error("Choose an available new status.");
  if (
    internalNote.length > 3000 ||
    (internalNote && internalNote.length < 10) ||
    ((status === "escalated" ||
      !Object.hasOwn(SUPPORT_STATUSES, detail.case.status)) &&
      internalNote.length < 10)
  )
    throw new Error(
      "Use an internal note between 10 and 3000 characters. Escalation and historical-status recovery require a note.",
    );
  if (!Number.isInteger(detail.case.version) || detail.case.version < 1)
    throw new Error("Reload this conversation before changing its status.");
  return {
    status,
    ...(internalNote ? { internalNote } : {}),
    expectedVersion: detail.case.version,
  };
}
export function supportReviewMarkup(kind, id, payload) {
  const reply = kind === "reply";
  return `<button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><h2 id="modal-title">${reply ? "Review customer reply" : "Review status change"}</h2><p>Support request ${reference(id)}</p>${reply ? `<p class="help-text">This exact message will be visible to the customer. The status becomes waiting on customer.</p><blockquote class="review-message message-body">${e(payload.message)}</blockquote>` : `<p>New status: <strong>${e(payload.status === "waiting-on-customer" ? "Waiting on customer" : SUPPORT_STATUSES[payload.status])}</strong></p>${payload.internalNote ? `<p class="help-text">Internal note · staff only</p><blockquote class="review-message message-body">${e(payload.internalNote)}</blockquote>` : ""}`}<form id="support-confirm-form"><label class="check"><input type="checkbox" name="confirmed" required><span>${reply ? "I have reviewed this customer-visible reply." : "I have reviewed this status change and any private note."}</span></label><p id="support-confirm-error" class="inline-error" role="alert"></p><div class="actions"><button class="button quiet" type="button" data-action="close-dialog">Go back</button><button class="button primary" type="submit">${reply ? "Send reply" : "Change status"}</button></div></form>`;
}
export function supportErrorMessage(error) {
  if (error?.code === "SUPPORT_VERSION_CONFLICT")
    return "This request changed after you opened it. Your text is still here. Copy it if needed, then reload the conversation before sending again.";
  if (["CONNECTION_FAILED", "REQUEST_TIMEOUT"].includes(error?.code))
    return "The response was interrupted. Your message may already be recorded. Retry unchanged to reuse this request and avoid sending it twice.";
  return error?.message || "This support action could not finish. Try again.";
}

// Private text stays in tab memory only. Uncertain retries reuse the exact intent.
export function createActionIntent(createId = () => crypto.randomUUID()) {
  let current = null;
  return {
    prepare(payload) {
      const fingerprint = JSON.stringify(payload);
      if (!current || current.fingerprint !== fingerprint)
        current = { fingerprint, idempotencyKey: createId() };
      return {
        ...JSON.parse(fingerprint),
        idempotencyKey: current.idempotencyKey,
      };
    },
    complete(key) {
      if (current?.idempotencyKey === key) current = null;
    },
  };
}
