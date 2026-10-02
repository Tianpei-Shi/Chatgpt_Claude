import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultDataDirectory } from './paths.js';
import { initializeEndpoint, rpc } from './client.js';
import { defaultModel, defaultEffort } from './preferences.js';

// 路径只作为参数传递，不拼接后执行用户提供的 shell 文本。
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  role: { type: 'string' }, data: { type: 'string' }, project: { type: 'string' },
  model: { type: 'string' }, effort: { type: 'string' },
  'request-id': { type: 'string' },
  'allow-ui': { type: 'boolean', default: false },
  'no-auto-trust': { type: 'boolean', default: false },
} });
const project = resolve(values.project ?? process.cwd());
const data = resolve(values.data ?? defaultDataDirectory(project));
try {
  switch (positionals[0]) {
    case 'mcp': {
      if (!['codex', 'claude'].includes(values.role ?? '')) throw new Error('MCP 必须指定 --role codex 或 claude');
      await (await import('./mcp.js')).serveMcp(values.role as 'codex' | 'claude', data, project); break;
    }
    case 'broker': {
      const broker = await (await import('./broker.js')).startBroker(data, initializeEndpoint(data));
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void broker.close().then(() => process.exit(0)));
      break;
    }
    case 'hook': await (await import('./hook.js')).runHook(data, project); break;
    // 桌面初始化必须显式启用界面权限；业务任务仍使用原有后台 MCP。
    case 'desktop-prepare': console.log(JSON.stringify(await (await import('./desktop-prepare.js')).prepareDesktop({ cwd: project, data, requestId: values['request-id'] ?? '', allowUi: values['allow-ui']!, model: values.model ?? defaultModel, effort: values.effort ?? defaultEffort, trustWorkspace: !values['no-auto-trust'] }), null, 2)); break;
    case 'desktop-open': console.log(JSON.stringify(await (await import('./desktop.js')).openDesktop(project, undefined, values['allow-ui']), null, 2)); break;
    case 'desktop-configure': console.log(JSON.stringify(await (await import('./desktop.js')).configureDesktop(values.model ?? defaultModel, values.effort ?? defaultEffort, undefined, project, values['allow-ui']), null, 2)); break;
    case 'install': console.log(JSON.stringify((await import('./install.js')).install(project, data), null, 2)); break;
    case 'uninstall': console.log(JSON.stringify((await import('./install.js')).uninstall(project, data), null, 2)); break;
    case 'doctor': console.log(JSON.stringify(await (await import('./doctor.js')).doctor(project, data), null, 2)); break;
    case 'stop': console.log(JSON.stringify(await rpc(data, 'codex', 'shutdown'), null, 2)); break;
    default: throw new Error('用法：node dist/main.js install|uninstall|doctor|stop --project 路径；MCP：mcp --role codex|claude --project 路径');
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : '桥接启动失败') + '\n'); process.exitCode = 1;
}
