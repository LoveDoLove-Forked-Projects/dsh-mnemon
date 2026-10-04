---
"dsh-mnemon": minor
---

Git repository sync: a new `/dsh-mnemon-sync` channel can publish the Mnemon Pack payload to a repository you own and restore it on another machine. Sign in with GitHub through the OAuth device flow, pick one of your repositories or create a new one, and push: the access token is stored in DSH's credentials service and never reaches the browser. The token field stays as an optional fallback, in `state/sync-git.json` at mode `0600` or in `MNEMON_SYNC_GIT_TOKEN`, and no credential ever enters the payload or an answer. Push and pull are both confirmed actions and both require `writeEnabled`, and pull merges through the same validation and importer the ZIP backup uses.

Git 仓库同步：新增 `/dsh-mnemon-sync` 通道，可以把 Mnemon Pack 载荷发布到你自己的仓库并在另一台机器上恢复。通过 OAuth 设备码流程使用 GitHub 登录，从已有仓库中选择或新建一个，然后推送：访问令牌保存在 DSH 凭据服务中，永不到达浏览器。token 字段保留为可选回退，保存在 `state/sync-git.json`（权限 `0600`）或环境变量 `MNEMON_SYNC_GIT_TOKEN` 中，任何凭据都不会进入载荷或响应。push 与 pull 都需要确认，也都要求 `writeEnabled`；pull 走与 ZIP 备份相同的校验与导入路径。
