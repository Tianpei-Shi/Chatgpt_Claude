import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 观察型 Hook 无法知道其他 Hook 的最终决策，遇到未知扩展时保守暂停自动接下一单。 */
export function stopReleasePolicy(project: string, files?: string[]) {
  const main = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/main.js');
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const paths = files ?? [join(claudeHome, 'settings.json'), join(project, '.claude/settings.json'), join(project, '.claude/settings.local.json'),
    ...(process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH ? [process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH] : [])];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      const hooks = config.hooks?.Stop?.flatMap((group: any) => group.hooks) ?? [];
      if (hooks.some((hook: any) => hook.command !== process.execPath || hook.args?.[0] !== main || hook.args?.[1] !== 'hook')) return { allowed: false, reason: '存在其他 Stop Hooks，无法确定最终停止决策；需结束并恢复会话后继续接单' };
      if (Object.values(config.enabledPlugins ?? {}).some(Boolean)) return { allowed: false, reason: '存在启用的 Claude 插件，未验证其 Stop Hooks；自动连续接单暂缓' };
    } catch { return { allowed: false, reason: '无法解析有效 Hook 配置；自动连续接单暂缓' }; }
  }
  return { allowed: true, reason: '已检查的配置没有其他 Stop Hooks 或启用插件；动态/管理端注入仍需实际验证' };
}
