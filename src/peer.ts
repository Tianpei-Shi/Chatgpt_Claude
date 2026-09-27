import { createConnection } from 'node:net';

/** Claude Code 2.1.281 的内置 Windows 诊断示例使用逐行 auth + user 消息。 */
export async function sendWake(peer: { socket: string; token: string }, taskId: string, sessionId: string): Promise<void> {
  let path = peer.socket.replace(/^uds:/, '');
  if (process.platform === 'win32' && !path.startsWith('\\\\.\\pipe\\')) throw new Error('无效 Windows 会话管道');
  const content = `A task was submitted by the user through the local Codex bridge. Task ID: ${taskId}. Session ID: ${sessionId}. Call the MCP tool bridge_claim with request_id="${taskId}" and session_id="${sessionId}" to read the English task. Execute only the claimed task in its bound directory, respecting your existing permissions. Reply in English using bridge_report with the returned lease. End your final assistant response with [BRIDGE_TASK:${taskId}]. If the bridge tool is unavailable, explain that and do not execute an inferred task.`;
  const lines = [JSON.stringify({ type: 'auth', token: peer.token }), JSON.stringify({ type: 'user', message: { role: 'user', content } })].join('\n') + '\n';
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('会话管道发送超时，投递状态未知')); }, 5000);
    socket.once('error', () => { clearTimeout(timer); reject(new Error('会话管道连接失败，未确认投递')); });
    socket.once('connect', () => socket.end(lines, () => { clearTimeout(timer); resolve(); }));
    socket.once('close', () => clearTimeout(timer));
  });
  // 返回只表示写入完成，必须等待 Claude 主动领取才能进入 running。
}
