# Git 仓库同步

[English](./README.md)

dsh-mnemon 可以把记忆发布到 Git 仓库，并在另一台机器上恢复。该能力保留原有的离线 ZIP 方式，同时增加一条持续通道：同一份 Mnemon Pack 载荷以可读文件写入用户指定的分支。本文记录已冻结的契约与支撑它的验收运行。

## 通道提供的能力

- 通道 `/dsh-mnemon-sync`，包含十二个 endpoint：`status`、`configure`、`push`、`preview`、`pull`、`github-status`、`github-start`、`github-poll`、`github-cancel`、`github-signout`、`github-repositories` 与 `github-create`。
- `push` 导出完整包，在本地镜像中提交并推送分支；必须传 `confirmed: true`，不会有任何定时推送。
- `pull` 先读取远端 manifest 与 SHA-256 清单，预览差异，确认后走与“导入 ZIP”相同的导入器合并。manifest 或校验和不匹配属于硬失败，不会导入任何内容。
- 载荷就是既有的 Mnemon Pack 载荷：同一个收集器、同一个校验器、同一个导入器。`manifest.json` 上的同步扩展字段记录通道、分支、目录与推送时间；不认识同步的读取方仍能读到合法的 Mnemon Pack manifest。
- 载荷始终是完整的 Mnemon Pack：runtime、documents、memory-spaces 与 settings，用户画像包含在 runtime 中。settings 组件承载 `mnemon` 命名空间的 `user` 层并剔除机器本地键（`storageScope`、`dataDir`、`cliPath`、`customPackId`、`customPacks`），因此第二台机器继承的是配置，而不是只存在于第一台机器上的路径。Pack manifest 的 `scope` 为 `full` 或恰好一个组件，因此无法表示持久化的组件选择，也不会保存这样的配置；组件筛选只是 pull 上一次性的可选参数 `components`。
- `push` 先合并远端包再导出：导入远端已有的内容，导出合并后的结果，响应里回报这次合并（`merged.commit`、`merged.machine`、`merged.components`、`merged.summary`、`merged.tombstones`）。本机删除的 Runtime 条目在导出时被记为墓碑，因此导入较旧的包不会把它带回来。
- 双向操作都要求 `writeEnabled`；只读部署会以与“导入 ZIP”相同的提示拒绝 push 与 pull。
- **使用 GitHub 登录**是首选凭据。表单走 GitHub 的 OAuth 设备码流程：显示一次性设备码、链接到 `https://github.com/login/device`，并按 GitHub 返回的间隔轮询。凭据经 DSH 凭据服务以记录键 `dsh-mnemon/github` 保存，永不到达浏览器。服务用 `ctx.get('credentials')` 读取而非 `inject`，因此未挂载 provider 的 profile 仍能加载插件，只是把登录报告为不可用。
- **你的仓库**列出已登录账号可推送的仓库（私有仓库有标注，无推送权限的不可选），**新建仓库**会创建新仓库（默认私有，带一个初始提交，让第一次 push 就有分支可发布）。选择其中任一个都会把 clone 地址写入手填表单编辑的同一个 `repoUrl` 字段。
- token 字段作为回退保留且为选填。状态与配置响应只描述凭据（`hasToken`、`credentialSource`、`credentialLogin`），不回传其值；失败信息也会脱敏。

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
| `repoUrl` | - | `https://`、`ssh://`、`git@host:path` 或本地绝对路径；token 不会写进该地址。唯一没有默认值的字段 |
| `branch` | `mnemon-sync` | 按 Git 分支名规则校验；留空恢复该默认值 |
| `subdir` | `mnemon/` | 相对路径，不含 `..`，不能是绝对路径；留空恢复该默认值 |
| `token` | - | 可选回退，仅 HTTPS 远端；`MNEMON_SYNC_GIT_TOKEN` 优先，且永不经 RPC 返回。GitHub 登录是首选凭据，保存在本文件之外 |
| `authorName` | `dsh-mnemon sync` | 同步分支的提交身份，选填；留空则使用本机 Git 的 `user.name` |
| `authorEmail` | `mnemon@localhost` | 同步分支的提交身份，选填；留空则使用本机 Git 的 `user.email` |

配置中没有 `components` 字段。Mnemon Pack 校验 manifest 的 `scope` 只能是 `full` 或恰好一个组件，任意子集在格式中无法表示，因此同步载荷始终是完整包；唯一的组件筛选是 pull 上的一次性可选参数 `components`。`<storageRoot>/state/sync/git` 下的镜像是可丢弃的 Git 工作树；存储根本身永远不会成为 Git 工作树，`state/` 也不属于任何数据组件，因此镜像不会同步自己。Git 通过 Host 既有的 `runProcess` 以参数数组和 `shell: false` 运行；不引入新依赖，也不拼接 shell 字符串。

## 验证

