import test from "node:test";
import assert from "node:assert/strict";
import {
  operationsReportMarkup,
  reportDays,
  reportAlertHref,
} from "../report.mjs";
test("report windows and alert destinations are strictly bounded", () => {
  for (const days of [7, 30, 90]) assert.equal(reportDays(String(days)), days);
  for (const value of ["365", "-1", "NaN", "30&admin=true"])
    assert.equal(reportDays(value), 30);
  assert.equal(
    reportAlertHref("/app/operator/support"),
    "/app/operator/support",
  );
  for (const path of [
    "javascript:alert(1)",
    "//evil.test",
    "/app/billing",
    "/api/operator/credits",
  ])
    assert.equal(reportAlertHref(path), "");
});
test("report remains content-free, labels partial capture, and never equates missing tokens with zero cost", () => {
  const html = operationsReportMarkup({
    window: { days: 30 },
    environment: "nonproduction",
    captureStartedAt: null,
    cohort: { signups: 0 },
    activity: {
      inputTokens: null,
      outputTokens: null,
      unmeteredUsageEvents: 2,
      jobs: [],
    },
    alerts: [
      {
        code: "<unsafe>",
        severity: "critical",
        count: 1,
        message: "<script>alert(1)</script>",
        href: "javascript:alert(1)",
      },
    ],
    definitions: ["<img onerror=1>"],
    customerPrompts: "PRIVATE_CONTENT_SENTINEL",
  });
  assert.match(html, /Nonproduction activity/);
  assert.match(html, /No historical activity has been inferred/);
  assert.match(html, /not a sequential conversion funnel/);
  assert.match(html, /Input tokens<\/dt><dd>Unavailable/);
  assert.match(html, /not monetary cost estimates/);
  assert.match(html, /Unmetered events lack complete valid input\/output token counts/);
  assert.doesNotMatch(
    html,
    /PRIVATE_CONTENT_SENTINEL|<script|<img|href="javascript/,
  );
});
