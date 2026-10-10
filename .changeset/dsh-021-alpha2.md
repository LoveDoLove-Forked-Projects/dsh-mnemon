---
"dsh-mnemon": patch
---

The dsh-mnemon page under Plugins explains the `dsh-mnemon/bundle` row only while DSH lists it. DSH 0.2.0 shows that grouping row as off, and the note above the component list says why; DSH 0.2.1 lists only the components, so the note no longer names a row that is not there. Background memory tasks for a workspace whose folder was deleted or moved no longer fail on DSH 0.2.1, which stops an Agent whose directory and original directory are both gone: they keep working on that workspace's memory and run from the first existing workspace, or the directory DSH started in. Saving or switching a Provider under Plugins now also reloads the Memory System's open page, so the Provider appears on Memory Spaces without pressing Refresh.
