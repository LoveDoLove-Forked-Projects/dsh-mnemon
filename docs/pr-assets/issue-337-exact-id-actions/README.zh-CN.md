# 按精确 id 遗忘记忆 — issue #337

[English](./README.md) | [Issue #337](https://github.com/omdsh-dev/dsh-mnemon/issues/337) | [验证记录](./verification.json)

Agent 写入的记忆，它自己删不掉：无论指明哪个 id 和记忆空间，`mnemon_forget` 都以 `forget requires evidence already admitted by this View` 失败。用户使用 `/mnemon forget <ID>` 时也以同样方式失败。修复后，以精确 id 指定的记忆会被遗忘，而且只遗忘这一条。

基线：main `2296898d`（dsh-mnemon 0.5.24）。修复：`cd66723a`。运行环境为 macOS 15.6 arm64、Node 24.19.0、隔离前缀中的 DSH 0.2.0-rc.2（npm `latest` 与 `next`），以及 Mnemon CLI 0.2.10。

## 方法

`MNEMON_CLI_PATH=/opt/homebrew/bin/mnemon pnpm e2e:serve --exact-id` 用临时 profile 和 Mnemon Native 启动真实 WebUI。只有委派工作 Agent 的决策是脚本化的：remember 工作 Agent 写入收到的内容，forget 工作 Agent 用收到的精确 id 调用 `mnemon_forget`。命令、工具、View 和 Native 存储都是真实运行。同一个脚本在修复版本上运行，也在换入 main 的记忆空间 Source 与 Mnemon Native 驱动后的基线上运行。在同一个对话中：

1. `/mnemon remember Issue 337 synthetic fact: the staging rollout gate closes at 18:00 on release days.`
2. `/mnemon recall staging rollout gate`，输出这条记忆的 id；
3. `/mnemon related <ID>`；
4. `/mnemon forget <ID>`，然后以只读方式读取 Native 存储状态。

## 修复前后

| main | 修复后 |
|---|---|
| ![Mnemon 未确认删除记忆：forget requires evidence already admitted by this View](./before-forget.jpg) | ![这条记忆已被软删除](./after-forget.jpg) |

| | main | 修复后 |
|---|---|---|
| `/mnemon related <ID>` | 两跳内没有关联记忆 | 相同 |
| `/mnemon forget <ID>` | **未确认删除**，`forget requires evidence already admitted by this View` | **已软删除** |
| 遗忘后的 Native 存储 | 1 条，删除 0 条 | 0 条，删除 1 条 |
| 浏览器控制台错误 | 无 | 无 |

## 原因与修复

遗忘、建立关联和相关记忆遍历只作用于当前 View 已接纳的 id，也就是它的召回真正返回过的证据。`mnemon_forget` 和 `/mnemon forget <ID>` 并不在调用方的 View 中执行，而是把请求交给一个工作 Agent，它的 View 是新的，什么也没召回过。这个工作 Agent 手里只有 id，没有任何召回查询能接纳它，所以这个操作永远无法执行。`/mnemon related <ID>` 没有这个问题：它运行在之前 `/mnemon recall` 已接纳该 id 的那个 View 中。

现在，当 id 不是本 View 的证据时，Source 会通过新增的可选方法 `get(body, id)`，让支持按 id 查找的 Provider 在 View 可读的空间中查找它，并接纳这条记忆；只有恰好一个空间持有该 id 时才执行。没有空间持有、或两个空间都持有的 id 会被拒绝，第二种情况指明空间即可解决。不支持按 id 查找的 Provider 保持原来的规则，只接受 View 返回过的证据，即使请求指明了空间也是如此：它自己的遗忘或建立关联调用未必限定在该空间内。View 返回过的证据仍然优先，行为与之前完全相同；除此之外，操作需要的从“在同一 View 中召回过”变为“给出 View 可读空间中某条记忆的精确 id”，View 可读哪些空间没有改变。Mnemon Native 用 `mnemon --readonly show` 查找，不改动访问计数和操作日志；未知或已遗忘的 id 视为不存在。建立关联和相关记忆遍历以同样方式解析 id。工具说明没有改变。

## 自动化检查

- `plugins/dsh-mnemon-source-memory-spaces/tests/source.spec.ts` 的 *acts on a memory named by exact id that this View has not returned*：遗忘能在唯一持有它的空间中找到 `written`；拒绝 `missing` 和有歧义的 `twin`；指明空间后可以遗忘 `twin`；遍历和建立关联以同样方式解析。在 main 上以报告中的错误失败。
- 原有的 *admits only evidence actually returned under the View budget* 测试使用不支持按 id 查找的 Provider：不在 View 证据中的 id 仍被拒绝遍历和遗忘，现在请求指明空间时也同样拒绝。
- `plugins/dsh-mnemon-provider-mnemon-native/tests/provider.spec.ts`：`get` 使用 `--readonly show` 读取，“no rows” 视为不存在，其他失败照常抛出。

## 限制

工作 Agent 是脚本化的，所以这次运行检查的是 Host 与 Source 的路径，而不是模型的选择。除 Mnemon Native 外，其他 Provider 尚未实现 `get`；对它们来说，遗忘、建立关联和遍历仍只接受 View 返回过的证据。Mnemon CLI 0.2.6 之前的版本没有 `show` 命令，在这些版本上查找会以 CLI 的报错失败，而不会找到记忆。截图只覆盖 DSH 默认浅色主题和中文界面。
