# DSH Settings compatibility and recovery — issue #267

[简体中文](./README.zh-CN.md)

## Baseline reproduction

On 2026-09-22, unmodified main `65c0e23ba410993e16c00c8b3adf92d59d853425` reproduced the activation failure with published DSH `0.1.7-alpha.1` in a disposable Web profile. The Mnemon root reported:

```text
mnemon (dsh-mnemon): TypeError: ctx.settings.register is not a function
```

The plugin page showed the root in an error state and dependent Sources and Strategies waiting for their dependency. The local activation record identifies this result as `reproduced`; selected installed DSH files were compared with integrity-verified public npm tarballs.

![Baseline: Mnemon activation fails and dependent plugins wait](./before-alpha7-activation.png)

See the [packed-artifact harness](./harness/HARNESS.md) for preparation and launch instructions. Baseline and fixed artifacts use separate disposable profiles. Only the baseline requires `--legacy-peer-deps` to get past its outdated peer range and expose the runtime failure; the fixed consumer uses normal peer resolution.

## Implementation and public contracts

DSH `0.1.7-alpha.1` replaces dynamic Settings registrations with forms derived from each plugin's static `Config`. The implementation uses published `SettingsForms.configure/describe/mutate`, `ConfigEditor.edit`, the Cordis `internal/config` waterfall, and the Loader's `loader/volatile-update` event. Official DSH packages, manifests and source are unchanged. No DSH source checkout, workspace alias or replacement Settings service is used by the artifact harness.

- [Live Config](../../../src/host/live-config.ts) uses real volatile references from the published DeepSeek Schemastery/Cosmokit packages. It preserves the object schema for native form discovery and performs pure cross-field validation. `remoteAccess` remains an ordinary field with the host's normal remount behavior.
- The [settings adapter](../../../src/host/settings-service.ts) retains Mnemon's client namespaces while binding reads, validation and writes to the owning Entry/Fiber. Existing hosts with `settings.register` retain their original service. Profile writes go through DSH's locked editor; the owner-scoped preflight validates the candidate runtime before persistence, and committed volatile updates refresh the runtime.
- Core, UI and View settings share one native revision. A bounded retry is allowed only when that namespace's unredacted effective, inherited and explicit values still match the observed snapshot. Same-namespace conflicts, missing snapshots, read-only state, disposal and Entry replacement are rejected. Remote descriptors remain redacted.
- [Plugin management](../../../src/host/plugin-management.ts) reapplies selected Entry state after whole-profile reconciliation, validates the resulting composition, and compensates failed transactions.
- [Client icon aliases](../../../src/client/ui-icons.ts) support both the old size-suffixed exports and alpha7's weight-suffixed exports. The settings footer now describes DSH-managed live saving in both languages without hardcoding the removed settings file.

## Retained settings and existing profile choices

Recovery reads `settings.yaml.imported` without modifying its bytes and writes only through `ConfigEditor.edit`. Its [pure planner](../../../src/host/legacy-settings-import.ts) maps the canonical root's retained sections as follows:

| Retained section | Profile Config destination |
| --- | --- |
| `mnemon` | Root fields missing from the current explicit override |
| `mnemon-ui` | `conversationInteraction` |
| Exact `mnemon-view[-hash]` | `memoryView` |
| Exact `mnemon-plugins[-hash]` | Source activation in `memoryView.entries`, only for confirmed Source Entries |

Current explicit root/UI choices win. Explicit `memoryView` fields, including an empty `entries` reset, are preserved. Existing Strategy rows take precedence over older saved activation/configuration; Source configuration remains on its native Entry. Local patch IDs are matched to their unambiguous full Loader IDs. Unrelated rows are not replaced. The plan is recomputed inside the editor callback so an intervening explicit edit wins, and `legacySettingsImported` prevents later resets from resurrecting old preferences.

Native `!!js` expressions are retained as expression data, never evaluated or converted into literal strings by recovery. An expression-controlled activation or Strategy configuration causes that Entry's old View overlay to be skipped. Source configuration expressions and unrelated expression rows stay on their native rows. Expressions in relevant legacy backup sections, malformed data and unsupported YAML are rejected without completing recovery or changing the backup.

## Migration and rollback limits

- If the original `settings.yaml` exists at startup, DSH performs its own asynchronous rename/import. Mnemon defers supplemental recovery until the next cold Host start; a page refresh or plugin remount does not clear this gate.
- Recovery accepts only the canonical root Entry `mnemon` and the exact owning profile's historical namespace suffix. It does not guess custom-root ownership, foreign profile hashes or an unsuffixed fallback. Ambiguous or rejected input remains available in the retained backup for manual review.
- Back up the DSH profile configuration, legacy settings and relevant Mnemon data before upgrading. New profile settings are not mirrored back to `settings.yaml`. A downgrade requires the corresponding configuration backup and manual reconciliation of later changes; there is no automatic reverse export.
- This changes preference storage and recovery, not the Runtime, Documents or Memory Spaces data formats.

## Verification scope

Focused regressions cover [schema/reference behavior](../../../tests/live-config.spec.ts), [owner isolation and redaction](../../../tests/profile-settings.spec.ts), [revision conflicts and retired owners](../../../tests/profile-settings-revisions.spec.ts), [pure migration planning](../../../tests/legacy-settings-import.spec.ts), [retained-file recovery and expressions](../../../tests/profile-settings-import.spec.ts), and [both client icon generations](../../../tests/client-primitives-compat.spec.tsx).

The artifact harness uses isolated test data and a deterministic model endpoint bound to `127.0.0.1`; it requires no external model API key and calls no external model provider. Bootstrap URLs, `server.json`, raw `web.log` and model request logs remain outside the repository. Public evidence must exclude credentials and private data.

<!-- Append measured final build/package checks, fixed WebUI screenshots and restart results here after verification completes. No final success result or aggregate test count is recorded yet. -->
