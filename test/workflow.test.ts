import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const plan = { objective: 'Fix behavior', findings: 'The entry is app.ts.', steps: 'Update the entry.', constraints: 'Preserve other changes.', acceptance: 'Run relevant checks.', mode: 'write' as const };
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'app.ts'), '// source\n');
  const store = new Store(dir);
  for (const id of ['s1', 's2']) store.register({ id, cwd: dir, socket: 'pipe', token: 'private' });
  return { dir, store };
}
test('执行必须绑定项目与会话、读取文件并准备方案；上下文与方案不能串用', t => {
  const { dir, store } = fixture(t);
  const a = store.createContext(dir, 'chat A'), b = store.createContext(dir, 'chat B');
  assert.throws(() => store.preparePlan(a.id, plan), /检查/);
  store.bindContext(a.id, 's1');
  assert.throws(() => store.bindContext(b.id, 's1'), /控制/);
  store.bindContext(b.id, 's2');
  store.inspectContext(a.id, ['app.ts']); const p = store.preparePlan(a.id, plan);
  assert.throws(() => store.submitPrepared('task', b.id, 's2', p.id), /方案/);
  assert.equal(store.submitPrepared('task', a.id, 's1', p.id).status, 'queued');
  assert.equal(store.submitPrepared('task', a.id, 's1', p.id).id, 'task');
  assert.throws(() => store.releaseContext(a.id, 's1'), /任务/);
  writeFileSync(join(dir, 'app.ts'), '// changed\n');
  assert.throws(() => store.submitPrepared('another', a.id, 's1', p.id), /变化/);
  assert.throws(() => store.inspectContext(a.id, ['../secret']), /越出|ENOENT/);
});
test('同目录两个写任务串行，匹配 Stop 后才能释放，绑定重启后保留', t => {
  const { dir, store } = fixture(t);
  const a = store.createContext(dir, 'A'); store.bindContext(a.id, 's1'); store.bindContext(a.id, 's2');
  store.inspectContext(a.id, ['app.ts']); const p = store.preparePlan(a.id, plan);
  store.submitPrepared('one', a.id, 's1', p.id); store.submitPrepared('two', a.id, 's2', p.id);
  assert.deepEqual(store.nextQueued().map(t => t.id), ['one']);
  store.dispatch('one'); assert.equal(store.nextQueued().length, 0);
  const claimed = store.claim('one', 's1'); store.report('one', 's1', claimed.lease!, 'completed', 'Done');
  assert.equal(store.nextQueued().length, 0);
  store.observe('s1', 'Stop', 'one'); assert.deepEqual(store.nextQueued().map(t => t.id), ['two']);
  assert.equal(new Store(dir).contextStatus(a.id).context.sessions.length, 2);
});

test('同目录只读任务可以并行，排队证据过期阻止执行，释放控制后允许转交', t => {
  const { dir, store } = fixture(t);
  const a = store.createContext(dir, 'A'), b = store.createContext(dir, 'B');
  store.bindContext(a.id, 's1'); store.bindContext(a.id, 's2');
  store.inspectContext(a.id, ['app.ts']);
  const p = store.preparePlan(a.id, { ...plan, mode: 'read' });
  store.submitPrepared('one', a.id, 's1', p.id); store.submitPrepared('two', a.id, 's2', p.id);
  assert.equal(store.nextQueued().length, 2);
  store.dispatch('one'); store.dispatch('two');
  const task = store.claim('one', 's1'); store.report('one', 's1', task.lease!, 'completed', 'Done'); store.observe('s1', 'Stop', 'one');
  store.releaseContext(a.id, 's1'); store.bindContext(b.id, 's1');
  store.inspectContext(b.id, ['app.ts']); const p2 = store.preparePlan(b.id, { ...plan, mode: 'read' });
  store.submitPrepared('three', b.id, 's1', p2.id);
  writeFileSync(join(dir, 'app.ts'), '// external edit\n');
  assert.equal(store.dispatch('three'), false);
  assert.equal(store.get('three').status, 'needs_input');
  assert.equal(store.sessions().find(s => s.id === 's1')!.activeTask, undefined);
  writeFileSync(join(dir, '.env'), 'not-for-inspection');
  assert.throws(() => store.inspectContext(b.id, ['.env']), /凭据/);
});
