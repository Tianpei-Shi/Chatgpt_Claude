import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, TaskInput, Registration, Session, Outcome, Interaction, InteractionKind } from './types.js';
import { validateAnswer, redact } from './interactions.js';
import { inspectSources, verifyEvidence, renderPlan, type Evidence, type PlanInput } from './workflow.js';

type Context = { id: string; cwd: string; label: string; sessions: string[]; evidence: Evidence[] };
type Plan = PlanInput & { id: string; contextId: string; evidence: Evidence[]; prompt: string };

export const canonical = (path: string) => {
  const actual = normalize(realpathSync(path));
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
};
const now = () => new Date().toISOString();
const finished = (status: string) => ['completed', 'failed', 'needs_input', 'cancelled'].includes(status);

/** 所有状态只由单个 broker 修改；通信令牌永不写入持久化文件。 */
export class Store {
  private tasks: Task[] = [];
  private entries: Session[] = [];
  private peers = new Map<string, Registration>();
  private contexts: Context[] = [];
  private plans: Plan[] = [];
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true }); this.file = join(dir, 'state.json');
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.tasks) || !Array.isArray(saved.sessions)) throw new Error('状态文件版本无效，保留原文件等待检查');
      this.tasks = saved.tasks; this.entries = saved.sessions;
      this.contexts = saved.contexts ?? []; this.plans = saved.plans ?? [];
      for (const entry of this.entries) entry.online = false;
      for (const task of this.tasks) {
        // 重启后原 Hook 等待链路不可确认，旧回答不得延迟批准新的交互。
        for (const i of task.interactions ?? []) if (['pending', 'answered'].includes(i.status)) i.status = 'expired';
        if (task.status === 'dispatching') task.status = 'delivery_unknown';
        if (task.status === 'running') task.status = 'disconnected';
      }
      this.save();
    }
  }
  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.tasks, sessions: this.entries, contexts: this.contexts, plans: this.plans }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  private task(id: string) { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error('任务不存在'); return task; }
  private session(id: string) { const session = this.entries.find(s => s.id === id); if (!session) throw new Error('会话不存在'); return session; }
  private publicTask(task: Task) {
    const { lease, ...publicTask } = task;
    for (const i of task.interactions ?? []) this.expireInteraction(i);
    // 内部心跳不参与监控游标，避免没有新内容也反复唤醒协调端。
    const interactions = (task.interactions ?? []).map(({ polledAt, ...i }) => i);
    return structuredClone({ ...publicTask, events: task.events ?? [], interactions });
  }
  sessions() { return this.entries.map(s => ({ ...s, canWake: this.peers.has(s.id) })); }
  listTasks() { return this.tasks.map(t => this.publicTask(t)); }
  get(id: string) { return this.publicTask(this.task(id)); }
  peer(id: string) { return this.peers.get(id); }
  /** 只接管当前受协调上下文控制的任务，普通桌面对话保持原样。 */
  private controlledTask(sessionId: string) {
    const session = this.session(sessionId);
    const task = session.activeTask ? this.task(session.activeTask) : undefined;
    if (!task?.contextId || !session.online || !this.context(task.contextId).sessions.includes(sessionId)) return;
    return task;
  }
  recordActivity(sessionId: string, event: string, tool: string | undefined, text: string) {
    const task = this.controlledTask(sessionId); if (!task) return;
    task.events ??= [];
    const sequence = (task.events.at(-1)?.sequence ?? 0) + 1;
    task.events.push({ sequence, at: now(), event, tool, text: redact(text, [task.lease ?? '', this.peers.get(sessionId)?.token ?? '']) });
    // 进度保留最近 200 条；交互正文独立存储，不受进度窗口裁剪。
    task.events = task.events.slice(-200); task.updatedAt = now(); this.save();
  }
  progress(id: string, sessionId: string, lease: string, text: string) {
    const task = this.task(id);
    if (task.sessionId !== sessionId || task.lease !== lease || this.session(sessionId).activeTask !== id || !['running', 'disconnected'].includes(task.status)) throw new Error('进度归属或任务状态无效');
    this.recordActivity(sessionId, 'Progress', undefined, text); return this.publicTask(task);
  }
  openInteraction(sessionId: string, kind: InteractionKind, hookEvent: string, payload: Record<string, any>, lifetimeMs = 300000): Interaction | null {
    const task = this.controlledTask(sessionId);
    if (!task || finished(task.status)) return null;
    if (Buffer.byteLength(JSON.stringify(payload)) > 131072) throw new Error('交互正文超过 128 KiB，需在原客户端查看完整内容');
    const i: Interaction = { id: randomUUID(), taskId: task.id, sessionId, kind, hookEvent,
      payload: redact(payload, [task.lease ?? '', this.peers.get(sessionId)?.token ?? '']), status: 'pending',
      createdAt: now(), expiresAt: new Date(Date.now() + lifetimeMs).toISOString(), polledAt: now() };
    task.interactions ??= []; task.interactions.push(i); task.updatedAt = now(); this.save(); return structuredClone(i);
  }
  private interaction(id: string) {
    for (const task of this.tasks) {
      const i = task.interactions?.find(i => i.id === id); if (i) return { task, i };
    }
    throw new Error('交互不存在');
  }
  private expireInteraction(i: Interaction) {
    if (['pending', 'answered'].includes(i.status) && (Date.now() >= Date.parse(i.expiresAt) || Date.now() - Date.parse(i.polledAt) > 60000)) {
      i.status = 'expired'; this.save();
    }
  }
  respondInteraction(contextId: string, taskId: string, id: string, answer: Record<string, any>, rationale: string) {
    const { task, i } = this.interaction(id), c = this.context(contextId);
    if (task.id !== taskId || task.contextId !== c.id || !c.sessions.includes(i.sessionId)) throw new Error('交互归属不匹配');
    this.expireInteraction(i);
    if (i.status === 'expired') throw new Error('交互已过期，请核对当前原会话');
    validateAnswer(i, answer);
    if (i.answer) {
      if (JSON.stringify(i.answer) === JSON.stringify(answer) && i.rationale === rationale) return structuredClone(i);
      throw new Error('交互已回答，不能覆盖');
    }
    if (!rationale.trim()) throw new Error('需要填写用户答复或既有授权依据');
    if (this.session(i.sessionId).activeTask !== task.id || finished(task.status)) throw new Error('原任务已结束');
    i.answer = structuredClone(answer); i.rationale = rationale; i.status = 'answered'; task.updatedAt = now(); this.save();
    return structuredClone(i);
  }
  pollInteraction(sessionId: string, id: string) {
    const { i } = this.interaction(id);
    if (i.sessionId !== sessionId) throw new Error('交互归属不匹配');
    this.expireInteraction(i); i.polledAt = now(); return structuredClone(i);
  }
  finishInteraction(sessionId: string, id: string, status: 'delivered' | 'expired') {
    const { task, i } = this.interaction(id);
    if (i.sessionId !== sessionId) throw new Error('交互归属不匹配');
    if (status === 'delivered' && i.status !== 'answered') throw new Error('交互没有待交付答案');
    i.status = status; task.updatedAt = now(); this.save(); return structuredClone(i);
  }
  /** 上下文由服务生成；这是同账号聊天的防串线标识，不是新的身份认证边界。 */
  private context(id: string) { const c = this.contexts.find(c => c.id === id); if (!c) throw new Error('尚未选择工作项目，请先创建协调上下文'); return c; }
  createContext(cwd: string, label: string) {
    const context: Context = { id: randomUUID(), cwd: canonical(cwd), label, sessions: [], evidence: [] };
    this.contexts.push(context); this.save(); return structuredClone(context);
  }
  bindContext(contextId: string, sessionId: string) {
    const c = this.context(contextId), s = this.session(sessionId);
    if (c.cwd !== s.cwd) throw new Error('会话与所选工作项目不一致');
    if (this.contexts.some(other => other.id !== c.id && other.sessions.includes(s.id))) throw new Error('会话已有其他聊天控制，请先由原上下文释放');
    if (!c.sessions.includes(s.id)) c.sessions.push(s.id);
    this.save(); return this.contextStatus(c.id);
  }
  releaseContext(contextId: string, sessionId: string) {
    const c = this.context(contextId);
    if (this.tasks.some(t => t.sessionId === sessionId && (!finished(t.status) || this.session(sessionId).activeTask === t.id))) throw new Error('会话仍有未释放任务，不能转交控制');
    c.sessions = c.sessions.filter(id => id !== sessionId); this.save(); return this.contextStatus(c.id);
  }
  contextStatus(id: string) {
    const c = this.context(id);
    return { context: structuredClone(c), sessions: this.sessions().filter(s => c.sessions.includes(s.id)),
      tasks: this.listTasks().filter(t => t.contextId === id).map(t => ({ ...t, prompt: undefined })) };
  }
  inspectContext(id: string, paths: string[]) {
    const c = this.context(id), result = inspectSources(c.cwd, paths);
    c.evidence = result.files.map(({ path, hash }) => ({ path, hash })); this.save(); return result;
  }
  preparePlan(id: string, input: PlanInput) {
    const c = this.context(id);
    if (!c.evidence.length) throw new Error('必须先检查相关项目文件');
    verifyEvidence(c.cwd, c.evidence);
    const plan: Plan = { ...input, id: randomUUID(), contextId: id, evidence: structuredClone(c.evidence), prompt: renderPlan(input, c.cwd) };
    this.plans.push(plan); this.save(); return structuredClone(plan);
  }
  submitPrepared(id: string, contextId: string, sessionId: string, planId: string) {
    const c = this.context(contextId), plan = this.plans.find(p => p.id === planId && p.contextId === contextId);
    if (!plan) throw new Error('方案不存在或属于其他聊天');
    if (!c.sessions.includes(sessionId)) throw new Error('请先绑定当前聊天控制的 Claude 会话');
    // 幂等回查不因执行后的文件变化失败；新任务才要求证据仍然有效。
    if (!this.tasks.some(t => t.id === id)) verifyEvidence(c.cwd, plan.evidence);
    return this.submit({ id, contextId, planId, sessionId, cwd: c.cwd, prompt: plan.prompt, mode: plan.mode });
  }
  register(input: Registration) {
    const cwd = canonical(input.cwd);
    let session = this.entries.find(s => s.id === input.id);
    if (session && session.cwd !== cwd) throw new Error('会话工作目录发生冲突');
    if (!session) { session = { id: input.id, cwd, online: true, updatedAt: now() }; this.entries.push(session); }
    session.online = true; session.updatedAt = now(); session.lastEvent = 'SessionStart';
    // 初始化标识只用于对应新草稿，普通输入重新登记时保留原有标识。
    if (input.initializationId) session.initializationId = input.initializationId;
    // 有效端点缺失时仍可诊断会话，但不宣称具备唤醒能力。
    if (input.socket && input.token) this.peers.set(input.id, { ...input, cwd });
    else this.peers.delete(input.id);
    this.save(); return { ...session };
  }
  submit(input: TaskInput) {
    const cwd = canonical(input.cwd);
    const old = this.tasks.find(t => t.id === input.id);
    if (old) {
      if (old.sessionId !== input.sessionId || old.cwd !== cwd || old.prompt !== input.prompt || old.contextId !== input.contextId || old.planId !== input.planId) throw new Error('任务编号冲突，不能复用编号提交不同内容');
      return this.publicTask(old);
    }
    const session = this.session(input.sessionId);
    if (session.cwd !== cwd) throw new Error('目标会话工作目录不匹配');
    if (!session.online) throw new Error('目标会话离线，请在 Claude 中恢复会话');
    if (!this.peers.has(session.id)) throw new Error('会话没有可用消息端点，先完成 Hooks 注册');
    const task: Task = { ...input, cwd, status: 'queued', createdAt: now(), updatedAt: now() };
    this.tasks.push(task); this.save(); return this.publicTask(task);
  }
  nextQueued() {
    // 将未知/断线任务也视为占用，不能在结果未确认时派发冲突任务。
    const occupied = this.tasks.filter(t => ['dispatching', 'delivery_unknown', 'running', 'disconnected'].includes(t.status) || this.entries.some(s => s.activeTask === t.id));
    const selected: Task[] = [];
    for (const task of this.tasks.filter(t => t.status === 'queued')) {
      const s = this.session(task.sessionId);
      if (!s.online || s.activeTask || !this.peers.has(s.id) || selected.some(t => t.sessionId === s.id)) continue;
      if ([...occupied, ...selected].some(t => t.cwd === task.cwd && (t.mode !== 'read' || task.mode !== 'read'))) continue;
      selected.push(task);
    }
    return selected.map(t => this.publicTask(t));
  }
  dispatch(id: string) {
    const task = this.task(id), session = this.session(task.sessionId);
    if (!this.nextQueued().some(t => t.id === id)) throw new Error('会话或项目忙，任务不可派发');
    // 排队期间前一任务可能已经改动代码；旧方案不得基于过期证据直接执行。
    if (task.planId) {
      const plan = this.plans.find(p => p.id === task.planId);
      try { if (!plan) throw new Error('缺少方案'); verifyEvidence(task.cwd, plan.evidence); }
      catch { task.status = 'needs_input'; task.note = '排队期间检查证据失效，请重新检查并创建新方案与任务'; task.updatedAt = now(); this.save(); return false; }
    }
    task.status = 'dispatching'; task.updatedAt = now(); session.activeTask = id; this.save();
    return true;
  }
  uncertain(id: string, note: string) {
    const task = this.task(id);
    if (task.status === 'dispatching') { task.status = 'delivery_unknown'; task.note = note; task.updatedAt = now(); this.save(); }
  }
  claim(id: string, sessionId: string) {
    const task = this.task(id);
    if (task.sessionId !== sessionId) throw new Error('领取会话不匹配');
    const session = this.session(sessionId);
    if (!session.online || session.activeTask !== id || !['dispatching', 'delivery_unknown', 'running', 'disconnected'].includes(task.status)) throw new Error('任务不能领取');
    task.lease ??= randomUUID(); task.status = 'running'; task.updatedAt = now(); this.save();
    return { ...task };
  }
  report(id: string, sessionId: string, lease: string, outcome: Outcome, report: string) {
    const task = this.task(id);
    if (task.sessionId !== sessionId || !lease || task.lease !== lease) throw new Error('任务会话或领取凭据不匹配');
    if (finished(task.status)) {
      if (task.status === outcome && task.report === report) return this.publicTask(task);
      throw new Error('任务已结束，拒绝覆盖结果');
    }
    if (!['running', 'disconnected'].includes(task.status)) throw new Error('任务未领取，不能汇报');
    task.status = outcome; task.report = report; task.updatedAt = now(); this.save();
    return this.publicTask(task);
  }
  observe(sessionId: string, event: string, requestId?: string) {
    const session = this.session(sessionId); session.lastEvent = event; session.updatedAt = now();
    if (event === 'StopFailure' && session.activeTask) {
      const task = this.task(session.activeTask);
      if (!finished(task.status)) {
        task.status = 'disconnected'; task.updatedAt = now();
        task.note = 'Claude 会话发生 API 失败，任务结果尚未确认；请核对原会话，不要重新提交';
      }
    }
    if (event === 'SessionEnd') {
      if (session.activeTask) for (const i of this.task(session.activeTask).interactions ?? []) if (['pending', 'answered'].includes(i.status)) i.status = 'expired';
      session.online = false; this.peers.delete(sessionId);
      if (session.activeTask) {
        const task = this.task(session.activeTask);
        if (!finished(task.status)) { task.status = 'disconnected'; task.note = 'Claude 会话已结束，未确认执行结果'; }
        else session.activeTask = undefined;
      }
    }
    // 只有最终回复携带相同任务编号时才释放占用，防止迟到事件串线。
    if (event === 'Stop' && requestId && session.activeTask === requestId && finished(this.task(requestId).status)) session.activeTask = undefined;
    this.save(); return { ...session };
  }
  cancel(id: string) {
    const task = this.task(id);
    if (task.status !== 'queued') throw new Error('任务已派发；请到 Claude 中停止，不会伪装为已取消');
    task.status = 'cancelled'; task.updatedAt = now(); this.save(); return this.publicTask(task);
  }
}
