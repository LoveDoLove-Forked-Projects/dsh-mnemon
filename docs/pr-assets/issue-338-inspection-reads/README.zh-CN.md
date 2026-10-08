# 检索记忆而不记录 — issue #338

[English](./README.md) | [Issue #338](https://github.com/omdsh-dev/dsh-mnemon/issues/338) | [验证记录](./verification.json)

Mnemon Native 会记录每次召回：把带查询文本的一行写入存储的操作日志，并把命中的记忆计为已访问。Mnemon 的保留策略会读取这些访问次数，访问过三次的记忆不会被自动清理。Issue 报告的是 Mnemon CLI 自身命令的这一行为，dsh-mnemon 无法控制。dsh-mnemon 能控制的，是自己的哪些读取走这条路径。Agent 召回记忆属于使用；记忆系统自身的检索只是查看，原来也以同样方式被记录。修复后，它们改为读取快照，不改变存储。

基线：main `2296898d`（dsh-mnemon 0.5.24）。修复：`f60990bf`。运行环境为 macOS 15.6 arm64、Node 24.19.0、隔离前缀中的 DSH 0.2.0-rc.2（npm `latest` 与 `next`），以及 Mnemon CLI 0.2.10。

## 方法

`pnpm e2e:serve` 配合 Mnemon Native 运行；Host 启动前，先通过 Mnemon CLI 在存储 `default` 中写入四条带实体的记忆。每一步之后，用 `mnemon --readonly status` 读取存储的 `oplog_count`，这次读取本身不会被记录。同一个脚本在修复版本上运行，也在把修复改动的文件换回 main 版本后的基线上运行。

| 被测的直接检索 | 被测的实体页 |
|---|---|
| ![在记忆空间页直接检索 “release gate”](./direct-search.jpg) | ![选中 SQLite 的实体页及其记忆](./entities-page.jpg) |

## 修复前后

每一步新增的操作日志行数：

| 步骤 | main | 修复后 |
|---|---|---|
| 打开记忆系统，再打开记忆空间 | 0 | 0 |
| 对 `release gate` **直接检索** | 1 | 0 |
| 在第一条结果上**查看关联** | 0 | 0 |
| **实体**：选中 SQLite | 0 | 0 |
| 对 SQLite **查找相关记忆** | 1 | 0 |
| 一轮模型不召回的对话 | 0 | 0 |
| `/mnemon recall release gate` | 1 | 1 |

之后的 `mnemon log` 在 main 上列出三次带查询的召回（`q=release gate`、`q=SQLite`、`q=release gate`）；修复后只有 `/mnemon recall` 的一次。两个版本的页面显示相同的结果。

## 原因与修复

记忆空间页上的**直接检索**和实体页上的**查找相关记忆**，与 Agent 召回走同一个 Source 检索，Mnemon Native 把它们都当作普通的 `mnemon recall` 执行。

这些检索现在会设置 `SearchRequest.inspect`。Mnemon Native 用 `mnemon --readonly` 处理它们：读取快照，不增加访问次数，也不写日志；记忆系统的列表和图谱本来就这样读取。Agent 召回、`/mnemon recall` 和 **Agent 查询**属于使用，照常记录，所以 Mnemon 的保留策略仍能看到 Agent 依赖的记忆。其他 Provider 也会收到这个标记，可以做同样的区分。Provider 指南现在说明了 Mnemon Native 会记录什么。

有两类读取保持不变：

- **查看关联**执行的是 `mnemon related`，它本身不记录任何内容；两个版本上都没有新增日志行。
- Host 归档时核验自身写入的检查（项目档案的索引是否已存在，以及核验被跳过写入的检索）继续读取实时存储。Mnemon 说明其快照不适用于正被其他进程修改的存储，而这些检查必须看到最新的写入。

## 自动化检查

- `plugins/dsh-mnemon-provider-mnemon-native/tests/provider.spec.ts`：带 `inspect` 的检索使用 `--readonly`；不带时与之前相同。
- `plugins/dsh-mnemon-source-memory-spaces/tests/source-io.spec.ts` 的 *passes an inspection on to the Provider and leaves Agent recall a use*：管理通道的检索会传递该标记；不带标记的检索，以及 Agent 通过 View 的召回都不会带上。
- 同一插件的 `tests/client.spec.tsx` 与 `tests/entity-index.spec.ts`：页面的检索和实体页的相关召回都是查看。

以上检查在 main 上都会失败。

## 限制

- 其他 Mnemon 进程打开存储期间完成的写入，在该进程退出前（通常几秒内）可能不在快照中。记忆系统的列表和图谱本来也是如此。
- Mnemon 的日志保留最近 5,000 条操作。Mnemon CLI 自身命令的日志以及其中保存的查询文本属于 Mnemon，这里没有改变。
- 截图只覆盖 DSH 默认浅色主题和中文界面。
