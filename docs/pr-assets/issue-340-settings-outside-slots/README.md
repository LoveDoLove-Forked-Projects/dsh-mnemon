# Component settings where a shell draws the configuration — issue #340

[简体中文](./README.zh-CN.md) | [Issue #340](https://github.com/omdsh-dev/dsh-mnemon/issues/340) | [Verification record](./verification.json)

The issue compares two ways into the dsh-mnemon configuration: DSH's Plugins page, opened from the Memory System, and a **插件配置** (Plugin configuration) section under Settings. In the second, **运行时记忆** (Runtime Memory) and **记忆空间** (Memory Spaces) had no gear, and the main strategy's page lacked settings. DSH 0.2.0-rc.2 itself has no such Settings section: it comes from a shell that shows plugin configurations on its own page. Such a shell renders the configuration without DSH's slot renderer.

Baseline: main `2296898d` (dsh-mnemon 0.5.24). Fix: `90bf2e89`. The runs use macOS 15.6 arm64, Node 24.19.0, DSH 0.2.0-rc.2 (npm `latest` and `next`) in an isolated prefix, and Mnemon CLI 0.2.10.

## Method

The [test-only plugin](./mnemon-settings-embed-fixture/lib/client.js) adds a **插件配置** section to DSH's Settings, the way such a shell does. It mirrors dsh-mnemon's `plugins.bundle.config` entry into a slot of its own, with the same component, locale and services, and renders it there as the page view. DSH binds the services as usual, but the mirrored entry declares no child slots, so the page receives no `renderSlot`. The same capture script ran against the fix and against the baseline, which is this branch with main's versions of the client files the fix changes swapped in, since main's `serve-e2e.mjs` has no `--plugin=` flag:

```sh
pnpm e2e:serve --plugin=docs/pr-assets/issue-340-settings-outside-slots/mnemon-settings-embed-fixture
```

1. open **插件** and the dsh-mnemon page, and list the gears of the memory composition;
2. open **设置**, then **插件配置**, and list the gears again;
3. from the Settings section, open the gears of 运行时记忆, 记忆空间 and the main strategy, 分层策略 (Layered); open 分层策略 from the Plugins page as well.

## Before and after

| Settings → 插件配置 on main | With the fix |
|---|---|
| ![运行时记忆 and 记忆空间 have no gear](./before-settings-section.jpg) | ![Every component with settings has its gear](./after-settings-section.jpg) |

| 分层策略 from the Settings section on main | With the fix |
|---|---|
| ![Only the relations, no background tasks](./before-strategy-page.jpg) | ![Background tasks: task Agent model, idle review, review mode](./after-strategy-page.jpg) |

With the fix, the 运行时记忆 gear opens its page with **用户画像范围** (User profile scope):

![Runtime Memory page with its user profile scope](./after-runtime-page.jpg)

| | Main | Fix |
|---|---|---|
| Gears on DSH's Plugins page | 6: 分层策略, 运行时记忆, 记忆空间, 主动记录, 轻量上下文, 范围组合 | the same 6 |
| Gears in the Settings section | 4: no 运行时记忆, no 记忆空间 | the same 6 as the Plugins page |
| 分层策略 from the Settings section | relations only | relations and **后台任务** (background tasks), as on the Plugins page |
| Browser console errors | none | none |

## Cause and fix

Runtime Memory, Memory Spaces and the Layered strategy register their own settings into a region the dsh-mnemon configuration declares, keyed by package name. The board shows a gear for a component that has declared options or registered settings, and renders the registered ones through the `renderSlot` DSH hands the configuration. Without `renderSlot` the configuration had no way to render them, so it dropped them: the two Sources lost their only way into their pages, and the strategy page lost its background tasks. The strategies' own declared options still showed, which is why some gears remained.

DSH's row page for a component already meets the same situation, since a child slot has one declaring entry; it renders the registered component directly through `renderContributed`. The configuration's services now include `renderContributed` as well. The page keeps preferring DSH's `renderSlot` whenever it has one, so DSH's Plugins page renders exactly as before.

## Automated checks

- `tests/client-plugin-page.spec.tsx`: with DSH's `renderSlot` the registered settings render through it; without it they render through `renderContributed`; with neither the page has none, as on main.
- `tests/client-apply.spec.ts`: the configuration's services include `renderContributed`. The assertion fails on main.

## Limits

The shell in the issue is not named, and DSH 0.2.0-rc.2, the official desktop app and the npm alpha have no **插件配置** Settings section. The fixture reproduces the reported symptom and its mechanism, a configuration rendered without DSH's `renderSlot`; a shell that renders it differently again may need its own check. Screenshots show DSH's default light theme and Chinese UI only.
