# 存入记忆：选择写入位置

[English](./README.md) | [验证记录](./verification.json)

对话中回复上的**存入记忆**一直把文本交给任务 Agent，由它判断是否值得保存并选择记忆空间。回复无法直接写入工作记忆或用户画像。没有记忆空间 Provider 时，任务 Agent 无处可写，对话框却仍显示就绪，提交后失败。现在对话框增加了**保存到**：任务 Agent 能写入时仍默认**由 Agent 决定**；选择**工作记忆（MEMORY.md）**、**用户画像（USER.md）**或某个记忆空间时，原文立即写入该位置，不经过任务 Agent。

基线：main `2296898d`（dsh-mnemon 0.5.24）。改动：本记录所在的提交。运行环境为 macOS 15.6 arm64、Node 24.19.0、独立前缀中的 DSH 0.2.0-rc.2，以及 1280 × 860、设备缩放 2、中文界面、浅色主题的 headless Chrome。

## 方法

`pnpm e2e:serve` 使用本机回环的模型桩，分两种环境运行：

- **有 Provider**：Mnemon CLI 0.2.10，Host 启动前在 Native 空间 `default` 中预置四条记忆。
- **没有 Provider**：一行 `mnemon` 配置，`cliPath` 指向不存在的文件，与 `--without-mnemon-cli` 一样隐藏已安装的 Mnemon CLI；也没有连接其他 Provider。

同一脚本分别在改动上运行，以及把改动涉及的客户端文件换回 main 版本、使用同一构建在基线上运行：

1. 发送一条消息，悬停回复，点击**存入记忆**。
2. 把候选内容改为一句话。
3. 在 main 上读取对话框。没有 Provider 时点击**交给任务 Agent**，读取回执。
4. 在改动上打开**保存到**，读取可选位置。有 Provider 时先保存到**工作记忆**，再保存到空间 `default`；没有 Provider 时保存到对话框默认选中的位置。
5. 从运行时数据目录读取 `MEMORY.md`，用 `mnemon --readonly recall` 读取 Native 库。

## 前后对比

| main 上的存入记忆 | 改动后 |
|---|---|
| ![对话框只能交给任务 Agent，无法选择位置](./before-dialog.jpg) | ![保存到列出由 Agent 决定、工作记忆、用户画像和空间 default](./after-menu.jpg) |

| 保存到工作记忆 | 保存到空间 `default` |
|---|---|
| ![已存入工作记忆（MEMORY.md），并提供在运行时记忆中查看](./after-saved-memory.jpg) | ![已存入记忆空间 default，并提供在记忆空间中查看](./after-saved-space.jpg) |

| 没有 Provider 时的 main | 改动后 | 保存后 |
|---|---|---|
| ![任务 Agent 就绪，提交后失败：memory subagent completed without recording its result](./before-no-provider.jpg) | ![对话框默认选中工作记忆；由 Agent 决定仍列出但不可选](./no-provider-menu.jpg) | ![已存入工作记忆（MEMORY.md）](./no-provider-saved.jpg) |

| | main | 改动后 |
|---|---|---|
| 选择写入位置 | 无：由任务 Agent 选择记忆空间 | **保存到**：**由 Agent 决定**（默认）、**工作记忆（MEMORY.md）**、**用户画像（USER.md）**，以及 `default` · 记忆空间 · Mnemon Native |
| 把回复写入工作记忆 | 无法完成 | `MEMORY.md` 逐字包含这句话；回执为“已存入工作记忆（MEMORY.md） · 当前 1 条”，并提供**在运行时记忆中查看** |
| 把回复写入指定空间 | 只能经由任务 Agent | Native 库 `default` 在预置的四条记忆之外逐字包含这句话；回执为“已存入记忆空间“default”” |
| 没有 Provider | 显示**任务 Agent 就绪**；提交失败，`memory subagent completed without recording its result` | 对话框默认选中工作记忆；**由 Agent 决定**仍列出但不可选；保存后写入 `MEMORY.md` |
| 浏览器控制台错误 | 无 | 无 |

## 行为

- **由 Agent 决定**保留原来的请求与回执。任务 Agent 能写入时它是默认选项：任务 Agent 可用、记忆空间层开启，并且已有空间或有就绪的 Provider 可以创建空间。否则它仍会列出但不可选，对话框默认选中工作记忆。
- 选定的位置原样接收文本，经由该 Source 自己的管理操作和当前 revision 写入，与其页面上的操作相同：`MEMORY.md` 与 `USER.md` 使用运行时记忆的 `add`，写满时照常进行容量整理；记忆空间使用记忆空间的 `remember`，`source: user`。不运行模型。
- 运行时记忆层开启时列出工作记忆和用户画像。记忆空间层开启、Provider 已启用且支持写入时列出各个空间；Mnemon Native 空间只在找到其 CLI 时列出。
- 一份回执只对应一段文本和一个位置。把同一段文本再次写入同一位置需要先修改；换一个位置，或之前提交失败，则可以原样提交。运行时记忆对同一条目只保留一份，重复保存时会说明，而不是报错。
- 状态中没有说明某个层、Provider 或任务 Agent 是否存在时，按存在处理，因此默认选项不会因为信息缺失而离开任务 Agent。

## 自动化检查

`tests/client-interaction-surfaces.spec.tsx`：

- 没有任务 Agent 时，对话框默认选中工作记忆，以最新 revision 和确认标记发送运行时记忆的 `add`，显示回执，并把**由 Agent 决定**列为不可选；不会发出任务 Agent 请求。
- 有任务 Agent 和两个空间时，默认仍是任务 Agent；CLI 缺失时不列出 Native 空间；写入所选空间失败后可以原样重试；成功后的回执只关闭该位置的提交，其链接打开记忆空间。
- 原有的存入记忆测试仍以任务 Agent 为默认，请求内容不变。

## 限制

- 选定位置不会判断价值、跨空间去重或提炼，这些由**由 Agent 决定**完成；只有运行时记忆会丢弃完全相同的条目。
- 对话框不记住上次的位置，每次打开都从默认选项开始。
- 在 main 上，没有记忆空间时写满的工作记忆会拒绝写入，回执会显示该拒绝。这种情况下的本地归档由另一项改动（#345）处理。
- 截图只包含 DSH 默认浅色主题和中文界面。
