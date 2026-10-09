---
"dsh-mnemon": patch
---

Adding the branch's memories now says what it actually did. An entry this installation deleted earlier, and the branch still holds, is counted apart (`heldBack` in `diff`) and explained instead of being offered as an add that would write nothing at all; **Bring them back** overrules that deletion once, and the tombstones it overruled leave the state this import commits, so the same merge behaves the same way next time. The answer carries the merge report (`runtime: { added, held }`), and the dialog repeats the real count, because a merge that wrote nothing used to read exactly like a successful one. Plans that already ran leave the review list and move into an **Applied plans** dialog kept for reading, and a control inside a dialog is no longer recoloured by the page shell, so **Add them** is readable again.

新增分支上的记忆现在会说清它到底做了什么。本机以前删掉、而分支仍持有的条目会被单独计数（`diff` 里的 `heldBack`）并说明，而不是当作一个其实什么都写不进去的新增来提供；**恢复这些记忆**会一次性推翻这次删除，被推翻的墓碑会从本次导入提交的状态里移除，因此同样的合并在下一次表现一致。响应里带上合并报告（`runtime: { added, held }`），弹窗按实际条数回报——因为什么都没写入的合并，过去看起来和成功没有区别。已经执行过的方案离开整理列表、收进只供回看的**已执行的历史方案**弹窗；弹窗里的控件也不再被页面外壳重新着色，**直接新增**的文字重新可见。
