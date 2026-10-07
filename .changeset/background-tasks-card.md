---
"dsh-mnemon": minor
---

The Memory System's status page now carries a **Background tasks** card: it states the Provider / Model the current conversation's background work actually uses, offers **Choose a model** without opening the plugin configuration, says so when the model directory cannot be read (and offers **Read again**) instead of silently falling back, and stays read-only when settings are not writable. The same model setting keeps working under the Layered strategy's page. In the review lists, plans that already ran fold behind **Applied plans (n)** so the plans still awaiting an answer stay in view; a dialog now leaves Escape and Tab to a menu opened above it, and an applied merge says the branch only matches after a push.