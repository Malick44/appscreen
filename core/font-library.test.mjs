import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../font-library.js', import.meta.url), 'utf8');

function createLibrary({ stylesheet, fontLoad, document = true } = {}) {
    const links = [];
    const requests = [];
    const doc = {
        head: {
            appendChild(link) {
                links.push(link);
                queueMicrotask(() => {
                    if (stylesheet) stylesheet(link, links.length);
                    else link.onload?.();
                });
            },
        },
        createElement(tag) {
            assert.equal(tag, 'link');
            return { dataset: {}, removed: false, remove() { this.removed = true; } };
        },
        fonts: {
            load(css, sample) {
                requests.push({ css, sample });
                return fontLoad ? fontLoad(css, sample, requests.length) : Promise.resolve([{ family: 'Real loaded face' }]);
            },
        },
    };
    const context = { setTimeout, clearTimeout, ...(document ? { document: doc } : {}) };
    runInNewContext(source, context);
    return { library: context.AppScreenFontLibrary, links, requests };
}

test('catalog contains 16 curated families from two providers and preserves legacy Fontshare fonts', () => {
    const { library, links } = createLibrary();
    const curated = library.fonts.filter(font => font.fancy);
    assert.equal(curated.length, 16);
    assert.equal(curated.filter(font => font.provider === 'google').length, 12);
    assert.equal(curated.filter(font => font.provider === 'fontlibrary').length, 4);
    assert.equal(links.length, 0, 'Loading the script must not send requests');
    assert.equal(new Set(library.fonts.map(font => font.name)).size, library.fonts.length);
    for (const font of library.fonts) {
        assert.ok(font.style && font.weights.length);
        assert.ok(font.value.startsWith(`"${font.cssFamily}"`));
        assert.ok(font.stylesheet.startsWith(font.hosted === 'local' ? '/render/fonts/fancy/' : 'https://'));
        assert.ok(font.source.startsWith('https://'));
        assert.ok(font.license.startsWith('https://'));
        assert.equal(library.getFont(font.name), font);
        assert.equal(library.getFont(font.value), font);
        assert.equal(library.getFont(font.cssFamily), font);
    }
    assert.match(library.getFont('Satoshi').stylesheet, /api\.fontshare\.com/);
    assert.equal(library.getFont('General Sans').fancy, false);
    assert.equal(library.getFont('Bagnard').cssFamily, 'BagnardRegular');
    assert.equal(library.getFont('Avara').cssFamily, 'AvaraBold');
});

test('font lookup rejects URLs, CSS, control characters and non-family input', async () => {
    const { library, links } = createLibrary();
    for (const input of ['', ' ', null, {}, 'https://evil.example/font.css', 'Arial; color:red', 'A";}', 'foo\nbar', 'url(font.woff)', 'x'.repeat(121)]) {
        assert.equal(library.getFont(input), null, String(input));
        assert.equal(await library.loadFont(input), false);
    }
    assert.equal(links.length, 0);
    assert.equal(library.getFont('Noto Sans JP').provider, 'google');
    assert.match(library.getFont('Noto Sans JP').stylesheet, /family=Noto\+Sans\+JP:wght@300;400;500;600;700;800;900/);
});

test('independent font CSS, original binaries and full licenses are bundled locally', () => {
    const { library } = createLibrary();
    const licenseNames = { Bagnard: 'Bagnard', Trickster: 'Trickster', 'Cotham Sans': 'Cotham', Avara: 'Avara' };
    for (const font of library.fonts.filter(font => font.hosted === 'local')) {
        const cssURL = new URL(`..${font.stylesheet}`, import.meta.url);
        const css = readFileSync(cssURL, 'utf8');
        assert.ok(css.includes(`font-family: '${font.cssFamily}'`));
        const binaryName = css.match(/url\('\.\/([^']+)'\)/)?.[1];
        assert.ok(binaryName, 'Each local stylesheet references a packaged font');
        const binary = readFileSync(new URL(binaryName, cssURL));
        assert.ok(binary.length > 1000, 'Font binary is not a placeholder or HTML redirect');
        assert.ok(binary.subarray(0, 4).equals(Buffer.from('OTTO')) || binary.readUInt32BE(0) === 0x00010000);
        const licenseURL = new URL(`${licenseNames[font.name]}-OFL.txt`, cssURL);
        assert.ok(existsSync(licenseURL));
        const license = readFileSync(licenseURL, 'utf8');
        assert.match(license, /SIL Open Font License|SIL OPEN FONT LICENSE/);
        assert.match(license, /DISCLAIMER|Disclaimer/);
        assert.ok(license.length > 3500, 'Keep the full OFL terms with every bundled font');
    }
});

