import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import { randomUUID } from 'node:crypto';

const name = 'codex_claude_bridge';
const events = ['SessionStart', 'Stop', 'StopFailure', 'PermissionRequest', 'SessionEnd'];
const main = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/main.js');
const json = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
function paths(project: string) { return { mcp: join(project, '.mcp.json'), hooks: join(project, '.claude', 'settings.local.json'), codex: join(project, '.codex', 'config.toml') }; }
function load(project: string) {
  const p = paths(project);
  return { p, mcp: json(p.mcp), hooks: json(p.hooks), codex: existsSync(p.codex) ? parse(readFileSync(p.codex, 'utf8').replace(/^\uFEFF/, '')) as any : {} };
}
function owned(config: any) { return config?.command === process.execPath && Array.isArray(config.args) && config.args[0] === main; }
function hookOwned(hook: any) { return owned(hook) && hook.args[1] === 'hook'; }
function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, 'utf8') === body) return;
  if (existsSync(path)) copyFileSync(path, `${path}.bridge-backup-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const tmp = `${path}.bridge-tmp`; writeFileSync(tmp, body, 'utf8'); renameSync(tmp, path);
}
function persist(config: ReturnType<typeof load>) {
  write(config.p.mcp, JSON.stringify(config.mcp, null, 2) + '\n');
  write(config.p.hooks, JSON.stringify(config.hooks, null, 2) + '\n');
  write(config.p.codex, stringify(config.codex));
}

/** 先解析全部配置并检查冲突；只合并自己的命名空间，备份原始字节。 */
export function install(project: string, data: string) {
  const config = load(project);
  const { mcp, hooks, codex } = config;
  mcp.mcpServers ??= {}; codex.mcp_servers ??= {}; hooks.hooks ??= {};
  for (const old of [mcp.mcpServers[name], codex.mcp_servers[name]]) if (old && !owned(old)) throw new Error('存在其他程序的同名 MCP，拒绝覆盖');
  const args = (role: string) => [main, 'mcp', '--role', role, '--data', resolve(data), '--project', resolve(project)];
  mcp.mcpServers[name] = { command: process.execPath, args: args('claude') };
  codex.mcp_servers[name] = { command: process.execPath, args: args('codex'), startup_timeout_sec: 20, tool_timeout_sec: 65 };
  for (const event of events) {
    const groups = hooks.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`已有 ${event} Hooks 格式无效`);
    const kept = groups.map((group: any) => ({ ...group, hooks: group.hooks.filter((hook: any) => !hookOwned(hook)) })).filter((group: any) => group.hooks.length);
    kept.push({ hooks: [{ type: 'command', command: process.execPath, args: [main, 'hook', '--data', resolve(data), '--project', resolve(project)], timeout: 10 }] });
    hooks.hooks[event] = kept;
  }
  persist(config);
  return { installed: true, project: resolve(project), files: Object.values(config.p), data, next: '在 Codex 重新加载 MCP，并在 Claude 桌面 Code 模式打开或恢复此目录。首次信任与工具权限由客户端提示。' };
}

/** 不回滚整份旧配置，保留安装后用户新增的设置。 */
export function uninstall(project: string, _data: string) {
  const config = load(project);
  if (owned(config.mcp.mcpServers?.[name])) delete config.mcp.mcpServers[name];
  if (owned(config.codex.mcp_servers?.[name])) delete config.codex.mcp_servers[name];
  for (const event of events) {
    const groups = config.hooks.hooks?.[event]; if (!groups) continue;
    config.hooks.hooks[event] = groups.map((group: any) => ({ ...group, hooks: group.hooks.filter((hook: any) => !hookOwned(hook)) })).filter((group: any) => group.hooks.length);
  }
  persist(config); return { uninstalled: true, preservedData: _data };
}
