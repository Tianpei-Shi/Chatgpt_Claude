import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { canonical } from './store.js';

type Project = { name: string; cwd: string; source: string };

/** 只枚举已知桥接状态，不递归扫描磁盘，也不读取会话对话内容返回给调用端。 */
export function discoverProjects(dataRoot: string, currentCwd?: string): Project[] {
  const result = new Map<string, Project>();
  const add = (path: unknown, source: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    try {
      if (!statSync(path).isDirectory()) return;
      const cwd = canonical(path); if (!result.has(cwd)) result.set(cwd, { name: basename(path), cwd, source });
    } catch { /* 已删除的历史项目不再作为候选。 */ }
  };
  add(currentCwd, 'current_chat');
  if (existsSync(dataRoot)) for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
    try {
      const state = JSON.parse(readFileSync(join(dataRoot, entry.name, 'state.json'), 'utf8'));
      for (const item of [...(state.sessions ?? []), ...(state.contexts ?? [])]) add(item.cwd, 'registered_bridge');
    } catch { /* 单个历史状态异常不阻断其他项目发现。 */ }
  }
  return [...result.values()];
}

/** 文本语义由 Codex 理解；本工具只把已识别名称解析成可验证的唯一目录。 */
export function resolveProject(projects: Project[], query = '', currentCwd?: string) {
  const text = query.trim();
  if (!text && currentCwd) {
    const selected = projects.find(p => p.cwd === canonical(currentCwd));
    if (selected) return { status: 'resolved', project: selected.cwd, reason: 'current_chat', candidates: [selected] };
  }
  if (!text) return { status: 'needs_project', candidates: projects };
  let path: string | undefined;
  if (isAbsolute(text)) { try { path = canonical(text); } catch { /* 不存在目录只返回未找到。 */ } }
  const matches = projects.filter(p => path ? p.cwd === path : p.name.toLocaleLowerCase() === text.toLocaleLowerCase());
  return { status: matches.length === 1 ? 'resolved' : matches.length ? 'ambiguous' : 'not_found',
    project: matches.length === 1 ? matches[0].cwd : undefined, candidates: matches };
}
