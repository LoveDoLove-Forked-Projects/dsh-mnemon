---
"dsh-mnemon-provider-mnemon-native": patch
---

Archiving Runtime Memory into a Mnemon Native space at its capacity keeps every entry. Once a store holds more than its limit (1,000 memories by default), Mnemon prunes up to ten of its weakest memories after an import, and an exact copy that the archive reused instead of writing again could be among them. The archive now imports such an entry again in the same call, so every receipt names a memory that still exists.

向已达容量上限的 Mnemon Native 空间归档运行时记忆时，不会丢失条目。存储超过上限（默认 1,000 条记忆）后，Mnemon 会在导入后清理最多十条最弱的记忆，而归档没有重复写入、直接复用的逐字副本可能就在其中。现在归档会在同一次调用中重新导入这样的条目，每张回执指向的记忆都仍然存在。
