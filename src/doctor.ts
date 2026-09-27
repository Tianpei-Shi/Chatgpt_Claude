import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { ensureBroker, rpc } from './client.js';
import { stopReleasePolicy } from './hook-policy.js';
import { codexConfigStatus } from './config-status.js';

/** 诊断只输出状态与路径，不输出认证配置或会话密钥。 */
export async function doctor(project: string, data: string) {
  const checks: Record<string, unknown> = { project, data, node: process.version };
  const codex = join(project, '.codex', 'config.toml'); const claude = join(project, '.mcp.json'); const hooks = join(project, '.claude', 'settings.local.json');
  checks.codexMcpConfigured = existsSync(codex) && Boolean((parse(readFileSync(codex, 'utf8')) as any).mcp_servers?.codex_claude_bridge);
  checks.codexRegistration = codexConfigStatus(project);
  checks.claudeMcpConfigured = existsSync(claude) && Boolean(JSON.parse(readFileSync(claude, 'utf8')).mcpServers?.codex_claude_bridge);
  checks.claudeHooksConfigured = existsSync(hooks) && Boolean(JSON.parse(readFileSync(hooks, 'utf8')).hooks?.SessionStart?.length);
  await ensureBroker(data); checks.broker = await rpc(data, 'codex', 'health');
  checks.sessions = await rpc(data, 'codex', 'sessions');
  checks.continuationPolicy = stopReleasePolicy(project);
  checks.desktopEndToEndVerified = false;
  checks.note = '配置存在、broker 在线或会话注册均不等于真实桌面执行已验证。请通过 Codex 提交只读任务，并在 Claude Desktop Code 核对收发。';
  return checks;
}
