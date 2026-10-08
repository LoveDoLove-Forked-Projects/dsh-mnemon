# 归档记忆空间中已有逐字副本的工作记忆 — issue #339

[English](./README.md) | [Issue #339](https://github.com/omdsh-dev/dsh-mnemon/issues/339) | [验证记录](./verification.json)

MEMORY.md 写满时，Host 先把条目复制到记忆空间，再压缩。Issue 中每次尝试都以 `runtime archive skipped an entry without exact durable recall evidence` 失败：空间里已有大部分条目的逐字副本，这次尝试删除了刚写入的内容，MEMORY.md 仍然是满的。报告者在同一路径上先遇到了四次超时，使用的是外部嵌入服务。修复后，这些条目直接依据 Provider 自己的回执完成归档，不再为它们检索。

基线：main `2296898d`（dsh-mnemon 0.5.24）。修复：`0064b658`，以及审查后补充的 `6e2733ac`。运行环境为 macOS 15.6 arm64、Node 24.19.0、隔离前缀中的 DSH 0.2.0-rc.2（npm `latest` 与 `next`），以及 Mnemon CLI 0.2.10。

## 方法

`MNEMON_CLI_PATH=/opt/homebrew/bin/mnemon pnpm e2e:serve --archive-copies` 用临时 profile 启动真实 WebUI。Host 启动前，它写入三条工作记忆（640 字节中的 475 字节），并把每条的逐字副本写入 Native 记忆空间 `default`，就像此前一次失败的尝试留下的那样。嵌入请求发往本机一个 12 秒后才响应的服务；Mnemon CLI 保持默认的 10 秒超时。同一个脚本在修复版本上运行，也在换入 main 的协调器与记忆空间运行器后的基线上运行：

1. 打开**记忆系统**，再打开**运行时记忆**；
2. **添加记忆**：夹具输出的那条 182 字节的条目，保存到工作记忆；
3. 用 `mnemon --readonly recall --basic` 读取 Native 存储。

## 修复前后

添加前的工作记忆（两个版本相同）：

![工作记忆：3 条，640 B 中的 475 B](./working-memory-full.jpg)

| main 上添加这条记忆 | 修复后 |
|---|---|
| ![runtime archive skipped an entry without exact durable recall evidence in Memory Space default，条目没有添加](./before-add.jpg) | ![容量整理完成：已先归档到记忆空间 default，再更新工作记忆 · 当前 2 条](./after-add.jpg) |

| | main | 修复后 |
|---|---|---|
| 结果 | `runtime archive skipped an entry without exact durable recall evidence in Memory Space default` | **容量整理完成**：已归档到 `default`，再添加新条目 |
| 从点击添加到出结果 | 10.2 秒 | 0.3 秒 |
| 嵌入请求 | 1 次，即第一次校验检索，被 10 秒超时中断 | 0 次 |
| 之后的工作记忆 | 未变化，640 B 中的 475 B，新条目没有添加 | 640 B 中的 345 B，共 2 条，含新条目 |
| Native 存储 | 前后都是 3 条 | 前后都是 3 条，没有写入重复内容 |
| 浏览器控制台错误 | 无 | 无 |

## 原因与修复

归档用 Mnemon Native 的批量写入导入条目。批量写入会先读取空间，跳过空间里已有逐字相同文本的条目，并在回执中给出那条记忆：它的 id 和已存储的原文。Host 丢弃了这两项信息，对每个被跳过的条目用其前 500 个字符逐一做排序检索，并要求结果中有逐字匹配。记忆空间的检索会把失败的 Provider 调用变成空结果，所以只要有一次检索超时（这里是嵌入服务超时），整次归档就会失败；检索把副本排到质量策略截断线以下，也会导致同样的结果。失败的尝试随后会删除刚创建的条目，所以每次重试都会回到同样的状态。

现在，携带已存记忆 id 且原文与条目逐字相同的跳过回执，就是该条目的证据。缺少这些信息的回执（例如只报告 id 的 Provider）仍然通过检索核验，检索失败时的报错会说明是检索不可用，还是没有找到逐字副本。项目档案归档读取被跳过的索引回执时也采用同样的方式。Mnemon CLI 超时会写明是哪条命令，例如 `mnemon import did not respond within 10000ms`，便于区分“慢”与“坏”。

审查发现了一种回执指向已不存在副本的情况。存储超过上限（默认 1,000 条记忆）后，Mnemon 的导入会在之后清理最多十条最弱的记忆，而归档复用的副本可能就在其中。现在 Mnemon Native 的批量写入会读取本次导入清理掉的 id，并在同一次调用中重新导入这样的条目，所以每张回执指向的记忆都仍然存在。

## 自动化检查

- `tests/subagent.spec.ts` 的 *takes a skipped receipt that names the exact stored memory as its evidence, without a search*：两个被跳过的条目和一个新条目依据回执中的 id 归档，不经检索。在 main 上以报告中的错误失败。
- *still searches when a skipped receipt does not carry the exact text, and says what the search found*：语义相近的匹配不被当作副本；新条目会被再次删除，工作记忆保持不变；报错说明检索结果为空还是检索不可用。
- *takes a skipped document index receipt that names the exact stored index as its evidence*：在 main 上失败。
- `plugins/dsh-mnemon-source-memory-spaces/tests/runner.spec.ts`：超时报错写明命令。
- `plugins/dsh-mnemon-provider-mnemon-native/tests/provider.spec.ts` 的 *imports an entry again when the same import prunes the copy it reused*：在 `6e2733ac` 之前失败。

用真实 Mnemon CLI（不配置嵌入服务）做的探测：在 400 条相似记忆旁边，把 14 条 MEMORY.md 大小的条目通过 remember-many 导入两次。第二次 14 条全部被跳过，14 个回执都带有已存记忆的 id 和逐字原文。没有慢速嵌入服务时，校验检索也找到了全部 14 条；所以这个故障需要一次失败、或把副本排出结果的检索，夹具用慢速嵌入服务制造了这种情况。

第二次真实 CLI 探测把容量设为 3、新记忆的保护期设为 2 秒，然后归档一个已存副本恰好是最弱记忆的条目，同时带上一个新条目。在 `6e2733ac` 之前，导入清理掉了这个副本，回执仍然指向它；`mnemon show` 显示它已被删除。修复后，这个条目被重新导入，两张回执指向的记忆都存在且原文一致。

## 限制

Issue 中的存储与嵌入服务无法获得；夹具用合成存储和本机嵌入服务复现了报告中的现象。截图只覆盖 DSH 默认浅色主题和中文界面。