本节是验收运行的记录，不是计划。运行环境为 Windows 11、Node 26.0.0、Git 2.55.0.windows.5，被测对象就是本 PR 携带的 revision。验收工具是 `scripts/verify-sync-git.mjs`，以 `node scripts/verify-sync-git.mjs` 运行（`pnpm run e2e:sync` 运行的是同一个脚本；本机上 pnpm 包装层会受跨盘符 `TEMP` 影响，直接用 Node 运行则不会）；它会创建两个一次性存储根，把插件安装进两个一次性 `DSH_HOME` profile，启动两个真实的 `dsh web` 实例，用各自的启动 token 换取浏览器 cookie，并以浏览器使用的同一套信封经 loopback HTTP 驱动 `/dsh-mnemon-sync` 与 `/dsh-mnemon-write`。唯一的替身是模型 endpoint，而它从未收到任何请求。

```sh
pnpm run build && pnpm --workspace-concurrency=4 -r build
node scripts/verify-sync-git.mjs
```

运行结果：

```text
1. One instance publishes the whole pack to a real repository
  ok   a fresh storage root reports Git and an unconfigured remote
  ok   the configuration path lives inside the storage root
  ok   a repository alone is enough: branch, directory and author keep their defaults
  ok   an empty author clears the identity so Git uses the one on this machine
  ok   an empty branch and directory fall back to the defaults
  ok   the working memory accepted one entry through the write channel
  ok   the configured remote is reachable and still has no branch
  ok   an unconfirmed push is refused
  ok   push committed and published one pack
  ok   the pack holds every component
  ok   the commit carries the identity Git was left with
  ok   the branch holds the manifest, the checksums and the payload
  ok   the published working memory carries the entry
  ok   the manifest declares the pack and its channel
  ok   the mirror lives under the storage root and not at its top level
  ok   a repeated push publishes nothing new
  ok   the branch holds exactly one commit

2. A second instance previews and imports the same branch
  ok   the second instance reaches the same defaults from a repository alone
  ok   preview reports the published commit and its manifest
  ok   preview reports the working memory as changed against an empty root
  ok   preview imported nothing
  ok   pull imported the published commit through the pack importer
  ok   the second machine now holds the working memory and the profile

3. A tampered payload fails hard and imports nothing
  ok   the checksum failure names the changed file
  ok   the tampered payload was not imported

4. A token never reaches a response, a file, or the mirror
  ok   configure names the credential without carrying it
  ok   status names the credential without carrying it
  ok   the token is stored in the 0600 state file
  ok   an unreachable remote is reported without leaking the token
  ok   a failed push never echoes the token
  ok   the token never reaches the mirror

5. Read-only work still answers while every write stays gated
  ok   an unknown endpoint is a bad request

6. GitHub sign-in answers over the channel without a browser
  ok   the sign-in surface reports what this Host can do
  ok   the store is mounted and the account is still signed out
  ok   cancelling a flow that never started leaves the account signed out
  ok   both instances shut down on the polite signal

Git sync end-to-end verification passed.
```

同一通道在真实 WebUI 中的表现（不是验收脚本）：真实 `dsh web` 实例提供存储页，仓库经表单配置，一条记忆经常规写入路径写入，分支用按钮发布。四张图都来自这次会话，且都不含凭据、账号名与仓库名；图里的绝对路径来自一次性验收实例的临时存储根。

| 在存储页保存并推送 | 导入之前读回的远端 | 在同一页面上登录 GitHub | 未登录时的默认值与选填字段 |
|---|---|---|---|
| ![仓库同步行显示已推送的提交与提示](./sync-pushed-zh.png) | ![预览行给出远端提交、组件与文件差异](./sync-preview-zh.png) | ![GitHub 账号区块显示设备码、复制按钮与授权链接](./sync-github-zh.png) | ![未登录时选择仓库区块的说明、预填的分支与远端目录，以及提交者字段的「可选」占位](./sync-defaults-zh.png) |

推送后页面提示 `已推送 0df94229（7 个文件，2.0 KB）。`，分支上的 `mnemon/payload/runtime/USER.md` 持有片刻之前写入的条目。随后 `检查远端` 报告 `远端 0df94229 · 3 个组件 · 1.9 KB`、`0/3 个组件与本地不同` 与 `新增 0 · 丢失 0 · 不同 1`，且没有导入任何内容：只有点击 `拉取并合并` 才会合并。验收实例的界面语言是中文，因此图中的文案为中文。

第四张图是未登录状态下的同一表单：`选择仓库` 区块仍然可见，并写明「登录后这里会列出你的仓库，可直接选用或新建；不登录也可以在手填表单里填写地址」；`分支` 与 `远端目录` 已预填 `mnemon-sync` 与 `mnemon/`，下方分别写明「默认 mnemon-sync」与「仓库内存放 payload 的目录，默认 mnemon/」；`提交者姓名` 与 `提交者邮箱` 都显示「可选」占位，姓名下方写明「留空则使用本机 Git 身份」。

这次运行在单元测试之外确立的事实：

