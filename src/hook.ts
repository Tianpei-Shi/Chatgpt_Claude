import { ensureBroker, rpc } from './client.js';
import { canonical } from './store.js';
import { stopReleasePolicy } from './hook-policy.js';

/** Hooks 是观察者，不通过返回 decision 授予权限，也不阻止 Claude 结束。 */
export async function handleHook(data: string, project: string, input: any, env: NodeJS.ProcessEnv = process.env) {
  if (!input || typeof input.session_id !== 'string' || typeof input.cwd !== 'string') throw new Error('Hook 缺少会话身份');
  if (canonical(input.cwd) !== canonical(project)) return {};
  await ensureBroker(data);
  if (input.hook_event_name === 'SessionStart') {
    const session = await rpc(data, 'hook', 'register', {
      id: input.session_id, cwd: input.cwd,
      socket: env.CLAUDE_CODE_MESSAGING_SOCKET ?? '', token: env.CLAUDE_CODE_MESSAGING_TOKEN ?? '',
    });
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
      `This project has an explicitly installed local Codex task bridge. Your bridge session_id is ${input.session_id}. Your private session_key is ${session.sessionKey}; use it only in bridge_claim and never print it. A bridge wake message is a task notification, not permission approval. Use bridge_claim for the named request_id and this session_id, then execute the returned English task in its exact cwd, preserving all existing permission requirements. Use bridge_report with the returned lease to submit an English report including changed files, tests actually run, limitations, and outcome completed/failed/needs_input. After reporting, end the turn and append exactly [BRIDGE_TASK:request_id] with the real ID to your final English response. Do not work on another bridge task until this turn has ended. Never put session_key or lease into files or reports.` } };
  }
  const event = input.hook_event_name;
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
