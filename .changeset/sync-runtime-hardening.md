---
"dsh-mnemon": patch
"dsh-mnemon-source-runtime": patch
---

Runtime Memory keeps the provenance a Host stamps on an entry and the entry's branch scope, and nothing else from a stored or imported object: a malformed `branches` value from `memories.json` or a Mnemon Pack now reads as no scope instead of breaking the runtime projection. Its Git branch probe ignores the `GIT_*` variables a launcher exports. Git sync offers the GitHub sign-in to github.com repositories only, checks symbolic links out as plain files and refuses a payload path that crosses one, runs Git without interactive prompts, and waits for the Host to take the switch before it reports Git and the remote.
