---
"dsh-mnemon": patch
---

Fix turn-tail registration on DSH 0.1.6-alpha.2 with a stable list ID while retaining the DSH 0.1.5-rc.2 chain selector. Keep memory activity restricted to completed turns and follow the public main-session binding for Sidebar and Settings context, preserving explicitly scoped views.

Declare the public UI Session dependency and set the Client compatibility floor to DSH 0.1.5-rc.1, retaining 0.1.5-rc.2 and 0.1.6-alpha.2 support. Older DSH rollback profiles must use their previously verified Mnemon release.
