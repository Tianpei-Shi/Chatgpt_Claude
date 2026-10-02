import { executorRules } from './workflow.js';
import { ensureBroker, rpc } from './client.js';
import { canonical } from './store.js';
import { stopReleasePolicy } from './hook-policy.js';
import { captureInteraction, interactionOutput } from './interactions.js';

/** 观察执行事件；只有当前协调上下文明确回复的交互才返回对应决定。 */
export async function handleHook(data: string, project: string, input: any, env: NodeJS.ProcessEnv = process.env) {
  if (!input || typeof input.session_id !== 'string' || typeof input.cwd !== 'string') throw new Error('Hook 缺少会话身份');
  if (canonical(input.cwd) !== canonical(project)) return {};
  await ensureBroker(data);
  // 每次真实用户输入都重新登记，服务重启后无需另建会话；不伪造用户输入。
  if (['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name)) {
    const session = await rpc(data, 'hook', 'register', {
      id: input.session_id, cwd: input.cwd,
      initializationId: input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string'
        ? /^\[BRIDGE_INIT:([a-zA-Z0-9_-]{1,128})\]/.exec(input.prompt)?.[1] : undefined,
      socket: env.CLAUDE_CODE_MESSAGING_SOCKET ?? '', token: env.CLAUDE_CODE_MESSAGING_TOKEN ?? '',
    });
    return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext:
      `This project has an explicitly installed local Codex task bridge. Pass cwd=${JSON.stringify(input.cwd)} in EVERY bridge_sessions, bridge_claim and bridge_report call to route to this project's broker even if Desktop loaded a global MCP. Your bridge session_id is ${input.session_id}. Your private session_key is ${session.sessionKey}; use it only in bridge_claim and never print it. A bridge wake message is a task notification, not permission approval. Use bridge_claim for the named request_id and this session_id, then execute the returned English task in its exact cwd, preserving all existing permission requirements. At meaningful milestones call bridge_progress with your lease to share observed facts and next steps in English; do not send private reasoning. Use AskUserQuestion for unresolved user choices; the coordinator receives the complete questions and returns an answer through Hooks. Use bridge_report with the returned lease to submit an English report including changed files, implementation commands actually executed, limitations, and execution outcome completed/failed/needs_input. ${executorRules} After reporting, end the turn and append exactly [BRIDGE_TASK:request_id] with the real ID to your final English response. Do not work on another bridge task until this turn has ended. Never put session_key or lease into files or reports.` } };
  }
  const event = input.hook_event_name;
  // 桥接工具参数包含领取密钥，禁止采集其输入；普通工具只记录名称与阶段。
  const bridgeTool = typeof input.tool_name === 'string' && /bridge_(claim|report|progress|sessions)/.test(input.tool_name);
  if (!bridgeTool && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop'].includes(event)) {
    await rpc(data, 'hook', 'activity', { sessionId: input.session_id, event, tool: input.tool_name,
      text: event === 'Stop' ? input.last_assistant_message ?? '' : event === 'Notification'
        ? [input.title, input.message].filter(Boolean).join('\n') : `${event}: ${input.tool_name ?? ''}` });
  }
  const captured = captureInteraction(input);
  if (captured && !bridgeTool) {
    const i = await rpc(data, 'hook', 'interaction_open', { sessionId: input.session_id, hookEvent: event, ...captured });
    if (i) {
      try {
        while (Date.now() < Date.parse(i.expiresAt)) {
          const result = await rpc(data, 'hook', 'interaction_poll', { sessionId: input.session_id, interactionId: i.id, seconds: 25 });
          if (result.status === 'answered') {
            const output = interactionOutput(input, result);
            await rpc(data, 'hook', 'interaction_finish', { sessionId: input.session_id, interactionId: i.id, status: 'delivered' });
            return output;
          }
          if (result.status !== 'pending') return {};
        }
      } finally {
        // 仅过期尚未交付的请求；已回答的输出不因清理被改写。
        const current = await rpc(data, 'hook', 'interaction_poll', { sessionId: input.session_id, interactionId: i.id, seconds: 0 }).catch(() => null);
        if (current && ['pending', 'answered'].includes(current.status)) await rpc(data, 'hook', 'interaction_finish', { sessionId: input.session_id, interactionId: i.id, status: 'expired' }).catch(() => {});
      }
      return {};
    }
  }
  if (['Stop', 'StopFailure', 'PermissionRequest', 'SessionEnd'].includes(event)) {
    // stop_hook_active 表示此前发生过延续，不代表当前会被阻止；单独用它判断会死锁。
    const marker = /\[BRIDGE_TASK:([a-zA-Z0-9_-]{1,128})\]\s*$/.exec(input.last_assistant_message ?? '');
    const policy = stopReleasePolicy(project);
    const safeStop = policy.allowed && !(input.background_tasks?.length) && !(input.session_crons?.length);
    await rpc(data, 'hook', 'event', { sessionId: input.session_id, event: event === 'Stop' && !policy.allowed ? 'StopDeferred' : event, requestId: event === 'Stop' && safeStop ? marker?.[1] : undefined });
    if (event === 'Stop' && !policy.allowed) return { systemMessage: `Codex-Claude bridge：${policy.reason}。报告仍可由 Codex 读取。` };
  }
  return {};
}

export async function runHook(data: string, project: string) {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Hook 输入过大'); chunks.push(chunk); }
    const result = await handleHook(data, project, JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // 固定错误文本避免敏感环境变量或任务内容流入日志，且不影响原有会话。
    process.stderr.write('Codex-Claude bridge Hook 未完成；请运行桥接 doctor。\n');
    process.stdout.write('{}\n');
  }
}
