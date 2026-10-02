import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codeLink, openDesktop, configureDesktop } from '../src/desktop.js';

test('桌面链接安全编码目录，不把打开成功当作会话就绪', async () => {
  const project = mkdtempSync(join(tmpdir(), 'bridge & 中文 '));
  try {
    const link = codeLink(project);
    assert.equal(new URL(link).searchParams.get('folder'), project);
    assert.equal(new URL(link).host, 'code');
    let opened = '';
    const result = await openDesktop(project, async url => { opened = url; }, true);
    assert.equal(opened, link);
    assert.equal(result.status, 'opened_pending_confirmation');
    assert.equal(result.sessionReady, false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('Windows PowerShell 可以解析含中文的桌面适配脚本', { skip: process.platform !== 'win32' }, () => {
  // 与实际启动使用相同的 Windows PowerShell，捕获 UTF-8 无 BOM 的编码回归。
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/claude-desktop.ps1'),[ref]$tokens,[ref]$errors); if($errors.Count){exit 1}"], { windowsHide: true });
});

test('目录无效不启动，UI 未验证不允许声称模型生效', async () => {
  await assert.rejects(openDesktop(join(tmpdir(), 'missing-' + Date.now()), async () => assert.fail('不应启动'), true));
  await assert.rejects(configureDesktop('Opus 5.5', 'medium', async () => ({ status: 'configured', model: 'Sonnet 5', effort: 'medium' }), undefined, true), /核验/);
  const result = await configureDesktop('Opus 5.5', 'medium', async () => ({ status: 'needs_confirmation', reason: 'workspace_trust' }), undefined, true);
  assert.equal(result.status, 'needs_confirmation');
  await assert.rejects(configureDesktop('Opus 5.5; bad', 'medium', async () => assert.fail('不应执行'), undefined, true), /模型/);
  await assert.rejects(configureDesktop('Sonnet', 'medium', async () => ({ status: 'configured', model: 'Sonnet', effort: 'medium' }), undefined, true), /核验/);
});

test('后台模式默认不启动桌面、不调用 UI 适配器，即使项目不存在也不尝试打开', async () => {
  const opened = await openDesktop('missing-project', async () => assert.fail('后台模式不能启动窗口'));
  const configured = await configureDesktop('Opus 5.5', 'medium', async () => assert.fail('后台模式不能操作控件'));
  for (const result of [opened, configured]) {
    assert.equal(result.status, 'background_only');
    assert.equal(result.uiTouched, false);
    assert.equal(result.sessionReady, false);
  }
});
