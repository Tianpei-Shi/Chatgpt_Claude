import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/install.js';
import { routeProject } from '../src/routing.js';
import { canonical } from '../src/store.js';

test('跨项目必须显式指定且已安装，不把默认项目会话当作目标项目', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const other = join(root, 'other'); mkdirSync(other);
  const data = join(root, 'data'), otherData = join(root, 'other-data');
  assert.equal(routeProject(root, data).data, data);
  assert.throws(() => routeProject(root, data, other), /未安装/);
  install(other, otherData);
  assert.deepEqual(routeProject(root, data, other), { project: canonical(other), data: otherData });
  writeFileSync(join(other, '.mcp.json'), JSON.stringify({ mcpServers: { codex_claude_bridge: { command: 'other-program', args: [] } } }));
  assert.throws(() => routeProject(root, data, other), /不属于/);
});
