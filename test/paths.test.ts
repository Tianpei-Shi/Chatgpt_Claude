import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDataDirectory } from '../src/paths.js';

test('默认共享目录避开被 Windows 打包应用虚拟化的 AppData', () => {
  const dir = defaultDataDirectory('D:/code/project', 'C:/Users/example');
  assert.match(dir, /\.codex-claude-bridge/);
  assert.equal(/AppData/i.test(dir), false);
  assert.equal(dir, defaultDataDirectory('D:/code/project', 'C:/Users/example'));
  assert.notEqual(dir, defaultDataDirectory('D:/code/other', 'C:/Users/example'));
});
