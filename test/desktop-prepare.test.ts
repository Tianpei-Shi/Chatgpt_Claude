import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/store.js';
import { prepareDesktop } from '../src/desktop-prepare.js';

test('初始化跨信任确认恢复，仅发送一次，必须匹配草稿标识和完整目录才就绪', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-prepare-'));
  try {
    let opened = 0, sent = 0, confirmed = false, marker = '';
    let sessions: any[] = [];
    const deps = {
      open: async (link: string) => { opened++; marker = /^\[BRIDGE_INIT:([^\]]+)\]/.exec(new URL(link).searchParams.get('q')!)![1]; },
      configure: async () => { if (!confirmed) return { status: 'needs_confirmation', reason: 'workspace_trust' }; sent++; return { status: 'bootstrap_sent', model: 'Opus 5.5', effort: 'medium' }; },
      sessions: async () => sessions,
    };
    const options = { cwd: dir, data: join(dir, 'data'), requestId: 'one', allowUi: false, model: 'Opus 5.5', effort: 'medium' };
    assert.equal((await prepareDesktop(options, deps)).status, 'background_only');
    assert.equal(opened, 0);
    options.allowUi = true;
    assert.equal((await prepareDesktop(options, deps)).status, 'needs_confirmation');
    confirmed = true;
    assert.equal((await prepareDesktop(options, deps)).status, 'awaiting_registration');
    sessions = [{ id: 'unrelated', cwd: canonical(dir), initializationId: 'different', online: true, canWake: true }];
    assert.equal((await prepareDesktop(options, deps)).sessionReady, false);
    sessions.push({ id: 'correct', cwd: canonical(dir), initializationId: marker, online: true, canWake: true });
    assert.equal((await prepareDesktop(options, deps)).sessionId, 'correct');
    sessions[1].online = false;
    assert.equal((await prepareDesktop(options, deps)).status, 'session_offline');
    sessions[1].online = true; sessions[1].canWake = false;
    assert.equal((await prepareDesktop(options, deps)).status, 'messaging_unavailable');
    assert.equal(opened, 1); assert.equal(sent, 1);
    await assert.rejects(prepareDesktop({ ...options, effort: 'high' }, deps), /不同参数/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('发送响应丢失时持久化不确定状态，不重复操作界面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-uncertain-'));
  try {
    let calls = 0;
    const deps = { open: async () => {}, configure: async () => { calls++; throw new Error('timeout'); }, sessions: async () => [] };
    const options = { cwd: dir, data: dir, requestId: 'one', allowUi: true, model: 'Opus 5.5', effort: 'medium' };
    assert.equal((await prepareDesktop(options, deps)).status, 'delivery_unknown');
    assert.equal((await prepareDesktop(options, deps)).status, 'delivery_unknown');
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('省略模型与强度默认 Sonnet medium 并传递精确目录自动信任', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: any[] = [];
  const deps = { open: async () => {}, sessions: async () => [], configure: async (...args: any[]) => {
    calls.push(args); return { status: 'bootstrap_sent', model: 'Sonnet 5', effort: 'medium' };
  } };
  const result = await prepareDesktop({ cwd: dir, data: dir, requestId: 'default', allowUi: true }, deps);
  assert.equal(result.status, 'awaiting_registration');
  assert.equal(calls[0][0], 'Sonnet'); assert.equal(calls[0][1], 'medium');
  assert.equal(calls[0][2], canonical(dir)); assert.equal(calls[0][4], true);
});
