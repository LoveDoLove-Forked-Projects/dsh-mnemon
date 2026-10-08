# Save to memory after editing the candidate — issue #342

[简体中文](./README.zh-CN.md) | [Issue #342](https://github.com/omdsh-dev/dsh-mnemon/issues/342) | [Verification record](./verification.json)

Save to memory marks its candidate as editable and, once a receipt is shown, asks for an edit before sending again. On main, a candidate edited after the reply had been saved once failed with `idempotency key was already used for different content`, and nothing was written. With the fix, the edited text reaches the task Agent and is saved as well.

Baseline: main `2296898d` (dsh-mnemon 0.5.24). Fix: `aaaa3ffa`. The runs use macOS 15.6 arm64, Node 24.19.0, DSH 0.2.0-rc.2 (npm `latest` and `next`) in an isolated prefix, and Mnemon CLI 0.2.10.

## Method

`pnpm e2e:serve --save-action` starts the real WebUI with a disposable profile, data directory and loopback model. Only the model's decisions are scripted: every conversation turn receives one reply worth saving, and the task Agent reads the Memory Space directory, creates a Native space when there is none, writes the candidate it was given and reports the Provider's receipt. The dialog, the Host tools and the Native writes are real. The same script was run against main and against the fix:

1. send one message; the reply is the fixture's release checklist;
2. select **Save to memory** under it, cut the candidate to its first sentence and send it to the task Agent;
3. edit the answered candidate and send it again;
4. read the Native store with `mnemon --readonly recall --basic`.

## Before and after

The first submission is saved on both builds:

![The first submission saved in Release notes](./first-receipt.jpg)

| Sending the edited candidate on main | With the fix |
|---|---|
| ![Failed: idempotency key was already used for different content](./before-edited-again.jpg) | ![Saved in Release notes, quoting the edited candidate](./after-edited-again.jpg) |

| | Main | Fix |
|---|---|---|
| Second receipt | **Failed**, `idempotency key was already used for different content` | **Saved**, the edited candidate |
| Writes by the task Agent | 1 | 2 |
| Native store afterwards | the first sentence only | the first sentence and the edited candidate |
| Browser console errors | none | none |

## Cause and fix

The dialog sends the reply's message id as the idempotency key of its request. The Host kept one replay entry per scope and key, and refused the key when the text differed. The dialog itself already treats an edited candidate as a new request: a receipt answers one text, and the send button returns once the text changes. The Host disagreed only after the first submission succeeded, since a failed submission removes its replay entry.

The replay key now also carries a SHA-256 digest of the text. Sending the same text again, for example after reopening the dialog, still returns the first receipt without starting a second task Agent; edited text is a request of its own. The replay guard keeps its bound of 256 entries and still drops an entry when its request fails. Submissions without a key, such as **Save to memory** on the Memory Spaces page, are unchanged.

## Automated checks

- `tests/lifecycle.spec.ts`, *treats an edited candidate for the same message as a request of its own*: the edited candidate is delegated as a second write, and sending the first text again replays its result without another write. On main the test fails with the reported error.
- The existing replay test still checks that two concurrent submissions of the same text start one task Agent.

## Limits

The task Agent is scripted, so the receipts show the fixture's summaries rather than a real model's judgment. The run uses Chinese UI copy only; the change is in the Host and applies to every language.
