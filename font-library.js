// Browser-only font catalog and lazy loader. Importing this script never starts a request.
(function (root) {
    'use strict';

    const google = (name, style, weights, fallback = 'serif', italic = false) => ({
        name, cssFamily: name, value: `"${name}", ${fallback}`,
        provider: 'google', style, weights, italic, fancy: true,
        stylesheet: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:${italic ? 'ital,wght@' + [0, 1].flatMap(slant => weights.map(weight => `${slant},${weight}`)).join(';') : 'wght@' + weights.join(';')}&display=swap`,
        source: `https://fonts.google.com/specimen/${encodeURIComponent(name).replace(/%20/g, '+')}`,
        license: `https://github.com/google/fonts/blob/main/ofl/${name.toLowerCase().replace(/ /g, '')}/OFL.txt`,
    });
    const independent = (name, cssFamily, slug, style, fallback) => ({
        name, cssFamily, value: `"${cssFamily}", ${fallback}`,
        provider: 'fontlibrary', style, weights: [400], fancy: true, hosted: 'local',
        stylesheet: `/render/fonts/fancy/${slug}.css`,
        source: `https://fontlibrary.org/en/font/${slug}`,
        license: `https://fontlibrary.org/en/font/${slug}`,
    });
    const range = (from, to) => Array.from({ length: (to - from) / 100 + 1 }, (_, i) => from + i * 100);
    const fonts = [
        google('Instrument Serif', 'Editorial serif', [400], 'serif', true),
        google('DM Serif Display', 'Statement serif', [400], 'serif', true),
        google('Bodoni Moda', 'Fashion serif', range(400, 900), 'serif', true),
        google('Cormorant Garamond', 'Elegant serif', range(300, 700), 'serif', true),
        google('Fraunces', 'Expressive serif', range(100, 900), 'serif', true),
        google('Playfair Display', 'Classic display', range(400, 900), 'serif', true),
        google('Syne', 'Artful geometric', range(400, 800), 'sans-serif'),
        google('DM Sans', 'Modern sans', range(100, 900), 'sans-serif', true),
        google('Unbounded', 'Wide futuristic', range(200, 900), 'sans-serif'),
        google('Bricolage Grotesque', 'Characterful sans', range(200, 800), 'sans-serif'),
        google('Great Vibes', 'Calligraphic script', [400], 'cursive'),
        google('Caveat', 'Handwritten', range(400, 700), 'cursive'),
        independent('Bagnard', 'BagnardRegular', 'bagnard', 'Independent serif', 'serif'),
        independent('Trickster', 'TricksterRegular', 'trickster', 'Playful display', 'fantasy'),
        independent('Cotham Sans', 'CothamSansRegular', 'cotham', 'Independent sans', 'sans-serif'),
        independent('Avara', 'AvaraBold', 'avara', 'Sculptural serif', 'serif'),
    ];
    fonts.forEach(font => { Object.freeze(font.weights); Object.freeze(font); });
    Object.freeze(fonts);

    const aliases = new Map();
    fonts.forEach(font => [font.name, font.cssFamily, font.value].forEach(alias => aliases.set(alias.toLowerCase(), font)));
    const loaded = new Set();
    const loading = new Map();
    const jobs = new Map();
    const stylesheets = new Map();

    function getFont(name) {
        if (typeof name !== 'string') return null;
        const family = name.trim();
        // Fontshare FFL v2 prohibits selectable fonts in third-party design tools.
        // Preserve saved CSS strings, but never fetch these legacy picker entries.
        const primaryFamily = family.split(',')[0].replace(/^[\s'"]+|[\s'"]+$/g, '').toLowerCase();
        if (['satoshi', 'general sans'].includes(primaryFamily)) return null;
        const catalogFont = aliases.get(family.toLowerCase());
        if (catalogFont) return catalogFont;
        // Family names only: never interpolate URLs, CSS declarations or control characters.
        if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,119}$/u.test(family)) return null;
        return { ...google(family, 'Google font', range(300, 900), 'sans-serif'), fancy: false, unknown: true };
    }

    function bounded(promise, milliseconds) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Font loading timed out')), Math.max(1, milliseconds));
            Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
    }

    function requestStylesheet(doc, href, remaining) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.appscreenFont = 'true';
        const ready = new Promise((resolve, reject) => {
            link.onload = () => resolve(link);
            link.onerror = () => reject(new Error('Font stylesheet could not load'));
            doc.head.appendChild(link);
        });
        return bounded(ready, remaining).then(() => {
            link.onload = null;
            link.onerror = null;
            return link;
        }, error => {
            link.onload = null;
            link.onerror = null;
            link.remove();
            throw error;
        });
    }

    function makeRequest(options) {
        const requestedWeights = Array.isArray(options.weights) ? options.weights : [400, 700];
        const weights = [...new Set(requestedWeights.map(Number).filter(weight => Number.isFinite(weight) && weight >= 1 && weight <= 1000))].sort((a, b) => a - b);
        const sample = typeof options.sample === 'string' && options.sample.trim() ? options.sample : 'BESbswy';
        return { weights: weights.length ? weights : [400], italic: options.italic === true, sample };
    }

    async function verifyRequests(doc, font, job, deadline) {
        let cursor = 0;
        while (cursor < job.requests.length) {
            const requests = job.requests.slice(cursor);
            cursor += requests.length;
            const results = await bounded(Promise.all(requests.flatMap(request => request.weights.map(weight =>
                doc.fonts.load(`${request.italic ? 'italic ' : ''}${weight} 16px "${font.cssFamily}"`, request.sample)
            ))), deadline - Date.now());
            if (results.some(faces => !faces || faces.length === 0)) throw new Error('Requested font faces are unavailable');
        }
        // Stop accepting here, before the async return boundary, so no late caller's
        // glyph/weight request can be dropped between verification and settlement.
        job.accepting = false;
    }

    function loadFont(name, options = {}) {
        const font = getFont(name);
        const doc = root.document;
        if (!font || !doc?.head || typeof doc?.fonts?.load !== 'function') return Promise.resolve(false);
        const request = makeRequest(options || {});
        // Families outside the curated catalog have no known axis inventory.
        // Request the selected face, and keep its CSS separate from an earlier
        // regular load so available bold/italic faces are not synthesized.
        const jobKey = font.unknown ? JSON.stringify([font.name, request.weights, request.italic]) : font.name;
        const current = jobs.get(jobKey);
        if (current?.accepting) {
            current.requests.push(request);
            return current.promise;
        }

        const milliseconds = Number(options?.timeout);
        const deadline = Date.now() + (Number.isFinite(milliseconds) && milliseconds > 0 ? Math.min(milliseconds, 30000) : 8000);
        const job = { family: font.name, accepting: true, requests: [request], promise: null };
        const work = Promise.resolve().then(async () => {
            let link = stylesheets.get(jobKey);
            const existingLink = link;
            let urls = [font.stylesheet];
            if (font.unknown) {
                const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.cssFamily).replace(/%20/g, '+')}`;
                const axes = request.italic ? `ital,wght@${request.weights.map(weight => `1,${weight}`).join(';')}` : `wght@${request.weights.join(';')}`;
                urls = [`${base}:${axes}&display=swap`];
                // Preserve the editor's existing synthetic-weight behavior for
                // single-style families, preferring a real italic when present.
                if (request.italic) urls.push(`${base}:ital@1&display=swap`);
                urls.push(`${base}&display=swap`);
            }
            for (const href of urls) {
                try {
                    if (!link) link = await requestStylesheet(doc, href, deadline - Date.now());
                    await verifyRequests(doc, font, job, deadline);
                    stylesheets.set(jobKey, link);
                    loaded.add(font.name);
                    job.accepting = false;
                    return true;
                } catch (_) {
                    if (link && link !== existingLink) link.remove();
                    link = existingLink;
                    if (existingLink || Date.now() >= deadline) break;
                }
            }
            job.accepting = false;
            return false;
        });
        job.promise = work.catch(() => { job.accepting = false; return false; }).finally(() => {
            if (jobs.get(jobKey) === job) jobs.delete(jobKey);
            if (loading.get(font.name) === job.promise) {
                const pending = [...jobs.values()].find(other => other.family === font.name);
                if (pending) loading.set(font.name, pending.promise);
                else loading.delete(font.name);
            }
        });
        jobs.set(jobKey, job);
        loading.set(font.name, job.promise);
        return job.promise;
    }

    root.AppScreenFontLibrary = Object.freeze({ fonts, getFont, loadFont, loaded, loading });
})(globalThis);
