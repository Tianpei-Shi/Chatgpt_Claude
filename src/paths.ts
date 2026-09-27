import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

/** MSIX 会虚拟化 AppData；共享端点放在用户主目录，避免两个客户端生成不同密钥。 */
export function defaultDataDirectory(project: string, userHome = homedir()) {
  const absolute = resolve(project);
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return join(userHome, '.codex-claude-bridge', hash);
}
