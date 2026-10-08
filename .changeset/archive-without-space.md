---
"dsh-mnemon": patch
"dsh-mnemon-source-runtime": patch
"dsh-mnemon-source-documents": patch
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-strategy-default-three-tier": patch
---

Memory keeps working without a Memory Space (#336). When working memory is full and no Memory Space at all can take an archive, because the layer is off or takes no automatic writes, no Provider is ready, no space is active or only Providers without exact writes remain, the Runtime Source moves the entries compaction leaves out to a local archive, `runtime/archived/` in the data directory, in the same commit, instead of refusing the write. A space the current View offers no writes to, or a directory that cannot be read, still refuses, so the retry in a new turn can archive into it. Importing a Mnemon Pack keeps the local archive, and the archive never follows a symbolic link. Project Documents are archived locally the same way, keeping their originals, when no Memory Space can take their index. Memory Spaces with no ready Provider no longer offer Agents writes that would fail, a Mnemon Native space counts as active only while its CLI is found, and the Layered strategy's guidance names `mnemon_recall` only while Memory Spaces can be recalled from, and archiving into them only while one takes writes; its Documents routing and write rules stay. `mnemon_status` says what a Memory Space needs while none exists. With a Memory Space to write to, nothing changes.

没有记忆空间时，记忆系统照常运转（#336）。工作记忆写满且完全没有能接收归档的记忆空间时（该层已关闭或不接受自动写入、没有就绪的 Provider、没有激活的空间，或只剩不支持精确写入的 Provider），Runtime Source 会在同一次提交中把压缩舍弃的条目移入数据目录下的本地归档 `runtime/archived/`，而不再拒绝写入。当前 View 不提供写入的空间，或暂时无法读取的空间目录，仍会拒绝，以便在新回合重试时归档到其中。导入 Mnemon Pack 会保留本地归档，归档也不会跟随符号链接。项目档案在没有记忆空间能接收索引时，也会以同样方式归档到本地并保留原文。没有就绪 Provider 时，记忆空间不再向 Agent 提供必然失败的写入；Mnemon Native 空间只在找到 CLI 时才算激活；分层策略只在记忆空间可召回时才提到 `mnemon_recall`，只在有空间可写入时才提到归档到记忆空间，项目档案路由与写入规则保持不变。没有任何记忆空间时，`mnemon_status` 会说明需要做什么。有可写的记忆空间时，行为不变。
