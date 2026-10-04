# Git 仓库同步

[English](./README.md)

dsh-mnemon 可以把记忆发布到 Git 仓库，并在另一台机器上恢复。该能力保留原有的离线 ZIP 方式，同时增加一条持续通道：同一份 Mnemon Pack 载荷以可读文件写入用户指定的分支。本文记录已冻结的契约与支撑它的验收运行。

## 通道提供的能力

- 通道 `/dsh-mnemon-sync`，包含五个 endpoint：`status`、`configure`、`push`、`preview` 与 `pull`。
- `push` 导出完整包，在本地镜像中提交并推送分支；必须传 `confirmed: true`，不会有任何定时推送。
- `pull` 先读取远端 manifest 与 SHA-256 清单，预览差异，确认后走与“导入 ZIP”相同的导入器合并。manifest 或校验和不匹配属于硬失败，不会导入任何内容。
- 载荷就是既有的 Mnemon Pack 载荷：同一个收集器、同一个校验器、同一个导入器。`manifest.json` 上的同步扩展字段记录通道、分支、目录与推送时间；不认识同步的读取方仍能读到合法的 Mnemon Pack manifest。
- 载荷始终是完整的 Mnemon Pack：runtime、documents 与 memory-spaces，用户画像包含在 runtime 中。Pack manifest 的 `scope` 为 `full` 或恰好一个组件，因此无法表示持久化的组件选择，也不会保存这样的配置；组件筛选只是 pull 上一次性的可选参数 `components`。
- 双向操作都要求 `writeEnabled`；只读部署会以与“导入 ZIP”相同的提示拒绝 push 与 pull。
- token 不进入载荷、配置文件与日志。状态与配置响应只描述它（`hasToken`），不回传其值；失败信息也会脱敏。

## 远端布局

文件位于所配置分支的 `<subdir>/` 下，默认分支 `mnemon-sync`、目录 `mnemon/`：

```text
<branch>:<subdir>/
+-- manifest.json       # Mnemon Pack manifest 加同步扩展字段
+-- checksums.json      # 与 ZIP 相同的逐文件 SHA-256 清单
+-- payload/
    +-- runtime/{memories.json,USER.md,MEMORY.md}
    +-- documents/{index.json,active/<id>.md,archived/<id>.md}
    +-- data/{.dsh-memory-bodies.json,<bodyId>/mnemon.db}
```

扩展字段为 `{"sync": {"channel": "git", "branch": "mnemon-sync", "subdir": "mnemon/", "pushedAt": "..."}}`；没有该字段的载荷在 pull 时仍会被接受。远端在稳定路径上保存当前状态，保留期即分支自身的 Git 历史。

## 配置

配置保存在 `<storageRoot>/state/sync-git.json`，权限 `0600`。它不属于 Config，只对应一个存储根，也不会经设置 RPC 或 profile patch 传递。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `repoUrl` | - | `https://`、`ssh://`、`git@host:path` 或本地绝对路径；token 不会写进该地址 |
| `branch` | `mnemon-sync` | 按 Git 分支名规则校验 |
| `subdir` | `mnemon/` | 相对路径，不含 `..`，不能是绝对路径 |
| `token` | - | 可选，仅 HTTPS 远端；`MNEMON_SYNC_GIT_TOKEN` 优先，且永不经 RPC 返回 |
| `authorName` | `dsh-mnemon sync` | 同步分支的提交身份 |
| `authorEmail` | `mnemon@localhost` | 同步分支的提交身份 |

配置中没有 `components` 字段。Mnemon Pack 校验 manifest 的 `scope` 只能是 `full` 或恰好一个组件，任意子集在格式中无法表示，因此同步载荷始终是完整包；唯一的组件筛选是 pull 上的一次性可选参数 `components`。`<storageRoot>/state/sync/git` 下的镜像是可丢弃的 Git 工作树；存储根本身永远不会成为 Git 工作树，`state/` 也不属于任何数据组件，因此镜像不会同步自己。Git 通过 Host 既有的 `runProcess` 以参数数组和 `shell: false` 运行；不引入新依赖，也不拼接 shell 字符串。

## 验证

本节是验收运行的记录，不是计划。运行环境为 Windows 11、Node 26.0.0、Git 2.55.0.windows.5，被测对象就是本 PR 携带的 revision。验收工具是 `scripts/verify-sync-git.mjs`，以 `pnpm run e2e:sync` 运行；它会创建两个一次性存储根，把插件安装进两个一次性 `DSH_HOME` profile，启动两个真实的 `dsh web` 实例，用各自的启动 token 换取浏览器 cookie，并以浏览器使用的同一套信封经 loopback HTTP 驱动 `/dsh-mnemon-sync` 与 `/dsh-mnemon-write`。唯一的替身是模型 endpoint，而它从未收到任何请求。

```sh
pnpm run build && pnpm --workspace-concurrency=4 -r build
pnpm run e2e:sync
```

