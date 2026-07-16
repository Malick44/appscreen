#!/usr/bin/env node
/**
 * export-db.js
 * Reads IndexedDB from the running app (http://localhost:8000) via Playwright
 * and writes the data as JSON files into /db/
 *
 * Usage:
 *   node scripts/export-db.js
 *
 * Prerequisites:
 *   - App must be running: npm run serve  (python3 -m http.server 8000)
 *   - Playwright browsers installed: npx playwright install chromium
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP_URL = 'http://localhost:8000';
const DB_NAME = 'AppStoreScreenshotGenerator';
const DB_VERSION = 2;
const STORES = ['projects', 'meta'];
const OUT_DIR = path.join(__dirname, '..', 'db');
const CDP_URL = process.env.CDP_URL || '';

function validateCdpUrl(cdpUrl) {
    if (!cdpUrl) return;
    let parsed;
    try {
        parsed = new URL(cdpUrl);
    } catch {
        throw new Error(`Invalid CDP_URL: ${cdpUrl}`);
    }

    const appPort = new URL(APP_URL).port;
    if (parsed.port === appPort) {
        throw new Error(
            `CDP_URL points to app server port ${appPort}. Use browser remote-debugging port (for example http://127.0.0.1:9222).`
        );
    }
}

async function openPage() {
    if (CDP_URL) {
        validateCdpUrl(CDP_URL);
        console.log(`Connecting to existing browser via CDP -> ${CDP_URL}`);
        const browser = await chromium.connectOverCDP(CDP_URL);
        const context = browser.contexts()[0] || await browser.newContext();
        const page = context.pages()[0] || await context.newPage();
        return { browser, page, connectedViaCdp: true };
    }

    console.log(`Launching Playwright Chromium -> ${APP_URL}`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    return { browser, page, connectedViaCdp: false };
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const { browser, page, connectedViaCdp } = await openPage();

    // Navigate so the origin is established
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // Read all stores from IndexedDB inside the page context
    const data = await page.evaluate(({ dbName, dbVersion, stores }) => {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, dbVersion);
            req.onerror = () => reject(req.error?.message || 'Failed to open DB');
            req.onsuccess = () => {
                const db = req.result;
                const result = {};
                let pending = stores.length;

                if (pending === 0) { resolve(result); return; }

                for (const store of stores) {
                    if (!db.objectStoreNames.contains(store)) {
                        result[store] = [];
                        if (--pending === 0) resolve(result);
                        continue;
                    }
                    const tx = db.transaction(store, 'readonly');
                    const getAll = tx.objectStore(store).getAll();
                    getAll.onsuccess = () => {
                        result[store] = getAll.result;
                        if (--pending === 0) resolve(result);
                    };
                    getAll.onerror = () => reject(getAll.error?.message || `Failed to read ${store}`);
                }
            };
        });
    }, { dbName: DB_NAME, dbVersion: DB_VERSION, stores: STORES });

    // Do not close externally managed browser sessions (CDP mode)
    if (!connectedViaCdp) {
        await browser.close();
    }

    // Write combined dump
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const combinedPath = path.join(OUT_DIR, `dump-${timestamp}.json`);
    fs.writeFileSync(combinedPath, JSON.stringify(data, null, 2));
    console.log(`✓ Combined dump → ${combinedPath}`);

    // Write one file per store for convenience
    for (const store of STORES) {
        const storePath = path.join(OUT_DIR, `${store}.json`);
        fs.writeFileSync(storePath, JSON.stringify(data[store], null, 2));
        const count = Array.isArray(data[store]) ? data[store].length : '?';
        console.log(`✓ ${store}.json  (${count} records) → ${storePath}`);
    }

    console.log('\nDone.');
})();
