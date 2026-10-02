import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects, resolveProject } from '../src/projects.js';
import { canonical } from '../src/store.js';

test('已知项目目录按真实证据识别，重名和未知项目不猜测', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'one', 'app'), b = join(root, 'two', 'app'), data = join(root, 'data');
  for (const path of [a, b, join(data, '0123456789abcdef')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(data, '0123456789abcdef', 'state.json'), JSON.stringify({ sessions: [{ cwd: a }, { cwd: b }] }));
  const known = discoverProjects(data, a);
  assert.equal(known.length, 2);
  assert.equal(resolveProject(known, 'app').status, 'ambiguous');
  assert.equal(resolveProject(known, a).project, canonical(a));
  assert.equal(resolveProject(known, '', a).project, canonical(a));
  assert.equal(resolveProject(known, 'missing', a).status, 'not_found');
  assert.equal(resolveProject(known, '').status, 'needs_project');
});
