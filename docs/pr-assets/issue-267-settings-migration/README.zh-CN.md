# DSH Settings 兼容与恢复 — Issue #267

[English](./README.md)

## 基线复现

2026-09-22，未修改的 main `65c0e23ba410993e16c00c8b3adf92d59d853425` 在临时 Web Profile 中，使用公开发布的 DSH `0.1.7-alpha.1` 复现了激活失败。Mnemon 根插件报错：

```text
mnemon (dsh-mnemon): TypeError: ctx.settings.register is not a function
```

插件页面显示根插件异常，依赖它的 Source 和 Strategy 等待依赖。本地激活记录将结果标记为 `reproduced`；选定的 DSH 安装文件已与经过完整性校验的公开 npm tarball 比对。

![基线：Mnemon 激活异常，依赖插件等待依赖](./before-alpha7-activation.png)

准备和启动方法见[打包制品验证夹具](./harness/HARNESS.md)。基线与修复制品使用独立的临时 Profile。仅基线需要 `--legacy-peer-deps`，用于越过其过时的 peer 范围并暴露运行时故障；修复制品使用正常的 peer 解析。

## 实现与公开契约

DSH `0.1.7-alpha.1` 将动态 Settings 注册改为从各插件的静态 `Config` 生成表单。实现使用公开发布的 `SettingsForms.configure/describe/mutate`、`ConfigEditor.edit`、Cordis 的 `internal/config` waterfall，以及 Loader 的 `loader/volatile-update` 事件。官方 DSH 包、manifest 和源码均未修改；制品夹具不使用 DSH 源码 checkout、工作区 alias 或替代 Settings 服务。

- [Live Config](../../../src/host/live-config.ts) 使用公开 DeepSeek Schemastery/Cosmokit 包提供的真实 volatile 引用，保留原生表单可识别的对象 schema，并执行纯跨字段校验。`remoteAccess` 保持普通字段，沿用 Host 正常的重挂载行为。
- [Settings 适配器](../../../src/host/settings-service.ts) 保留 Mnemon 客户端命名空间，将读取、校验和写入绑定到所属 Entry/Fiber。仍提供 `settings.register` 的旧 Host 继续使用原服务。Profile 写入经过 DSH 加锁的编辑器；所属实例的 preflight 在持久化前校验候选运行图，提交后的 volatile 更新负责刷新运行时。
- Core、UI 和 View 共用一个原生 revision。仅当该命名空间未脱敏的生效值、继承值和显式覆盖仍与已观察快照一致时，才允许有限重试。同命名空间冲突、缺少历史快照、只读状态、实例销毁和 Entry 替换均会拒绝写入；远程描述仍保持脱敏。
- [插件管理](../../../src/host/plugin-management.ts) 在整个 Profile 被重新协调后重放已选择的 Entry 状态，校验最终组合，并对失败事务执行补偿。
- [客户端图标别名](../../../src/client/ui-icons.ts) 同时支持旧版按尺寸命名的导出和 alpha7 按字重命名的导出。设置页双语说明改为由 DSH 保存并实时生效，不再硬编码已移除的设置文件。

## 保留设置与现有 Profile 选择

恢复过程只读 `settings.yaml.imported`，保持其字节不变，并仅通过 `ConfigEditor.edit` 写入。[纯迁移规划器](../../../src/host/legacy-settings-import.ts) 将规范根插件的保留分区映射如下：

| 保留分区 | Profile Config 目标 |
| --- | --- |
| `mnemon` | 当前显式覆盖中缺失的根配置字段 |
| `mnemon-ui` | `conversationInteraction` |
| 精确匹配的 `mnemon-view[-hash]` | `memoryView` |
| 精确匹配的 `mnemon-plugins[-hash]` | `memoryView.entries` 中的 Source 启用状态，仅接受已确认的 Source Entry |

当前显式根配置和 UI 选择优先。已显式设置的 `memoryView` 字段会保留，包括将 `entries` 重置为空的选择。现有 Strategy 行优先于更早保存的启用状态和配置；Source 配置仍由原生 Entry 保存。Profile 的局部 patch ID 会匹配到无歧义的完整 Loader ID，其他行不会被替换。规划器在编辑器回调内重新读取状态，使期间发生的显式编辑优先；`legacySettingsImported` 标记防止后续重置又恢复旧偏好。

原生 `!!js` 表达式以表达式数据保留，恢复过程不会执行它们，也不会把它们转成普通字符串。若某个 Entry 的启用状态或 Strategy 配置由表达式控制，将跳过该 Entry 的旧 View 覆盖。Source 配置表达式和无关表达式行继续保留在原生行中。相关旧备份分区中的表达式、损坏数据和不支持的 YAML 会被拒绝，不会完成恢复或修改备份。

## 迁移与回滚边界

- 若启动时仍有原始 `settings.yaml`，DSH 会自行异步重命名和导入。Mnemon 的补充恢复延后到下一次 Host 冷启动；刷新页面或重挂插件不会解除该限制。
- 自动恢复仅接受规范根 Entry `mnemon`，以及所属 Profile 精确匹配的历史命名空间后缀。不猜测自定义根归属、其他 Profile 的 hash 或无后缀回退。歧义和被拒绝的数据仍保留在备份中，供人工核对。
- 升级前备份 DSH Profile 配置、旧设置和相关 Mnemon 数据。新 Profile 设置不会反向同步到 `settings.yaml`；降级需要相应的配置备份，并人工核对升级后的新增修改，没有自动逆向导出。
- 此变更涉及偏好存储和恢复，不改变 Runtime、Documents 或 Memory Spaces 的数据格式。

## 验证范围

定向回归覆盖 [schema 与引用行为](../../../tests/live-config.spec.ts)、[所属实例隔离与脱敏](../../../tests/profile-settings.spec.ts)、[revision 冲突与已退役实例](../../../tests/profile-settings-revisions.spec.ts)、[纯迁移规划](../../../tests/legacy-settings-import.spec.ts)、[保留文件恢复与表达式](../../../tests/profile-settings-import.spec.ts)，以及[两代客户端图标](../../../tests/client-primitives-compat.spec.tsx)。

制品夹具使用隔离测试数据，确定性模型端点仅绑定 `127.0.0.1`，不需要外部模型 API Key，也不会调用外部模型服务。启动认证 URL、`server.json`、原始 `web.log` 和模型请求日志均留在仓库外；公开证据不得包含凭据或私人数据。

<!-- 最终验证完成后，在此补充实际构建/制品检查、修复后 WebUI 截图和重启结果。目前不记录最终成功结论或测试总数。 -->
