import { escapeHTML as e } from "./utils.mjs";
import { messageTime, resourceId } from "./engagement.mjs";

export function reportDays(value) {
  const days = Number(value || 30);
  return [7, 30, 90].includes(days) ? days : 30;
}
export function reportAlertHref(value) {
  if (
    ["/app/operator", "/app/operator/support", "/app/operator/report"].includes(
      value,
    )
  )
    return value;
  const match =
    typeof value === "string" &&
    value.match(/^\/app\/operator\/(jobs|support)\/([^/?#]+)$/);
  return match && resourceId(match[2]) ? value : "";
}
function count(value) {
  return Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat().format(value)
    : "Unavailable";
}
export function operationsReportMarkup(data) {
  const cohort = data.cohort || {};
  const activity = data.activity || {};
  return `<div class="report-toolbar"><div class="field"><label for="report-days">Reporting window</label><select id="report-days">${[7, 30, 90].map((days) => `<option value="${days}" ${days === reportDays(data.window?.days) ? "selected" : ""}>Last ${days} days</option>`).join("")}</select></div><p class="help-text mb0">${e(messageTime(data.window?.from))} – ${e(messageTime(data.window?.to))}</p></div>${data.environment !== "production" ? '<p class="notice warning">Nonproduction activity · these counts are not production customer metrics.</p>' : ""}${data.captureStartedAt ? `<p class="help-text">First captured milestone: ${e(messageTime(data.captureStartedAt))}. Earlier activity is not backfilled.</p>` : '<p class="notice warning">Milestone capture has not started or its start time is unavailable. No historical activity has been inferred.</p>'}<div class="operator-split"><section class="panel"><h2>Workspace milestones</h2><p class="help-text">These milestones belong to workspaces signed up within the same reporting window. This is not a sequential conversion funnel.</p><div class="table-wrap"><table><thead><tr><th scope="col">Milestone</th><th scope="col">Workspaces</th></tr></thead><tbody>${[
    ["Signed up", cohort.signups],
    ["First screenshot upload", cohort.firstUpload],
    ["First ready campaign", cohort.firstCampaign],
    ["First completed store export", cohort.firstExport],
    ["Paid conversion", cohort.paidConversion],
  ]
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${label}</th><td>${count(value)}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div></section><section class="panel"><h2>Provider usage</h2><dl class="operator-details"><div><dt>Input tokens</dt><dd>${count(activity.inputTokens)}</dd></div><div><dt>Output tokens</dt><dd>${count(activity.outputTokens)}</dd></div><div><dt>Unmetered usage events</dt><dd>${count(activity.unmeteredUsageEvents)}</dd></div></dl><p class="help-text mb0">Token counts are reported usage, not monetary cost estimates. Unmetered events lack complete valid input/output token counts.</p></section></div><section class="panel mt20"><h2>Operational alerts</h2><p class="help-text">A snapshot of persistent service conditions at this refresh. These are not email alerts.</p>${Array.isArray(data.alerts) && data.alerts.length ? `<div class="report-alerts">${data.alerts.map((alert) => `<article class="notice ${alert.severity === "critical" ? "error" : "warning"}"><div class="message-meta"><strong>${alert.severity === "critical" ? "Critical" : "Warning"} · ${count(alert.count)}</strong><span>${e(alert.code)}</span></div><p>${e(alert.message)}</p>${alert.oldestAt ? `<p class="help-text">Oldest: ${e(messageTime(alert.oldestAt))}</p>` : ""}${reportAlertHref(alert.href) ? `<a class="button quiet" href="${e(reportAlertHref(alert.href))}" data-link>Review condition</a>` : ""}</article>`).join("")}</div>` : '<p class="help-text mb0">No alert conditions were returned for this snapshot.</p>'}</section><section class="panel mt20"><h2>Job activity</h2>${Array.isArray(activity.jobs) && activity.jobs.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Jobs</th></tr></thead><tbody>${activity.jobs.map((item) => `<tr><td>${e(item.kind)}</td><td>${e(item.status)}</td><td>${count(item.count)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="help-text mb0">No job activity was returned for this window.</p>'}</section><section class="panel mt20"><h2>How to read this report</h2><ul class="report-definitions">${(Array.isArray(
    data.definitions,
  )
    ? data.definitions
    : []
  )
    .filter((item) => typeof item === "string")
    .map((item) => `<li>${e(item)}</li>`)
    .join(
      "",
    )}</ul><p class="help-text mb0">A completed store export is not a browser-download counter. This content-free report does not include private screenshots, prompts, or support conversations.</p></section>`;
}
