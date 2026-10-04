---
"dsh-mnemon": minor
---

Git repository sync: a new `/dsh-mnemon-sync` channel can publish the Mnemon Pack payload to a repository you own and restore it on another machine. Push and pull are both confirmed actions, both require `writeEnabled`, and pull merges through the same validation and importer the ZIP backup uses. The token lives in `state/sync-git.json` at mode `0600` or in `MNEMON_SYNC_GIT_TOKEN`, and never enters the payload or an answer.

Git 仓库同步：新增 `/dsh-mnemon-sync` 通道，可以把 Mnemon Pack 载荷发布到你自己的仓库并在另一台机器上恢复。push 与 pull 都需要确认，也都要求 `writeEnabled`；pull 走与 ZIP 备份相同的校验与导入路径。token 保存在 `state/sync-git.json`（权限 `0600`）或环境变量 `MNEMON_SYNC_GIT_TOKEN` 中，不进入载荷，也不出现在任何响应里。