# v0.5.26 发布验收

[English](README.md)

验证于 2026-10-09（Asia/Shanghai）。被测的是 0.5.26 改动的两个包，由 `pnpm release:version` 基于 `main` `d295f52d`（包含 #335 与 #357）构建：`dsh-mnemon@0.5.26` 与 `dsh-mnemon-source-runtime@0.5.14`。其余 16 个组件包按 Starter 锁定的版本从 npm 安装，0.5.26 没有改动它们。

## DSH 0.2.0-rc.2 与 0.2.1-alpha.2 上的官方 WebUI

两个宿主都是未经修改的 npm DSH，使用 Node `24.19.0`，以及全新的 home、DSH home 与 pnpm store：`0.2.0-rc.2`（npm `latest` 与 `next`）和 `0.2.1-alpha.2`（npm `alpha`）。每一步在两个宿主上都通过。

1. 启动未安装 Mnemon 的宿主，打开**插件 → 添加插件**。
2. 安装 `dsh-mnemon`。安装源由 DSH 自己选择，测速后选中了中国大陆镜像源。本机回环 registry 返回 npm 的真实元数据，并加上两个新版本。之后 profile 中是两个新版本，其余组件都是 npm 上锁定的版本。
3. 点击**立即启用**，无需重启宿主即出现记忆系统。状态页显示 **dsh-mnemon 0.5.26 / 系统正常**，Mnemon Native 显示 **Mnemon 0.2.10**：[0.2.0-rc.2](status.png)、[0.2.1-alpha.2](status-alpha.png)。
4. 添加一条运行时记忆，刷新页面后读回：[运行时记忆](runtime.png)。
5. 在 WebUI 中创建一个 Mnemon Native 空间，并在卡片上激活：[记忆空间](spaces.png)。用 Mnemon CLI `0.2.10` 写入一条事实并用 CLI 召回，再用 WebUI 的**直接检索**找到同一条：[检索](recall.png)。
6. 再用 CLI 写入三条带有实体 `Atlas` 的记忆，以及一条只在正文中提到 Atlas 的记忆。**实体**页上 `Atlas` 计数为 3，选中后恰好列出这三条（“当前显示 3 / 3”）。相关记忆收在**查找相关记忆**之后：[实体](entities.png)。点击后找到了只提到 Atlas 的那条：[相关记忆](entities-related.png)。
7. dsh-mnemon 配置页上的 **Git 同步**默认关闭，这一行只显示标题与开关。打开后显示仓库、**使用 GitHub 登录**与默认关闭的**自动备份**，再关闭即隐藏：[关闭](sync-off.png)、[打开](sync-on.png)。
8. 打开**检查版本**。dsh-mnemon 显示已安装 0.5.26。发布前 npm 的最新版本仍是 0.5.25，所以对话框把 0.5.26 标为本地版本，不提供更新。**立即启用**之后没有重启提示，因为正在运行的就是已安装的版本。

两个宿主都没有宿主警告或控制台错误，每个宿主进程只启动一次。[validation.json](validation.json) 记录了包摘要与结果。Profile 与记忆均为合成数据。

![打开 Git 同步后：仓库、GitHub 登录与自动备份](sync-on.png)

## 本版本的改动

每项改动都有自己的记录：
- [Git 仓库同步](../git-sync/README.zh-CN.md)（#335）
- [DSH 0.2.1-alpha.2 上的记忆子 Agent](../issue-356-subagent-activation/README.zh-CN.md)（#357）：两个宿主上 main 与修复后在 WebUI 中向已满的 USER.md 写入，以及两个版本上的真实宿主子 Agent 测试

## 验证与发布边界

`pnpm run release:check` 确认 Starter 0.5.26 发布到 `latest` 标签，并锁定新的运行时记忆版本；发布流程会根据上一版本计算需要发布的包。Starter 的公开入口自 v0.5.25 以来没有变化，所以 peer 下限不变。版本号变更只改动 lockfile 中两行 specifier，CI 使用的 pnpm 10.13.1 以 `--frozen-lockfile` 接受它。包解压后为 1,851,881 字节，与 2,000,000 字节上限的差距不到 10%，所以本版本把上限提高到 2,500,000。

发布 PR 与发布工作流会运行完整的工作区验证和打包插件验证。之后发布流程会：
- 冻结合并后的 main revision；
- 发布有变化的包，并从 npm 读回；
- 安装完整的 18 包组合，检查一次真实的 Registry 升级；
- 创建 GitHub Release。

这些截图展示的是带版本号的本地包，本身并不证明 npm 发布成功。
