import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';

/** 文件条目只能证明配置存在，不能证明当前桌面聊天已加载工具。 */
export function codexConfigStatus(project: string, userPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')) {
  const entry = (path: string): any => existsSync(path)
    ? (parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as any).mcp_servers?.codex_claude_bridge : undefined;
  const local = entry(join(project, '.codex/config.toml')), user = entry(userPath);
  return {
    projectConfigured: Boolean(local), userRegistered: Boolean(user), userEnabled: Boolean(user && user.enabled !== false),
    currentChatLoaded: 'not_verified' as const,
    nextAction: !user ? '用户级 MCP 未注册，项目配置存在并不保证客户端设置列表显示；请用 codex mcp add 注册。' : '用户级已注册；请重新加载桌面 MCP，并在目标聊天核对工具列表。',
  };
}
