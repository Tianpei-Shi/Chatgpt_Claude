# Codex ⇄ Claude Desktop Code 本地 MCP 桥接

在 Codex 桌面客户端用中文提出需求，由 Codex 整理英文任务，交给 **Claude 官方桌面客户端的 Code 会话**执行，再将英文报告整理为中文。

**状态：首版实现。已完成真实 Claude Desktop Code 的只读任务往返及同会话后台追问。默认只走后台管道与 MCP；静默新建会话、切换项目/模型未实现，代码修改类桌面任务仍待验收。**

## 如何接入两个客户端

两个客户端分别启动同一个 MCP 程序的不同角色，共用本地任务服务：

```text
Codex 桌面客户端                    Claude 桌面客户端 / Code
  中文需求                            英文执行、修改文件、运行检查
     │ MCP（codex 角色）                  │ MCP（claude 角色）
     └────────── 本地任务服务 ────────────┘
                       │           ↑
           会话命名管道唤醒       Hooks 会话注册及生命周期
```

MCP 服务本身不会让一个空闲的 Claude 会话自动开始思考。为此，SessionStart Hook 登记该会话的原生消息端点，桥接服务发送带任务编号的通知。Claude 必须通过自己的 MCP `bridge_claim` 领取任务，再用 `bridge_report` 回传结果。

本项目不启动另一个 Claude CLI 编程会话代替桌面 Code，不使用 OpenAI/Anthropic API key，也不负责翻译模型调用。中英文转换由你已经在使用的 Codex 会话完成。

## 环境要求

- Windows、本机同一用户。
- Node.js 22 或以上，推荐当前已安装的 Node.js 24。
- Codex 桌面客户端能够加载本地 STDIO MCP。
- Claude Desktop 的 Code 模式，具备本地项目访问权限。
- Claude Code 的原生会话消息功能开启且允许接收；本机协议依据为 CLI 2.1.281 的内置诊断示例。桌面内置版本必须由实际注册/领取验证，不能仅根据 CLI 版本推断。
- 两端使用同一实际项目目录。首版不自动推断 worktree 与原项目的对应关系。

## 构建与安装

在本仓库目录运行：

```powershell
npm ci
npm run build
npm test
npm run bridge:install
npm run doctor
```

也可以将桥接安装到另一个项目，以下路径替换为你的真实目录：

```powershell
node .\dist\main.js install --project 'D:\code\YourProject'
node .\dist\main.js doctor --project 'D:\code\YourProject'
```

安装器修改指定项目下的三个文件，原文件保留带 `.bridge-backup-` 的副本：

| 文件 | 内容 |
| --- | --- |
| `.codex/config.toml` | Codex 角色的 MCP 启动配置 |
| `.mcp.json` | Claude Code 角色的 MCP 启动配置 |
| `.claude/settings.local.json` | SessionStart、Stop、StopFailure、PermissionRequest、SessionEnd Hooks |

安装不覆盖全局配置，不改变权限模式，不自动同意工具权限。配置通过结构化合并写入；原文件中的注释保存在备份里，格式可能重新排版。首次加载时请处理客户端自己的目录信任和 MCP 启用提示。

安装后：

如果 Codex 设置列表中看不到桥接，先执行 `codex mcp get codex_claude_bridge`。项目配置存在并不等于用户级 MCP 已注册；`doctor` 的 `codexRegistration` 会分别显示项目配置、用户级注册和当前聊天加载状态。当前聊天是否加载必须在客户端验证。

需要在 Codex 用户级注册时，先备份用户配置，然后使用官方命令（将路径替换为你的安装位置；`--data` 使用 doctor 输出的 data 路径）：

```powershell
codex mcp add codex_claude_bridge -- node 'D:\tools\Chatgpt_Claude\dist\main.js' mcp --role codex --data 'doctor 输出的数据目录' --project 'D:\code\YourProject'
```

用户级注册会让此 MCP 出现在其他项目的可用服务列表中，但本实例仍绑定 `--project` 指定的目录。卸载这项用户级注册使用 `codex mcp remove codex_claude_bridge`；项目卸载命令不会擅自删除用户级条目。

若 Claude 桌面端也看不到项目 MCP，需要检查其实际 `claude_desktop_config.json`。Windows 打包版可能使用 `%LOCALAPPDATA%\Packages\Claude_包标识\LocalCache\Roaming\Claude\claude_desktop_config.json`，不能只检查普通 `%APPDATA%\Claude`。备份后，将本项目 `.mcp.json` 中的 `mcpServers.codex_claude_bridge` 合并到桌面配置同名字段，保持 `--role claude`，然后正常退出并重新打开 Claude。桌面配置同时提供给普通聊天和本地 Code 会话，但桥接执行仍要求 Code 会话完成本项目 Hooks 注册。项目卸载不会移除手动添加的桌面条目；需要单独移除该条目并保留其他设置。

