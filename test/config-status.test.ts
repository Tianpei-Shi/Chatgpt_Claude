import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexConfigStatus } from '../src/config-status.js';

test('仅项目配置不能当作用户级注册或当前聊天已加载', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.codex')); const user = join(dir, 'user.toml');
  const config = '[mcp_servers.codex_claude_bridge]\ncommand = "node"\n';
  writeFileSync(join(dir, '.codex/config.toml'), config);
  let status = codexConfigStatus(dir, user);
  assert.equal(status.projectConfigured, true);
  assert.equal(status.userRegistered, false);
  assert.equal(status.currentChatLoaded, 'not_verified');
  writeFileSync(user, config + 'enabled = false\n');
  status = codexConfigStatus(dir, user);
  assert.equal(status.userRegistered, true);
  assert.equal(status.userEnabled, false);
  assert.equal(status.currentChatLoaded, 'not_verified');
});
