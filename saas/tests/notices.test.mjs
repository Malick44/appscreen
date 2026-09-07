import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NOTICES_PATH,
  LICENSE_NOTICES,
  noticesFooterLink,
  loadLicenseNotices,
  thirdPartyNoticesMarkup,
} from "../notices.mjs";
import { escapeHTML } from "../utils.mjs";

const sources = {
  "/third-party/supabase-license.txt": new URL(
    "../../node_modules/@supabase/supabase-js/LICENSE",
    import.meta.url,
  ),
  "/render/fonts/LICENSE.txt": new URL(
    "../../render/fonts/LICENSE.txt",
    import.meta.url,
  ),
};

test("notices page and footer use the same public route and only the agreed license sources", async () => {
  assert.equal(NOTICES_PATH, "/third-party-notices");
  assert.match(noticesFooterLink(), /href="\/third-party-notices" data-link/);
  assert.deepEqual(
    LICENSE_NOTICES.map((item) => item.href),
    Object.keys(sources),
  );
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /path === NOTICES_PATH/);
  assert.match(app, /noticesFooterLink\(\)/);
});
test("full Supabase and Inter texts remain exactly the installed source text", async () => {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([url, file]) => [
        url,
        await readFile(file, "utf8"),
      ]),
    ),
  );
  const result = await loadLicenseNotices(async (url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    return new Response(texts[url], {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });
  for (const notice of LICENSE_NOTICES)
    assert.equal(
      result.find((item) => item.id === notice.id).text,
      texts[notice.href],
    );
  const html = thirdPartyNoticesMarkup(result);
  for (const text of Object.values(texts))
    assert.ok(
      html.includes(escapeHTML(text)),
      "The entire notice is included without trimming or rewriting.",
    );
  assert.match(html, /Partial notice coverage/);
  assert.match(html, /not a completed commercial-rights audit/);
  assert.doesNotMatch(html, /Copyright.*AppScreen|Samsung/);
});
test("loaded notice content is escaped and cannot replace source links or execute markup", () => {
  const text = '<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n';
  const html = thirdPartyNoticesMarkup([
    { id: "supabase", text, href: "javascript:alert(1)" },
    { id: "inter", text },
  ]);
  assert.ok(html.includes(escapeHTML(text)));
  assert.doesNotMatch(html, /<script|<img|href="javascript/);
  assert.match(html, /href="\/third-party\/supabase-license.txt"/);
});
test("failed and wrong-content-type notice loads are explicit, retryable, and never replaced with invented text", async () => {
  const results = await loadLicenseNotices(
    async () =>
      new Response("<html>App screen</html>", {
        headers: { "content-type": "text/html" },
      }),
  );
  assert.ok(results.every((item) => item.error && !item.text));
  const html = thirdPartyNoticesMarkup(results);
  assert.match(html, /Retry loading notices/);
  assert.match(html, /No substitute license text has been supplied/);
  assert.doesNotMatch(html, /App screen|Permission is hereby granted/);
  const failure = await loadLicenseNotices(async () => {
    throw new Error("PRIVATE_SERVER_ERROR");
  });
  assert.doesNotMatch(thirdPartyNoticesMarkup(failure), /PRIVATE_SERVER_ERROR/);
  const loading = thirdPartyNoticesMarkup([], { loading: true });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading the original license text/);
});
