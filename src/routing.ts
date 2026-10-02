import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './store.js';

/** 只路由到显式安装了本程序的项目；不执行项目配置中的任何命令。 */
export function routeProject(baseProject: string, baseData: string, cwd?: string) {
  const project = canonical(cwd ?? baseProject);
  if (project === canonical(baseProject)) return { project, data: baseData };
  const file = join(project, '.mcp.json');
  if (!existsSync(file)) throw new Error(`目标项目未安装桥接：${project}。请先运行 install --project 目标目录；打开 Claude 目录本身不会安装 Hooks。`);
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).mcpServers?.codex_claude_bridge;
  const args = config?.args;
  const main = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/main.js');
  if (config?.command !== process.execPath || !Array.isArray(args) || args[0] !== main || args[1] !== 'mcp') throw new Error('目标项目的同名 MCP 不属于当前桥接安装');
  const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const bound = flag('--project'), data = flag('--data');
  if (typeof bound !== 'string' || canonical(bound) !== project || typeof data !== 'string' || !isAbsolute(data) || flag('--role') !== 'claude') throw new Error('目标项目桥接配置的目录或数据路径不匹配');
  return { project, data };
}
