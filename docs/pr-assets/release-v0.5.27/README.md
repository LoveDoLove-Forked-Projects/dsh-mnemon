# v0.5.27 release acceptance

[中文](README.zh-CN.md)

Verified on 2026-10-10 (Asia/Shanghai). The packages under test are the two that 0.5.27 changes, as `pnpm release:version` builds them from `main` `6a0b5da6`, which includes #360 and #361: `dsh-mnemon@0.5.27` and `dsh-mnemon-source-memory-spaces@0.5.18`. The other 16 component packages come from npm at the Starter's pinned versions, which 0.5.27 does not change.

Each host is unmodified npm DSH, run with Node `24.19.0` and a fresh home, DSH home and pnpm store: `0.2.0-rc.2` (npm `latest` and `next`) and `0.2.1-alpha.2` (npm `alpha`). A loopback registry answered with npm's real metadata plus the two new versions. Every step passed on both hosts.

## A fresh installation from the official WebUI

1. Started the host without Mnemon installed and opened **Plugins → Add plugin**.
2. Installed `dsh-mnemon`. DSH chose the install source itself; its speed check picked the mainland China mirror. The profile then held the two new versions, with every other component at its pinned npm version.
3. Clicked **Enable now**; the Memory System appeared without a host restart. Status reports **dsh-mnemon 0.5.27 / System nominal**, and Mnemon Native names **Mnemon 0.2.10**: [0.2.0-rc.2](status.png), [0.2.1-alpha.2](status-alpha.png).
4. Added a Runtime memory entry and read it back after reloading the page: [Runtime](runtime.png).
5. Created a Mnemon Native space in the WebUI and activated it on its card: [Memory Spaces](spaces.png). Wrote a fact with Mnemon CLI `0.2.10`, recalled it with the CLI, then found the same fact with the WebUI's **Direct search**: [Recall](recall.png).
6. Wrote three more memories with the CLI that carry the entity `Atlas`, and one that only mentions Atlas. On **Entities**, `Atlas` counts 3 and lists exactly those three; **Find related memories** found the one that only mentions it: [Entities](entities.png), [Related memories](entities-related.png).
7. Opened **Check versions**. dsh-mnemon lists 0.5.27 as installed. Before publication npm's latest is still 0.5.26, so the dialog marks 0.5.27 as a local version and offers no update for it.

## The setup from issue #359, updated from v0.5.26

1. Installed the reporter's setup from the command line before starting the WebUI: `dsh plugin --profile web add dsh-mnemon@0.5.26 dshmarket@1.66.14 dsh-mnemon-source-memory-spaces@0.5.17`, so Memory Spaces is maintained by the Profile.
2. Started DSH: it warned that `mkt-client-dsh-mnemon-source-memory-spaces` did not activate (`Memory Spaces requires at least one explicit Provider child`), as the issue reports. Status was nominal and showed each Source once.
3. Updated both packages the way the release notes say for a host without pnpm on its PATH: `dsh plugin --profile web add dsh-mnemon@0.5.27 dsh-mnemon-source-memory-spaces@0.5.18`. Check versions cannot offer these candidates before publication, because it asks npm for the latest version.
4. Restarted DSH. No warning appeared, Status reports **dsh-mnemon 0.5.27 / System nominal** with each Source once, and Check versions lists Memory Spaces 0.5.18 as maintained by the Profile, matching the Starter's pin: [Check versions after the update](update-versions.png).

Neither host logged a console error, and apart from the warning in step 2 neither logged a host warning. [validation.json](validation.json) has the package digests and the results. Profiles and memories are synthetic.

![Check versions after the update on DSH 0.2.1-alpha.2: Memory Spaces 0.5.18, maintained by the Profile](update-versions.png)

## The changes in this release

Each change has its own record:
- [Memory Sources under dshmarket's client-only mount](../issue-359-market-client-shim/README.md) (#360): the startup warning, duplicate Status cards and failed turns on both hosts before the fix, and none after
- [dsh-mnemon on DSH 0.2.1-alpha.2](../dsh-021-alpha2/README.md) (#361): every root test, the real-host specs, Headless and the activation contracts against both installed hosts, the WebUI flows on 0.2.1-alpha.2, and a Provider switched under Plugins on both

## Validation and release boundary

`pnpm run release:check` confirms the Starter 0.5.27 on the `latest` tag with its new Memory Spaces pin; publication computes the changed packages from the previous release. Memory Spaces keeps its peer floor `dsh-mnemon ^0.5.19`, since it uses no new Starter SDK export. The version bump changes two specifier lines in the lockfile, and pnpm 10.13.1, the CI version, accepts it with `--frozen-lockfile`. The package measures 1,856,213 unpacked bytes, under the 2,500,000-byte ceiling.

The release pull request and the publication workflow run the complete workspace and packed-plugin verification. Publication then:
- freezes the merged main revision;
- publishes the changed packages and reads them back from npm;
- installs the complete 18-package combination and checks a real Registry upgrade;
- creates the GitHub release.

After publication, Check versions is also used on both hosts to update the #359 setup from npm itself.

These screenshots show the versioned local packages; they do not by themselves certify npm publication.
