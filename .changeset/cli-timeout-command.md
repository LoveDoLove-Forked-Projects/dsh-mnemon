---
"dsh-mnemon-source-memory-spaces": patch
---

A Mnemon CLI call that runs out of time names its command, for example `mnemon import did not respond within 10000ms` instead of `mnemon did not respond within 10000ms`, as an oversized output already does.

Mnemon CLI 调用超时时，报错会写明是哪条命令，例如 `mnemon import did not respond within 10000ms`，而不是 `mnemon did not respond within 10000ms`，与输出超限时的报错一致。
