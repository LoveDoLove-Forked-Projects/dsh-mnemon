# v0.5.25 release acceptance

[中文](README.zh-CN.md)

Verified on 2026-10-08 (Asia/Shanghai). The packages under test are the six that 0.5.25 changes, as `pnpm release:version` builds them from `main` `d89a67f6`, which includes #343 to #349: `dsh-mnemon@0.5.25`, `dsh-mnemon-source-runtime@0.5.13`, `dsh-mnemon-source-documents@0.5.10`, `dsh-mnemon-source-memory-spaces@0.5.17`, `dsh-mnemon-strategy-default-three-tier@0.5.8` and `dsh-mnemon-provider-mnemon-native@0.5.9`. The other 12 component packages come from npm at the Starter's pinned versions, which 0.5.25 does not change.

## Real official WebUI on DSH 0.2.0-rc.2

On unmodified npm DSH `0.2.0-rc.2` (npm `latest` and `next`) with Node `24.19.0` and a fresh home, DSH home and pnpm store:

1. Started the host without Mnemon installed and opened **Plugins → Add plugin**.
2. Installed `dsh-mnemon`. DSH chose the install source itself; its speed check picked the mainland China mirror. A loopback registry answered with npm's real metadata plus the six new versions. The profile then held each new version, with every other component at its pinned npm version.
3. Clicked **Enable now**; the Memory System appeared without a host restart. [Status](status.png) reports **dsh-mnemon 0.5.25 / System nominal**, and Mnemon Native names **Mnemon 0.2.10**.
4. Added a Runtime memory entry and read it back after reloading the page: [Runtime](runtime.png).
5. Created and activated a Mnemon Native space in the WebUI: [Memory Spaces](spaces.png). Wrote a fact with Mnemon CLI `0.2.10`, recalled it with the CLI, then found the same fact with the WebUI's **Direct search**: [Recall](recall.png).
6. Wrote three more memories with the CLI that carry the entity `Atlas`, and one that only mentions Atlas. On **Entities**, `Atlas` counts 3, and selecting it lists exactly those three ("Showing 3 / 3"). Related memories stay collapsed behind **Find related memories**: [Entities](entities.png). Pressing it found the memory that only mentions Atlas, and the button became **Hide**: [Related memories](entities-related.png).
7. Opened **Check versions**. dsh-mnemon lists 0.5.25 as installed. Before publication npm's latest is still 0.5.24, so the dialog marks 0.5.25 as a local version and offers no update for it. No restart notice appeared after **Enable now**, since the version that runs is the one installed.

The host passed every step without a host warning or console error, and the host process was started once. [validation.json](validation.json) has the package digests and the results. Profiles and memories are synthetic. DSH 0.1.7-rc.2 is no longer part of release acceptance.

![Entities on DSH 0.2.0-rc.2: Atlas counted 3 and listed 3, related memories collapsed](entities.png)

## The fixes in this release

Each fix has its own before-and-after record:
- [Memory without a Memory Space](../issue-336-archive-without-space/README.md) (#345)
- [Save to memory places](../save-action-destination/README.md) (#349)
- [Edited Save to memory candidates](../issue-342-edited-save/README.md) (#343)
- [Forgetting by exact id](../issue-337-exact-id-actions/README.md) (#346)
- [Skipped archive receipts](../issue-339-archive-receipt-evidence/README.md) (#347)
- [Searches that only look](../issue-338-inspection-reads/README.md) (#348)
- [Settings outside DSH's slots](../issue-340-settings-outside-slots/README.md) (#344)

## Validation and release boundary

`pnpm run release:check` confirms the Starter 0.5.25 on the `latest` tag with its five new component pins; publication computes the changed packages from the previous release. No plugin uses a new SDK export from the Starter, so no peer floor moves. The version bump changes eleven specifier lines in the lockfile, and pnpm 10.13.1, the CI version, accepts it with `--frozen-lockfile`.

The release pull request and the publication workflow run the complete workspace and packed-plugin verification. Publication then:
- freezes the merged main revision;
- publishes the changed packages and reads them back from npm;
- installs the complete 18-package combination and checks a real Registry upgrade;
- creates the GitHub release.

These screenshots show the versioned local packages; they do not by themselves certify npm publication.
