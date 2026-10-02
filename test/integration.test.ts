import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeEndpoint, rpc } from '../src/client.js';
import { startBroker } from '../src/broker.js';
import { handleHook } from '../src/hook.js';
import { install } from '../src/install.js';

// 两个 SDK 客户端启动两个独立 MCP 进程，共用真实 HTTP 服务和真实管道。
test('双 STDIO MCP 从提交到英文结果完整往返，并隔离两端工具权限', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-e2e-'));
  writeFileSync(join(dir, 'README.md'), 'Test project source documentation.');
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
  for (const role of ['codex', 'claude', 'codex']) {
    const client = new Client({ name: `test-${role}`, version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/main.js'), 'mcp', '--role', role, '--data', dir, '--project', dir], stderr: 'pipe' });
    await client.connect(transport); clients.push(client);
  }
  const [codex, claude, codexTwo] = clients;
  assert.match(codex.getInstructions()!, /先选择/);
  assert.equal((await codex.listTools()).tools.some(t => t.name === 'bridge_report'), false);
  assert.equal((await claude.listTools()).tools.some(t => t.name === 'bridge_submit'), false);
  // 桌面控制只交给协调端；执行端不应递归启动或修改自己的会话。
  for (const name of ['bridge_desktop_open', 'bridge_desktop_configure', 'bridge_desktop_prepare']) {
    assert.equal((await codex.listTools()).tools.some(t => t.name === name), true);
    assert.equal((await claude.listTools()).tools.some(t => t.name === name), false);
  }
  const call = async (c: Client, name: string, args: any) => {
    const r = await c.callTool({ name, arguments: { cwd: dir, ...args } });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    return JSON.parse((r.content as any)[0].text);
  };
  // 每个聊天独立选项目、检查源码与保存方案，不能通过旧 prompt 参数跳过流程。
  const contexts = new Map<string, string>();
  const submit = async (c: Client, cwd: string, session: string, request: string, objective: string) => {
    let context = contexts.get(cwd);
    if (!context) {
      context = (await call(c, 'bridge_context_create', { cwd, label: 'Independent chat' })).id;
      contexts.set(cwd, context!);
      await call(c, 'bridge_context_bind', { cwd, context_id: context, session_id: session });
    }
    await call(c, 'bridge_inspect', { cwd, context_id: context, paths: ['README.md'] });
    const plan = await call(c, 'bridge_plan', { cwd, context_id: context, objective, findings: 'README describes this project.', steps: 'Inspect README.', constraints: 'Do not modify files.', acceptance: 'Report findings.', mode: 'read' });
    return call(c, 'bridge_submit', { cwd, context_id: context, plan_id: plan.plan_id, request_id: request, session_id: session });
  };
  assert.equal((await codex.callTool({ name: 'bridge_sessions', arguments: {} })).isError, true);
  assert.equal((await codex.callTool({ name: 'bridge_submit', arguments: { cwd: dir, request_id: 'bypass', session_id: 'desktop-session', prompt: 'Skip planning.' } })).isError, true);
  await assert.rejects(rpc(dir, 'codex', 'submit', { id: 'bypass', sessionId: 'desktop-session', cwd: dir, prompt: 'Skip planning.' }));
  assert.equal((await call(codex, 'bridge_desktop_prepare', { cwd: dir, request_id: 'init-disabled' })).status, 'background_only');
  // 即使模型误调用旧桌面工具，真实 MCP 子进程也必须保持纯后台。
  for (const name of ['bridge_desktop_open', 'bridge_desktop_configure']) {
    const result = await call(codex, name, {});
    assert.equal(result.status, 'background_only');
    assert.equal(result.uiTouched, false);
  }
  await submit(codex, dir, 'desktop-session', 'test-one', 'Read README and report in English.');
  await new Promise(r => setTimeout(r, 100));
  assert.match(frames[1].message.content, /test-one/);
  const wrong = await claude.callTool({ name: 'bridge_claim', arguments: { cwd: dir, request_id: 'test-one', session_id: 'desktop-session', session_key: 'another-session' } });
  assert.equal(wrong.isError, true);
  const task = await call(claude, 'bridge_claim', { request_id: 'test-one', session_id: 'desktop-session', session_key: sessionKey });
  assert.match(task.prompt, /Read README and report in English/);
  const waitingProgress = call(codex, 'bridge_wait', { request_id: 'test-one', seconds: 5 });
  await new Promise(r => setTimeout(r, 100));
  await call(claude, 'bridge_progress', { request_id: 'test-one', session_id: 'desktop-session', lease: task.lease, text: 'Read the source; now verifying the question flow.' });
  const progressed = await waitingProgress;
  assert.equal(progressed.status, 'running');
  assert.equal(progressed.events.at(-1).event, 'Progress');
  assert.match(progressed.events.at(-1).text, /verifying the question flow/);
  // 真实 Hook 在后台等待，协调端完整收到问题，答案回到同一个工具调用。
  const questions = [{ question: 'Which direction?', header: 'Direction', multiSelect: false,
    options: [{ label: 'Keep scope', description: 'Only inspect the current files.' }, { label: 'Expand', description: 'Investigate more files.' }] }];
  const pendingHook = handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion', tool_use_id: 'question-1', tool_input: { questions } });
  let pending: any;
  for (let n = 0; n < 30; n++) {
    const current = await call(codex, 'bridge_status', { request_id: 'test-one' });
    pending = current.interactions?.find((i: any) => i.status === 'pending');
    if (pending) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(pending, '问题应出现在实时状态中');
  assert.deepEqual(pending.payload.tool_input.questions, questions);
  await call(codex, 'bridge_respond', { context_id: contexts.get(dir), request_id: 'test-one', interaction_id: pending.id,
    answer: { answers: { 'Which direction?': 'Keep scope' } }, rationale: '用户要求仅检查当前文件，保持原范围。' });
  const answered: any = await pendingHook;
  assert.equal(answered.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(answered.hookSpecificOutput.updatedInput, { questions, answers: { 'Which direction?': 'Keep scope' } });
  await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Read' });
  const activity = await call(codex, 'bridge_status', { request_id: 'test-one' });
  assert.equal(activity.events.at(-1).tool, 'Read');
  assert.equal(activity.interactions[0].status, 'delivered');
  await call(claude, 'bridge_report', { request_id: 'test-one', session_id: 'desktop-session', lease: task.lease, outcome: 'completed', report: 'README inspected. No files changed.' });
  const result = await call(codex, 'bridge_status', { request_id: 'test-one' });
  assert.equal(result.status, 'completed'); assert.equal(result.lease, undefined);
  assert.equal(result.report, 'README inspected. No files changed.');
  // 第二轮必须在匹配的 Stop 到达后发送，后台任务尚未停止时不能释放。
  await submit(codex, dir, 'desktop-session', 'test-two', 'Continue the prior inspection.');
  await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'Stop', last_assistant_message: '[BRIDGE_TASK:test-one]', background_tasks: [{ id: 'still-running' }] });
  assert.equal((await call(codex, 'bridge_status', { request_id: 'test-two' })).status, 'queued');
  await handleHook(dir, dir, { session_id: 'desktop-session', cwd: dir, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Finished. [BRIDGE_TASK:test-one]' });
  await new Promise(r => setTimeout(r, 100));
  assert.match(frames[3].message.content, /test-two/);
  const second = await call(claude, 'bridge_claim', { request_id: 'test-two', session_id: 'desktop-session', session_key: sessionKey });
  await call(claude, 'bridge_report', { request_id: 'test-two', session_id: 'desktop-session', lease: second.lease, outcome: 'needs_input', report: 'Please provide the desired feature.' });
  assert.equal((await call(codex, 'bridge_status', { request_id: 'test-two' })).status, 'needs_input');
  // 模拟 Desktop 全局同名 MCP 覆盖项目配置：两端仍连原实例，但用 cwd 路由第二项目。
  const other = join(dir, 'other-project'), otherData = join(dir, 'other-data');
  mkdirSync(other); install(other, otherData);
  writeFileSync(join(other, 'README.md'), 'Other project documentation.');
  const otherEndpoint = initializeEndpoint(otherData);
  let otherBroker = await startBroker(otherData, otherEndpoint);
  t.after(async () => { await otherBroker.close(); });
  const otherHook: any = await handleHook(otherData, other, { session_id: 'other-session', cwd: other, hook_event_name: 'UserPromptSubmit', prompt: '[BRIDGE_INIT:test-init] Initialize only.' }, { CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'private-key' });
  assert.equal(otherHook.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const otherKey = /session_key is ([a-f0-9]+);/.exec(otherHook.hookSpecificOutput.additionalContext)![1];
  assert.equal((await call(codex, 'bridge_diagnose', { cwd: other })).status, 'ready');
  const otherSessions = await call(codex, 'bridge_sessions', { cwd: other });
  assert.deepEqual(otherSessions.map((s: any) => s.id), ['other-session']);
  assert.equal(otherSessions[0].initializationId, 'test-init');
  await submit(codexTwo, other, 'other-session', 'test-one', 'Inspect the other project.');
  const otherTask = await call(claude, 'bridge_claim', { cwd: other, request_id: 'test-one', session_id: 'other-session', session_key: otherKey });
  await call(claude, 'bridge_report', { cwd: other, request_id: 'test-one', session_id: 'other-session', lease: otherTask.lease, outcome: 'completed', report: 'Other project inspected.' });
  assert.equal((await call(codex, 'bridge_status', { cwd: other, request_id: 'test-one' })).report, 'Other project inspected.');
  assert.equal((await call(codex, 'bridge_status', { request_id: 'test-one' })).report, 'README inspected. No files changed.');
  const monitor = await call(codex, 'bridge_monitor', { targets: [
    { cwd: dir, context_id: contexts.get(dir), request_id: 'test-one' },
    { cwd: other, context_id: contexts.get(other), request_id: 'test-one' },
    { cwd: other, context_id: 'missing' },
  ] });
  assert.equal(monitor.results[0].tasks[0].report, 'README inspected. No files changed.');
  assert.equal(monitor.results[1].tasks[0].report, 'Other project inspected.');
  assert.match(monitor.results[2].error, /尚未选择/);
  const unchanged = await call(codex, 'bridge_monitor', { targets: [
    { cwd: dir, context_id: contexts.get(dir), request_id: 'test-one' },
    { cwd: other, context_id: contexts.get(other), request_id: 'test-one' },
    { cwd: other, context_id: 'missing' },
  ], after: monitor.cursor, seconds: 0 });
  assert.equal(unchanged.changed, false);
  // 另一个聊天知道任务编号也不能取消原聊天排队的任务。
  await submit(codex, dir, 'desktop-session', 'cancel-test', 'Read pending documentation.');
  const outsider = await call(codexTwo, 'bridge_context_create', { cwd: dir, label: 'Observer only' });
  assert.equal((await codexTwo.callTool({ name: 'bridge_cancel', arguments: { cwd: dir, context_id: outsider.id, request_id: 'cancel-test' } })).isError, true);
  assert.equal((await call(codex, 'bridge_cancel', { context_id: contexts.get(dir), request_id: 'cancel-test' })).status, 'cancelled');
  await handleHook(otherData, other, { session_id: 'other-session', cwd: other, hook_event_name: 'Stop', last_assistant_message: '[BRIDGE_TASK:test-one]' });
  // 服务重启不会伪造在线；下一次真实输入携带端点，恢复注册并给出新领取密钥。
  await otherBroker.close(); otherBroker = await startBroker(otherData, otherEndpoint);
  assert.equal((await call(codex, 'bridge_diagnose', { cwd: other })).status, 'session_offline');
  const recovered: any = await handleHook(otherData, other, { session_id: 'other-session', cwd: other, hook_event_name: 'UserPromptSubmit' }, { CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'private-key' });
  const recoveredKey = /session_key is ([a-f0-9]+);/.exec(recovered.hookSpecificOutput.additionalContext)![1];
  assert.notEqual(recoveredKey, otherKey);
  assert.equal((await call(codex, 'bridge_sessions', { cwd: other }))[0].initializationId, 'test-init');
  assert.equal((await call(codex, 'bridge_diagnose', { cwd: other })).status, 'ready');
  await otherBroker.close();
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
