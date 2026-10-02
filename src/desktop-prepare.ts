import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codeLink, launch, ui, type DesktopResult } from './desktop.js';
import { canonical } from './store.js';
import { rpc, ensureBroker } from './client.js';
import { defaultModel, defaultEffort, modelPattern, modelMatches } from './preferences.js';

type Options = { cwd: string; data: string; requestId: string; allowUi: boolean; model?: string; effort?: string; trustWorkspace?: boolean };
type State = { project: string; model: string; effort: string; marker: string; phase: 'opening' | 'draft' | 'sending' | 'sent'; selection?: DesktopResult };
type Dependencies = { open: typeof launch; configure: typeof ui; sessions: () => Promise<any[]> };

/** 两次调用可跨过信任确认；发送状态先落盘，崩溃或超时后不重复点击发送。 */
export async function prepareDesktop(options: Options, injected?: Dependencies): Promise<DesktopResult> {
  if (!options.allowUi) return { status: 'background_only', uiTouched: false, sessionReady: false };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.requestId)) throw new Error('初始化编号无效');
  const model = options.model ?? defaultModel, effort = options.effort ?? defaultEffort;
  if (!modelPattern.test(model) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('模型或强度无效');
  const project = canonical(options.cwd);
  const deps: Dependencies = injected ?? { open: launch, configure: ui, sessions: async () => { await ensureBroker(options.data); return rpc(options.data, 'codex', 'sessions'); } };
  mkdirSync(options.data, { recursive: true });
  // 同一项目串行初始化；不抢占仍在运行的调用或自动删除不明来源的锁。
  const lock = join(options.data, 'desktop-prepare.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); } catch (error: any) {
    if (error.code === 'EEXIST') return { status: 'needs_attention', reason: 'initialization_locked', sessionReady: false };
    throw error;
  }
  try {
    const file = join(options.data, `desktop-init-${options.requestId}.json`);
    let state: State;
    const save = () => { writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(file + '.tmp', file); };
    if (existsSync(file)) {
      state = JSON.parse(readFileSync(file, 'utf8'));
      if (state.project !== project || state.model !== model || state.effort !== effort) throw new Error('初始化编号已绑定不同参数');
    } else {
      // 先确认服务可查询，再打开界面；服务异常时不留下新草稿。
      await deps.sessions();
      state = { project, model, effort, marker: randomUUID(), phase: 'opening' };
      save();
      const prompt = bootstrap(state);
      await deps.open(codeLink(project, prompt));
      state.phase = 'draft'; save();
    }
    // 必须是本次草稿的 Hook 标识与完整 cwd 同时匹配，不能认领恰好新出现的其他会话。
    const matched = (await deps.sessions()).filter(s => s.cwd === project && s.initializationId === state.marker);
    const ready = matched.filter(s => s.online && s.canWake);
    if (ready.length === 1) return { status: 'ready', project, sessionReady: true, sessionId: ready[0].id, selection: state.selection, uiTouched: false };
    if (matched.length > 1) return { status: 'needs_attention', reason: 'ambiguous_initialization', sessionReady: false };
    if (matched.length === 1) return { status: matched[0].online ? 'messaging_unavailable' : 'session_offline', sessionReady: false,
      sessionId: matched[0].id, nextAction: '原会话已登记但当前不可接收；恢复原会话，或明确创建新会话。不重复发送初始化。' };
    if (state.phase === 'opening') return { status: 'needs_attention', reason: 'open_delivery_unknown', sessionReady: false };
    if (state.phase === 'draft') {
      state.phase = 'sending'; save();
      let result: DesktopResult;
      try { result = await deps.configure(state.model, state.effort, project, bootstrap(state), options.trustWorkspace ?? true); }
      catch { return { status: 'delivery_unknown', reason: 'bootstrap_delivery_unknown', sessionReady: false }; }
      if (result.status !== 'bootstrap_sent') {
        // 通用异常可能发生于发送后；仅明确的前置阻塞允许继续同一草稿。
        if (result.reason !== 'desktop_control_failed') { state.phase = 'draft'; save(); }
        return { ...result, sessionReady: false, initializationRequestId: options.requestId };
      }
      // 发送后模型读回异常属于不确定状态，不能回到草稿重新发送。
      if (!modelMatches(state.model, result.model) || result.effort !== state.effort) return { status: 'delivery_unknown', reason: 'selection_not_verified', sessionReady: false };
      state.phase = 'sent'; state.selection = { status: 'configured', model: result.model, effort: result.effort }; save();
    }
    return { status: state.phase === 'sent' ? 'awaiting_registration' : 'delivery_unknown', sessionReady: false,
      initializationRequestId: options.requestId, nextAction: '保持相同 cwd、request_id、模型和强度再次调用；只检查登记，不重复发送。' };
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** 初始化只让桌面登记，不携带实际业务任务，避免目录未核验前发生代码修改。 */
function bootstrap(state: State) {
  return `[BRIDGE_INIT:${state.marker}] Initialize the desktop MCP bridge for ${state.project}. Do not modify files or run project tasks. Confirm your actual working directory, then reply briefly in English that you are ready to receive bridge tasks. If the directory differs, report the mismatch and stop.`;
}
