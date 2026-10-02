import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, canonical } from './store.js';
import { sendWake } from './peer.js';
import type { Endpoint, Role } from './types.js';
import { redact } from './interactions.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const allowed: Record<Role, string[]> = {
  codex: ['health', 'sessions', 'submit', 'status', 'wait', 'cancel', 'shutdown', 'context_create', 'context_status', 'context_bind', 'context_release', 'inspect', 'plan', 'respond'],
  claude: ['health', 'sessions', 'claim', 'report', 'progress'],
  hook: ['health', 'register', 'event', 'activity', 'interaction_open', 'interaction_poll', 'interaction_finish'],
};
function same(a: string, b: string) {
  // 认证头可能含非 ASCII 字符；必须比较字节长度，不能比较字符数。
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 先取得监听端口，再打开状态文件，避免竞态启动的第二个进程恢复正在运行的任务。 */
export async function startBroker(dir: string, endpoint: Endpoint) {
  let store: Store;
  const workerKeys = new Map<string, string>();
  const timers = new Set<NodeJS.Timeout>();
  let closing = false;
  function pump() {
    if (closing) return;
    for (const task of store.nextQueued()) {
      if (!store.dispatch(task.id)) { queueMicrotask(pump); continue; }
      const peer = store.peer(task.sessionId)!;
      void sendWake(peer, task.id, task.sessionId).catch(() => store.uncertain(task.id, '管道未确认接收；不会自动重发'));
      const timer = setTimeout(() => { timers.delete(timer); store.uncertain(task.id, '30 秒内尚未领取，请检查 Claude 权限提示与 MCP 状态'); }, 30000);
      timer.unref(); timers.add(timer);
    }
  }
  async function run(role: Role, op: string, args: any) {
    if (!allowed[role].includes(op)) throw new Error('角色权限不允许此操作');
    if (['context_status', 'context_bind', 'context_release', 'inspect', 'plan', 'submit', 'cancel', 'respond'].includes(op)) {
      const contextId = id.parse(args.contextId);
      if (store.contextStatus(contextId).context.cwd !== canonical(z.string().min(1).parse(args.cwd))) throw new Error('协调上下文与工作项目不匹配');
    }
    switch (op) {
      case 'health': return { ok: true, version: '0.3.0', pid: process.pid, workflowVersion: 1, interactionVersion: 1 };
      case 'activity': {
        const input = z.object({ sessionId: id, event: z.string().max(80), tool: z.string().max(200).optional(), text: z.string().max(200000) }).parse(args);
        store.recordActivity(input.sessionId, input.event, input.tool, redact(input.text, [workerKeys.get(input.sessionId) ?? ''])); return { recorded: true };
      }
      case 'progress': {
        const input = z.object({ id, sessionId: id, lease: z.string().min(1), text: z.string().trim().min(1).max(15000) }).parse(args);
        return store.progress(input.id, input.sessionId, input.lease, redact(input.text, [workerKeys.get(input.sessionId) ?? '']));
      }
      case 'interaction_open': {
        const input = z.object({ sessionId: id, kind: z.enum(['question', 'permission', 'elicitation']), hookEvent: z.enum(['PreToolUse', 'PermissionRequest', 'Elicitation']), payload: z.record(z.unknown()) }).parse(args);
        return store.openInteraction(input.sessionId, input.kind, input.hookEvent, redact(input.payload, [workerKeys.get(input.sessionId) ?? '']));
      }
      case 'interaction_poll': {
        const input = z.object({ sessionId: id, interactionId: id, seconds: z.number().min(0).max(25).default(25) }).parse(args);
        const start = Date.now();
        let result = store.pollInteraction(input.sessionId, input.interactionId);
        while (!closing && result.status === 'pending' && Date.now() - start < input.seconds * 1000) {
          await new Promise(r => setTimeout(r, 200)); result = store.pollInteraction(input.sessionId, input.interactionId);
        }
        return result;
      }
      case 'interaction_finish': {
        const input = z.object({ sessionId: id, interactionId: id, status: z.enum(['delivered', 'expired']) }).parse(args);
        return store.finishInteraction(input.sessionId, input.interactionId, input.status);
      }
      case 'respond': {
        const input = z.object({ id, interactionId: id, answer: z.record(z.unknown()), rationale: z.string().trim().min(1).max(10000) }).parse(args);
        return store.respondInteraction(args.contextId, input.id, input.interactionId, input.answer, input.rationale);
      }
      case 'context_create': return store.createContext(z.string().min(1).parse(args.cwd), z.string().trim().min(1).max(200).parse(args.label));
      case 'context_status': return store.contextStatus(args.contextId);
      case 'context_bind': return store.bindContext(args.contextId, id.parse(args.sessionId));
      case 'context_release': return store.releaseContext(args.contextId, id.parse(args.sessionId));
      case 'inspect': return store.inspectContext(args.contextId, z.array(z.string().min(1)).min(1).max(16).parse(args.paths));
      case 'plan': {
        const text = z.string().trim().min(1).max(15000);
        return store.preparePlan(args.contextId, z.object({ objective: text, findings: text, steps: text, constraints: text, acceptance: text, mode: z.enum(['read', 'write']) }).parse(args));
      }
      case 'shutdown': {
        if (store.sessions().some(s => s.online)) throw new Error('仍有在线会话，请先结束 Claude 桥接会话，避免丢失连接');
        // 先完成当前 HTTP 响应，再关闭自己的监听器；不终止客户端进程。
        setImmediate(() => { closing = true; for (const timer of timers) clearTimeout(timer); server.close(); server.closeIdleConnections(); });
        return { stopped: true };
      }
      case 'sessions': return store.sessions();
      case 'register': {
        const input = z.object({ id, cwd: z.string().min(1), socket: z.string().max(2048), token: z.string().max(4096), initializationId: id.optional() }).parse(args);
        const session = store.register(input);
        // 每个会话的领取密钥仅通过自己的 SessionStart 上下文交给 Claude。
        const sessionKey = workerKeys.get(input.id) ?? randomBytes(24).toString('hex'); workerKeys.set(input.id, sessionKey);
        pump(); return { ...session, sessionKey };
      }
      case 'submit': {
        const input = z.object({ id, sessionId: id, contextId: id, planId: id }).parse(args);
        const task = store.submitPrepared(input.id, input.contextId, input.sessionId, input.planId); pump(); return task;
      }
      case 'status': return store.get(id.parse(args.id));
      case 'cancel': {
        const task = store.get(id.parse(args.id));
        if (task.contextId !== args.contextId) throw new Error('不能取消其他聊天的任务');
        const result = store.cancel(task.id); pump(); return result;
      }
      case 'wait': {
        const input = z.object({ id, seconds: z.number().int().min(0).max(50).default(25) }).parse(args);
        const start = Date.now(); const before = JSON.stringify(store.get(input.id));
        // 进度和待答问题同样唤醒等待；不能只比较 running/completed。
        while (!closing && Date.now() - start < input.seconds * 1000 && ['queued', 'dispatching', 'running'].includes(store.get(input.id).status) && JSON.stringify(store.get(input.id)) === before && !store.get(input.id).interactions.some(i => i.status === 'pending')) await new Promise(r => setTimeout(r, 200));
        return store.get(input.id);
      }
      case 'claim': {
        const input = z.object({ id, sessionId: id, sessionKey: z.string().min(1) }).parse(args);
        const key = workerKeys.get(input.sessionId);
        if (!key || !same(key, input.sessionKey)) throw new Error('会话领取密钥无效，请恢复该 Claude 会话重新注册');
        return store.claim(input.id, input.sessionId);
      }
      case 'report': {
        const input = z.object({ id, sessionId: id, lease: z.string().min(1), outcome: z.enum(['completed', 'failed', 'needs_input']), report: z.string().min(1).max(200000) }).parse(args);
        return store.report(input.id, input.sessionId, input.lease, input.outcome, input.report);
      }
      case 'event': {
        const input = z.object({ sessionId: id, event: z.enum(['Stop', 'StopDeferred', 'StopFailure', 'PermissionRequest', 'SessionEnd']), requestId: id.optional() }).parse(args);
        const session = store.observe(input.sessionId, input.event, input.requestId);
        if (input.event === 'SessionEnd') workerKeys.delete(input.sessionId);
        pump(); return session;
      }
    }
  }
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.headers.origin) return reply(403, { error: '不接受浏览器来源请求' });
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const role = (Object.keys(endpoint.keys) as Role[]).find(role => same(endpoint.keys[role], token));
    if (!role) return reply(401, { error: '桥接认证失败' });
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: '接口不存在' });
    try {
      const buffers: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return reply(413, { error: '请求过大' }); buffers.push(chunk); }
      const { op, args } = z.object({ op: z.string(), args: z.any() }).parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
      const result = await run(role, op, args); reply(200, result);
    } catch (error) { reply(400, { error: error instanceof z.ZodError ? '输入参数格式无效' : error instanceof Error ? error.message : '桥接操作失败' }); }
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint.port, '127.0.0.1', resolve); });
  try { store = new Store(dir); }
  catch (error) { server.close(); throw error; }
  const port = (server.address() as any).port as number;
  endpoint.port = port;
  writeFileSync(join(dir, 'endpoint.json'), JSON.stringify(endpoint), { mode: 0o600 });
  return { port, store, close: async () => {
    closing = true; for (const timer of timers) clearTimeout(timer);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  } };
}
