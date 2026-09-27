import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

// 使用真实临时状态文件，检查重启和任务归属而非模拟调用次数。
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Store(dir);
  s.register({ id: 's1', cwd: dir, socket: 'fake', token: 'private' });
  return { s, dir, task: { id: 'r1', sessionId: 's1', cwd: dir, prompt: 'Create a documented example.' } };
}

test('重复提交不产生第二次执行，内容冲突必须拒绝', t => {
  const { s, task } = fixture(t);
  assert.equal(s.submit(task).id, s.submit(task).id);
  assert.equal(s.listTasks().length, 1);
  assert.throws(() => s.submit({ ...task, prompt: 'Other work' }), /冲突/);
});

test('错误会话和工作目录不能领取或提交任务', t => {
  const { s, task } = fixture(t);
  assert.throws(() => s.submit({ ...task, cwd: tmpdir() }), /目录/);
  s.submit(task); s.dispatch('r1');
  assert.throws(() => s.claim('r1', 'other'), /会话/);
  const claimed = s.claim('r1', 's1');
  assert.equal(claimed.status, 'running');
  assert.throws(() => s.report('r1', 's1', 'wrong', 'completed', 'Done'), /凭据/);
});

test('汇报后等待 Stop 再派发下一任务，重复 Stop 不污染下一任务', t => {
  const { s, task } = fixture(t);
  s.submit(task); s.submit({ ...task, id: 'r2' }); s.dispatch('r1');
  assert.equal(s.nextQueued().length, 0);
  const c = s.claim('r1', 's1');
  s.report('r1', 's1', c.lease!, 'completed', 'Done');
  assert.equal(s.nextQueued().length, 0);
  s.observe('s1', 'Stop', 'r1');
  assert.equal(s.nextQueued()[0].id, 'r2');
  s.dispatch('r2');
  s.observe('s1', 'Stop', 'r1');
  assert.equal(s.sessions()[0].activeTask, 'r2');
});

test('重启保留结果但不会重发未确认的任务，会话必须重新注册', t => {
  const { s, dir, task } = fixture(t);
  s.submit(task); s.dispatch('r1');
  const restored = new Store(dir);
  assert.equal(restored.get('r1').status, 'delivery_unknown');
  assert.equal(restored.sessions()[0].online, false);
  assert.equal(restored.nextQueued().length, 0);
});

test('领取凭据不在协调端结果中泄漏；已发送任务不能假装取消', t => {
  const { s, task } = fixture(t);
  s.submit(task); s.dispatch('r1'); s.claim('r1', 's1');
  assert.equal('lease' in s.get('r1'), false);
  assert.throws(() => s.cancel('r1'), /已派发/);
});

test('收到 SessionEnd 后完成任务不再占用恢复会话的队列', t => {
  const { s, task, dir } = fixture(t);
  s.submit(task); s.dispatch('r1');
  const claim = s.claim('r1', 's1');
  s.report('r1', 's1', claim.lease!, 'completed', 'Done');
  s.observe('s1', 'SessionEnd');
  s.register({ id: 's1', cwd: dir, socket: 'fake', token: 'private' });
  s.submit({ ...task, id: 'r2' });
  assert.equal(s.nextQueued()[0]?.id, 'r2');
});

test('Claude API 失败不被显示为持续执行，也不释放未知任务供重做', t => {
  const { s, task } = fixture(t);
  s.submit(task); s.dispatch('r1'); s.claim('r1', 's1');
  s.observe('s1', 'StopFailure');
  assert.equal(s.get('r1').status, 'disconnected');
  assert.match(s.get('r1').note!, /API/);
  assert.equal(s.sessions()[0].activeTask, 'r1');
});
