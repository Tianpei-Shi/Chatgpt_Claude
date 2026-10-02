# Codex ⇄ Claude Desktop Code 本地 MCP 桥接

在 Codex 桌面客户端用中文提出需求，由 Codex 整理英文任务，交给 **Claude 官方桌面客户端的 Code 会话**执行，再由 ChatGPT／Codex 独立运行测试、复测并进行最终验收，用中文反馈结果。Claude 只承担实施与修复，执行完成不代表验收通过。

**状态：2026-10-02 新增项目识别、Sonnet/medium 默认值、Hook 完整提问回传/答复、实时进度和目标目录自动信任。新功能的自动化与真机验证分别见 `docs/verification.md`。此前已验证官方 Claude Desktop Code 的交互初始化、新建本地会话及后台只读任务往返。初始化需用户允许短暂界面操作，之后任务全走 MCP 与会话管道；全程静默创建及代码修改类桌面任务仍待验收。**

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
| `.claude/settings.local.json` | 会话生命周期、工具前后、失败、通知、PermissionRequest、Elicitation Hooks |

安装不覆盖全局配置，不改变权限模式；只在协调端回复已授权的具体交互后返回该次决定，不设置所有工具自动允许。配置通过结构化合并写入；原文件中的注释保存在备份里，格式可能重新排版。首次加载时请处理客户端自己的目录信任和 MCP 启用提示。

安装后：

如果 Codex 设置列表中看不到桥接，先执行 `codex mcp get codex_claude_bridge`。项目配置存在并不等于用户级 MCP 已注册；`doctor` 的 `codexRegistration` 会分别显示项目配置、用户级注册和当前聊天加载状态。当前聊天是否加载必须在客户端验证。

需要在 Codex 用户级注册时，先备份用户配置，然后使用官方命令（将路径替换为你的安装位置；`--data` 使用 doctor 输出的 data 路径）：

