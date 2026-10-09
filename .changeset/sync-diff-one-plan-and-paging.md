---
"dsh-mnemon": patch
---

The branch's difference no longer runs a plan of its own. **Ask AI to reconcile** lived inside the
dialog while the review list below the page read the same ledger, so a plan could be made, approved
and applied in two places, and the dialog's copy was the one that went stale: a plan that already ran
still offered to run again. The dialog now reads the branch - history and difference - and points at
**Memory reconciliation**, which is the one place a plan is made, decided and applied.

The ledger records the plan positions that actually ran (`appliedOperations`). Applying part of a
plan was already possible, but nothing remembered which part: the entry stayed "accepted" whatever
happened, so an applied plan sat in the worklist forever and a partly applied one offered to run its
first operation twice. Now a position that ran is never offered again, a plan with positions left
stays in the list showing only what is left, and a plan whose every operation ran moves into the
**Applied plans** dialog. Reopening a plan clears the record, because reopening is a decision about
the whole plan.

The backup history is read one page at a time, with **Load older backups** appending the next page,
and the directory row wraps instead of breaking **Choose directory...** across two lines.
