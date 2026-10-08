---
"dsh-mnemon": patch
---

Runtime Memory archives entries that a Memory Space already holds word for word. When MEMORY.md is full, the Host copies its entries into a Memory Space before compacting. Mnemon Native skips an entry the space already holds exactly and names that stored memory in its receipt, but the Host still searched for each skipped entry, one recall at a time. A recall that timed out on a slow embedding service, or that ranked the copy out, failed the whole archive with `runtime archive skipped an entry without exact durable recall evidence`, removed what it had just written and left MEMORY.md full, so every retry failed the same way (#339). The Host now takes the receipt's id and exact text as the evidence and searches only when a receipt lacks them; that error now says whether the search was unavailable or found no exact copy. Document archives read a skipped index receipt the same way.

运行时记忆可以归档记忆空间中已有逐字副本的条目。MEMORY.md 写满时，Host 先把条目复制到记忆空间，再压缩。Mnemon Native 遇到空间里已有完全相同的条目时会跳过写入，并在回执中给出那条已存记忆；但 Host 仍对每个被跳过的条目逐一检索。只要有一次检索因嵌入服务过慢而超时，或副本没有排进结果，整次归档就会以 `runtime archive skipped an entry without exact durable recall evidence` 失败，删除刚写入的内容，MEMORY.md 依旧是满的，之后每次重试都以同样方式失败（#339）。现在 Host 直接以回执中的 id 和逐字原文作为证据，只有回执缺少这些信息时才检索；检索失败时，报错会说明是检索不可用，还是没有找到逐字副本。项目档案归档读取被跳过的索引回执时也采用同样的方式。
