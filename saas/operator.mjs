import { escapeHTML as e, formatCredits } from "./utils.mjs";

export function operatorTimestamp(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  return new Date(value)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}
function bytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return "—";
  const number = Number(value);
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
  if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
  return `${(number / 1024 ** 3).toFixed(2)} GiB`;
}
function status(value) {
  return `<span class="badge">${e(value || "Unavailable")}</span>`;
}
function table(headers, rows, empty) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th scope="col">${e(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="help-text mb0">${e(empty)}</p>`;
}
function code(value) {
  return `<code class="operator-id">${e(value || "—")}</code>`;
}

export function operatorOverviewMarkup(data) {
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const support = Array.isArray(data.support) ? data.support : [];
  return `<p class="notice">Restricted operations data. Customer screenshots, briefs, prompts, and support messages are not shown here.</p><div class="operator-stats">${[
    ["Pending billing events", formatCredits(data.billing?.pendingEvents)],
    ["Failed billing events", formatCredits(data.billing?.failedEvents)],
    ["Jobs holding credits", formatCredits(data.credits?.reservedJobs)],
    ["Stored asset bytes", bytes(data.storage?.assetBytes)],
  ]
    .map(
      ([label, value]) =>
        `<div class="billing-stat"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join(
      "",
    )}</div><section class="panel"><h2>Recent jobs</h2><p class="help-text">Open a job for its saved stages, token usage, and credit reservation. Times are UTC.</p>${table(
    [
      "Job / kind",
      "Workspace / project",
      "State / stage",
      "Attempts",
      "Updated",
      "Error code",
    ],
    jobs.map(
      (job) =>
        `<tr><td><a href="/app/operator/jobs/${encodeURIComponent(job.id)}" data-link>${code(job.id)}</a><br>${e(job.kind)}</td><td>${code(job.workspaceId)}<br>${code(job.projectId)}</td><td>${status(job.status)}<br>${e(job.stage)}</td><td>${formatCredits(job.attempts)}</td><td>${operatorTimestamp(job.updatedAt)}</td><td>${code(job.errorCode)}</td></tr>`,
    ),
    "No job records were returned.",
  )}</section><section class="panel mt20"><h2>Support and account requests</h2><p class="help-text">Request metadata only. Private messages and account contents are not loaded.</p>${table(
    ["Request", "Workspace", "Kind", "Status", "Created"],
    support.map(
      (item) =>
        `<tr><td>${code(item.id)}</td><td>${code(item.workspaceId)}</td><td>${e(item.kind)}</td><td>${status(item.status)}</td><td>${operatorTimestamp(item.createdAt)}</td></tr>`,
    ),
    "No support requests were returned.",
  )}</section><section class="panel mt20"><h2>Adjust workspace credits</h2><p class="help-text">Use an adjustment only for a documented correction. The next step shows the exact workspace, amount, and reason before anything is changed.</p><form id="operator-credit-form"><div class="fields-row"><div class="field"><label for="operator-workspace">Workspace ID</label><input id="operator-workspace" name="workspaceId" required autocomplete="off" maxlength="36" placeholder="Paste the full workspace UUID"></div><div class="field"><label for="operator-amount">Credit adjustment</label><input id="operator-amount" name="amount" type="number" required min="-1000" max="1000" step="1" placeholder="For example, 5 or -5"><small>Positive adds credits. Negative removes credits. Zero is not allowed.</small></div></div><div class="field"><label for="operator-reason">Reason for the audit record</label><textarea id="operator-reason" name="reason" required minlength="10" maxlength="1000" placeholder="Explain the correction. Do not include private screenshots, access tokens, or payment details."></textarea></div><p id="operator-credit-error" class="inline-error" role="alert"></p><button class="button" type="submit">Review adjustment</button></form><div id="operator-credit-receipt" aria-live="polite"></div></section>`;
}
export function operatorJobMarkup(data) {
  const job = data.job || {};
  return `<p class="notice">This view contains operational metadata only. No customer screenshots or prompts are requested.</p><section class="panel"><dl class="operator-details">${[
    ["Job", code(job.id)],
    ["Workspace", code(job.workspaceId)],
    ["Project", code(job.projectId)],
    ["Kind", e(job.kind)],
    ["State", status(job.status)],
    ["Stage", e(job.stage)],
    ["Attempts", formatCredits(job.attempts)],
    ["Created", operatorTimestamp(job.createdAt)],
    ["Updated", operatorTimestamp(job.updatedAt)],
    ["Error code", code(job.errorCode)],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join(
      "",
    )}</dl></section><div class="operator-split mt20"><section class="panel"><h2>Saved stages</h2>${table(
    ["Stage", "Time (UTC)"],
    (data.events || []).map(
      (event) =>
        `<tr><td>${e(event.stage)}</td><td>${operatorTimestamp(event.createdAt)}</td></tr>`,
    ),
    "No saved stage events were returned.",
  )}</section><section class="panel"><h2>Credit reservation</h2><dl class="operator-details"><div><dt>Amount</dt><dd>${formatCredits(data.reservation?.amount)}</dd></div><div><dt>Status</dt><dd>${status(data.reservation?.status)}</dd></div></dl><p class="help-text mb0">A reservation is not a second charge. This is the server’s current ledger status.</p></section></div><section class="panel mt20"><h2>Provider token usage</h2>${table(
    ["Stage", "Input tokens", "Output tokens", "Total tokens"],
    (data.usage || []).map(
      (usage) =>
        `<tr><td>${e(usage.stage)}</td><td>${formatCredits(usage.inputTokens)}</td><td>${formatCredits(usage.outputTokens)}</td><td>${formatCredits(usage.totalTokens)}</td></tr>`,
    ),
    "No token usage records were returned.",
  )}</section>`;
}
export function parseCreditAdjustment(values) {
  const workspaceId = String(values.workspaceId || "").trim();
  const amount = Number(values.amount);
  const reason = String(values.reason || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      workspaceId,
    )
  )
    throw new Error("Enter the full workspace UUID.");
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000)
    throw new Error(
      "Use a whole-number adjustment from -1000 to 1000, excluding zero.",
    );
  if (reason.length < 10 || reason.length > 1000)
    throw new Error("Give a reason between 10 and 1000 characters.");
  return { workspaceId, amount, reason };
}
export function creditReviewMarkup(payload) {
  return `<button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><h2 id="modal-title">Confirm credit adjustment</h2><p>This writes a correction to the workspace’s credit ledger. It does not change its subscription plan or charge a payment method.</p><dl class="operator-details"><div><dt>Workspace</dt><dd>${code(payload.workspaceId)}</dd></div><div><dt>Adjustment</dt><dd><strong>${payload.amount > 0 ? "+" : ""}${e(payload.amount)} credits</strong></dd></div><div><dt>Reason</dt><dd>${e(payload.reason)}</dd></div></dl><form id="operator-credit-confirm-form"><div class="field"><label for="credit-confirmation">Type ADJUST CREDITS to confirm</label><input id="credit-confirmation" name="confirmation" required pattern="ADJUST CREDITS" autocomplete="off" spellcheck="false"></div><p id="credit-confirm-error" class="inline-error" role="alert"></p><div class="actions"><button type="button" class="button quiet" data-action="close-dialog">Cancel</button><button type="submit" class="button danger">Apply credit adjustment</button></div></form>`;
}
export function creditReceiptMarkup(result) {
  const receipt = result.receipt || result;
  return `<div class="notice success mt20"><strong>Credit adjustment recorded.</strong><dl class="operator-details"><div><dt>Receipt</dt><dd>${code(receipt.id || receipt.receiptId)}</dd></div><div><dt>Workspace</dt><dd>${code(receipt.workspaceId)}</dd></div><div><dt>Recorded amount</dt><dd>${formatCredits(receipt.amount)} credits</dd></div><div><dt>Recorded at</dt><dd>${operatorTimestamp(receipt.createdAt)}</dd></div></dl><p class="mb0">This receipt confirms the adjustment only. No resulting balance has been inferred.</p></div>`;
}
