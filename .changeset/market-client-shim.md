---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
---

A Memory Source installed on its own in a profile that also has dshmarket no longer runs twice (#359). dshmarket 1.66 mounts such a package a second time as `mkt-client-<package>`, meant to serve its client only, but it loads the package's host code there too. Runtime Memory and Project Documents then registered a second instance, the Status page showed their cards twice, and the default layered Strategy failed every conversation turn with "found ambiguous working-context Sources". Memory Spaces failed that mount at every start with "Memory Spaces requires at least one explicit Provider child". Nothing installs under such a mount now; the Starter's own Entries keep composing the Sources, so nothing else changes. Runtime Memory and Project Documents need only the new Starter. A Memory Spaces copy installed on its own needs its new version: Check versions updates it where pnpm is on the Host's PATH, and otherwise `dsh plugin --profile <profile> add dsh-mnemon-source-memory-spaces@0.5.18` does. Removing that copy works too, since the Starter brings its own.
