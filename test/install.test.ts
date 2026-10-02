import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { install, uninstall } from '../src/install.js';

test('配置安装幂等，卸载保留原工具和安装后的用户修改', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-install-')); const data = join(dir, 'data');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.claude')); mkdirSync(join(dir, '.codex'));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'keep' } } }));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] }, permissions: { deny: ['Bash(danger)'] } }));
  writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "keep-model"\n[mcp_servers.existing]\ncommand = "keep"\n');
  install(dir, data); install(dir, data);
  const config = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(config.hooks.Stop.length, 2);
  assert.equal(config.hooks.UserPromptSubmit.length, 1);
  config.extra = 'user-change';
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(config));
  assert.equal((parse(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')) as any).model, 'keep-model');
  assert.ok(readdirSync(dir).some(n => n.startsWith('.mcp.json.bridge-backup-')));
  uninstall(dir, data);
  const after = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(after.extra, 'user-change'); assert.equal(after.hooks.Stop.length, 1);
  assert.deepEqual(after.permissions, { deny: ['Bash(danger)'] });
  assert.equal(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers.existing.command, 'keep');
});

test('现有同名 MCP 不属于此项目时拒绝覆盖，损坏 JSON 不被重置', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-collision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.mcp.json');
  writeFileSync(path, '{ broken');
  assert.throws(() => install(dir, join(dir, 'data')));
  assert.equal(readFileSync(path, 'utf8'), '{ broken');
  writeFileSync(path, JSON.stringify({ mcpServers: { codex_claude_bridge: { command: 'someone-else' } } }));
  assert.throws(() => install(dir, join(dir, 'data')), /同名/);
});
