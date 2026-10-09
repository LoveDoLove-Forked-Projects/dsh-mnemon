---
"dsh-mnemon": patch
---

Git sync could only be driven by hand, and every push rewrote the branch as a brand-new set of
objects. Three changes, one theme: the channel has to keep running on its own without ever writing
something a human did not agree to.

**Automatic backup.** The configuration form now offers an interval - off, or 1, 3, 6 or 12 hours, or
1, 3 or 7 days - saved the moment it is chosen. The Host arms one timer for the whole runtime and
repeats the same confirmed push the button runs, reading the interval from `state/sync-git.json` on
every tick, so a save takes effect without a restart and turning it off drops the timer at once. The
timer adds no write path of its own: the merge inside a push is still the only thing that ever brings
remote entries into this machine, so nothing appears in memory behind the reader's back. The page
reports when the next run is due, how the last one went, and the most recent failure; a push that
could not travel without credentials says so and is retried on the next tick rather than being lost.

**Backup size.** Git stores a brand-new blob for every push and the payload is the whole pack, so the
mirror accumulated a complete copy of each generation while a clone only ever downloads the pack.
Every successful push now folds the mirror's loose objects into one pack and reports how many objects
it collected and how the size changed. The collection runs after the branch has been updated, so a
slow repack can never hold a publish back, and a collection that fails is reported as a warning
rather than failing a push that already succeeded.

**The reconciliation area states how it runs.** The row states its own rules - the background only
repeats the push at the interval set under **Automatic backup**, a difference is read only by **Check remote** or by the merge before a
push and is never written on its own, and a plan to answer appears only when **Reconcile** runs - so
a timer is never mistaken for a proposal.
