---
"dsh-mnemon": minor
---

Merged memory now waits for a human. Every export stamps the machine identity, records the runtime entries it carried and turns what disappeared into tombstones, so importing an older pack cannot resurrect a deletion. Push merges the remote pack before it exports and reports that merge. On top of that, **Memory reconciliation** asks the model to propose a merge of the memory this machine already holds, records the plan as a review entry under `state/review-ledger.json` instead of applying it, and lets you accept, reject, annotate or reopen every proposal; only an accepted entry is applied, operation by operation, and it stops at the first failure.

合并后的记忆现在要经过人来确认。每次导出都会打上机器标识、记录本次携带的 Runtime 条目，并把消失的条目记为墓碑，因此导入较旧的包不会把删除过的记忆带回来。push 会先合并远端包再导出，并在响应中回报这次合并。在此基础上新增**整理记忆**：模型针对本机已持有的记忆提出合并方案，方案被记录为 `state/review-ledger.json` 下的审查条目而不是直接应用，你可以对每条建议接受、拒绝、批注或重新打开；只有已接受的条目才会逐条执行，遇到第一个失败即停止。
