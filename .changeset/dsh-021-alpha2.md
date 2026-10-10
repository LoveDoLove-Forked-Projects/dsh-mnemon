---
"dsh-mnemon": patch
---

The dsh-mnemon page under Plugins explains the `dsh-mnemon/bundle` row only while DSH lists it. DSH 0.2.0 shows that grouping row as off, and the note above the component list says why; DSH 0.2.1 lists only the components, so the note no longer names a row that is not there. Background memory tasks for a workspace whose folder was deleted or moved now run in the first existing workspace, or the directory DSH started in, instead of failing on DSH 0.2.1, which refuses an Agent whose directory is gone. Returning to the Memory System also reloads the open page, so a Provider enabled under Plugins meanwhile appears on Memory Spaces without pressing Refresh.
