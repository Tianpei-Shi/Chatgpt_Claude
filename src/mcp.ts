import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureBroker, rpc } from './client.js';
import { canonical } from './store.js';
import type { Role } from './types.js';
import { openDesktop, configureDesktop } from './desktop.js';

/** 两个客户端使用独立角色的同一 MCP 程序，STDOUT 仅输出协议。 */
export async function serveMcp(role: 'codex' | 'claude', data: string, project: string) {
  await ensureBroker(data);
  const server = new McpServer({ name: `codex-claude-${role}`, version: '0.1.0' });
  const request_id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
  const session_id = request_id;
  function tool(name: string, description: string, schema: any, call: (args: any) => Promise<any>) {
    server.registerTool(name, { description, inputSchema: schema }, async (args: any) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await call(args)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '桥接失败' }] }; }
    });
  }
  const send = (op: string, args: unknown = {}) => rpc(data, role as Role, op, args);
  tool('bridge_sessions', '列出此项目已注册的 Claude Code 会话；无会话时请在 Claude Desktop Code 中打开项目。不得猜测会话编号。', {}, async () => {
    const sessions = await send('sessions'); return sessions.filter((s: any) => s.cwd === canonical(project));
  });
  if (role === 'codex') {
    tool('bridge_desktop_open', '兼容入口：后台模式只返回 background_only，不打开窗口。使用 bridge_sessions 选择已注册会话；没有会话则等待用户准备，不使用 UI 自动化。', {}, () => openDesktop(project));
    tool('bridge_desktop_configure', '兼容入口：后台模式只返回 background_only，不修改或核验 UI 模型设置，不操作鼠标键盘。MCP 不允许启用 UI 控制。', { model: z.string().default('Opus 5.5'), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium') }, a => configureDesktop(a.model, a.effort, undefined, project));
    tool('bridge_submit', '把用户需求整理为英文后提交给绑定的 Claude 桌面 Code 会话。相同 request_id 幂等，不得超时后换编号重试。返回 queued 不等于执行成功。', { request_id, session_id, cwd: z.string(), prompt: z.string().min(1).max(100000) }, async a => {
      if (canonical(a.cwd) !== canonical(project)) throw new Error('只能提交当前 MCP 配置绑定的项目');
      return send('submit', { id: a.request_id, sessionId: a.session_id, cwd: a.cwd, prompt: a.prompt });
    });
    tool('bridge_status', '读取任务状态和英文结果，并用中文向用户汇报；没有验证证据不得宣称成功。', { request_id }, a => send('status', { id: a.request_id }));
    tool('bridge_wait', '有界等待任务状态变化；仍在执行可再次等待。delivery_unknown 时检查 Claude，禁止重复提交。', { request_id, seconds: z.number().int().min(0).max(50).default(25) }, a => send('wait', { id: a.request_id, seconds: a.seconds }));
    tool('bridge_cancel', '仅取消尚未派发的排队任务；已派发任务须在 Claude 客户端停止。', { request_id }, a => send('cancel', { id: a.request_id }));
  } else {
    tool('bridge_claim', '领取发给本 Claude 会话的英文任务。session_key 来自 SessionStart bridge 上下文，禁止输出该密钥。只执行返回的目标与约束。', { request_id, session_id, session_key: z.string().min(1) }, a => send('claim', { id: a.request_id, sessionId: a.session_id, sessionKey: a.session_key }));
    tool('bridge_report', '用英文回传执行结果，包含修改文件、实际检查及未完成项。outcome 必须真实。随后结束本轮，最终回复末尾写 [BRIDGE_TASK:任务编号]，让 Stop hook 释放会话。', { request_id, session_id, lease: z.string().min(1), outcome: z.enum(['completed', 'failed', 'needs_input']), report: z.string().min(1).max(200000) }, a => send('report', { id: a.request_id, sessionId: a.session_id, lease: a.lease, outcome: a.outcome, report: a.report }));
  }
  await server.connect(new StdioServerTransport());
}