test('concurrent calls share one promise, verify each sample and use actual provider CSS family', async () => {
    const { library, links, requests } = createLibrary();
    const first = library.loadFont('Bagnard', { weights: [400], sample: 'First headline' });
    const second = library.loadFont('BagnardRegular', { weights: [700], italic: true, sample: '日本語' });
    assert.equal(first, second);
    assert.equal(library.loading.get('Bagnard'), first);
    assert.equal(await first, true);
    assert.equal(links.length, 1);
    assert.equal(library.loaded.has('Bagnard'), true);
    assert.equal(library.loading.size, 0);
    assert.deepEqual(requests, [
        { css: '400 16px "BagnardRegular"', sample: 'First headline' },
        { css: 'italic 700 16px "BagnardRegular"', sample: '日本語' },
    ]);
});

test('known regular-only faces request valid CSS without unsupported weight variants', async () => {
    const { library, links } = createLibrary();
    assert.equal(await library.loadFont('Great Vibes'), true);
    assert.match(links[0].href, /:wght@400&display=swap$/);
    assert.equal(await library.loadFont('Instrument Serif', { italic: true }), true);
    assert.match(links[1].href, /:ital,wght@0,400;1,400&display=swap$/);
});

test('already loaded families still verify new weights and localized glyphs without another stylesheet', async () => {
    const { library, links, requests } = createLibrary();
    assert.equal(await library.loadFont('Fraunces', { weights: [400], sample: 'Hello' }), true);
    assert.equal(await library.loadFont('Fraunces', { weights: [900], italic: true, sample: 'Český nadpis' }), true);
    assert.equal(links.length, 1);
    assert.deepEqual(requests.at(-1), { css: 'italic 900 16px "Fraunces"', sample: 'Český nadpis' });
});

test('a request arriving during face loading is also verified before shared promise settles', async () => {
    let release;
    const { library, requests } = createLibrary({
        fontLoad: (_css, _sample, count) => count === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve([{}]),
    });
    const first = library.loadFont('Caveat', { weights: [400], sample: 'First' });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const second = library.loadFont('Caveat', { weights: [700], sample: 'Second' });
    assert.equal(first, second);
    release([{}]);
    assert.equal(await second, true);
    assert.equal(requests.length, 2);
    assert.equal(requests.at(-1).sample, 'Second');
});

test('unknown Google families retry regular-only CSS when their full-weight request fails', async () => {
    const { library, links } = createLibrary({ stylesheet: (link, count) => count === 1 ? link.onerror?.() : link.onload?.() });
    assert.equal(await library.loadFont('An Older Display Face'), true);
    assert.equal(links.length, 2);
    assert.equal(links[0].removed, true);
    assert.equal(links[1].removed, false);
    assert.equal(links[1].href, 'https://fonts.googleapis.com/css2?family=An+Older+Display+Face&display=swap');
});

test('failed stylesheets are removed, not marked loaded, and can be retried', async () => {
    const { library, links } = createLibrary({ stylesheet: (link, count) => count === 1 ? link.onerror?.() : link.onload?.() });
    assert.equal(await library.loadFont('Syne'), false);
    assert.equal(library.loaded.has('Syne'), false);
    assert.equal(library.loading.size, 0);
    assert.equal(links[0].removed, true);
    assert.equal(await library.loadFont('Syne'), true);
    assert.equal(links.length, 2);
});

test('an empty FontFaceSet response is failure rather than a false-positive font load', async () => {
    const { library, links } = createLibrary({ fontLoad: () => Promise.resolve([]) });
    assert.equal(await library.loadFont('Trickster'), false);
    assert.equal(library.loaded.has('Trickster'), false);
    assert.equal(library.loading.size, 0);
    assert.equal(links[0].removed, true);
});

test('CSS and FontFaceSet hangs have bounded timeouts and clean up loading state', async () => {
    for (const hooks of [{ stylesheet: () => {} }, { fontLoad: () => new Promise(() => {}) }]) {
        const { library, links } = createLibrary(hooks);
        assert.equal(await library.loadFont('DM Sans', { timeout: 10 }), false);
        assert.equal(library.loaded.has('DM Sans'), false);
        assert.equal(library.loading.size, 0);
        assert.equal(links[0].removed, true);
    }
});

test('face-load failures return false without removing a previously successful stylesheet', async () => {
    const { library, links } = createLibrary({ fontLoad: (_css, _sample, count) => count === 1 ? Promise.resolve([{}]) : Promise.reject(new Error('Offline')) });
    assert.equal(await library.loadFont('Playfair Display', { weights: [400] }), true);
    assert.equal(await library.loadFont('Playfair Display', { weights: [700], sample: 'New text' }), false);
    assert.equal(links.length, 1);
    assert.equal(links[0].removed, false);
    assert.equal(library.loading.size, 0);
});

test('a non-browser context returns false without side effects', async () => {
    const { library } = createLibrary({ document: false });
    assert.equal(await library.loadFont('Syne'), false);
    assert.equal(library.loading.size, 0);
});
