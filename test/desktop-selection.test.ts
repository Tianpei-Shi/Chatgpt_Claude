import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('桌面模型与强度支持分离控件，拒绝相似名称和不明确的强度', { skip: process.platform !== 'win32' }, () => {
  // 只测试纯文本解析，不读取或操作真实窗口。
  const script = `
    . ./scripts/desktop-selection.ps1
    @(
      (Read-DesktopSelection 'Model: Opus 5.5' 'Effort: Medium'),
      (Read-DesktopSelection 'Model: Sonnet 5 Medium' ''),
      (Read-DesktopSelection 'Model: Opus 5.5' 'Effort: Extra high'),
      (Read-DesktopSelection 'Model: Opus 5.50' 'Effort: Unknown')
    ) | ConvertTo-Json -Compress
  `;
  const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(rows[0], { model: 'Opus 5.5', effort: 'medium' });
  assert.deepEqual(rows[1], { model: 'Sonnet 5', effort: 'medium' });
  assert.equal(rows[2].effort, 'xhigh');
  assert.equal(rows[3].model, 'Opus 5.50');
  assert.equal(rows[3].effort, null);
});

test('Sonnet 默认按模型族唯一匹配，信任仅核对完整目录后执行', { skip: process.platform !== 'win32' }, () => {
  const script = `
    . ./scripts/desktop-selection.ps1
    @{
      exact = (Test-DesktopModel 'Sonnet' 'Sonnet 5');
      different = (Test-DesktopModel 'Sonnet' 'Opus 5.5');
      version = (Test-DesktopModel 'Sonnet 5' 'Sonnet 5.1');
      trusted = (Test-WorkspaceTrust 'D:\\code\\app' @('Trust workspace', 'D:\\code\\app') $true);
      wrong = (Test-WorkspaceTrust 'D:\\code\\app' @('Trust workspace', 'E:\\code\\app') $true);
      basename = (Test-WorkspaceTrust 'D:\\code\\app' @('Trust workspace', 'app') $true);
      disabled = (Test-WorkspaceTrust 'D:\\code\\app' @('Trust workspace', 'D:\\code\\app') $false)
    } | ConvertTo-Json -Compress
  `;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(result, { exact: true, different: false, version: false, trusted: true, wrong: false, basename: false, disabled: false });
});
