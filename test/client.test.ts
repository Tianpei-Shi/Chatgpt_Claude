import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeEndpoint, ensureBroker } from '../src/client.js';
import { startBroker } from '../src/broker.js';

test('相同端口使用不同密钥时报告共享目录冲突，不另起 broker', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-auth-'));
  const a = join(root, 'real'), b = join(root, 'virtualized');
  const server = await startBroker(a, initializeEndpoint(a, 0));
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  initializeEndpoint(b, server.port);
  await assert.rejects(ensureBroker(b), /认证.*冲突/);
  assert.equal(existsSync(join(b, 'broker.log')), false);
});
