import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fido-ios-root-'));
  const repo = path.join(temporary, 'allowed', 'checkout');
  fs.mkdirSync(repo, {recursive: true});
  fs.cpSync(new URL('.', import.meta.url), path.join(repo, 'v2'), {recursive: true});
  const run = root => {
    const env = {...process.env};
    delete env.REMOTE_FIDO_BUILD_ROOT;
    if (root !== undefined) env.REMOTE_FIDO_BUILD_ROOT = root;
    return spawnSync(process.execPath, [path.join(repo, 'v2/build-ios.mjs')], {cwd: repo, env, encoding: 'utf8'});
  };
  return {temporary, repo, run, cleanup: () => fs.rmSync(temporary, {recursive: true, force: true})};
}

test('iOS generator requires an explicit absolute containing build root', () => {
  const f = fixture();
  try {
    for (const root of [undefined, '.']) {
      const result = f.run(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /explicitly approved absolute build root/);
      assert.equal(fs.existsSync(path.join(f.repo, 'build')), false);
    }
    const result = f.run(path.dirname(f.repo));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(f.repo, 'build/ios/RemoteFIDO.xcodeproj/project.pbxproj')));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.repo, 'build/ios/Resources/manifest.json')));
    assert.equal(manifest.key, undefined);
    assert.deepEqual(manifest.background, {scripts: ['mobile-worker.js'], type: 'module'});
  } finally { f.cleanup(); }
});

test('iOS generator rejects sibling prefixes, traversal, and unrelated symlink roots', () => {
  const f = fixture();
  try {
    const siblingPrefix = path.join(f.temporary, 'allow');
    const outside = path.join(f.temporary, 'outside');
    fs.mkdirSync(siblingPrefix); fs.mkdirSync(outside);
    const linkedRoot = path.join(f.temporary, 'linked-root');
    fs.symlinkSync(outside, linkedRoot, 'dir');
    for (const root of [siblingPrefix, path.join(path.dirname(f.repo), '../outside'), linkedRoot]) {
      const result = f.run(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Source checkout must be inside/);
      assert.equal(fs.existsSync(path.join(f.repo, 'build')), false);
    }
  } finally { f.cleanup(); }
});

test('iOS generator rejects output directory and file symlink escapes before writing', () => {
  for (const escape of ['directory', 'file', 'dangling-directory', 'dangling-file']) {
    const f = fixture();
    try {
      const outside = path.join(f.temporary, 'outside');
      if (escape !== 'dangling-directory') fs.mkdirSync(outside);
      if (escape.endsWith('directory')) fs.symlinkSync(outside, path.join(f.repo, 'build'), 'dir');
      else {
        fs.mkdirSync(path.join(f.repo, 'build/ios/Resources'), {recursive: true});
        if (escape === 'file') fs.writeFileSync(path.join(outside, 'app.html'), 'preserve this file');
        fs.symlinkSync(path.join(outside, 'app.html'), path.join(f.repo, 'build/ios/Resources/app.html'));
      }
      const result = f.run(path.dirname(f.repo));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Build output (?:escapes|cannot be resolved inside) REMOTE_FIDO_BUILD_ROOT/);
      if (escape === 'directory') assert.deepEqual(fs.readdirSync(outside), []);
      else if (escape === 'file') assert.equal(fs.readFileSync(path.join(outside, 'app.html'), 'utf8'), 'preserve this file');
      else if (escape === 'dangling-directory') assert.equal(fs.existsSync(outside), false);
      else assert.equal(fs.existsSync(path.join(outside, 'app.html')), false);
    } finally { f.cleanup(); }
  }
});
