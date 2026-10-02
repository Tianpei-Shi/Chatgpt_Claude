import type { Interaction, InteractionKind } from './types.js';

/** 仅提取交互字段；不把整个 Hook（包含会话路径等）写入任务记录。 */
export function captureInteraction(input: any): { kind: InteractionKind; payload: Record<string, any> } | undefined {
  const event = input.hook_event_name;
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    return { kind: 'question', payload: { tool_name: input.tool_name, tool_use_id: input.tool_use_id, tool_input: input.tool_input } };
  }
  if (event === 'PreToolUse' && input.tool_name === 'ExitPlanMode') return { kind: 'permission', payload: {
    tool_name: input.tool_name, tool_use_id: input.tool_use_id, tool_input: input.tool_input,
  } };
  if (event === 'PermissionRequest') {
    return { kind: input.tool_name === 'AskUserQuestion' ? 'question' : 'permission', payload: {
      tool_name: input.tool_name, tool_use_id: input.tool_use_id, tool_input: input.tool_input,
      permission_suggestions: input.permission_suggestions,
    } };
  }
  if (event === 'Elicitation') return { kind: 'elicitation', payload: {
    mcp_server_name: input.mcp_server_name, message: input.message, mode: input.mode ?? 'form',
    url: input.url, elicitation_id: input.elicitation_id, requested_schema: input.requested_schema,
  } };
}

/** 回复必须覆盖全部问题；允许自由文本，保留原始标签作为映射键。 */
export function validateAnswer(i: Interaction, answer: Record<string, any>) {
  if (i.kind === 'question') {
    const questions = i.payload.tool_input?.questions;
    if (!Array.isArray(questions) || !questions.length || !answer.answers ||
      questions.some(q => typeof answer.answers[q.question] !== 'string' || !answer.answers[q.question].trim()) ||
      Object.keys(answer.answers).some(key => !questions.some(q => q.question === key))) throw new Error('必须按原文回答全部问题');
  } else if (i.kind === 'permission') {
    if (!['allow', 'deny'].includes(answer.behavior)) throw new Error('权限回复必须明确 allow 或 deny');
  } else {
    if (!['accept', 'decline', 'cancel'].includes(answer.action)) throw new Error('表单回复无效');
    if (answer.action === 'accept' && i.payload.mode === 'url') throw new Error('登录链接必须在原客户端完成，不能代替认证');
    if (answer.action === 'accept' && (!answer.content || typeof answer.content !== 'object' || Array.isArray(answer.content))) throw new Error('表单回复缺少字段');
  }
}

/** 原始工具输入仅在 Hook 进程内回填，公开记录中的脱敏内容不能覆盖真实执行参数。 */
export function interactionOutput(input: any, i: Interaction) {
  if (i.status !== 'answered' || !i.answer) return {};
  const event = input.hook_event_name;
  if (i.kind === 'question') {
    const updatedInput = { ...input.tool_input, answers: i.answer.answers };
    return { hookSpecificOutput: event === 'PreToolUse'
      ? { hookEventName: event, permissionDecision: 'allow', updatedInput }
      : { hookEventName: event, decision: { behavior: 'allow', updatedInput } } };
  }
  if (i.kind === 'permission' && event === 'PreToolUse') return { hookSpecificOutput: {
    hookEventName: event, permissionDecision: i.answer.behavior,
    ...(i.answer.behavior === 'allow' ? { updatedInput: input.tool_input } : { permissionDecisionReason: i.answer.message ?? 'The user declined through the coordinator.' }),
  } };
  if (i.kind === 'permission') return { hookSpecificOutput: { hookEventName: event, decision: {
    behavior: i.answer.behavior, ...(i.answer.behavior === 'deny' ? { message: i.answer.message ?? 'The user declined through the coordinator.' } : {}),
  } } };
  return { hookSpecificOutput: { hookEventName: event, action: i.answer.action, ...(i.answer.action === 'accept' ? { content: i.answer.content } : {}) } };
}

/** 结构性脱敏不截断问题或选项；超大交互由调用层明确拒绝并回退原界面。 */
export function redact(value: any, secrets: string[] = []): any {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]+)/gi, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    /^(?:session_key|sessionKey|lease|token|password|api_key|apiKey|authorization)$/i.test(key) ? '[REDACTED]' : redact(v, secrets)]));
  return value;
}
