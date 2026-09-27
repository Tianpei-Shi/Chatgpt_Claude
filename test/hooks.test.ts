import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stopReleasePolicy } from '../src/hook-policy.js';

test('其他 Stop Hooks 或插件存在时，不把一次 Stop 观察当成已结束', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-hooks-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude'));
  const path = join(dir, '.claude/settings.local.json');
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'external-validator' }] }] } }));
  assert.equal(stopReleasePolicy(dir, [path]).allowed, false);
  writeFileSync(path, JSON.stringify({ enabledPlugins: { 'another-plugin': true } }));
  assert.equal(stopReleasePolicy(dir, [path]).allowed, false);
  writeFileSync(path, '{invalid');
  assert.equal(stopReleasePolicy(dir, [path]).allowed, false);
  writeFileSync(path, '{}');
  assert.equal(stopReleasePolicy(dir, [path]).allowed, true);
});
