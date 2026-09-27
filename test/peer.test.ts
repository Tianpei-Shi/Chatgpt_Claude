import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { sendWake } from '../src/peer.js';

test('真实管道先发送认证，任务唤醒包含准确编号且不把写入当执行成功', async t => {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\bridge-test-${randomUUID()}` : `/tmp/bridge-${randomUUID()}.sock`;
  const received = new Promise<any[]>(resolve => {
    const server = createServer(socket => {
      let raw = ''; socket.on('data', data => raw += data.toString());
      socket.on('end', () => { resolve(raw.trim().split('\n').map(line => JSON.parse(line))); socket.end(); });
    });
    t.after(() => server.close()); server.listen(path);
  });
  await sendWake({ socket: path, token: 'secret' }, 'r1', 's1');
  const frames = await received;
  assert.deepEqual(frames[0], { type: 'auth', token: 'secret' });
  assert.equal(frames[1].type, 'user');
  assert.match(frames[1].message.content, /bridge_claim/);
  assert.match(frames[1].message.content, /r1/);
  assert.equal(frames[1].message.content.includes('secret'), false);
});