- 一个真实实例通过 `/dsh-mnemon-write` 写入工作记忆与用户画像，再通过 `/dsh-mnemon-sync/push` 推送；随后裸仓库在 `mnemon-sync` 分支上确实持有 `mnemon/manifest.json`、`mnemon/checksums.json` 与 `mnemon/payload/runtime/{memories.json,USER.md,MEMORY.md}`，且该条目可在 `git show mnemon-sync:mnemon/payload/runtime/MEMORY.md` 中读到。
- 拥有独立 `DSH_HOME` 与存储根的第二个实例先预览该分支，确认后导入，随后磁盘上同时持有工作记忆条目与用户画像，因此该分支确实可以在机器之间移植。
- 重复同一份 push 返回 `committed: false`、`pushed: false` 与 `the branch already holds this payload`，分支仍停在一个提交。这正是固定时钟曾经掩盖的情形；验收运行使用真实时钟。
- 改动一个载荷文件后，preview 与 pull 都以 `the remote Mnemon payload failed its checksum: payload/runtime/MEMORY.md` 失败，第二台机器的文件未被触碰。
- token 只出现在权限为 `0600` 的状态文件中；响应、失败信息与镜像的 Git 配置都不含它。
- 设备码流程在 `tests/sync-rpc.spec.ts` 中以桩化的 GitHub 端到端驱动：`github-start` 返回设备码与验证地址，`github-poll` 返回带登录名的 `success`，而生成的访问令牌没有出现在任何响应里——只有 `credentialSource: 'github'` 与 `credentialLogin: 'octocat'` 出现。
- 未确认的 push 与 pull 分别以 `Publishing the sync branch requires confirmation` 与 `Importing the remote Mnemon payload requires confirmation` 被拒；未知 endpoint 返回 `bad-request` 与 `unknown sync endpoint: nope`。
- 登录区块随后在真实页面上被驱动，而非验收脚本：`github-start` 返回真实设备码与授权链接，页面在 32 秒内发出 7 次 `github-poll`，相邻间隔为 5.39 s、5.38 s、5.40 s、5.38 s、5.41 s 与 5.38 s，即 GitHub 要求的 5 秒间隔加上往返耗时。任何响应都不携带令牌。
- 表单在未登录时也给出 `选择仓库` 区块：`github-status` 报告登录可用时该区块即渲染，未登录只是把列表与新建按钮换成一句说明，手填表单始终可用。
- 只填仓库地址即可完成配置：`configure` 只带 `repoUrl` 时，`branch`、`subdir`、`authorName` 与 `authorEmail` 都取默认值；`branch` 或 `subdir` 传空串会恢复默认值，`authorName` 与 `authorEmail` 传空串则让 Git 使用本机身份。提交作者因此等于 `git var GIT_AUTHOR_IDENT` 报出的身份，因为 Git 会拒绝 `-c user.name=` 这样的空值参数。
- 账号登录后，该区块列出该账号的仓库，标记私有仓库、禁用无推送权限的仓库，选中其一会把地址写入仓库字段。上一次会话遗留的设备码在登录后不再显示，区块改为报告 `已登录 @…`，并有回归测试守住这一情形。

运行记录到的两种行为不是缺陷，但在读取真实远端之前值得了解：

- 全新的存储根仍会导出一个空的 `documents/index.json` 与一个空的 `payload/data/.dsh-memory-bodies.json`，因此相对于空根，这两个组件可能报告 `changed: false`，而 runtime 报告 `changed: true`。预览比较的是字节，两个空索引就是同样的字节。
- 导入器会用自身的键序重建 `memories.json`，因此一台拉取过该分支的机器再次 push 时，可能产生字节不同但内容相同的提交。载荷比较只忽略 manifest 上的两个时间戳，不忽略字段顺序。

自动化覆盖在 `pnpm test` 中运行：`tests/sync-config.spec.ts` 覆盖读写、`0600` 权限、脱敏与校验；`tests/git-sync.spec.ts` 覆盖 init、push、第二台机器 pull、manifest 与校验和拒绝、subdir 与分支校验、不产生静默空载荷的情形，以及移动时钟下的重复 push，Git 缺失时跳过；`tests/github-auth.spec.ts` 以桩化凭据端口与队列式假 `fetch` 覆盖设备码流程（start、pending、`slow_down`、success、过期、拒绝、错误、取消、退出登录、列表与新建校验）；`tests/sync-rpc.spec.ts` 覆盖 endpoint 校验、`writeEnabled` 门禁、token 脱敏、错误脱敏、令牌不出现在任何响应中的完整登录流程，以及远程投影被拒绝的路径。

## 限制

- 没有自动或定时推送；push 是用户动作，且始终先确认。
- 加密快照、WebDAV 与带保留窗口的快照目录不在范围内。
- 只有记忆会同步：载荷不包含 DSH 配置、凭据与会话历史。
- 没有远端凭据时 push 仍会本地提交并报告推送被跳过；下次带凭据 push 即可把分支推到远端。
- 凭据按以下顺序解析：环境变量 `MNEMON_SYNC_GIT_TOKEN`、`state/sync-git.json`（权限 `0600`）中的 token，最后是 GitHub 登录写入 DSH 凭据服务的凭据。既然服务已经接入，是否还要保留本地 token 字段是规格中记录的维护者决定。
