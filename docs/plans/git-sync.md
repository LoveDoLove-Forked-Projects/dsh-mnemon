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
5. **Credentials stay out of the payload, the config file and the logs.** A credential is resolved
   per network operation, in this order: `MNEMON_SYNC_GIT_TOKEN`, the token in
   `<storageRoot>/state/sync-git.json` (`0600`, the same treatment
   `state/memory-providers.json` already gets for Provider keys), then the grant GitHub sign-in
   wrote into DSH's credentials store. RPC answers describe the credential (`hasToken`,
   `credentialSource`, `credentialLogin`) and never return its value. Failure messages are masked.
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
10. **GitHub sign-in is the primary credential, the token field is the fallback.** The form offers
    GitHub's OAuth **device flow**: the Host asks for a device code, the page shows the one-time
    code and the verification URL, and the Host polls at the interval GitHub returns until the
    browser step finishes. The access token is stored through DSH's credentials service
    (`@deepseek-ai/dsh-credentials`, record key `dsh-mnemon/github`, kind `grant`) and never
    reaches the browser. The service is read with `ctx.get('credentials')` rather than added to
    `inject`, so a profile that mounts no provider still loads the plugin and simply reports the
    login as unavailable; the manual token field stays as the path for those profiles. The scope is
    `repo`, and a grant can be deleted again from the same block. GitHub calls go through the
    environment's own `fetch`, so the Host's proxy dispatcher applies without a new dependency.
11. **Repository choice comes from the account, not from memory.** Once signed in, `github-repositories`
    lists the repositories the account may push to and `github-create` makes a new one (private by
    default, with an initial commit so the first push has a branch to publish to). Selecting one
    writes its clone URL into the same `repoUrl` field the manual form edits, so there is one
    configuration value and one validation path.

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
| `token` | - | optional fallback; HTTPS remotes only; never returned by RPC. GitHub sign-in is the preferred credential and is stored outside this file |
| `authorName` / `authorEmail` | `dsh-mnemon sync` / `mnemon@localhost` | commit identity for the sync branch |

## RPC surface

New channel `MNEMON_SYNC_CHANNEL = '/dsh-mnemon-sync'`, handler `createSyncHandler`:

| Endpoint | Payload | Answer |
|---|---|---|
| `status` | - | mirror path, configured repo/branch/subdir, `hasToken`, `credentialSource`, `credentialLogin`, remote reachability, last commit |
| `configure` | `{ repoUrl?, branch?, subdir?, token?, authorName?, authorEmail? }` (`token: null` clears it) | saved view, token replaced by `hasToken` |
| `push` | `{ message?, confirmed: true }` | commit id, file/byte summary, `pushed` flag and reason when the push was skipped |
| `preview` | `{ }` | remote manifest summary, component sizes, which components differ from local |
| `pull` | `{ confirmed: true, components? }` | import result (components, summary) |
| `github-status` | - | login availability, `signedIn`, the login name and scopes, and the live device flow when one is running |
| `github-start` | - | the device flow: user code, verification URL, expiry and poll interval |
| `github-poll` | - | `pending`, `success` (with the login), `expired`, `denied` or an error message |
| `github-cancel` | - | the flow is dropped; nothing is stored |
| `github-signout` | - | the stored grant is deleted |
| `github-repositories` | - | the login and the repositories it may push to |
| `github-create` | `{ name, private }` | the created repository, read back from GitHub |

All writing endpoints require `writeEnabled`, and `push`/`pull` additionally require
`confirmed: true` so the page cannot publish or import by accident; `status`, `preview`,
`github-status` and `github-repositories` stay readable while the Host is read-only. The handler is
projected through `MnemonRemoteService` with the other management handlers, so
`remoteAccess: read-only` still denies it remotely.

## UI

A **Git sync** group in the plugin's Storage section, next to backup and migration. One status
line reports whether a repository is set, whether git is present, what the remote branch holds and
which credential is in use. Three buttons carry the actions: `Configure` (opens the form),
`Check remote` (previews the remote payload and the component/file differences) and `Push`. The
form opens with a **GitHub** block - `Sign in with GitHub`, the one-time code with a copy button
and a link to `https://github.com/login/device`, a cancel button while the flow runs, and
`Sign out` once it holds a login - followed by a **Your repositories** block that lists the
account's repositories (private ones marked, ones without push permission disabled) and a
`Create repository` field with a private checkbox. Both blocks write into the same repository URL
field the manual form edits, which stays visible with the branch, remote directory, token, author
name and author email fields; the token field shows `saved` rather than the value, with an
explicit clear checkbox, and reads as the optional fallback. `Pull and merge` appears only after
a preview, with the same preview-then-confirm shape the ZIP import already uses. Every string goes
into both dictionaries in `src/client/locales.ts`.

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
  remote reported without the token, the read-only gate, a full device-flow sign-in whose token
  never appears in an answer, and the no-credentials-store Host.
- `tests/github-auth.spec.ts`: the device flow against a stub credentials port and a queued stub
  `fetch` - start, poll (pending, `slow_down`, success, expiry, denial, error), cancel, sign-out,
  repository listing and creation validation, and the messages a Host without a credentials store
  produces.
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

1. **Credential home.** GitHub sign-in now writes through `@deepseek-ai/dsh-credentials`, which is
   what `dsh-config-manager` uses, but the service is reached with `ctx.get('credentials')` instead
   of `inject: ['credentials']` so a profile without a provider still loads. The manual token and
   `MNEMON_SYNC_GIT_TOKEN` stay as fallbacks for those profiles; the maintainer may prefer to make
   the service required and drop the local `token` field from `state/sync-git.json` altogether.
2. **Remote history.** This plan uses the branch's Git history as retention. A bounded snapshot
   directory layout is only worth adding if a maintainer wants non-Git-readable retention.
3. **New capability gate.** `CONTRIBUTING.md` requires an Issue and maintainer approval before
   implementing a new capability. This plan is the proposal; the Issue link goes into the PR
   description.
