import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CHROME_SECURITY_FLOOR, requirePatchedChrome} from '../browser-security.mjs';

test('Chrome full-version policy rejects old patch releases and matches all manifests', () => {
  for (const version of ['156.0.8078.47', '156.0.8078.48', '157.0.0.0']) requirePatchedChrome(version);
  for (const version of ['156.0.8078.4', '155.0.8059.85', '156.0.0.0', 'garbage']) assert.throws(() => requirePatchedChrome(version));
  for (const file of ['extension/manifest.json', 'v2/target-extension/manifest.json', 'v2/approver-extension/manifest.json'])
    assert.equal(JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url))).minimum_chrome_version, CHROME_SECURITY_FLOOR);
});
