---
"dsh-mnemon": patch
"dsh-mnemon-source-runtime": patch
---

Prefer a unique full-content match for Runtime replace and remove before falling back to a unique substring. This lets short entries such as X be edited or removed alongside EGO_LINUX_CHROME, while duplicate exact matches remain rejected. Clarify the matching contract in the Runtime Source action and Host tool descriptions.
