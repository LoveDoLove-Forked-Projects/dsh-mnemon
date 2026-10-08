# 没有记忆空间时的记忆系统 — issue #336

[English](./README.md) | [Issue #336](https://github.com/omdsh-dev/dsh-mnemon/issues/336) | [验证记录](./verification.json)

MEMORY.md 在压缩前会先把条目归档到记忆空间，以此腾出容量。报告者的机器上没有 Mnemon CLI，也没有其他 Provider，所以既没有记忆空间，也无法创建，放不下的写入每次都被拒绝。项目档案在需要腾出容量或归档时，也会以同样方式被拒绝。修复后，没有记忆空间时记忆系统照常运转：放不下的内容移入本地归档，不丢任何数据。

基线：main `2296898d`（dsh-mnemon 0.5.24）。修复：`b3e478a9`。运行环境为 macOS 15.6 arm64、Node 24.19.0 与隔离前缀中的 DSH 0.2.0-rc.2（npm `latest` 与 `next`）。

## 方法

`pnpm e2e:serve` 使用一行 `mnemon` 配置运行：`cliPath` 指向不存在的文件（与 `--without-mnemon-cli` 一样，会屏蔽已安装的 Mnemon CLI），工作记忆上限为 300 字节；没有连接其他 Provider。同一个脚本在修复版本上运行，也在把修复改动的源文件换回 main 版本后的基线上运行：

1. 打开**记忆系统**和**运行时记忆**，依次添加四条工作记忆，第四条放不下；
2. 读取运行时数据目录；
3. 打开**项目档案**，新建一份档案并**归档**。

## 修复前后

| main 上的第四条 | 修复后 |
|---|---|
| ![被拒绝：runtime memory archival requires an existing active writable Memory Space](./before-runtime-full.jpg) | ![容量整理完成：没有可写的记忆空间，已先把 2 条移入本地归档](./after-runtime-full.jpg) |

| main 上归档档案 | 修复后 |
|---|---|
| ![被拒绝：document archive requires an existing active Memory Space](./before-document-archive.jpg) | ![已归档到本地：原文移入归档目录，没有建立 Mnemon 冷索引](./after-document-archive.jpg) |

| | main | 修复后 |
|---|---|---|
| 放不下的工作记忆写入 | 被拒绝：`runtime memory archival requires an existing active writable Memory Space …; Memory Space body-directory is empty` | 写入成功；2 条较早的条目移入 `runtime/archived/` |
| 之后的工作记忆 | 3 条，300 字节中的 290 字节，新条目没有写入 | 2 条，192 字节，即新条目和最早的一条 |
| 本地归档 | 无 | `runtime/archived/MEMORY.md` 逐字保存这 2 条，另有 `memories.jsonl` |
| 归档项目档案 | 被拒绝：`document archive requires an existing active Memory Space …` | 归档到本地；原文仍可在归档标签页阅读 |
| 浏览器控制台错误 | 无 | 无 |

## 原因与修复

容量整理会先把所有能移走的 MEMORY.md 条目归档到记忆空间，再压缩。没有能接收它们的空间时，无论原因是没有就绪的 Provider、该层已关闭、没有激活的空间，还是只剩不支持精确写入的 Provider，都会拒绝写入。项目档案同样需要记忆空间来建立冷索引。

现在，当完全没有能接收归档的记忆空间时，Host 会让 Runtime Source 以 `archive: 'local'` 压缩。它在同一把锁内，先把压缩舍弃的已提交条目追加到 `runtime/archived/`（`memories.jsonl` 供恢复，`MEMORY.md` 供阅读），再提交压缩后的存储。中途失败时，条目最多同时出现在两处，绝不会两处都没有。项目档案也以同样方式归档到本地并保留原文。有能接收归档的记忆空间时，行为不变。如果空间存在、只是不在当前 View 的写入范围内，写入仍会被拒绝，这样报错所建议的“在新回合重试”就能把内容归档进那个空间。

记忆空间这一层也不再承诺做不到的事：

- 没有就绪 Provider 时，不再向 Agent 提供 remember 和 manage-spaces 动作。
- Mnemon Native 空间只在找到 CLI 时才算激活。Source revision 只在这种情况下才变化。
- 分层策略只在记忆空间可召回时才提到 `mnemon_recall` 和归档到记忆空间。三层齐全时，提示文字逐字节不变。
- 没有任何记忆空间时，`mnemon_status` 会附带一条说明。

## 自动化检查

- `tests/layer-combinations.spec.ts` 让各层运行到容量上限：
  - 记忆空间分别处于就绪、只有未激活的空间、没有就绪 Provider、已关闭、未安装五种状态：通过 Agent 工具和网页写满 MEMORY.md，再检查每种状态下 View 提供的内容。
  - 没有记忆空间的四种状态下：项目档案写满，以及手动归档。
  - 运行时记忆、项目档案、记忆空间三层开关的全部 8 种组合。
  - 每种情况下放不下的内容都不会丢失，也都不需要模型参与就能腾出容量。
- `plugins/dsh-mnemon-source-runtime/tests/controller.spec.ts`：本地归档恰好保存压缩舍弃的条目；之后的批次追加在同一个标题之下；只有明确要求时才写入。
- `plugins/dsh-mnemon-strategy-default-three-tier/tests/strategy.spec.ts`：记忆空间可召回时提示不变；不可召回时既不提 `mnemon_recall`，也不提归档到记忆空间。
- 原先断言拒绝写入的测试，现在断言本地归档，且仍然不写入只读、未激活或不支持的空间。issue 250 的测试（空间存在但在 View 范围之外）保持拒绝。

## 限制

- Agent 无法从本地归档召回。本地归档为用户保存这些条目，也便于以后导入记忆空间。
- Mnemon Pack 暂不包含本地归档；导入 Pack 时它保持原样。
- 对话中的“存入记忆”仍需要记忆空间；另一项改动会让对话框可以直接写入工作记忆。
- 截图只覆盖 DSH 默认浅色主题和中文界面。
