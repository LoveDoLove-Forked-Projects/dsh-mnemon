---
"dsh-mnemon": patch
---

Memory subagents start on DSH 0.2.1-alpha.2, which replaced `subagents.start` with managed activations, and still start on DSH 0.2.0 (#356). Memory Space writes such as `mnemon_remember`, a USER.md or MEMORY.md write that needs compaction or archiving, idle review, Save to memory, placement, Document archive and evidence answers no longer fail there with `this.subagents.start is not a function`. A child started this way reports to Mnemon, so the conversation gets no completion notice, and cancelling stops it as before. A DSH that offers neither API now gets an error that says so.