```powershell
codex mcp add codex_claude_bridge -- node 'D:\code\CodexClaudeBridge\dist\main.js' mcp --role codex --data 'doctor 输出的数据目录' --project 'D:\code\CodexClaudeBridge'
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

### 多聊天绑定与执行前检查

每个协调端聊天使用独立 `context_id`，由 `bridge_context_create({cwd,label})` 返回的 `id` 获取，不依赖客户端私有聊天编号。先选择项目，再绑定 Claude 会话、检查源码、保存方案、提交任务：

1. `bridge_context_create`：必须明确提供工作项目绝对路径；新聊天创建新上下文。
2. `bridge_context_bind`：将 `session_id` 绑定到 `context_id`。一个上下文可绑定多个同目录会话；同会话只有一个控制者。
3. `bridge_inspect`：提供相关源码相对路径，读取内容并登记文件指纹；每次 1～16 文件、合计 128 KiB。
4. `bridge_plan`：英文填写 `objective/findings/steps/constraints/acceptance`，指定 `mode:read|write`，获取 `plan_id`。
5. `bridge_submit`：只接受 `{cwd,context_id,session_id,plan_id,request_id}`，不能再直接传裸 prompt 跳过准备。
6. `bridge_monitor`：批量查询或等待多个上下文的会话、任务和报告变化；旧的单任务 status/wait 仍可用。

```json
{
  "targets": [
    {"cwd":"D:\\code\\ProjectA","context_id":"第一个上下文返回的编号"},
    {"cwd":"D:\\code\\ProjectB","context_id":"第二个上下文返回的编号"}
  ],
  "seconds": 0
}
```

后续传入返回的 `cursor` 作为 `after`，并设置 seconds（最多 50）等待变化。每次最多 20 个目标，单个目标失败独立报告。默认最近 50 个任务，目标可加 request_id 查询历史任务；报告摘要最多 6000 字符，完整报告使用 status。进度 events 和完整 interactions 也参与游标变化；待答问题由 Codex 翻译后使用宿主中文提问卡片展示，bridge_respond 返回答案。事件窗口可截断并标记，问题正文不截断。此功能不是聊天结束后的常驻推送。

规则通过 MCP 初始化 instructions、工具说明及 `bridge_rules` 提供；项目选择、绑定和准备记录由服务端检查。规则不能证明模型理解或翻译一定正确。源码指纹变化会拒绝新任务；已排队任务在派发前也会复核。上下文是同账号防串线标识，不是独立账号安全边界。

不同项目可并行；同项目的修改任务与其他活动任务互斥，只读任务可并行。只有对应 Stop 才释放占用，不确定或断线任务不会自动释放。只读模式不是文件系统沙箱，执行端仍需遵守指令。转交会话用 `bridge_context_release`，未结束任务会阻止转交。

**升级注意：**此版本更改了 submit 参数，并要求项目执行工具显式传 cwd（projects 发现工具使用 current_cwd/query）。需要重新加载两端 MCP；旧 broker 也需在该项目会话结束后执行 `node dist/main.js stop --project '项目绝对路径'`，由后续调用重新启动。新增交互功能要求 health.interactionVersion=1；若仍运行旧 broker，新协调端返回 `broker_upgrade_required`，不会降级为不检查方案的旧提交。恢复 Claude 会话并正常发送一条消息，使 Hook 重新登记。旧任务与结果仍保留；不要中断正在执行的任务来升级。

### 多项目调用与掉线诊断

全局 MCP 的 `--project` 指定安装基准目录，不代表用户为当前聊天选定了项目。对其他项目，先运行 `node dist/main.js install --project '目标项目绝对路径'`，再让两端重新加载 MCP/Hooks。所有项目工具调用都显式传入 `cwd`：

```json
{"cwd":"D:\\code\\ProjectB"}
```

先调用 `bridge_diagnose`：`project_not_configured` 表示配置缺失或不匹配；`no_registered_session` 表示还未登记；`session_offline` 表示历史会话已退出或服务重启；`messaging_unavailable` 表示登记时缺少原生消息端点；`ready` 才表示有在线且可唤醒的候选会话。再用相同 cwd 调用 sessions/submit/status/wait，Claude 的 claim/report 也使用该 cwd。任务编号在各项目内独立，不会将另一个项目的同名任务结果混入。

路由只读取由当前桥接安装器生成的 `.mcp.json`，不执行其中的命令，不扫描或导入其他聊天。Desktop 的全局同名 MCP 即使覆盖项目配置，也能通过显式 cwd 路由到目标项目自己的数据目录。已运行的旧 MCP 进程需要重新加载才会识别这个参数。

安装器增加 `UserPromptSubmit` Hook：服务重启后，已加载 Hooks 的 Claude 会话在下一次真实用户输入时自动重新登记并更新领取上下文。它不伪造输入，不自动重发不确定任务；关闭的会话仍需要用户自行恢复。

### 无感后台模式

默认通过 `bridge_sessions`、`bridge_submit`、`bridge_wait` 与已注册的 Claude Desktop Code 会话通信，不打开或聚焦窗口、不操作菜单、不模拟键盘鼠标、不使用剪贴板。没有在线会话时返回缺少会话，不能回退到桌面自动化或新建 CLI 会话。

用户明确允许初始化时短暂操作界面后，使用 `bridge_desktop_prepare`。参数默认 `allow_ui: false`，只有显式为 true 才打开官方桌面 Code 草稿、核对模型与强度、关闭 worktree 并发送只读初始化。不会使用独立 CLI 会话或复制登录凭据。

```json
{"cwd":"D:\\code\\ProjectA","request_id":"desktop-init-20260928-01","model":"Sonnet","effort":"medium","allow_ui":true}
```

默认自动确认完整目标目录严格匹配的 Trust workspace；无法完整核对则返回弹窗供中文转述，并使用相同参数继续。`awaiting_registration` 表示等待 Hook；重复调用只查询登记，不重复发送。只有初始化标识、完整 cwd、online 和 canWake 都匹配才返回 `ready` 与 sessionId，然后使用 `bridge_submit/bridge_wait`。`delivery_unknown` 时不得换编号重发。新的初始化操作使用新编号。

这限制的是桥接自身的行为，不是 Claude 或操作系统的全局窗口控制。Claude 自己的通知、权限弹窗和用户任务中主动运行的 GUI 软件仍可能显示界面。静默启动、静默项目/模型切换目前没有实现。

等价的本地初始化入口（会影响 Claude 界面，但不会启动独立 Claude CLI 会话）：

```powershell
node dist/main.js desktop-prepare --project 'D:\code\CodexClaudeBridge' --request-id desktop-init-20260928-01 --allow-ui --model 'Sonnet' --effort medium
```

不加 `--allow-ui` 时也只返回后台限制状态。本机已验证 Sonnet 5.5 / medium、目标目录自动信任及真实问答往返；旧记录另有 Opus 5.5 / Medium 验证。任意模型切换与旧会话自动恢复不在本轮真机验收范围。升级后 MCP 子进程需要重新加载才会出现新工具，已有 submit/wait 可继续使用。初次升级到本功能时，旧 broker 也应在没有在线会话时停止并重启，才能保存 Hook 初始化标识；不会强制终止客户端。锁残留返回 `initialization_locked` 时应核对持锁调用是否已结束，不盲目删除锁或重发。

参考：[官方桌面深链接](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)、[桌面模型与快捷键](https://code.claude.com/docs/en/desktop)。此功能没有添加网页后台浏览或帖子滚动模块。

| 客户端 | 工具 | 用途 |
| --- | --- | --- |
| 两端 | `bridge_sessions` | 列出当前项目注册会话 |
| Codex | `bridge_projects` | 根据当前聊天目录或唯一项目名解析目标，不猜默认目录 |
| Codex | `bridge_respond` | 将中文协调后的答案回传原提问 Hook |
| Claude | `bridge_progress` | 英文报告关键阶段事实与下一步 |
| Codex | `bridge_diagnose` | 按 cwd 诊断目标项目配置、登记与离线原因 |
| Codex | `bridge_desktop_prepare` | 显式许可下初始化官方桌面会话，登记后返回 ready |
| Codex | `bridge_desktop_open` | 显式许可下打开目标项目，不代表会话就绪 |
| Codex | `bridge_desktop_configure` | 显式许可下配置可核对完整目录的页面 |
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

原生消息和 MCP 操作服从 Claude 权限规则；支持的 Hook 交互可在 Codex 中文卡片中处理后回填，未覆盖或过期的交互仍在原客户端处理。Codex 聊天关闭后，不保证自动唤醒它；结果保留，可以下次读取。

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