1. 在 Codex 中打开目标项目并重新加载 MCP；必要时新开该项目的聊天。当前聊天不保证热加载新工具。
2. 在 Claude 桌面客户端的 **Code** 模式中选择同一目录，创建或恢复本地会话，使 SessionStart Hook 生效。选择已有 worktree 时必须把桥接明确安装到那个 worktree，并从同一目录调用。
3. 在两端 MCP 列表里检查 `codex_claude_bridge`。若已有会话没加载新配置，恢复或新建该项目会话；不必终止其他项目的工作。
4. 再运行 `npm run doctor`，应出现已注册会话，且 `online` 与 `canWake` 为 `true`。

运行数据默认位于 `%USERPROFILE%\.codex-claude-bridge\项目路径摘要\`，包含本地鉴权文件、任务记录和日志。避免使用 AppData：Windows 打包版 Claude 会把该位置重定向到包内，造成两端使用不同认证密钥却争用同一端口。不要将运行目录提交到 Git 或发送给他人；Claude 的原生会话令牌仅保存在服务内存中。安装器不会修改系统服务或 PATH。

## 在 Codex 中怎么说

首次使用可以直接输入：

> 使用 codex_claude_bridge，先列出本项目 Claude Code 会话。选定目标后，把下面的中文需求整理成英文任务交给 Claude 执行。保持同一个会话，等待英文结果，然后用中文报告改动、实际测试及未完成项。不要由你自己修改代码。先做只读验证：请 Claude 说明当前目录和 README 的用途，不修改文件。

后续直接说：

> 继续交给同一个 Claude 会话：为上次功能增加输入校验，执行相关测试，然后中文告诉我结果。

多个候选会话时先选定一个。Codex 必须记录 `session_id` 与实际目录，每个任务使用一个稳定的 `request_id`；轮询或断线恢复时复用原编号，不能创建新编号重复执行同一修改。

可复用的协调提示见 [Codex 使用说明](docs/codex-instructions.md)。

## 工具

### 无感后台模式

默认通过 `bridge_sessions`、`bridge_submit`、`bridge_wait` 与已注册的 Claude Desktop Code 会话通信，不打开或聚焦窗口、不操作菜单、不模拟键盘鼠标、不使用剪贴板。没有在线会话时返回缺少会话，不能回退到桌面自动化或新建 CLI 会话。

`bridge_desktop_open` 与 `bridge_desktop_configure` 保留为兼容入口，但只返回 `background_only` 和 `uiTouched: false`，不会启动 UI 子进程或操作桌面。MCP 不提供启用 UI 的参数。

这限制的是桥接自身的行为，不是 Claude 或操作系统的全局窗口控制。Claude 自己的通知、权限弹窗和用户任务中主动运行的 GUI 软件仍可能显示界面。静默启动、静默项目/模型切换目前没有实现。

仅当用户以后明确要求交互诊断时，保留手动 CLI 入口（这些命令会影响 Claude 界面）：

```powershell
node dist/main.js desktop-open --allow-ui
node dist/main.js desktop-configure --allow-ui --model 'Opus 5.5' --effort medium
```

不加 `--allow-ui` 时 CLI 也只返回后台限制状态。完整自动模型选择仍未验证。升级后已运行的 MCP 子进程需要重新加载才会执行新代码；在重新加载前禁止调用旧桌面工具，既有 submit/wait 通道可以继续使用，无需重启在线 Claude 会话或 broker。

参考：[官方桌面深链接](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)、[桌面模型与快捷键](https://code.claude.com/docs/en/desktop)。此功能没有添加网页后台浏览或帖子滚动模块。

| 客户端 | 工具 | 用途 |
| --- | --- | --- |
| 两端 | `bridge_sessions` | 列出当前项目注册会话 |
| Codex | `bridge_desktop_open` | 兼容入口，仅返回后台限制状态 |
| Codex | `bridge_desktop_configure` | 兼容入口，仅返回后台限制状态 |
| Codex | `bridge_submit` | 提交英文任务，保留路径和用户指定文本原样 |
| Codex | `bridge_status` | 读取状态与英文结果 |
| Codex | `bridge_wait` | 等待状态变化，单次最多 50 秒 |
| Codex | `bridge_cancel` | 取消尚未派发的排队任务 |
| Claude | `bridge_claim` | 凭会话专属密钥领取英文任务 |
| Claude | `bridge_report` | 凭领取凭据回传英文报告 |

Claude 的 SessionStart 上下文会提供会话身份和私有领取密钥。Claude 调用 `bridge_report` 后必须在最终英文回复末尾写 `[BRIDGE_TASK:真实任务编号]`，Stop Hook 才会释放会话执行下一个任务。不要把密钥写进报告或文件。

## 状态与恢复

| 状态 | 含义及操作 |
| --- | --- |
| `queued` | 排队，可以取消 |
| `dispatching` | 通知正在投递，尚不表示 Claude 已领取 |
| `delivery_unknown` | 30 秒未领取或投递异常；检查 Claude 权限/MCP，不自动重发 |
| `running` | Claude 已领取 |
| `completed` | Claude 已提交完成报告；检查报告中的真实验证证据 |
| `needs_input` | Claude 需要补充信息，Codex 翻译后询问用户 |
| `failed` | Claude 提交失败报告 |
| `disconnected` | 服务重启或会话退出后，未确认完成 |
| `cancelled` | 排队阶段取消成功 |

“完成报告已收到”和“会话可以继续接单”分别判断。会话的 `activeTask` 在带匹配标记的 Stop 到达前不会清空，以免 Claude 尚未结束本轮就接到下一条修改。

遇到 `delivery_unknown` 可以在原 Claude 会话中要求它领取**同一任务编号**；不要再提交一份。若已收到报告但 `activeTask` 没有释放，可让原会话只回复 `[BRIDGE_TASK:原任务编号]` 后结束本轮，不要重新执行任务。

原生消息和 MCP 操作都服从 Claude 原有权限；需要批准时由用户在 Claude 处理。Codex 聊天关闭后，不保证自动唤醒它；结果保留，可以下次读取。

**Stop Hooks 兼容边界：**若用户、项目或指定管理配置含其他 Stop Hooks，或启用了尚未核验的 Claude 插件，桥接不会仅凭一次 Stop 观察就释放会话，而会记录 `StopDeferred`。本轮结果仍可读取，后续任务要等原会话结束并恢复后才能继续。`doctor` 会显示此限制。动态注入或客户端内部的阻止型 Hooks 仍属于真实桌面验收项；首版自动连续接单面向仅使用桥接 Stop Hook 的会话。

服务重启会使会话离线并保留不确定任务。请在 Claude 恢复会话重新注册，再核对原任务状态；服务不会自动重做未知任务。

## 验证层级

`npm test` 包含真实 SDK/STDIO 客户端、真实本机 HTTP broker、真实命名管道接收端和状态持久化测试；这些不消耗模型额度。管道接收端是测试程序，不是真实 Claude。

真实桌面验收需要另外记录：

1. Codex 的 MCP 工具出现在实际聊天中。
2. Claude Desktop Code 会话注册，英文只读任务出现在该会话。
3. Claude 领取任务并回传英文结果，Codex 中文汇报。
4. 在相同会话中继续一次追问。
5. 最后用专用测试文件验证修改与测试，不直接拿重要项目试错。

`doctor` 只核查配置和本地服务，并输出会话状态；它不会把这些检查自动标记为真实桌面闭环成功。

## 卸载

```powershell
npm run bridge:uninstall
# 其他项目：node .\dist\main.js uninstall --project 'D:\code\YourProject'
```

卸载只删除本程序拥有的 MCP/Hooks 条目，保留其他设置、备份与任务数据。已运行的客户端需要重新加载配置；后台 broker 不属于系统服务。

结束此项目的 Claude 桥接会话后，可运行 `npm run bridge:stop` 关闭后台服务；有在线会话时会拒绝关闭。更新源码并重新构建后，应先停止旧服务，再运行 `npm run doctor` 加载新构建。停止服务不删除结果记录，也不终止任何 Claude/Codex 进程。

## 依据与兼容性

- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Claude Desktop](https://code.claude.com/docs/en/desktop)
- [Claude 跨会话消息](https://code.claude.com/docs/en/cross-session-messaging)
- [Claude Hooks](https://code.claude.com/docs/en/hooks)

命名管道消息格式具有版本依赖，本项目保留独立适配器；后续客户端升级后需要重新做真实收发验证。

## 公开发布

源码：[Tianpei-Shi/Chatgpt_Claude](https://github.com/Tianpei-Shi/Chatgpt_Claude)。项目发布在 GitHub，不代表已发布到 npm；package.json 保留 private 以避免误上传 npm。

本项目是 Node.js 本地 MCP 服务，不是独立 EXE。安装与运行需要 Node.js 22+，按上方步骤构建并接入两个客户端。首次公开发布不包含开发机的配置、任务记录、认证文件或会话数据。
