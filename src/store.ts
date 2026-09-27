import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, TaskInput, Registration, Session, Outcome } from './types.js';

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
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true }); this.file = join(dir, 'state.json');
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.tasks) || !Array.isArray(saved.sessions)) throw new Error('状态文件版本无效，保留原文件等待检查');
      this.tasks = saved.tasks; this.entries = saved.sessions;
      for (const entry of this.entries) entry.online = false;
      for (const task of this.tasks) {
        if (task.status === 'dispatching') task.status = 'delivery_unknown';
        if (task.status === 'running') task.status = 'disconnected';
      }
      this.save();
    }
  }
  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.tasks, sessions: this.entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  private task(id: string) { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error('任务不存在'); return task; }
  private session(id: string) { const session = this.entries.find(s => s.id === id); if (!session) throw new Error('会话不存在'); return session; }
  private publicTask(task: Task): Omit<Task, 'lease'> { const { lease, ...publicTask } = task; return { ...publicTask }; }
  sessions() { return this.entries.map(s => ({ ...s, canWake: this.peers.has(s.id) })); }
  listTasks() { return this.tasks.map(t => this.publicTask(t)); }
  get(id: string) { return this.publicTask(this.task(id)); }
  peer(id: string) { return this.peers.get(id); }
  register(input: Registration) {
    const cwd = canonical(input.cwd);
    let session = this.entries.find(s => s.id === input.id);
    if (session && session.cwd !== cwd) throw new Error('会话工作目录发生冲突');
    if (!session) { session = { id: input.id, cwd, online: true, updatedAt: now() }; this.entries.push(session); }
    session.online = true; session.updatedAt = now(); session.lastEvent = 'SessionStart';
    // 有效端点缺失时仍可诊断会话，但不宣称具备唤醒能力。
    if (input.socket && input.token) this.peers.set(input.id, { ...input, cwd });
    else this.peers.delete(input.id);
    this.save(); return { ...session };
  }
  submit(input: TaskInput) {
    const cwd = canonical(input.cwd);
    const old = this.tasks.find(t => t.id === input.id);
    if (old) {
      if (old.sessionId !== input.sessionId || old.cwd !== cwd || old.prompt !== input.prompt) throw new Error('任务编号冲突，不能复用编号提交不同内容');
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
    return this.entries.filter(s => s.online && !s.activeTask && this.peers.has(s.id))
      .flatMap(s => { const t = this.tasks.find(t => t.sessionId === s.id && t.status === 'queued'); return t ? [this.publicTask(t)] : []; });
  }
  dispatch(id: string) {
    const task = this.task(id), session = this.session(task.sessionId);
    if (task.status !== 'queued' || session.activeTask || !session.online) throw new Error('会话忙或任务不可派发');
    task.status = 'dispatching'; task.updatedAt = now(); session.activeTask = id; this.save();
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
