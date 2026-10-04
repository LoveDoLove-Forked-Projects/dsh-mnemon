# Git repository sync

## Aim

A second, off-machine home for the memory that matters most: runtime memory (the user profile
`USER.md`, `MEMORY.md` and `runtime/memories.json`), project Documents, and Mnemon Native Memory
Spaces. The user names a Git repository and a branch; dsh-mnemon writes the same payload the ZIP
backup already produces, as readable files, commits it, and pushes it. Another machine can pull the
branch and restore the payload into its own storage root.

The ZIP backup stays the offline, single-file path. Git sync is the continuous one: history, review
and restore come from Git itself.

## Reference

`dsh-config-manager` (`docs/spec/sync-channel-v1.md`) establishes the shape this plan follows:

- a Git channel that stores loose files under a remote subdirectory, plus `manifest.json`;
- "a blob that cannot be read is a hard failure, never an empty section" - a silent downgrade shows
  a successful sync while the user's data is gone;
- credentials are read per network operation and never persisted into the payload or logged;
- the remote keeps a bounded history.

It also shows the cost of the parts we deliberately do not copy: snapshot directories with a
retention window, encrypted snapshots, WebDAV, and cross-version compatibility registries. Git
history already provides retention, review and restore, so the Git channel does not need them.

## Decisions

1. **The payload is the existing Mnemon Pack payload.** `MnemonPackManager.exportPack('full')`
   already collects `payload/runtime/memories.json`, `payload/runtime/USER.md`,
   `payload/runtime/MEMORY.md`, `payload/documents/**`, `payload/data/.dsh-memory-bodies.json` and
   `payload/data/<bodyId>/mnemon.db`, with a `manifest.json` and a SHA-256 `checksums.json`.
   Sync unpacks that archive into the mirror and commits the files; pull re-zips the mirror and runs
   the existing `importPack` validation and merge path. One collector, one validator, one importer -
   no second format to keep in step, and every size, path and integrity rule the ZIP already
   enforces applies unchanged.
2. **Readable files on the remote, not a binary.** `USER.md` and `MEMORY.md` are Markdown, the
   Document and memory-space files are Markdown and SQLite. A user can read their profile on GitHub
   and see what changed in a diff.
3. **The remote is the current state, at a stable path.** Files live at `<subdir>/` on the chosen
   branch (default subdir `mnemon/`, default branch `mnemon-sync`). Retention is Git history, not a
   second snapshot tree.
4. **Local mirror, not the storage root.** Push and pull work in `<storageRoot>/state/sync/git`, a
   scratch clone. The storage root is never made a Git work tree, and `state/` is not part of any
   pack component, so the mirror can never sync itself.
5. **Credentials stay out of the payload, the config file and the logs.** The token is read per
   network operation from `MNEMON_SYNC_GIT_TOKEN`, or from `<storageRoot>/state/sync-git.json`
   (`0600`, the same treatment `state/memory-providers.json` already gets for Provider keys). RPC
   answers describe a token (`hasToken`) and never return its value. Failure messages are masked.
6. **Git runs through the Host's existing runner.** `src/host/process.ts`'s `runProcess` (`spawn`
   with an argument array, `shell: false`, a timeout, an output cap) is the only process entry. No
   new dependency, no `simple-git`, no shell string interpolation.
7. **Push is an explicit, confirmed action.** Nothing in this feature pushes on a timer, and a push
   that would create a commit without remote credentials still commits locally and reports that the
   push was skipped. Pull previews before it writes: `preview` returns what the remote holds and
   what would change; `pull` requires `confirmed: true` and merges through the pack importer.
8. **Read-only deployments stay read-only.** Both directions require `writeEnabled`; a
   `writeEnabled: false` profile refuses push and pull with the same message the pack import uses.
9. **The payload is always the whole pack; scope is a pull-time filter.** Every push exports
   `scope: 'full'`, so the branch is a complete, restorable state and never a partial one that
   looks complete. `pull` accepts an optional one-off `components` list to import only some of it;
   the setting is deliberately not persisted, because a remembered filter is how a machine ends up
   with half its memory restored and no error to show for it.

## Remote layout

```text
<branch>
└─ <subdir>/                     # default "mnemon/"
   ├─ manifest.json              # Mnemon Pack manifest + sync extension
   ├─ checksums.json             # sha256 per payload file, as in the ZIP
   └─ payload/
      ├─ runtime/{memories.json,USER.md,MEMORY.md}
      ├─ documents/{index.json,active/<id>.md,archived/<id>.md}
      └─ data/{.dsh-memory-bodies.json,<bodyId>/mnemon.db}
```

`manifest.json` is the pack manifest verbatim (`format`, `version`, `scope`, `exportedAt`,
`source`, `components`, `summary`) plus one extension:

```json
{ "sync": { "channel": "git", "branch": "mnemon-sync", "subdir": "mnemon/", "pushedAt": "..." } }
```

A reader that does not know `sync` still reads a valid Mnemon Pack manifest, and a payload without
the extension is still accepted on pull.

## Local layout

```text
<storageRoot>/state/sync-git.json     # configuration (0600 when it holds a token)
<storageRoot>/state/sync/git/         # mirror: a Git work tree, never inside a pack component
```

The mirror is disposable: deleting it costs a fetch, never data.

## Configuration

Stored in `state/sync-git.json`, edited from the plugin's Storage group. It is not part of
`Config`: the value is per storage root, may hold a secret, and must not travel through settings
RPC or a profile patch.

