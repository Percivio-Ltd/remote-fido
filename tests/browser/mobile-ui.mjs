// Render the generated Safari UI at phone/tablet sizes in an isolated Chrome
// fixture. This checks layout/wiring, not Safari APIs or hardware biometrics.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(repo, '.scratch/mobile-ui-'));
const extension = path.join(temporary, 'extension');
await fs.cp(path.join(repo, 'build/ios/Resources'), extension, {recursive: true});
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
manifest.background = {service_worker: 'mobile-worker.js', type: 'module'};
await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let context;
try {
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {headless: true, channel: 'chromium',
    ...(process.env.CHROME_TEST_BIN ? {executablePath: process.env.CHROME_TEST_BIN} : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.getByText('Import this device’s configuration to begin.').waitFor();
  for (const [name, width, height] of [['iphone', 390, 844], ['ipad', 1024, 1366]]) {
    await page.setViewportSize({width, height});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow');
    await page.screenshot({path: path.join(repo, `.scratch/${name}-approver.png`), fullPage: true});
  }
  assert.deepEqual(errors, []);
  console.log('PASS: generated mobile dashboard loads without JS errors and fits iPhone/iPad widths; screenshots in .scratch.');
} finally { await context?.close(); await fs.rm(temporary, {recursive: true, force: true}); }
