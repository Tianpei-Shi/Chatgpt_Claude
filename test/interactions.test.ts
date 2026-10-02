import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { captureInteraction, interactionOutput } from '../src/interactions.js';

// 使用真实状态库测试提问生命周期，避免只验证假接口返回值。
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-dialog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Store(dir);
  s.register({ id: 'session', cwd: dir, socket: 'pipe', token: 'secret' });
  const c = s.createContext(dir, '协调聊天'); s.bindContext(c.id, 'session');
  s.submit({ id: 'task', sessionId: 'session', cwd: dir, contextId: c.id, prompt: 'Inspect.' });
  s.dispatch('task'); s.claim('task', 'session');
  return { s, c, dir };
}
const questions = { tool_name: 'AskUserQuestion', tool_use_id: 'tool-one', tool_input: { questions: [
  { question: 'Which layout?', header: 'Layout', multiSelect: false, options: [
    { label: 'Compact', description: 'Less whitespace.' }, { label: 'Spacious', description: 'More whitespace.' },
  ] },
] } };

test('完整提问绑定原任务，跨聊天拒绝，答案幂等且仅原 Hook 领取', t => {
  const { s, c, dir } = setup(t);
  const i = s.openInteraction('session', 'question', 'PreToolUse', questions);
  assert.deepEqual(i.payload, questions);
  assert.equal(s.contextStatus(c.id).tasks[0].interactions[0].id, i.id);
  const other = s.createContext(dir, '其他聊天');
  const answer = { answers: { 'Which layout?': 'Compact' } };
  assert.throws(() => s.respondInteraction(other.id, 'task', i.id, answer, '用户选择紧凑布局'), /归属/);
  assert.throws(() => s.respondInteraction(c.id, 'task', i.id, { answers: {} }, '无答案'), /全部问题/);
  s.respondInteraction(c.id, 'task', i.id, answer, '用户选择紧凑布局');
  assert.equal(s.respondInteraction(c.id, 'task', i.id, answer, '用户选择紧凑布局').status, 'answered');
  assert.throws(() => s.respondInteraction(c.id, 'task', i.id, { answers: { 'Which layout?': 'Spacious' } }, '不同答案'), /覆盖/);
  assert.throws(() => s.pollInteraction('other-session', i.id), /归属/);
  assert.equal(s.pollInteraction('session', i.id).status, 'answered');
  s.finishInteraction('session', i.id, 'delivered');
  assert.equal(s.get('task').interactions[0].status, 'delivered');
  assert.equal(JSON.stringify(s.get('task')).includes('secret'), false);
});

test('服务重启和过期使旧弹窗失效，不允许迟到答复影响原会话', t => {
  const { s, c, dir } = setup(t);
  const expired = s.openInteraction('session', 'question', 'PreToolUse', questions, -1);
  assert.throws(() => s.respondInteraction(c.id, 'task', expired.id, { answers: { 'Which layout?': 'Compact' } }, '用户答案'), /过期/);
  const pending = s.openInteraction('session', 'question', 'PreToolUse', { ...questions, tool_use_id: 'tool-two' });
  const restored = new Store(dir);
  assert.equal(restored.get('task').interactions.find(i => i.id === pending.id)!.status, 'expired');
});

test('仅活动桥接任务接管问题，进度有序且不改变任务完成状态', t => {
  const { s } = setup(t);
  s.recordActivity('session', 'PreToolUse', 'Read', 'Reading a source file');
  s.recordActivity('session', 'PostToolUse', 'Read', 'Read completed');
  const task = s.get('task');
  assert.equal(task.status, 'running');
  assert.deepEqual(task.events.slice(-2).map(e => e.sequence), [1, 2]);
  assert.equal(task.events[1].text, 'Read completed');
  s.register({ id: 'unbound', cwd: task.cwd, socket: 'pipe', token: 'secret' });
  assert.equal(s.openInteraction('unbound', 'question', 'PreToolUse', questions), null);
});

test('权限与计划只返回单次决定，表单与问题按各自 Hook 协议回传', t => {
  const { s, c } = setup(t);
  const permissionInput = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const captured = captureInteraction(permissionInput)!;
  const permission = s.openInteraction('session', captured.kind, 'PermissionRequest', captured.payload)!;
  const answered = s.respondInteraction(c.id, 'task', permission.id, { behavior: 'allow' }, '用户授权运行测试');
  assert.deepEqual(interactionOutput(permissionInput, answered), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const planInput = { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Inspect only.' } };
  const plan = s.openInteraction('session', 'permission', 'PreToolUse', captureInteraction(planInput)!.payload)!;
  const approved = s.respondInteraction(c.id, 'task', plan.id, { behavior: 'allow' }, '原需求明确要求只读检查');
  assert.deepEqual((interactionOutput(planInput, approved) as any).hookSpecificOutput.updatedInput, planInput.tool_input);
  const formInput = { hook_event_name: 'Elicitation', mode: 'form', message: 'Project name?', requested_schema: { type: 'object' } };
  const form = s.openInteraction('session', 'elicitation', 'Elicitation', captureInteraction(formInput)!.payload)!;
  const filled = s.respondInteraction(c.id, 'task', form.id, { action: 'accept', content: { name: 'demo' } }, '用户指定项目名');
  assert.deepEqual(interactionOutput(formInput, filled), { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'demo' } } });
});

test('监控忽略内部心跳、保留长选项，不能把 URL 登录代为完成', t => {
  const { s, c } = setup(t);
  const long = { ...questions, tool_input: { questions: [{ question: 'Long?', options: [{ label: 'A', description: 'x'.repeat(10000) }] }] } };
  const i = s.openInteraction('session', 'question', 'PreToolUse', long)!;
  const before = s.contextStatus(c.id);
  s.pollInteraction('session', i.id);
  assert.deepEqual(s.contextStatus(c.id), before);
  assert.equal(s.get('task').interactions[0].payload.tool_input.questions[0].options[0].description.length, 10000);
  const url = s.openInteraction('session', 'elicitation', 'Elicitation', { mode: 'url', url: 'https://example.com/login' })!;
  assert.throws(() => s.respondInteraction(c.id, 'task', url.id, { action: 'accept', content: {} }, '自动登录'), /认证/);
});