| Field | Default | Notes |
|---|---|---|
| `repoUrl` | - | `https://`, `ssh://`, `git@host:path` or an absolute local path; the token is never embedded in it |
| `branch` | `mnemon-sync` | validated as a Git branch name |
| `subdir` | `mnemon/` | relative, no `..`, no absolute path |
| `token` | - | optional; HTTPS remotes only; never returned by RPC |
| `authorName` / `authorEmail` | `dsh-mnemon sync` / `mnemon@localhost` | commit identity for the sync branch |

## RPC surface

New channel `MNEMON_SYNC_CHANNEL = '/dsh-mnemon-sync'`, handler `createSyncHandler`:

| Endpoint | Payload | Answer |
|---|---|---|
| `status` | - | mirror path, configured repo/branch/subdir, `hasToken`, remote reachability, last commit |
| `configure` | `{ repoUrl?, branch?, subdir?, token?, authorName?, authorEmail? }` (`token: null` clears it) | saved view, token replaced by `hasToken` |
| `push` | `{ message?, confirmed: true }` | commit id, file/byte summary, `pushed` flag and reason when the push was skipped |
| `preview` | `{ }` | remote manifest summary, component sizes, which components differ from local |
| `pull` | `{ confirmed: true, components? }` | import result (components, summary) |

All three writing endpoints require `writeEnabled`, and `push`/`pull` additionally require
`confirmed: true` so the page cannot publish or import by accident; `status` and `preview` stay
readable while the Host is read-only. The handler is projected through `MnemonRemoteService` with
the other management handlers, so `remoteAccess: read-only` still denies it remotely.

## UI

A **Git sync** group in the plugin's Storage section, next to backup and migration. One status
line reports whether a repository is set, whether git is present, what the remote branch holds and
whether a token is saved. Three buttons carry the actions: `Configure` (opens the form),
`Check remote` (previews the remote payload and the component/file differences) and `Push`. The
form holds six fields - repository URL, branch, remote directory, token, author name, author
email - and the token field shows `saved` rather than the value, with an explicit clear
checkbox. `Pull and merge` appears only after a preview, with the same preview-then-confirm shape
the ZIP import already uses. Every string goes into both dictionaries in `src/client/locales.ts`.

## Failure semantics

| Condition | Behaviour |
|---|---|
| no repository configured | push/pull answer `bad-request` with a configuration message; no process runs |
| git missing or older than required | `status` reports it; push and pull refuse |
| remote branch missing | pull reports an empty remote; push creates the branch |
| manifest or checksum mismatch on pull | hard failure; nothing is imported |
| remote unreachable, no token | push commits locally and reports the skipped push; nothing is lost |
| concurrent export/import | the pack manager's exclusive storage lock serialises them |

## Tests

Landed:

- `tests/sync-config.spec.ts`: read/write, `0600`, redaction, branch/subdir/URL validation, clear-token.
- `tests/git-sync.spec.ts`: a real `git` in a temporary bare repository (skipped when git is
  absent) covering init, push, second-machine pull, manifest/checksum rejection, subdir and branch
  validation, and the "no silent empty payload" rule.
- `tests/sync-rpc.spec.ts`: the channel over the real runtime graph - a push from one machine and a
  preview plus merge on a second machine, the unconfirmed and unconfigured refusals, an unreachable
  remote reported without the token, and the read-only gate.
- `tests/rpc.spec.ts`: the channel's endpoint validation against the mocked graph, including
  `writeEnabled`, the confirmation flags, the component filter and token redaction.
- `tests/client-api.spec.ts`: the five client methods, their channel, and the automatic
  `confirmed: true` on push and pull.
- `tests/remote-rpc.spec.ts`: the `denied` path and the trusted-host allow path of the `sync`
  remote method.

## Documentation

Landed:

- `docs/{en,zh-CN}/guides/operations.md`: a Git sync section under backup and restore, with the
  repository layout, the token rules and a restore drill.
- `docs/{en,zh-CN}/reference/interfaces.md`: the channel, its five endpoints and the remote method.
- `docs/{en,zh-CN}/reference/storage-model.md`: `state/sync-git.json` and `state/sync/git`.
- `README.md` and `README.zh-CN.md`: one bullet each, next to the storage bullet.
- `docs/pr-assets/git-sync/{README.md,README.zh-CN.md}`: what the PR adds and the frozen contract it
  was reviewed against.
- `.changeset/git-sync.md`: minor bump for `dsh-mnemon`.

## Out of scope

- Automatic or scheduled pushes (the config-manager autosync scheduler is a separate decision).
- Encrypted snapshots, WebDAV, snapshot directories with a retention window.
- Pushing anything other than memory: no DSH configuration, no credentials, no session history.
- Making the storage root itself a Git repository.

## Open questions for maintainers

1. **Credential home.** `state/sync-git.json` at `0600` follows the Provider-credential precedent
   in this repository. The DSH-native alternative is `@deepseek-ai/dsh-credentials` behind
   `inject: ['credentials']`, which is what `dsh-config-manager` uses. We chose the local file to
   avoid a new DSH service dependency in this PR; the maintainer may prefer the credentials service.
2. **Remote history.** This plan uses the branch's Git history as retention. A bounded snapshot
   directory layout is only worth adding if a maintainer wants non-Git-readable retention.
3. **New capability gate.** `CONTRIBUTING.md` requires an Issue and maintainer approval before
   implementing a new capability. This plan is the proposal; the Issue link goes into the PR
   description.
