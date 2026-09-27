import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export type DesktopResult = { status: string; model?: string; effort?: string; reason?: string; [key: string]: unknown };
type UiRunner = (model: string, effort: string, project?: string) => Promise<DesktopResult>;

/** 官方桌面协议只负责定位 Code 和目录；不把 prompt 参数误认为自动发送。 */
export function codeLink(project: string) {
  const path = resolve(project);
  if (!statSync(path).isDirectory()) throw new Error('项目必须是存在的目录');
  const url = new URL('claude://code/new');
  url.searchParams.set('folder', path);
  return url.toString();
}

async function launch(url: string) {
  if (process.platform !== 'win32') throw new Error('桌面控制目前仅支持 Windows');
  // 编码后作为数据传入固定脚本，避免 URL/路径被 PowerShell 当成命令。
  const encoded = Buffer.from(url).toString('base64');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Start-Process -FilePath $u`], { windowsHide: true, timeout: 15000 });
}

/** 后台模式的硬边界：未显式启用交互时，连 UI 子进程都不能创建。 */
function backgroundOnly(): DesktopResult {
  return { status: 'background_only', uiTouched: false, sessionReady: false,
    nextAction: '仅通过 bridge_sessions 选择已注册会话，再使用 bridge_submit/bridge_wait。无会话时等待用户自行准备；不自动打开窗口或操作控件。' };
}

export async function openDesktop(project: string, opener = launch, allowUi = false) {
  if (!allowUi) return backgroundOnly();
  const url = codeLink(project);
  await opener(url);
  return { status: 'opened_pending_confirmation', project: resolve(project), sessionReady: false,
    nextAction: '在 Claude 核对并确认目录信任；之后调用 bridge_desktop_configure。打开窗口不代表会话已注册。' };
}

/** UI 脚本只返回必要状态，不返回聊天正文、控件树或账户信息。 */
async function ui(model: string, effort: string, project?: string): Promise<DesktopResult> {
  if (process.platform !== 'win32') throw new Error('桌面控制目前仅支持 Windows');
  const script = fileURLToPath(new URL('../scripts/claude-desktop.ps1', import.meta.url));
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script,
    '-Model', model, '-Effort', effort, '-Project', project ?? ''], { windowsHide: true, timeout: 25000, maxBuffer: 65536 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

export async function configureDesktop(model: string, effort: string, runner: UiRunner = ui, project?: string, allowUi = false) {
  if (!allowUi) return backgroundOnly();
  if (!/^(Opus|Sonnet|Haiku) \d+(\.\d+)?$/.test(model)) throw new Error('模型必须是界面显示名称，例如 Opus 5.5');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('不支持的思考强度');
  const result = await runner(model, effort, project);
  // 即使适配器误报 configured，也必须核对实际读回的模型和强度。
  if (result.status === 'configured' && (result.model !== model || result.effort !== effort)) throw new Error('桌面模型与思考强度核验失败');
  return result;
}
