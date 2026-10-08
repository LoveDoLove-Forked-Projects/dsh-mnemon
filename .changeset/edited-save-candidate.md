---
"dsh-mnemon": patch
---

Save to memory accepts an edited candidate again. The dialog marks the candidate as editable and asks for an edit before sending again, but the Host keyed its replay guard by the reply alone: after a reply had been saved once, sending an edited candidate for it failed with `idempotency key was already used for different content`. The guard now keeps the text last sent for each reply: sending it again still returns its receipt without a second write, and edited text goes to the task Agent as a new candidate.

存入记忆现在可以再次提交修改后的候选内容。对话框标明候选内容可编辑，并要求修改后才能再次提交；但 Host 的重放保护只按回复区分：同一条回复保存过一次后，修改候选内容再提交会报 `idempotency key was already used for different content`。现在重放保护会记住每条回复最后一次提交的文本：原样再次提交仍返回它的回执，不会重复写入；修改后的内容会作为新的候选交给任务 Agent。
