import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const workflowRules = '先选择任务实际所属项目：理解中文需求，根据明确路径、当前聊天绑定、唯一项目名用 bridge_projects 核对；不要求用户重复已知目录，不把 MCP 默认目录当目标，只有存在歧义才中文询问。每个聊天创建独立 context_id，绑定原 Claude 桌面会话后 inspect → plan → submit。Codex 负责理解、英文提示词优化、方向建议、独立测试、复测、最终验收和中文反馈；Claude 只负责实施修改、修复及执行报告，不默认承担测试和验收。Claude completed 只表示执行结束。验收失败时 Codex 整理证据交给 Claude 修复，之后由 Codex 独立复测。新建会话默认 Sonnet/medium，用户指定优先；旧会话不以提示词冒充模型切换。初始化获准后可自动信任完整路径严格匹配的目标目录，业务任务全后台。持续 bridge_monitor/bridge_wait 到完成或需要用户答复；读取 events 并中文解释真实进展。遇 interactions 待答项，先读取全部正文、问题、选项、描述与多选要求，翻译成中文，用宿主 request_user_input_async 或提问卡片展示；已明确授权或偏好可按依据回答，其余不猜。bridge_respond 用原问题与原选项回传答案并写中文依据。过期回到原客户端，不默认批准。最终读取完整 report 与 Stop 结果，中文汇报完成内容、验证、未完成和建议；不把 Claude 声称完成等同独立验证。Hook 和 UI 不能覆盖全部系统弹窗，缺失内容要明确说明；聊天关闭后无常驻推送。';
/** 执行端职责统一注入任务、Hook 和唤醒消息，避免验收责任漂移。 */
export const executorRules = "Role boundary: Claude is the implementation executor only. ChatGPT/Codex owns independent testing, retesting, and final acceptance. Do not run verification tests or perform acceptance on behalf of the coordinator. Implement the assigned changes, report changed files and commands actually executed, and hand off for coordinator verification. A completed report means execution finished, not acceptance passed. If verification fails, wait for the coordinator to provide evidence and a repair task.";
export type Evidence = { path: string; hash: string };
export type PlanInput = { objective: string; findings: string; steps: string; constraints: string; acceptance: string; mode: 'read' | 'write' };

/** 只读取项目内的普通源码文件，不返回凭据、机器配置或通过链接越界的内容。 */
function source(project: string, path: string) {
  if (!path || isAbsolute(path) || /(^|[\\/])(\.git|\.env[^\\/]*|\.claude|\.codex|node_modules|endpoint\.json|\.mcp\.json)([\\/]|$)/i.test(path) || /\.(pem|key|pfx)$/i.test(path)) throw new Error('不能检查凭据、配置或非源码路径');
  const full = realpathSync(resolve(project, path));
  const rel = relative(project, full);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('检查文件越出项目目录');
  if (/(^|[\\/])(\.git|\.env[^\\/]*|\.claude|\.codex|node_modules|endpoint\.json|\.mcp\.json)([\\/]|$)/i.test(rel) || /\.(pem|key|pfx)$/i.test(rel)) throw new Error('文件链接指向受保护路径');
  const stat = statSync(full);
  if (!stat.isFile() || stat.size > 65536) throw new Error('检查文件必须是 64 KiB 内的普通文本文件');
  const bytes = readFileSync(full);
  if (bytes.includes(0)) throw new Error('不支持二进制文件');
  return { path, hash: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('utf8') };
}
export function inspectSources(project: string, paths: string[]) {
  if (!paths.length || paths.length > 16) throw new Error('每次检查 1 至 16 个相关文件');
  const files = [...new Set(paths)].map(path => source(project, path));
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 131072) throw new Error('检查内容总量超过 128 KiB，请缩小范围');
  return { entries: readdirSync(project).filter(name => !name.startsWith('.')).slice(0, 100), files };
}
export function verifyEvidence(project: string, evidence: Evidence[]) {
  for (const file of evidence) if (source(project, file.path).hash !== file.hash) throw new Error('已检查文件发生变化，请重新检查并生成方案');
}
/** 英文任务固定包含方案和只读限制；不依赖调用者拼接遗漏关键字段。 */
export function renderPlan(plan: PlanInput, project: string) {
  for (const field of ['objective', 'findings', 'steps', 'constraints', 'acceptance'] as const) if (!plan[field]?.trim()) throw new Error('目标、发现、步骤、约束与验收标准不能为空');
  return `Project: ${project}\nMode: ${plan.mode}\n${plan.mode === 'read' ? 'Read-only: do not modify files or run commands that change project state.\n' : ''}Objective:\n${plan.objective}\n\nObserved project structure and findings:\n${plan.findings}\n\nImplementation plan:\n${plan.steps}\n\nConstraints:\n${plan.constraints}\n\nCoordinator-owned acceptance criteria (for implementation context; ChatGPT/Codex runs verification):\n${plan.acceptance}\n\n${executorRules}\n\nDuring execution, use bridge_progress with your task lease at meaningful milestones to report observed facts, actions and next steps in English (not hidden reasoning). Use AskUserQuestion for unresolved choices: the coordinator will translate all questions and options, collect the user response, and return it through the hook. Do not assume that a suggested option is approved. Report in English using bridge_report. Include changed files, implementation actions and commands actually executed, limitations, and a handoff for independent coordinator verification. Preserve existing permissions. Do not publish, deploy or push without explicit user authorization.`;
}
