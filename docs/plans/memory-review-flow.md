# Seeing every machine's backup, and merging through review

## Aim

Two gaps in the Git sync channel as it stands:

1. **A backup you cannot look at is a backup you do not trust.** The branch holds one commit per
   push, each with a manifest, a machine identity and the runtime entries it carried, but the page
   shows only the *tip*: one `lastCommit`, one component summary, one "Push" button. The history -
   which machine published what, when, and which memories came with it - is invisible.
2. **A merge that happens in one click is not a review.** `Push` folds the branch into this machine
   and re-publishes the result before anyone has seen what it brought. Memory reconciliation exists,
   but it reads only the local runtime memory: it cannot see the branch, it cannot be told what the
   user wants, and an accepted plan is applied whole.

This plan closes both: the branch becomes **readable** (backups, per-machine memory, an entry-level
diff), and the merge becomes a **review** the user drives - look at the difference, read what the
model makes of it, either accept some of it or say what should happen instead, let the model plan
again, and apply the parts that are chosen.

## Decisions

1. **The branch is read, never written, by the new endpoints.** `backups` and `diff` run `git log`
   and `git show` inside the existing mirror and touch neither the work tree nor the remote. A push
   still merges before it publishes; that ordering is unchanged, and these endpoints are what make
   the merge reviewable *before* it is published.

2. **A backup is a commit on the sync branch that carries the payload.** Listing is
   `git log --max-count=<n> -- <subdir>`, newest first, each entry read back through
   `git show <commit>:<subdir>manifest.json`. The manifest is the only place that says which machine
   published it and what it held, so the list is built from it rather than from commit metadata
   alone: the commit message is free text, the manifest is the contract.

3. **`git show`, not a work-tree checkout.** Reading an older commit by checking it out would move
   the mirror's work tree and index, and the push path depends on `git status --porcelain` being
   empty to decide whether a commit is needed. `git show <rev>:<path>` is read-only, so a backup can
   be inspected while a push is in flight. Only the JSON files a comparison needs are read
   (`manifest.json`, `payload/runtime/memories.json`, `payload/runtime/tombstones.json`,
   `payload/documents/index.json`); the SQLite payload of a Memory Space is never decoded from a
   pipe.

4. **The diff is stated in entries, not in bytes.** `diff` compares this machine's runtime entries
   with the ones the branch tip carries, and answers with the entries only this machine holds, the
   entries only the branch holds, how many both hold, and the removals the branch recorded that this
   machine has not applied. A byte-level file diff already exists in `preview`; what a user cannot
   get today is "which of my memories is not on the branch, and which of the branch's is not here".

5. **Reconciliation reads the branch too.** `MnemonReconcileEvidence` gains the remote side, and the
   prompt names it: the entries the branch holds that this machine does not. The existing behaviour
   is preserved exactly when there is no repository, no mirror, or no payload - the evidence is
   simply local, and the review is what it was.

6. **The user's words are part of the next plan.** `reconcile` accepts `guidance` and folds in the
   opinions already recorded on the pending reviews, so the loop the user asked for works:
   read the difference, read the model's opinion, either accept it or write what should happen
   instead, run 整理记忆 again, and the new plan answers what was written. Nothing is applied by
   running it.

7. **An accepted review can be applied in part.** `apply` accepts `operations`, a list of the
   operation indexes to carry out. Omitted means all of them, which is what an existing caller
   sends. The list is validated against the entry (an index outside the plan is refused rather than
   silently dropped), the rest stay in the entry, and the review stays `accepted` so the remaining
   operations can be applied later.

8. **Nothing new is written outside `state/` and the review ledger.** No new file, no new directory,
   no new credential path. The backup list and the diff are answers, not state.

## Wire surface

New `MNEMON_SYNC_CHANNEL` endpoints (both read-only; they need neither `writeEnabled` nor
`confirmed`):

| Endpoint | Payload | Answer |
|---|---|---|
| `backups` | `{ limit?: number }` | the commits on the branch that carry the payload, newest first, each with its machine, time, message and component summary |
| `diff` | - | this machine against the branch tip: entries only here, entries only there, shared count, and the branch's unapplied removals |

`MNEMON_REVIEW_CHANNEL` gains two optional payload fields:

| Endpoint | Field | Meaning |
|---|---|---|
| `reconcile` | `guidance?: string` | what the user wants the plan to do, read by the model alongside the pending opinions |
| `apply` | `operations?: number[]` | which operations of an accepted review to carry out; omitted means all |

## Types

```ts
interface MnemonSyncBackup {
  commit: string
  message: string
  committedAt: string
  machine?: MnemonMachineIdentity
  pushedAt?: string
  components: MnemonPackComponentSummary[]
}

interface MnemonSyncBackupList {
  repoUrl: string
  branch: string
  subdir: string
  commits: MnemonSyncBackup[]
  /** Whether older commits exist beyond the requested window. */
  truncated: boolean
}

interface MnemonSyncDiffEntry {
  target: 'memory' | 'user'
  content: string
  importance: 'critical' | 'normal' | 'low'
  origin?: MnemonEntryOrigin
}

interface MnemonSyncDiff {
  repoUrl: string; branch: string; subdir: string; commit: string
  machine?: MnemonMachineIdentity
  pushedAt?: string
  localExportAt: string
  local: MnemonSyncDiffSide
  remote: MnemonSyncDiffSide
  localOnly: MnemonSyncDiffEntry[]
  remoteOnly: MnemonSyncDiffEntry[]
  shared: number
  /** Removals the branch recorded that this machine has not applied. */
  remoteTombstones: MnemonTombstone[]
}
```

## UI

**Git sync** gains a third action, `Backups`: it opens a list of the commits on the branch - time,
machine, message, component counts - and each row expands to show what that backup held, with a
button that loads its runtime entries into the same panel the diff uses. `Check remote` keeps its
byte-level preview and gains the entry-level difference beneath it: two short lists ("only here",
"only on the branch") with the target, importance and origin of each entry, and a count of what both
sides hold.

**Memory reconciliation** gains a guidance field above the button: `整理记忆` sends whatever is in it,
and the answer says whether the model had guidance to follow. A pending review lists its operations
with a checkbox each; `执行` applies the checked ones and reports how many were carried out and how
many are left. The opinions list already shows what was written and by whom.

## Tests

- `tests/git-sync.spec.ts`: two machines over a real bare repository - `backups` lists both pushes
  newest first with the right machine and counts, is empty on an unpublished branch, and `diff`
  reports the second machine's entries as `remoteOnly` on the first machine before any push, then as
  `shared` after one.
- `tests/sync-rpc.spec.ts`: the two new endpoints over the real runtime graph, their read-only
  availability, and the payload validation.
- `tests/rpc-review.spec.ts`: `reconcile` with guidance, and `apply` with a selection - a subset
  applied, an out-of-range index refused, and the entry keeping the rest.
- `tests/reconcile.spec.ts`: the prompt with a remote side and with guidance.
- `tests/client-api.spec.ts`, `tests/client-storage-review.spec.tsx`: the new client calls and the
  two panels.

## Out of scope

- Restoring one backup over the current state (that is `pull`, and it is already confirmed).
- Per-operation accept/reject as a stored state: a selection is applied, not remembered.
- Any change to what a push publishes, or to the pack format.
