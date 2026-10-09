# Memory subagents on DSH 0.2.1-alpha.2 — issue #356

[简体中文](./README.zh-CN.md) | [Issue #356](https://github.com/omdsh-dev/dsh-mnemon/issues/356) | [Verification record](./verification.json)

Issue #356 reports that on DSH 0.2.1-alpha.2, every `mnemon_runtime_memory` add or replace to the user profile failed with `this.subagents.start is not a function`. The same dsh-mnemon 0.5.25 had worked on 0.2.1-alpha.1, and reads still worked. With the fix the write succeeds on 0.2.1-alpha.2, and nothing changes on DSH 0.2.0.

Baseline: main `76532791` (dsh-mnemon 0.5.25 with #335). Fix: `3acc6cf6`. The runs took place on 2026-10-09 (Asia/Shanghai):
- macOS 15.6 arm64 and Node 24.19.0;
- headless Chrome 154 at 1280×900, zh-CN, light;
- DSH 0.2.1-alpha.2 (npm `alpha`, the version in the report) and 0.2.0-rc.2 (npm `latest` and `next`), each in an isolated npm prefix.

## Cause

- DSH 0.2.1-alpha.2 removed `ctx.subagents.start(name, request)` together with `startContinuable`. 0.2.0-rc.2 and 0.2.1-alpha.1 still have both.
  - Every child now starts through `startActivation({ provider, label, request, signal, delivery })`, which returns `{ childId, messageId, result, dispose }`.
  - Its spawn and fork providers only prepare continuable children.
- Every Mnemon memory subagent started with `start`, and on 0.2.1-alpha.2 each one throws before a child exists. They are:
  - USER.md compaction and working-memory archive routing;
  - idle review, Save to memory and the other delegated writes;
  - Memory Space placement, Document archive and metadata maintenance;
  - evidence answers and reconcile.
- The reporter's USER.md was full, so every profile write needed compaction and failed. Reads, and writes that fit, start no child, which is why they kept working.

## Fix

`startSubagent` in `src/host/subagent-start.ts` starts each child through whichever API the running DSH offers:
- **`startActivation`**, where DSH has it, with `delivery: 'caller'`.
  - The result comes back to Mnemon, as a run's did.
  - DSH sends the conversation no completion notice and adds no "report back with send_message" guidance to the child's prompt.
- An activation's signal covers only startup, so an abort after startup disposes the child. That is how an aborted run stopped.
- The live child from DSH's Agent registry stands in for the run's `localAgent`, once it is checked against its parent. The idle-review tool guard and the failure detail read it.
- **`start`**, unchanged, where DSH has only `start`. DSH 0.2.0 and 0.1.7 therefore behave exactly as before. No published DSH has both.
- With neither API, the error says so instead of a `TypeError`.
- If anything fails after the start and before the run is handed back, the child is disposed instead of left running.
- An activation reports its child only by id. The idle-review guard therefore takes the child it attached when DSH published it, by that id, when the run carries no `localAgent`.

## Method

`pnpm e2e:serve --profile-compaction` starts the real WebUI with a disposable profile whose USER.md holds 100 bytes. `MNEMON_E2E_DSH` points it at the DSH release under test. Three messages in a Mnemon E2E conversation each save one user preference:
1. `记住：回答尽量简洁，不要冗长的开场白。` uses 48 bytes;
2. `记住：回答使用简体中文。` brings it to 79 of 100 bytes;
3. `记住：汇报时先列出阻塞项。` does not fit. The Host starts the compaction child, which merges the two saved entries, and then adds the new one.

Only the model's choices are scripted; the tool, the child, its result tool and the Runtime writes are real. Each run then opens the third call in the conversation's **轨迹** (trajectory) tab, and the Runtime Memory page.

## Before and after

| | DSH 0.2.0-rc.2 | DSH 0.2.1-alpha.2 |
|---|---|---|
| main | saved, after local compaction | **fails** with `Error: this.subagents.start is not a function`; USER.md keeps its two entries (79 B) |
| Fix | saved, after local compaction | saved, after local compaction; USER.md holds the merged entry and the new one (67 B) |

Main on DSH 0.2.1-alpha.2, the reported failure:

![Trajectory on main: the third mnemon_runtime_memory call returns error, Error: this.subagents.start is not a function](./before-trajectory.jpg)

| The fix on DSH 0.2.1-alpha.2 | USER.md afterwards |
|---|---|
| ![Trajectory with the fix: the third call succeeds with maintenance kind local-compaction from the spawn provider](./after-trajectory.jpg) | ![Runtime Memory: two USER.md entries, 67 B of 100 B](./after-runtime.jpg) |

On DSH 0.2.0-rc.2 the fix starts the child through `start`, exactly as main does:

![Trajectory with the fix on DSH 0.2.0-rc.2: the third call succeeds after local compaction](./after-020-trajectory.jpg)

No run logged a browser console error. Here, as for all Runtime maintenance, the compaction child belongs to a short-lived task Agent, so its notice could not reach the conversation either way. The real-host test `runtime-compaction-host` below starts the child under the conversation itself; on 0.2.1-alpha.2 the conversation receives no `subagent-settled` notice.

## Real-host tests

The repository's tests that build a real DSH host in process also ran against both published releases. [`harness/adapt-host-specs.mjs`](./harness/adapt-host-specs.mjs) writes copies of them outside the repository, and [`harness/installed-dsh.vitest.config.mjs`](./harness/installed-dsh.vitest.config.mjs) runs the copies with every `@deepseek-ai/*` package resolved inside one installation. The development baseline itself stays DSH 0.1.7-rc.2.

```sh
node docs/pr-assets/issue-356-subagent-activation/harness/adapt-host-specs.mjs <specs>
DSH_HOST_ROOT=<prefix>/lib/node_modules/@deepseek-ai/dsh DSH_VERSION=0.2.1-alpha.2 MNEMON_HOST_SPECS=<specs> \
  pnpm exec vitest run --config docs/pr-assets/issue-356-subagent-activation/harness/installed-dsh.vitest.config.mjs
```

| Real-host test file (17 tests) | main on 0.2.1-alpha.2 | Fix on 0.2.1-alpha.2 | Fix on 0.2.0-rc.2 |
|---|---|---|---|
| `runtime-compaction-host` (new): a full USER.md compacted by a spawn child | 1 fails | 1 passes | 1 passes |
| `review-user-turn-host`: fork and spawn reviews with the #327 recovery | 4 fail | 4 pass | 4 pass |
| `review-evidence-host`: fork and spawn reviews, native and Code Mode, own-scope tools refused | 4 fail | 4 pass | 4 pass |
| `agent-team-review-host`: the Team review matrix | 1 fails | 1 passes | 1 passes |
| `async-subagent-host`: continuable children calling Mnemon recall | 2 pass | 2 pass | 2 pass |
| `subagent-token-usage-host` | 5 pass | 5 pass | 5 pass |

On main all 10 failures are `this.subagents.start is not a function`. The copies differ from the committed specs in four ways, each forced by DSH 0.2.1-alpha.2; none changes Mnemon's code:
1. its subagent runtime needs the working-directory service, which needs `fs`. A DSH profile loads both; these hand-wired compositions now load them too;
2. tools mode `both` is gone, so the Code Mode cases keep the root `native` and still present children as Code Mode;
3. in Code Mode it refuses a filtered tool inside `run_code` before dispatch. The Team case therefore sees a failed `run_code` call instead of a failed `spawn_teammate` call. The Team tool never runs on either release;
4. two specs call the removed APIs themselves. `review-evidence-host` wraps the start call to hold the child back until its first tool attempt, and wraps `startActivation` the same way where `start` is gone. `async-subagent-host` starts its own continuable child, with `startActivation` and parent delivery where `startContinuable` is gone. This is the tests' own scaffolding; Mnemon's start in both is `startSubagent`.

## Automated checks

- `tests/subagent-start.spec.ts` covers:
  - a caller-delivered activation with the request DSH expects, preferred when a DSH has both APIs;
  - the registry child, used only when the parent owns it, and kept after the activation releases it;
  - an abort after startup and one during startup, no dispose after the child settles, and a dispose when the run cannot be handed back;
  - `start` unchanged on DSH 0.2.0, and the error when neither API exists.
- `tests/subagent.spec.ts` covers USER.md compaction, a fork review with its tool guard, and a failed child's bounded error, each through a DSH that has only activations. As on 0.2.1-alpha.2, the fake releases the child before its result settles. All three fail on main with the reported error.
- `tests/review-tools.spec.ts` takes the guarded child by the run's id, and refuses a published child with another id. It fails on main.
- `tests/runtime-compaction-host.spec.ts` is the new real-host test. CI runs it on the pinned DSH 0.1.7-rc.2.
- `tests/dsh-host-compatibility.spec.ts` adds 0.2.1-alpha.2; the peer ranges already admit it, prereleases included.

## Limits

- The model is scripted, so the merged entry is the fixture's.
- On 0.2.1-alpha.2 only USER.md compaction, fork and spawn idle review, and the Team review ran. Delegated writes such as `mnemon_remember`, Save to memory, placement, Document archive, metadata maintenance, evidence answers, archive routing and reconcile start the same way, but were not run there.
- CI runs the pinned DSH 0.1.7-rc.2, so it reaches the activation path only through fakes.
- On 0.2.1-alpha.2 every local child is continuable, Mnemon's included. A child started under the conversation, such as a delegated write or an idle review, is listed among its subagents.
  - The conversation's model, given the child's id, or a prompt from the WebUI can resume it later. That later turn runs outside Mnemon's delegation: no review guard, no result request, and its completion notice reaches the conversation.
  - It gains no tool the conversation lacks. On 0.2.0 such a child could not be resumed.
  - Maintenance children (compaction, archive routing, reconcile) belong to a short-lived task Agent and go with it.
- While it runs, such a child also takes one of the conversation's subagent slots (`maxActiveSubagents`, 8 by default). With all of them taken, a memory task fails with DSH's `subagent limit reached`. One-shot runs on 0.2.0 took no slot.
- DSH 0.2.1-alpha.2 is an alpha, and its activation API may change again before a release candidate. A DSH that has neither API then gets the explicit error instead of a `TypeError`.
