---
"dsh-mnemon": patch
---

The dsh-mnemon configuration shows every component's own settings wherever it is drawn. A shell that puts plugin configurations in its own Settings page, such as a **插件配置** (Plugin configuration) section, renders the page without DSH's slot renderer, so the settings that Runtime Memory, Memory Spaces and the Layered strategy contribute to their pages had nowhere to render: their gears were missing and the strategy page lacked its background tasks. The configuration now renders those contributions directly in that case, as DSH's component row pages already do. On DSH's own Plugins page nothing changes.

dsh-mnemon 的配置页无论在哪里显示，都会显示各组件自己的设置。有的外壳把插件配置放进自己的设置页（例如“插件配置”分区），绘制这个页面时不经过 DSH 的 slot 渲染器；运行时记忆、记忆空间和分层策略注册到各自页面的设置因此无处渲染：它们的齿轮按钮消失，分层策略页面也缺少“后台任务”。现在遇到这种情况，配置页会直接渲染这些设置，与 DSH 的组件行页面一致。DSH 自带的插件页不受影响。
