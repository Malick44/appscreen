import { escapeHTML as e } from "./utils.mjs";

export const NOTICES_PATH = "/third-party-notices";
export const LICENSE_NOTICES = Object.freeze([
  Object.freeze({
    id: "supabase",
    title: "Supabase JavaScript client",
    label: "MIT License",
    description:
      "Notice distributed with the installed @supabase/supabase-js package.",
    href: "/third-party/supabase-license.txt",
  }),
  Object.freeze({
    id: "inter",
    title: "Inter font",
    label: "SIL Open Font License 1.1",
    description:
      "Notice distributed with the Inter font bundled for campaign rendering.",
    href: "/render/fonts/LICENSE.txt",
  }),
]);

export function noticesFooterLink() {
  return `<a href="${NOTICES_PATH}" data-link>Third-party notices</a>`;
}

export async function loadLicenseNotices(fetcher = fetch, timeoutMs = 10000) {
  return Promise.all(
    LICENSE_NOTICES.map(async (notice) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(notice.href, {
          method: "GET",
          headers: { Accept: "text/plain" },
          credentials: "omit",
          signal: controller.signal,
        });
        if (
          !response.ok ||
          !/^text\/plain(?:;|$)/i.test(
            response.headers.get("content-type") || "",
          )
        )
          throw new Error("Notice source unavailable.");
        const text = await response.text();
        if (!text.trim() || text.length > 100000)
          throw new Error("Notice text is incomplete.");
        return { id: notice.id, text };
      } catch {
        return {
          id: notice.id,
          error:
            "The full license text could not load. Retry, or open its original text file below. No substitute license text has been supplied.",
        };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
}

export function thirdPartyNoticesMarkup(
  results = [],
  { loading = false } = {},
) {
  return `<article class="prose third-party-notices"><p class="eyebrow">Included third-party notices</p><h1>Third-party notices</h1><p>AppScreen uses third-party software and fonts. The notices below are reproduced from the files distributed with the identified components.</p><p class="notice warning"><strong>Partial notice coverage.</strong> This page covers only the two components listed below. It is not a completed commercial-rights audit or a blanket license clearance for the application, its other dependencies, screenshots, device artwork, or other assets.</p><p class="help-text">These notices do not establish the copyright holder or license of the AppScreen application itself. Review the relevant source files and remaining asset rights before commercial distribution.</p><div id="license-notices" ${loading ? 'aria-busy="true"' : ""}>${LICENSE_NOTICES.map(
    (notice) => {
      const result = results.find((item) => item.id === notice.id);
      return `<section class="license-notice" aria-labelledby="${notice.id}-notice-title"><h2 id="${notice.id}-notice-title">${notice.title}</h2><p class="license-label">${notice.label}</p><p>${notice.description}</p>${loading ? '<p class="help-text" role="status">Loading the original license text…</p>' : typeof result?.text === "string" ? `<pre class="license-text" aria-label="Full ${e(notice.label)} notice">${e(result.text)}</pre>` : `<p class="notice error" role="alert">${e(result?.error || "The full license text is unavailable. Open its original source or retry loading the notices.")}</p>`}<div class="actions"><a class="button quiet" href="${notice.href}">Open original text file</a></div></section>`;
    },
  ).join(
    "",
  )}</div>${!loading && results.some((item) => item.error) ? '<div class="actions"><button class="button" type="button" data-action="refresh">Retry loading notices</button></div>' : ""}</article>`;
}
