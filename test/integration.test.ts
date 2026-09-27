import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeEndpoint, rpc } from '../src/client.js';
import { startBroker } from '../src/broker.js';
import { handleHook } from '../src/hook.js';

// 两个 SDK 客户端启动两个独立 MCP 进程，共用真实 HTTP 服务和真实管道。
test('双 STDIO MCP 从提交到英文结果完整往返，并隔离两端工具权限', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-e2e-'));
  // 隔离开发者自己的插件/管理设置，否则保守的 Stop 策略会影响测试预期。
  const oldConfig = process.env.CLAUDE_CONFIG_DIR, oldManaged = process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'empty-user-settings');
  delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH;
  t.after(() => {
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    if (oldManaged === undefined) delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH; else process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = oldManaged;
  });
  const endpoint = initializeEndpoint(dir, 0);
  const broker = await startBroker(dir, endpoint);
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); await broker.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\bridge-e2e-${randomUUID()}` : `/tmp/bridge-e2e-${randomUUID()}.sock`;
  const frames: any[] = [];
  const peer = createServer(socket => {
    let text = ''; socket.on('data', data => text += data.toString());
    socket.on('end', () => { frames.push(...text.trim().split('\n').map(s => JSON.parse(s))); socket.end(); });
  });
  await new Promise<void>(r => peer.listen(path, r)); t.after(() => peer.close());
  const hookOutput: any = await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'SessionStart' }, { CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'private-key' });
  const sessionKey = /session_key is ([a-f0-9]+);/.exec(hookOutput.hookSpecificOutput.additionalContext)![1];
  for (const role of ['codex', 'claude']) {
    const client = new Client({ name: `test-${role}`, version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/main.js'), 'mcp', '--role', role, '--data', dir, '--project', dir], stderr: 'pipe' });
    await client.connect(transport); clients.push(client);
  }
  const [codex, claude] = clients;
  assert.equal((await codex.listTools()).tools.some(t => t.name === 'bridge_report'), false);
  assert.equal((await claude.listTools()).tools.some(t => t.name === 'bridge_submit'), false);
  // 桌面控制只交给协调端；执行端不应递归启动或修改自己的会话。
  for (const name of ['bridge_desktop_open', 'bridge_desktop_configure']) {
    assert.equal((await codex.listTools()).tools.some(t => t.name === name), true);
    assert.equal((await claude.listTools()).tools.some(t => t.name === name), false);
  }
  const call = async (c: Client, name: string, args: any) => {
    const r = await c.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    return JSON.parse((r.content as any)[0].text);
  };
  // 即使模型误调用旧桌面工具，真实 MCP 子进程也必须保持纯后台。
  for (const name of ['bridge_desktop_open', 'bridge_desktop_configure']) {
    const result = await call(codex, name, {});
    assert.equal(result.status, 'background_only');
    assert.equal(result.uiTouched, false);
  }
  await call(codex, 'bridge_submit', { request_id: 'test-one', session_id: 'desktop-session', cwd: dir, prompt: 'Read README and report in English.' });
  await new Promise(r => setTimeout(r, 100));
  assert.match(frames[1].message.content, /test-one/);
  const wrong = await claude.callTool({ name: 'bridge_claim', arguments: { request_id: 'test-one', session_id: 'desktop-session', session_key: 'another-session' } });
  assert.equal(wrong.isError, true);
  const task = await call(claude, 'bridge_claim', { request_id: 'test-one', session_id: 'desktop-session', session_key: sessionKey });
  assert.equal(task.prompt, 'Read README and report in English.');
  await call(claude, 'bridge_report', { request_id: 'test-one', session_id: 'desktop-session', lease: task.lease, outcome: 'completed', report: 'README inspected. No files changed.' });
  const result = await call(codex, 'bridge_status', { request_id: 'test-one' });
  assert.equal(result.status, 'completed'); assert.equal(result.lease, undefined);
  assert.equal(result.report, 'README inspected. No files changed.');
  // 第二轮必须在匹配的 Stop 到达后发送，后台任务尚未停止时不能释放。
  await call(codex, 'bridge_submit', { request_id: 'test-two', session_id: 'desktop-session', cwd: dir, prompt: 'Continue the prior inspection.' });
  await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'Stop', last_assistant_message: '[BRIDGE_TASK:test-one]', background_tasks: [{ id: 'still-running' }] });
  assert.equal((await call(codex, 'bridge_status', { request_id: 'test-two' })).status, 'queued');
  await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Finished. [BRIDGE_TASK:test-one]' });
  await new Promise(r => setTimeout(r, 100));
  assert.match(frames[3].message.content, /test-two/);
  const second = await call(claude, 'bridge_claim', { request_id: 'test-two', session_id: 'desktop-session', session_key: sessionKey });
  await call(claude, 'bridge_report', { request_id: 'test-two', session_id: 'desktop-session', lease: second.lease, outcome: 'needs_input', report: 'Please provide the desired feature.' });
  assert.equal((await call(codex, 'bridge_status', { request_id: 'test-two' })).status, 'needs_input');
  await assert.rejects(rpc(dir, 'codex', 'report', {}), /权限/);
  const response = await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
  const browser = await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.keys.codex}`, Origin: 'https://example.com' }, body: '{}' });
  assert.equal(browser.status, 403);
  const unicode = await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${'é'.repeat(64)}` }, body: '{}', signal: AbortSignal.timeout(1500) });
  assert.equal(unicode.status, 401);
  assert.equal((await rpc(dir, 'codex', 'health')).ok, true);
  await assert.rejects(rpc(dir, 'codex', 'shutdown'), /在线会话/);
  await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'SessionEnd' });
  assert.equal((await rpc(dir, 'codex', 'shutdown')).stopped, true);
});