运行结果：

```text
1. One instance publishes the whole pack to a real repository
  ok   a fresh storage root reports Git and an unconfigured remote
  ok   the configuration path lives inside the storage root
  ok   configure echoes the effective settings without a token
  ok   the working memory accepted one entry through the write channel
  ok   the configured remote is reachable and still has no branch
  ok   an unconfirmed push is refused
  ok   push committed and published one pack
  ok   the pack holds every component
  ok   the branch holds the manifest, the checksums and the payload
  ok   the published working memory carries the entry
  ok   the manifest declares the pack and its channel
  ok   the mirror lives under the storage root and not at its top level
  ok   a repeated push publishes nothing new
  ok   the branch holds exactly one commit

2. A second instance previews and imports the same branch
  ok   preview reports the published commit and its manifest
  ok   preview reports the working memory as changed against an empty root
  ok   preview imported nothing
  ok   pull imported the published commit through the pack importer
  ok   the second machine now holds the working memory and the profile

3. A tampered payload fails hard and imports nothing
  ok   the checksum failure names the changed file
  ok   the tampered payload was not imported

4. A token never reaches a response, a file, or the mirror
  ok   configure answers with hasToken only
  ok   status answers with hasToken only
  ok   the token is stored in the 0600 state file
  ok   an unreachable remote is reported without leaking the token
  ok   a failed push never echoes the token
  ok   the token never reaches the mirror

5. Read-only work still answers while every write stays gated
  ok   an unknown endpoint is a bad request
  ok   both instances shut down on the polite signal

Git sync end-to-end verification passed.
```

这次运行在单元测试之外确立的事实：

- 一个真实实例通过 `/dsh-mnemon-write` 写入工作记忆与用户画像，再通过 `/dsh-mnemon-sync/push` 推送；随后裸仓库在 `mnemon-sync` 分支上确实持有 `mnemon/manifest.json`、`mnemon/checksums.json` 与 `mnemon/payload/runtime/{memories.json,USER.md,MEMORY.md}`，且该条目可在 `git show mnemon-sync:mnemon/payload/runtime/MEMORY.md` 中读到。
- 拥有独立 `DSH_HOME` 与存储根的第二个实例先预览该分支，确认后导入，随后磁盘上同时持有工作记忆条目与用户画像，因此该分支确实可以在机器之间移植。
- 重复同一份 push 返回 `committed: false`、`pushed: false` 与 `the branch already holds this payload`，分支仍停在一个提交。这正是固定时钟曾经掩盖的情形；验收运行使用真实时钟。
- 改动一个载荷文件后，preview 与 pull 都以 `the remote Mnemon payload failed its checksum: payload/runtime/MEMORY.md` 失败，第二台机器的文件未被触碰。
- token 只出现在权限为 `0600` 的状态文件中；响应、失败信息与镜像的 Git 配置都不含它。
- 未确认的 push 与 pull 分别以 `Publishing the sync branch requires confirmation` 与 `Importing the remote Mnemon payload requires confirmation` 被拒；未知 endpoint 返回 `bad-request` 与 `unknown sync endpoint: nope`。

运行记录到的两种行为不是缺陷，但在读取真实远端之前值得了解：

- 全新的存储根仍会导出一个空的 `documents/index.json` 与一个空的 `payload/data/.dsh-memory-bodies.json`，因此相对于空根，这两个组件可能报告 `changed: false`，而 runtime 报告 `changed: true`。预览比较的是字节，两个空索引就是同样的字节。
- 导入器会用自身的键序重建 `memories.json`，因此一台拉取过该分支的机器再次 push 时，可能产生字节不同但内容相同的提交。载荷比较只忽略 manifest 上的两个时间戳，不忽略字段顺序。

自动化覆盖在 `pnpm test` 中运行：`tests/sync-config.spec.ts` 覆盖读写、`0600` 权限、脱敏与校验；`tests/git-sync.spec.ts` 覆盖 init、push、第二台机器 pull、manifest 与校验和拒绝、subdir 与分支校验、不产生静默空载荷的情形，以及移动时钟下的重复 push，Git 缺失时跳过；`tests/sync-rpc.spec.ts` 覆盖 endpoint 校验、`writeEnabled` 门禁、token 脱敏、错误脱敏与远程投影被拒绝的路径。

## 限制

- 没有自动或定时推送；push 是用户动作，且始终先确认。
- 加密快照、WebDAV 与带保留窗口的快照目录不在范围内。
- 只有记忆会同步：载荷不包含 DSH 配置、凭据与会话历史。
- 没有远端凭据时 push 仍会本地提交并报告推送被跳过；下次带凭据 push 即可把分支推到远端。
- 凭据从环境变量或 `state/sync-git.json`（权限 `0600`）读取，沿用 Provider 凭据的先例；迁移到 DSH 原生凭据服务是规格中记录的维护者决定。
