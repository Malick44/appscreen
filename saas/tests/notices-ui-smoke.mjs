// Read-only public-page check. No sign-in, account records, or external requests.
// Run explicitly: node saas/tests/notices-ui-smoke.mjs
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = new URL(
  process.env.APPSCREEN_QA_BASE_URL || "http://127.0.0.1:8001",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
  "Public notice QA is loopback-only.",
);
const expected = [
  await readFile(
    new URL(
      "../../node_modules/@supabase/supabase-js/LICENSE",
      import.meta.url,
    ),
    "utf8",
  ),
  await readFile(
    new URL("../../render/fonts/LICENSE.txt", import.meta.url),
    "utf8",
  ),
];
const output = await mkdtemp(join(tmpdir(), "appscreen-notices-ui-"));
const report = {
  screenshots: [],
  pageErrors: [],
  externalRequests: [],
  writes: [],
  checks: [],
};
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  let failSupabaseOnce = true;
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin !== base.origin &&
      !["data:", "blob:"].includes(url.protocol)
    ) {
      report.externalRequests.push(url.origin);
      await route.abort();
      return;
    }
    if (request.method() !== "GET") {
      report.writes.push(request.method());
      await route.abort();
      return;
    }
    if (
      url.pathname === "/third-party/supabase-license.txt" &&
      failSupabaseOnce
    ) {
      failSupabaseOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Synthetic public license load failure.",
      });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  const response = await page.goto(new URL("/third-party-notices", base).href);
  assert.equal(response.status(), 200);
  await page.getByRole("button", { name: "Retry loading notices" }).waitFor();
  assert.match(
    await page.locator("#license-notices").innerText(),
    /No substitute license text/,
  );
  assert.equal(await page.locator(".license-text").count(), 1);
  assert.equal(await page.locator(".license-text").textContent(), expected[1]);
  report.checks.push(
    "failed source stays explicit; unaffected Inter notice remains complete",
  );
  await page.getByRole("button", { name: "Retry loading notices" }).click();
  await page.locator(".license-text").nth(1).waitFor();
  assert.deepEqual(
    await page.locator(".license-text").allTextContents(),
    expected,
  );
  assert.equal(
    await page.getByRole("button", { name: "Retry loading notices" }).count(),
    0,
  );
  assert.match(
    await page.locator(".third-party-notices").innerText(),
    /Partial notice coverage/,
  );
  assert.equal(
    await page.locator('footer a[href="/third-party-notices"]').count(),
    1,
  );
  assert.equal(await page.locator(".license-notice .button").count(), 2);
  report.checks.push(
    "retry succeeds with both exact source texts, no invented notice or blanket rights claim",
  );
  for (const [size, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    const path = join(output, `${size}-notices.png`);
    await page.screenshot({ path, fullPage: false, animations: "disabled" });
    report.screenshots.push(path);
    await page.locator("#inter-notice-title").scrollIntoViewIfNeeded();
    const interPath = join(output, `${size}-inter-notice.png`);
    await page.screenshot({
      path: interPath,
      fullPage: false,
      animations: "disabled",
    });
    report.screenshots.push(interPath);
    for (const link of await page.locator(".license-notice .button").all()) {
      await link.scrollIntoViewIfNeeded();
      const rect = await link.boundingBox();
      assert.ok(
        rect.height >= 44 && rect.x >= 0 && rect.x + rect.width <= width + 1,
      );
    }
    const footerLink = page.locator('footer a[href="/third-party-notices"]');
    await footerLink.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.ok(
      await footerLink.evaluate(
        (element) =>
          document.activeElement === element &&
          getComputedStyle(element).outlineStyle !== "none",
      ),
    );
    assert.equal(
      await page
        .locator(".license-text")
        .first()
        .evaluate((element) => getComputedStyle(element).whiteSpace),
      "pre-wrap",
    );
    report.checks.push(
      `${size}: no horizontal overflow; 44px source links, wrapped text, and visible keyboard footer focus`,
    );
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.writes, []);
  report.checks.push(
    "no browser errors, external requests, sign-in, or write actions",
  );
} finally {
  await browser.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.checks.length, output }));
