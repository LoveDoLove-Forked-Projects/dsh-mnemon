---
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-provider-mnemon-native": patch
---

Searching Mnemon Native memories in the Memory System no longer writes to the store. Mnemon Native records every recall in its operation log, query text included, and counts its hits as accessed, which Mnemon's retention takes into account (#338). That fits an Agent using memory, but **Direct search** on Memory Spaces and **Find related memories** on the Entities page only look, and each still added a row and counted the memories it showed as used. These searches now pass `inspect`, which Mnemon Native serves from a read-only snapshot, as the Memory System's lists and graph already were. Agent recall, `/mnemon recall` and **Ask Agent** still record their use, and the Host's checks of its own writes while archiving keep reading the live store. `SearchRequest.inspect` lets other Providers make the same distinction.

在记忆系统中检索 Mnemon Native 的记忆不再写入存储。Mnemon Native 会把每次召回连同查询文本写入操作日志，并把命中的记忆计为已访问，Mnemon 的保留策略会参考这些访问（#338）。这适合 Agent 使用记忆的场景；但记忆空间页上的**直接检索**和实体页上的**查找相关记忆**只是查看，原来也各自写入一行，并把显示的记忆计为已使用。现在这些检索会带上 `inspect`，Mnemon Native 改从只读快照读取，与记忆系统的列表和图谱一致。Agent 召回、`/mnemon recall` 和 **Agent 查询**仍会记录使用，Host 归档时核验自身写入的检查也继续读取实时存储。其他 Provider 可以借助 `SearchRequest.inspect` 做同样的区分。
