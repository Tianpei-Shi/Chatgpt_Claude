import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Endpoint, Role } from './types.js';

class RpcError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function initializeEndpoint(dir: string, port?: number): Endpoint {
  mkdirSync(dir, { recursive: true }); const path = join(dir, 'endpoint.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const key = () => randomBytes(32).toString('hex');
  const endpoint: Endpoint = { port: port ?? 40000 + createHash('sha256').update(resolve(dir)).digest().readUInt16BE(0) % 20000, instance: key(), keys: { codex: key(), claude: key(), hook: key() } };
  try { writeFileSync(path, JSON.stringify(endpoint), { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; return JSON.parse(readFileSync(path, 'utf8')); }
  return endpoint;
}

/** 本机请求始终带角色凭据；错误不包含端点文件或通信密钥。 */
export async function rpc(dir: string, role: Role, op: string, args: unknown = {}, timeoutMs = 65000): Promise<any> {
  const endpoint = initializeEndpoint(dir);
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.keys[role]}` },
    body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json() as any;
  if (!response.ok || result.error) throw new RpcError(result.error ?? `桥接服务 HTTP ${response.status}`, response.status);
  return result;
}

export async function ensureBroker(dir: string) {
  initializeEndpoint(dir);
  const probe = async () => {
    try { await rpc(dir, 'codex', 'health', {}, 1000); return true; }
    catch (error) {
      if (error instanceof RpcError && error.status === 401) throw new Error('桥接认证冲突：该端口的服务使用不同共享目录或密钥；请检查 Windows AppData 重定向及两端 --data 配置，不会另起服务');
      if ((error as any)?.cause?.code === 'ECONNREFUSED') return false;
      throw error;
    }
  };
  if (await probe()) return;
  const log = openSync(join(dir, 'broker.log'), 'a', 0o600);
  const main = join(dirname(fileURLToPath(import.meta.url)), 'main.js');
  const child = spawn(process.execPath, [main, 'broker', '--data', dir], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.on('error', () => { /* 下方健康检查会报告启动失败。 */ });
  child.unref(); closeSync(log);
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await probe()) return;
  }
  throw new Error('桥接服务未启动，请运行 doctor 并检查本地 broker.log');
}
