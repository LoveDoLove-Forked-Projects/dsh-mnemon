# Memory Sources under dshmarket's client-only mount — issue #359

[简体中文](./README.zh-CN.md) | [Issue #359](https://github.com/omdsh-dev/dsh-mnemon/issues/359) | [Verification record](./verification.json)

Issue #359 reports that on DSH 0.2.1-alpha.2, with dsh-mnemon 0.5.26, Memory Spaces 0.5.17 and dshmarket 1.66.14, every `dsh web` start warns that the Entry `mkt-client-dsh-mnemon-source-memory-spaces` failed with `Memory Spaces requires at least one explicit Provider child`, although the Profile's Memory Spaces Entry lists five Providers. The warning comes from dshmarket, not from DSH 0.2.1-alpha.2: it appears the same way on DSH 0.2.0-rc.2. The same mount also loads Runtime Memory and Project Documents a second time when they too are installed on their own, and then every conversation turn fails. With the fix, neither happens on either DSH.

Baseline: dsh-mnemon 0.5.26 and Memory Spaces 0.5.17 from npm, as in the report (main `7bd96593`). Fix: `58d19c24`; the review follow-up `af350e1a` changes nothing these runs exercise. The runs took place on 2026-10-10 (Asia/Shanghai):
- macOS 15.6 arm64 and Node 24.19.0;
- headless Chrome 154 at 1280×800, zh-CN, light;
- DSH 0.2.1-alpha.2 (npm `alpha`, the version in the report) and 0.2.0-rc.2 (npm `latest` and `next`), each in an isolated npm prefix;
- dshmarket 1.66.14, the version in the report and npm's latest.

## Cause

- At start, dshmarket's `mountClientOnlyDeps` looks at the direct dependencies of the Profile that declare `dsh.client` without `dsh.bundle` and are not among the Profile's bundles. Unless dshmarket has switched the package off or the Profile's own `cordis.patch.yml` names it, it writes a row `mkt-client-<package>` into its own Include tree. The row is meant to load a no-op host module, so that DSH serves the package's client bundle.
- The override that should swap in the no-op module compares the bare package name, but the row it writes holds the package's resolved `file://` URL. The two never match, so the Loader imports the package's real host module and applies it without configuration. The bug is in every dshmarket 1.66 release we checked, from 1.66.0 (2026-09-25) to 1.66.14 (2026-10-08).
- Runtime Memory, Project Documents and Memory Spaces are the only dsh-mnemon packages that match: they ship a client and are not bundles. The Starter composes them through its own Entries, so a copy installed on its own in the Profile, which Check versions lists as maintained by the Profile, gets a second mount.
- What each Source did there:
  - Memory Spaces received no Providers and threw. DSH printed that as the startup warning in the report.
  - Runtime Memory and Project Documents registered a second instance. Status then showed their cards twice, and the default layered Strategy refused to compose a View with two working-context Sources. Every turn failed with `default-three-tier View Strategy found ambiguous working-context Sources; select an explicit Strategy`.
- The Profile's own Memory Spaces Entry, the one with the Providers, was never affected: in scenario A below on DSH 0.2.0-rc.2, which reproduces the report, the conversation still received the Memory Spaces tools.
- DSH's Loader names an Entry after its parents, so the shim's id is `include:dsh-market:mkt-client-<package>`.

## Fix

- `installMemory` in the Starter's extension SDK installs nothing when the last segment of the Loader Entry id starts with `mkt-client-`, whatever `instanceId` the plugin passes. Runtime Memory and Project Documents call it from the installed Starter, so their published versions are fixed by the Starter alone.
- Memory Spaces returns from `apply` before it resolves Providers under such an Entry. It reads the Loader itself instead of a new SDK export, so its new version also works with older Starters.
- The Starter's own Entries compose all three Sources as before; dshmarket still mounts its row, which now does nothing.

## Method

For each DSH, a fresh home, DSH home and pnpm store held one Profile:
1. **Scenario A, the report.** `dsh plugin --profile web add dsh-mnemon@0.5.26 dshmarket@1.66.14 dsh-mnemon-source-memory-spaces@0.5.17`.
2. **Scenario B.** Scenario A plus `dsh-mnemon-source-runtime@0.5.14` and `dsh-mnemon-source-documents@0.5.10`, also installed on their own.
3. **The fix.** `dsh plugin --profile web add` with the Starter and Memory Spaces packed from the fix. They keep the version numbers 0.5.26 and 0.5.17.

Each start went through `dsh web`, with a loopback model stub. In a new conversation the message `记住：回答尽量简洁。` makes the stub call the real `mnemon_runtime_memory` tool to save the preference. Only the model's choices are scripted.

## Before and after

| | DSH 0.2.0-rc.2 | DSH 0.2.1-alpha.2 |
|---|---|---|
| Scenario A, npm releases | Warning at both starts; Status normal; the turn saves the preference | Warning at start; Status normal |
| Scenario B, npm releases | Status shows Runtime Memory and Project Documents twice; **the turn fails** | Same as on 0.2.0-rc.2 |
| Scenario A, fix | No warning at two starts; the turn saves the preference | No warning at two starts; the turn saves the preference |
| Scenario B, fix | Each card once; the turn saves the preference | Each card once; the turn saves the preference |

The startup warning with the npm releases, on both DSH versions (paths shortened):

```text
dsh: warning: 1 entry did not activate
mkt-client-dsh-mnemon-source-memory-spaces (file://<profile>/node_modules/dsh-mnemon-source-memory-spaces/lib/index.js): Error: Memory Spaces requires at least one explicit Provider child
    at resolveMemorySpaceProviderEntries (file://<profile>/node_modules/dsh-mnemon-source-memory-spaces/lib/index.js:3756:39)
    ...
    at file://<profile>/.dsh-market/#mkt-client-dsh-mnemon-source-memory-spaces
    at file://<profile>/#dsh-market
```

In scenario B the Memory Spaces mount failed the same way, but DSH printed no warning for it in our runs.

Scenario B on DSH 0.2.1-alpha.2 with the npm releases:

| Status | The conversation |
|---|---|
| ![Status: Runtime Memory and Project Documents cards each appear twice](./before-status-alpha.jpg) | ![The turn fails: default-three-tier View Strategy found ambiguous working-context Sources](./before-turn-alpha.jpg) |

The same Profile with the fix:

| Status | The conversation |
|---|---|
| ![Status: one card each for the Memory Engine, Runtime Memory, Project Documents and Memory Spaces](./after-status-alpha.jpg) | ![The turn saves the preference: 已记住, with one write in this turn's memory](./after-turn-alpha.jpg) |

Scenario B on DSH 0.2.0-rc.2, before and after the fix:

| npm releases | Fix |
|---|---|
| ![The turn fails with the same ambiguous working-context Sources error](./before-turn-020.jpg) | ![The turn saves the preference](./after-turn-020.jpg) |

No run logged a browser console error.

## Automated checks

- `tests/composable-extension-sdk.spec.ts`: under `include:dsh-market:mkt-client-<package>`, `installMemory` installs nothing next to the Starter's Entry, with no `instanceId`, a blank one, or one the plugin chose. An Entry that has the prefix only in an earlier segment installs as usual.
- `tests/market-client-shim.spec.ts`: the real Runtime Memory, Project Documents and Memory Spaces plugins are mounted under the Starter's Entries, then again as dshmarket mounts them, without configuration. The second Runtime Memory and Project Documents add no Source, and a turn still composes under the default layered Strategy. The second Memory Spaces adds none and throws nothing. A second Runtime Memory under an ordinary Entry is still a second instance, and Memory Spaces there still requires Providers.
- `plugins/dsh-mnemon-source-memory-spaces/tests/source.spec.ts`: Memory Spaces stays inert under the dshmarket Entry and still requires Providers under any other.
- On the baseline the tests fail with the errors users saw: the turn fails with `found ambiguous working-context Sources`, Memory Spaces throws `requires at least one explicit Provider child`, and the SDK case registers the shim's Source. With only the Starter's change, the Memory Spaces case still throws; with only Memory Spaces' change, the others still fail. They also fail when the match ignores the Entry id's prefix. That was this fix's first attempt, which passed tests with unprefixed ids and failed in the real Profile.

## Limits

- dshmarket's override is still broken; this fix keeps dsh-mnemon's Sources inert under it. A third-party package that ships a client and is not a bundle still gets its host module loaded there.
- A Profile that maintains Memory Spaces itself keeps loading its installed Memory Spaces at the dshmarket mount. The warning stops only once that package is 0.5.18 or later. **Check versions** updates it where pnpm is on the Host's PATH; otherwise `dsh plugin --profile <profile> add dsh-mnemon-source-memory-spaces@0.5.18` does, or the copy can be removed. Runtime Memory and Project Documents need only the new Starter.
- The fix was installed from packed archives with the old version numbers. The release acceptance installs the published versions.
- Only macOS was run; the report came from Windows. The cause and the fix depend on neither.
