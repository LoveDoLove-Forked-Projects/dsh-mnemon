# Git repository sync

[简体中文](./README.zh-CN.md)

dsh-mnemon can publish its memory to a Git repository and restore it on another machine. The capability keeps the offline ZIP path as it is and adds a continuous one: the same Mnemon Pack payload, written as readable files, committed on a branch the user names. This record documents the frozen contract and the acceptance run behind it.

## What the channel adds

- Channel `/dsh-mnemon-sync` with five endpoints: `status`, `configure`, `push`, `preview` and `pull`.
- `push` exports the complete pack, commits it in the local mirror and pushes the branch. It requires `confirmed: true`; nothing pushes on a timer.
- `pull` reads the remote manifest and its SHA-256 inventory, previews the differences and, after confirmation, merges through the same importer Import ZIP uses. A manifest or checksum mismatch fails hard and imports nothing.
- The payload is the existing Mnemon Pack payload: one collector, one validator, one importer. The sync extension on `manifest.json` records the channel, branch, directory and push time, and a reader that does not know sync still reads a valid Mnemon Pack manifest.
- The payload is always a full Mnemon Pack: runtime, documents and memory-spaces, with the user profile inside runtime. A pack manifest's `scope` is `full` or exactly one component, so a persistent component selection cannot be represented and none is stored. Component filtering is a one-off, optional `components` parameter on pull.
- Both directions require `writeEnabled`; a read-only deployment refuses push and pull with the same message Import ZIP uses.
- The token stays out of the payload, the configuration file and the logs. Status and configuration responses describe it (`hasToken`) and never return its value, and a failure message is masked.

## Remote layout

Files sit under `<subdir>/` on the configured branch, `mnemon/` on `mnemon-sync` by default:

```text
<branch>:<subdir>/
+-- manifest.json       # Mnemon Pack manifest plus the sync extension
+-- checksums.json      # SHA-256 per payload file, as in the ZIP
+-- payload/
    +-- runtime/{memories.json,USER.md,MEMORY.md}
    +-- documents/{index.json,active/<id>.md,archived/<id>.md}
    +-- data/{.dsh-memory-bodies.json,<bodyId>/mnemon.db}
```

The extension is `{"sync": {"channel": "git", "branch": "mnemon-sync", "subdir": "mnemon/", "pushedAt": "..."}}`. A payload without it is still accepted on pull. The remote holds the current state at a stable path; retention is the branch's own Git history.

## Configuration

Configuration lives in `<storageRoot>/state/sync-git.json` with mode `0600`. It is not part of Config, it belongs to one storage root, and it never travels through a settings RPC or a profile patch.

| Field | Default | Notes |
|---|---|---|
| `repoUrl` | - | `https://`, `ssh://`, `git@host:path` or an absolute local path; the token is never embedded in it |
| `branch` | `mnemon-sync` | validated as a Git branch name |
| `subdir` | `mnemon/` | relative, no `..`, no absolute path |
| `token` | - | optional, HTTPS remotes only; `MNEMON_SYNC_GIT_TOKEN` overrides it and it is never returned by RPC |
| `authorName` | `dsh-mnemon sync` | commit identity for the sync branch |
| `authorEmail` | `mnemon@localhost` | commit identity for the sync branch |

There is no `components` field. Mnemon Pack validates a manifest `scope` as `full` or exactly one component, so an arbitrary subset has no representation in the format and the sync payload is always the full pack; the only component filter is the optional one-off `components` parameter on pull. The mirror under `<storageRoot>/state/sync/git` is a disposable Git work tree; the storage root is never made a Git work tree, and `state/` is not part of any pack component, so the mirror cannot sync itself. Git runs through the Host's existing `runProcess` with an argument array and `shell: false`; no new dependency and no shell string interpolation.

## Verification

This section is the record of the acceptance run, not a plan. It was run on Windows 11 with Node 26.0.0 and Git 2.55.0.windows.5, against the revision the pull request carries. The harness is `scripts/verify-sync-git.mjs`, run with `pnpm run e2e:sync`; it builds two disposable storage roots, installs the plugin into two disposable `DSH_HOME` profiles, starts two real `dsh web` instances, exchanges each launch token for its browser cookie, and drives `/dsh-mnemon-sync` and `/dsh-mnemon-write` over loopback HTTP with the same envelopes the browser sends. The only stand-in is the model endpoint, which never receives a request.

```sh
pnpm run build && pnpm --workspace-concurrency=4 -r build
pnpm run e2e:sync
```

The run reported:

```text
1. One instance publishes the whole pack to a real repository
  ok   a fresh storage root reports Git and an unconfigured remote
  ok   the configuration path lives inside the storage root
  ok   configure echoes the effective settings without a token
  ok   the working memory accepted one entry through the write channel
  ok   the configured remote is reachable and still has no branch
  ok   an unconfirmed push is refused
  ok   push committed and published one pack
  ok   the pack holds every component
  ok   the branch holds the manifest, the checksums and the payload
  ok   the published working memory carries the entry
  ok   the manifest declares the pack and its channel
  ok   the mirror lives under the storage root and not at its top level
  ok   a repeated push publishes nothing new
  ok   the branch holds exactly one commit

2. A second instance previews and imports the same branch
  ok   preview reports the published commit and its manifest
  ok   preview reports the working memory as changed against an empty root
  ok   preview imported nothing
  ok   pull imported the published commit through the pack importer
  ok   the second machine now holds the working memory and the profile

3. A tampered payload fails hard and imports nothing
  ok   the checksum failure names the changed file
  ok   the tampered payload was not imported

4. A token never reaches a response, a file, or the mirror
  ok   configure answers with hasToken only
  ok   status answers with hasToken only
  ok   the token is stored in the 0600 state file
  ok   an unreachable remote is reported without leaking the token
  ok   a failed push never echoes the token
  ok   the token never reaches the mirror

5. Read-only work still answers while every write stays gated
  ok   an unknown endpoint is a bad request
  ok   both instances shut down on the polite signal

Git sync end-to-end verification passed.
```

The same channel through the real WebUI, rather than the harness: a real `dsh web` instance served the storage page, the repository was configured through the form, one entry was written through the normal write path, and the branch was published with the button. Both images come from that session, and neither shows a credential or a personal path.

| Save and push from the storage page | Reading the remote back before importing anything |
|---|---|
| ![The repository sync row with the published commit and its notice](./sync-pushed-zh.png) | ![The preview line naming the remote commit, its components and the file deltas](./sync-preview-zh.png) |

The page reported `已推送 0df94229（7 个文件，2.0 KB）。` after the push, and the branch held `mnemon/payload/runtime/USER.md` with the entry that had been written a moment earlier. `检查远端` then reported `远端 0df94229 · 3 个组件 · 1.9 KB`, `0/3 个组件与本地不同` and `新增 0 · 丢失 0 · 不同 1` without importing anything: the merge happens only after `拉取并合并`. The fixture runs in Chinese, which is why the copy in the images is Chinese.

What the run establishes, beyond the unit suites:

- One real instance wrote the working memory and the user profile through `/dsh-mnemon-write`, pushed through `/dsh-mnemon-sync/push`, and the bare repository then held `mnemon/manifest.json`, `mnemon/checksums.json` and `mnemon/payload/runtime/{memories.json,USER.md,MEMORY.md}` on `mnemon-sync`, with the entry readable in `git show mnemon-sync:mnemon/payload/runtime/MEMORY.md`.
- A second instance with its own `DSH_HOME` and storage root previewed the branch, imported it after confirmation and then held both the working memory entry and the profile on disk, so the branch really is portable between machines.
- Repeating the same push reported `committed: false`, `pushed: false` and `the branch already holds this payload`, and the branch stayed at one commit. This is the case a fixed test clock used to hide; the acceptance run uses the real clock.
- Tampering with one payload file made both preview and pull fail with `the remote Mnemon payload failed its checksum: payload/runtime/MEMORY.md` and left the second machine's files untouched.
- The token appeared only in the `0600` state file. Responses, failure messages and the mirror's Git configuration never contained it.
- Unconfirmed push and pull were refused with `Publishing the sync branch requires confirmation` and `Importing the remote Mnemon payload requires confirmation`, and an unknown endpoint returned `bad-request` with `unknown sync endpoint: nope`.

Two behaviors the run recorded that are not defects, and are worth knowing before reading a real remote:

- A fresh storage root still exports an empty `documents/index.json` and an empty `payload/data/.dsh-memory-bodies.json`, so those two components can report `changed: false` against an empty root while runtime reports `changed: true`. Preview compares bytes, and two empty indexes are the same bytes.
- The importer rebuilds `memories.json` with its own key order, so a machine that pulled a branch and then pushes it again can produce a commit whose bytes differ while its content does not. The payload comparison ignores only the two manifest timestamps, not field order.

The automated coverage runs in `pnpm test`: `tests/sync-config.spec.ts` for reading, writing, mode `0600`, redaction and validation; `tests/git-sync.spec.ts` for init, push, a second-machine pull, manifest and checksum rejection, subdir and branch validation, the no-silent-empty-payload case and the repeat-push case on a moving clock, skipped when Git is absent; and `tests/sync-rpc.spec.ts` for endpoint validation, the `writeEnabled` gate, token redaction, error masking and the denied remote projection.

## Limits

- No automatic or scheduled pushes. Push is a user action and always asks first.
- Encrypted snapshots, WebDAV and snapshot directories with a retention window are out of scope.
- Only memory travels: the payload carries no DSH configuration, no credentials and no session history.
- A push without remote credentials still commits locally and reports that the push was skipped; the branch reaches the remote on the next push with credentials.
- Credentials are read from the environment or from `state/sync-git.json` at mode `0600`, following the Provider-credential precedent. Moving them to a DSH-native credential service is a maintainer decision recorded in the plan.
