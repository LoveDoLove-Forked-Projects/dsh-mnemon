# 没有记忆空间时的记忆系统 — issue #336

[English](./README.md) | [Issue #336](https://github.com/omdsh-dev/dsh-mnemon/issues/336) | [验证记录](./verification.json)

MEMORY.md 在压缩前会先把条目归档到记忆空间，以此腾出容量。报告者的机器上没有 Mnemon CLI，也没有其他 Provider，所以既没有记忆空间，也无法创建，放不下的写入每次都被拒绝。项目档案在需要腾出容量或归档时，也会以同样方式被拒绝。修复后，没有记忆空间时记忆系统照常运转：放不下的内容移入本地归档，不丢任何数据。

基线：main `2296898d`（dsh-mnemon 0.5.24）。修复：`7ecc5a61`。运行环境为 macOS 15.6 arm64、Node 24.19.0 与隔离前缀中的 DSH 0.2.0-rc.2（npm `latest` 与 `next`）。

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

现在，当完全没有能接收归档的记忆空间时，Host 会让 Runtime Source 以 `archive: 'local'` 压缩。这包括：记忆空间这一层已关闭、不接受自动写入或未安装，或者其中没有任何能接收归档的空间（已激活、Provider 已启用且就绪、支持精确写入与安全删除）。Runtime Source 在同一把锁内，先把压缩舍弃的已提交条目追加到 `runtime/archived/`（`MEMORY.md` 供阅读，`memories.jsonl` 保存每个条目及其元数据），再提交压缩后的存储。中途失败时，条目最多同时出现在两处，绝不会两处都没有。归档目录或文件的位置上是符号链接，或文件的位置上是目录时，会在写入任一文件之前被拒绝。本改动之前的 Runtime Source 无法保留压缩舍弃的条目，它的计划中没有 `localArchive: true`，Host 会像以前一样拒绝。项目档案也以同样方式在不建索引的情况下归档到本地并保留原文。

其余情况仍像以前一样拒绝，工作记忆中的内容不会移走：空间在当前 View 的写入范围之外、View 不提供对合适空间的写入（例如受限范围的策略）、合适的空间在另一个记忆空间 Source 中，或空间目录暂时无法读取。这样报错所建议的“在新回合重试”就能把内容归档进那个空间。有能接收归档的记忆空间时，行为不变。导入 Mnemon Pack 会保留本地归档。

记忆空间这一层也不再承诺做不到的事：

- 没有就绪 Provider 时，不再向 Agent 提供 remember 和 manage-spaces 动作。
- Mnemon Native 空间只在找到 CLI 时才算激活。Source revision 只在这种情况下才变化。
- 分层策略只在记忆空间可召回时才提到 `mnemon_recall`，只在有空间能接收归档时才提到归档到记忆空间；项目档案路由与写入规则在任何情况下都保留。记忆空间既可召回又可写入时，提示文字逐字节不变。
- 没有任何记忆空间时，`mnemon_status` 会附带一条说明。

## 自动化检查

- `tests/layer-combinations.spec.ts` 让各层运行到容量上限：
  - 记忆空间分别处于就绪、只有未激活的空间、没有就绪 Provider、已关闭、未安装五种状态：通过 Agent 工具、网页以及 Host 在回合之外的路径写满 MEMORY.md，再检查每种状态下 View 提供的内容与提示。
  - 没有记忆空间的四种状态下：项目档案写满，以及手动归档。
  - 运行时记忆、项目档案、记忆空间三层开关的全部 8 种组合。
  - 每种情况下放不下的内容都不会丢失；没有记忆空间的各种状态下，也都不需要模型参与就能腾出容量。
- `plugins/dsh-mnemon-source-runtime/tests/controller.spec.ts`：本地归档恰好保存压缩舍弃的条目；之后的批次追加在同一个标题之下；只有明确要求时才写入。追加之后提交失败时，条目同时保留在两处。归档目录或文件的位置上是符号链接，或文件的位置上是目录时，会在写入任一文件之前被拒绝，链接目标与 MEMORY.md 都保持不变。计划中带有 `localArchive: true`。
- `tests/subagent.spec.ts`：计划中没有 `localArchive` 的 Runtime Source 会得到拒绝而不是压缩；另一个记忆空间 Source 中有能接收归档的空间时，写入同样被拒绝。
- `tests/pack.spec.ts`：合并或替换导入都会保留本地归档的文件与文件夹，不携带符号链接，也不改动链接目标。
- `plugins/dsh-mnemon-strategy-default-three-tier/tests/strategy.spec.ts`：记忆空间既可召回又可写入时提示不变；召回与归档分别按 View 提供的内容提及，只有在有空间能接收归档时才提到归档到记忆空间；没有召回时的路由仍保留项目档案与写入规则。
- 针对没有空间可接收归档的测试，现在断言本地归档，且仍然不写入只读、未激活或不支持的空间。受限范围策略的测试（View 不提供对合适空间的写入）和 issue 250 的测试（空间在 View 范围之外）保持拒绝。

## 限制

- Agent 无法从本地归档召回，目前也没有工具把它导入记忆空间。本地归档为用户逐字保存这些条目。
- 在 Windows 上没有不跟随链接的打开标志，符号链接只靠每次写入前的检查拒绝。
- Mnemon Pack 不包含本地归档；导入 Pack 时会保留它。
- 对话中的“存入记忆”会把文本交给任务 Agent，而任务 Agent 需要记忆空间；另一项改动会让对话框可以直接写入工作记忆。
- 截图只覆盖 DSH 默认浅色主题和中文界面。
