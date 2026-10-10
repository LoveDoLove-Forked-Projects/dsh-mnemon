# DSH 0.2.1-alpha.2 上的 dsh-mnemon

[English](./README.md) | [验证记录](./verification.json)

DSH 0.2.1-alpha.2（npm `alpha`）改动了 dsh-mnemon 依赖的若干行为。[#356](../issue-356-subagent-activation/README.zh-CN.md) 适配了记忆子 Agent，已随 v0.5.26 发布。本记录覆盖其余部分：还有哪些差异、本次改动如何处理，以及在 0.2.1-alpha.2 与 DSH 0.2.0-rc.2（npm `latest` 与 `next`）上运行了哪些检查，证明 dsh-mnemon 在两者上都能正常工作。

被测版本：分支 `claude/dsh-021-alpha2-adaptation`，基于 [#359 的修复](../issue-359-market-client-shim/README.zh-CN.md)。运行于 2026-10-10（Asia/Shanghai）：
- macOS 15.6 arm64，Node 24.19.0；
- headless Chrome 154，zh-CN，浅色；
- DSH 0.2.1-alpha.2 与 0.2.0-rc.2，各自安装在独立的 npm 前缀中；
- Mnemon CLI 0.2.10。

## 0.2.1-alpha.2 的差异

| DSH 0.2.1-alpha.2 | 本次改动前对 dsh-mnemon 的影响 | 现在 |
|---|---|---|
| 移除 `subagents.start`，子 Agent 改由 `startActivation` 启动 | 所有记忆子 Agent 失败 | 已在 v0.5.26 修复（#357） |
| 插件页不再列出分组行 | DSH 组件列表上方的说明解释了一行并不存在的 `dsh-mnemon/bundle` | 只有 DSH 列出该行时才显示说明 |
| 每一步之前，若当前目录已不存在，Agent 会退回会话的原始目录；原始目录也不存在时就停止 | 工作区文件夹被删除或移动后，该工作区的后台记忆任务会停止 | 任务保留这个工作区，并在一个仍存在的目录中运行 |
| 每次启用后，插件管理器按已选中的 bundle 重新计算包路由 | 对用户没有影响：已停用 bundle 的依赖路由在重新启用前暂时缺席，启用后回到原目录 | 激活测试接受这段缺席，但仍要求回到原目录 |
| 移除 tools 模式 `both`；Code Mode 在派发前拒绝被过滤的工具 | 没有影响：dsh-mnemon 不设置 tools 模式 | 由 #356 的真实宿主测试覆盖 |
| 移除提示变量 `{{cwd}}` | 没有影响：dsh-mnemon 的提示词都不使用它 | — |

### DSH 组件列表上方的说明

在 DSH 0.2.0 及更早版本中，dsh-mnemon 页面的组件列表会列出 Starter 的分组行 `dsh-mnemon/bundle`，且始终显示为已关闭，配置页在列表正上方说明原因。DSH 0.2.1-alpha.2 只列出组件，这条说明便指向了不存在的内容。页面顶部的操作区能看到 DSH 绘制的各行，并报告其中是否有这一行；只有有这一行时，配置页才显示说明。

| DSH 0.2.1-alpha.2，v0.5.26 | DSH 0.2.1-alpha.2，本次改动 | DSH 0.2.0-rc.2，本次改动 |
|---|---|---|
| ![说明提到 dsh-mnemon/bundle，但列表从组件开始](./components-alpha-before.jpg) | ![没有说明；列表从组件开始](./components-alpha.jpg) | ![有说明，列表中的 dsh-mnemon/bundle 行显示为已关闭](./components-020.jpg) |

在锁定的 DSH 0.1.7-rc.2 上，说明与该行的显示与 0.2.0-rc.2 相同。不经 DSH 插件页、自行绘制配置的外壳现在不再显示说明，因为那里配置下方没有组件列表。

### 工作区缺失时的后台任务

运行时记忆维护、项目档案归档、记忆放置、元数据维护等后台记忆任务由一个任务 Agent 在对话之外执行。它的 `cwd` 是调用方的工作区（调用方没有工作区时，是 DSH 工作区列表中的第一个工作区），Mnemon 由此决定任务操作哪个工作区的记忆。DSH 0.2.1-alpha.2 在每一步之前检查工作目录：当前目录不存在时退回会话的原始目录，原始目录也不存在时就停止该 Agent；对任务 Agent 来说，两者都是这个工作区文件夹。现在任务 Agent 的 `cwd` 仍按原来的方式选择，只有在该文件夹缺失时，才把 DSH 的工作目录设为 DSH 工作区列表中第一个仍存在的工作区，或 DSH 的启动目录。它的子 Agent 会继承这两者，与 DSH 自己的子 Agent 一样。文件夹存在时，以及在没有工作目录服务的 DSH 0.2.0 与 0.1.7 上，行为都不变。

## 在已安装的 DSH 上运行测试

[`harness/installed-dsh-all.vitest.config.mjs`](./harness/installed-dsh-all.vitest.config.mjs) 在已安装的 DSH 上运行根测试。每个 `@deepseek-ai/*` 导入（包括子路径）都在该安装内解析，其中的包会被内联，因此安装中缺少的裸导入（`zustand`、`clsx`：DSH 的客户端是预先构建的）改从本仓库解析。#356 适配过的六个真实宿主测试改用其适配副本运行：

```sh
DSH_HOST_ROOT=<前缀>/lib/node_modules/@deepseek-ai/dsh DSH_VERSION=<版本> \
  MNEMON_BUNDLE_TEST_PROFILE=<前缀>/lib/node_modules/@deepseek-ai/dsh \
  MNEMON_TEST_EXCLUDE=runtime-compaction-host,review-user-turn-host,review-evidence-host,agent-team-review-host,async-subagent-host,subagent-token-usage-host \
  pnpm exec vitest run --config docs/pr-assets/dsh-021-alpha2/harness/installed-dsh-all.vitest.config.mjs
node docs/pr-assets/issue-356-subagent-activation/harness/adapt-host-specs.mjs <副本目录>
DSH_HOST_ROOT=<前缀>/lib/node_modules/@deepseek-ai/dsh DSH_VERSION=<版本> MNEMON_TEST_DIR=<副本目录> \
  pnpm exec vitest run --config docs/pr-assets/dsh-021-alpha2/harness/installed-dsh-all.vitest.config.mjs
```

`MNEMON_E2E_DSH=<前缀>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 让 `pnpm e2e:serve`、`node scripts/verify-headless-profile.mjs` 与 `node scripts/verify-sync-git.mjs` 都改用该安装；`node --expose-internals tests/fixtures/bundle-activation.mjs <前缀>/lib/node_modules/@deepseek-ai/dsh manager` 在其上运行 Starter 的激活契约。

## 结果

### 在已安装宿主上的测试

| 检查 | DSH 0.2.1-alpha.2 | DSH 0.2.0-rc.2 |
|---|---|---|
| 除下列六个真实宿主测试外的根测试 | 1,816 个通过，6 个跳过（127 个文件） | 1,816 个通过，6 个跳过（127 个文件） |
| 六个真实宿主测试，使用 `adapt-host-specs.mjs` 写出的副本（17 个测试） | 17 个通过 | 17 个通过 |
| Starter 激活契约：未选中任何 bundle 时的冷启动、另一个 bundle 自启动起即停用、组件与 bundle 开关的持久化 | 通过 | 通过 |
| `--check-declared-rows`：列出的每个组件都能切换 | 通过 | 在分组行上失败，即 0.1.7-rc.2 已知的列表问题 |
| Headless，默认组合以及启用三个可选策略的组合 | 通过 | 通过 |
| 工作区文件夹已删除时的任务 Agent 及其子 Agent（[探针](./harness/task-agent-cwd-host.probe.ts)） | v0.5.26：任务的第一步就以 `working-directory: directory does not exist` 失败，启动子 Agent 也同样失败。本次改动：两者都以已删除的工作区作为 `cwd`；任务在宿主目录中运行，子 Agent 正常结束 | 两个版本：两者都保留已删除的工作区并正常运行；DSH 0.2.0 不检查目录 |

`pnpm verify` 与 `verify:plugins` 也都通过，它们运行在锁定的 DSH 0.1.7-rc.2 上。我们从 DSH 各包按名称导入的值（例如来自 `dsh-client-ui-primitives` 的 20 个）在两个版本中都存在。

### 0.2.1-alpha.2 上的 WebUI

每项检查都在 e2e 夹具的真实 WebUI 中进行，`MNEMON_E2E_DSH` 指向 0.2.1-alpha.2，步骤见[开发指南](../../zh-CN/development/README.md#真实-webui)；只有模型的选择是脚本化的。

| 范围 | 结果 |
|---|---|
| 插件页 | 配置正常加载。DSH 列出 9 个组件、没有分组行，说明也不显示。顶部按钮可打开记忆系统。切换可选策略或项目档案立即生效，没有重启提示，状态页保持正常。主策略可在分层策略与通用策略之间切换，刷新后保留。每个组件行都能打开自己的页面。 |
| 界面 | 记忆系统入口可在侧边栏与会话标签页之间切换。回合记忆栏与存入记忆按钮的开关会隐藏并恢复相应控件。 |
| 检查版本 | 列出 dsh-mnemon、Mnemon CLI 与 17 个子包。 |
| 对话记忆（`--docs-demo`） | 通过 View 工具完成一次档案检索与两次记忆空间召回，随后替换一条工作记忆。记忆系统各页面显示预置的档案、记忆空间、记忆与实体。 |
| 通用策略（`--general-strategy`） | 其协议、三个 Source、一次运行时记忆写入，以及从常驻记忆中召回。 |
| 存入记忆（`--save-action`） | 保存一次；原样再次发送返回第一次的回执；编辑后再次发送会再保存一次。 |
| 空闲审查（`--idle-review`） | 审查在夹具故意制造的失败之前提交了一份档案和一条运行时记忆。状态页显示两条回执，一次尝试的上限生效。 |
| USER.md 压缩（`--profile-compaction`） | 第三次写入通过 spawn 子 Agent 压缩后成功。 |
| 运行时记忆 | 添加、编辑、删除与刷新，容量条随之变化。 |
| 记忆空间 | 创建并激活 Native 空间，由 Mnemon CLI 写入一条事实，直接检索、内容、实体与相关记忆。 |
| 项目档案归档（`--document-archive`） | 不合格的目标让档案保持活跃；改名后建立冷索引并归档。 |
| ZIP 备份 | 导出后，分别安全导入同一个 profile 和全新的 profile，后者的数据逐字节一致。 |
| Git 同步 | 默认关闭，只显示标题与开关；打开后显示仓库、GitHub 登录与自动备份。设置 `MNEMON_E2E_DSH` 指向 0.2.1-alpha.2 后，`scripts/verify-sync-git.mjs` 通过全部 58 项检查。 |
| 未安装 Mnemon CLI（`--without-mnemon-cli`） | 没有 Native 卡片，CLI 显示为可选，嵌入测试不可用；另一个 Provider 就绪后即可创建记忆空间。 |
| 远程管理（`--trusted-host`） | 没有授权时页面只读并说明原因；设置 `remoteAccess: trusted-host` 后，修改在刷新后保留。 |
| dshmarket | 见 [#359 记录](../issue-359-market-client-shim/README.zh-CN.md)。 |

所有运行都没有浏览器控制台错误。除夹具预期的输出外，服务端日志没有其他内容。

### 过程中的发现

- **可续接的记忆任务。** 在 0.2.1-alpha.2 上，在对话之下启动的记忆任务（例如空闲审查）会以“可继续”留在对话的子 Agent 列表中。发给它的消息会在 Mnemon 的委派之外续接它。在这次运行中，它的记忆写入因此跳过了空闲审查只写一层的检查并被提交；它每次停止时 DSH 都会通知对话，对话随之回复。DSH 没有提供移除该条目或拒绝续接的方式，因此[兼容性说明](../../zh-CN/reference/compatibility.md#dsh-02)现在提醒不要续接这些任务。
- **启用 Provider 之后的记忆空间页。** 在两个宿主上，在插件页启用 Provider 后，记忆空间页都保留旧的 Provider 列表，直到点击刷新，新建空间时用不上它。现在保存或切换 Provider 时，记忆系统会同时重新加载当前打开的页面，就像切换组件时已经会重新读取状态一样。已在两个宿主上检查：在插件页启用 Holographic 后，无需刷新，记忆空间页就显示它的空间，新建空间时也可以选择它；关闭后两者都不再出现。
- **e2e 夹具的“文稿”目录。** DSH 把首个工作区建在系统的“文稿”目录下，在 macOS 上这个目录由系统给出，与 `HOME` 无关。夹具现在把 DSH 的 `documentsDirectory` 设在自身内部；此前在夹具中选择工作区存储范围，会在真实的“文稿”目录中写入一个空的 `.mnemon`。
- 与 0.2.1 无关、留待后续处理：会话标签页模式下，在没有消息的新对话中“打开记忆系统”没有反应；该标签页中 DSH 的输入框会遮住状态页底部的存储说明；主动记录的默认指引在中文界面中是英文；运行时记忆页的移除提示在离开页面后仍然保留；不合格归档目标的错误没有翻译；归档回执用 id 而不是名称指代记忆空间；没有就绪的 Provider 时，被禁用的 Native 选项看起来是选中的；ZIP 清单记录的 `pluginVersion` 是 0.1.0。

## 局限

- DSH 0.2.1-alpha.2 是 alpha 版本，在发布候选版之前其 API 仍可能变化。
- 模型是本机回环的模型桩，只脚本化模型的选择；工具、子 Agent、存储与 WebUI 都是真实的。
- 只在 macOS 上运行。DSH 桌面版没有 0.2.1-alpha.2 构建，因此未在其上检查桌面版窗口。
