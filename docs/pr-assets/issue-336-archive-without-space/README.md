# Memory without a Memory Space — issue #336

[简体中文](./README.zh-CN.md) | [Issue #336](https://github.com/omdsh-dev/dsh-mnemon/issues/336) | [Verification record](./verification.json)

MEMORY.md makes room by archiving entries into a Memory Space before it compacts. On the reporter's machine there was no Mnemon CLI and no other Provider, so no space existed or could be created, and every write that no longer fit was refused. Project Documents refused the same way when they needed room or an archive. With the fix, memory keeps working without a Memory Space: what no longer fits moves to a local archive, and nothing is lost.

Baseline: main `2296898d` (dsh-mnemon 0.5.24). Fix: `4a992c86`. The runs use macOS 15.6 arm64, Node 24.19.0 and DSH 0.2.0-rc.2 (npm `latest` and `next`) in an isolated prefix.

## Method

`pnpm e2e:serve` ran with one `mnemon` configuration row: a `cliPath` that points at a missing file, which hides any installed Mnemon CLI as `--without-mnemon-cli` does, and a 300-byte working memory. No other Provider was connected. The same script ran on the fix and, with main's versions of the source files the fix changes swapped into the build, on the baseline:

1. open **记忆系统** (Memory System), then **运行时记忆** (Runtime Memory), and add four working-memory entries; the fourth does not fit;
2. read the runtime data directory;
3. open **项目档案** (Project Documents), create a document and **归档** (Archive) it.

## Before and after

| The fourth entry on main | With the fix |
|---|---|
| ![Refused: runtime memory archival requires an existing active writable Memory Space](./before-runtime-full.jpg) | ![Capacity maintenance complete: with no Memory Space to write to, moved 2 entries to the local archive](./after-runtime-full.jpg) |

| Archiving a Document on main | With the fix |
|---|---|
| ![Refused: document archive requires an existing active Memory Space](./before-document-archive.jpg) | ![Archived locally: the original moved to the archive, without a Mnemon cold index](./after-document-archive.jpg) |

| | Main | Fix |
|---|---|---|
| The working-memory write that does not fit | refused, `runtime memory archival requires an existing active writable Memory Space …; Memory Space body-directory is empty` | saved; 2 older entries moved to `runtime/archived/` |
| Working memory afterwards | 3 entries, 290 B of 300 B, the new one missing | 2 entries, 192 B, the new one and the oldest one |
| Local archive | none | `runtime/archived/MEMORY.md` with the 2 entries, word for word, plus `memories.jsonl` |
| Archiving a Project Document | refused, `document archive requires an existing active Memory Space …` | archived locally; the original stays readable under the archive tab |
| Browser console errors | none | none |

## Cause and fix

Capacity maintenance archived every MEMORY.md entry it could move into a Memory Space, then compacted. With no space that could take them, it refused, whatever the reason: no Provider ready, the layer switched off, no active space, or only Providers without exact writes. Project Documents needed a Memory Space for their cold index in the same way.

When no Memory Space at all can take the archive, the Host now asks the Runtime Source to compact with `archive: 'local'`. That is the case when the Memory Spaces layer is switched off, takes no automatic writes or is not installed, or when it lists no space that could take the archive: active, its Provider enabled and ready, with exact writes and safe forget. Inside the same lock the Runtime Source appends the committed entries that compaction leaves out to `runtime/archived/` (`memories.jsonl` to restore from, `MEMORY.md` to read), and then commits the compacted store. A failure in between leaves an entry in both places, never in neither. The archive refuses a linked directory and never follows a link. A Project Document is archived locally the same way, without an index, and keeps its original.

Everything else refuses as before, and nothing leaves working memory: a space that lies outside the current View's write scope, a View that offers no writes to an eligible space, as a scoped Strategy can, or a directory that cannot be read now. The retry in a new turn that the error asks for can then archive into the space. When a Memory Space can take the archive, nothing changes. Importing a Mnemon Pack keeps the local archive.

The Memory Spaces layer also stops promising what it cannot do:

- With no ready Provider, it offers Agents no remember or manage-spaces Action.
- A Mnemon Native space counts as active only while its CLI is found. The Source revision changes only in that case.
- The Layered strategy names `mnemon_recall` only while Memory Spaces offer recall, and archiving into Memory Spaces only while one takes writes. Its Documents routing and write rules stay in every case. With Memory Spaces to recall from and write to, the guidance is byte for byte what it was.
- `mnemon_status` adds a notice while no Memory Space exists.

## Automated checks

- `tests/layer-combinations.spec.ts` runs the layers to their limits:
  - Memory Spaces ready, with only an inactive space, without a ready Provider, switched off, and not installed: MEMORY.md full through the Agent tool, the web page and the Host's path outside a turn, then the View and guidance each state offers.
  - The four states without a Memory Space: Project Documents full, and an explicit archive.
  - All eight on and off combinations of Runtime Memory, Project Documents and Memory Spaces.
  - In every case nothing that did not fit is lost, and no state needs model work to make room.
- `plugins/dsh-mnemon-source-runtime/tests/controller.spec.ts`: the local archive takes exactly the entries compaction leaves out, appends later batches under one header, and is written only when asked. A commit that fails after the append leaves the entries in both places. A linked file or directory at the archive is refused, and its target and MEMORY.md stay unchanged.
- `tests/pack.spec.ts`: a merge or replace import keeps the local archive's files, carries no link, and leaves the link's target alone.
- `plugins/dsh-mnemon-strategy-default-three-tier/tests/strategy.spec.ts`: the guidance with Memory Spaces to recall from and write to is unchanged; recall and archiving are named by what the View offers, each on its own; the routing without recall keeps Documents and the write rules.
- Tests for a layer with no space to take an archive now assert the local archive, still with no write to a read-only, inactive or unsupported space. The scoped Strategy tests, where the View offers no writes to an eligible space, and the issue 250 tests, where a space lies outside the View's scope, keep their refusal.

## Limits

- Agents cannot recall from the local archive. It keeps the entries for the user, and for a later import into a Memory Space.
- Mnemon Packs do not carry the local archive; importing one keeps it.
- Save to memory in a conversation hands text to a task Agent, which needs a Memory Space. A separate change lets the dialog write to working memory directly.
- Screenshots show DSH's default light theme and Chinese UI only.
