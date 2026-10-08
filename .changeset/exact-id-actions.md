---
"dsh-mnemon-source-memory-spaces": patch
"dsh-mnemon-provider-mnemon-native": patch
---

Forget accepts a memory named by its exact id. It required evidence that the current View had returned, but the Agent's `mnemon_forget` and `/mnemon forget <ID>` hand the request to a worker with a View of its own, which never recalled the id, so an Agent could write a memory and not remove it again (#337). When an id is not evidence of the View, the Source now asks a Provider that can look ids up for it among the spaces the View can read, and acts only when exactly one holds it; a request that names the space (`memoryBodyId`) also reaches a Provider without that lookup. Links and related-memory traversal accept such an id the same way. Evidence the View returned works as before. Mnemon Native looks an id up with `mnemon --readonly show`, which leaves the store untouched. Providers can implement the new optional `get(body, id)`.

遗忘现在接受以精确 id 指定的记忆。原来它只接受当前 View 返回过的证据；但 Agent 的 `mnemon_forget` 和 `/mnemon forget <ID>` 会把请求交给一个工作 Agent，它有自己的 View，从未召回过这个 id，所以 Agent 写入的记忆它自己删不掉（#337）。现在，当 id 不是本 View 的证据时，Source 会让支持按 id 查找的 Provider 在 View 可读的空间中查找它，只有恰好一个空间持有它时才执行；请求中指明空间（`memoryBodyId`）时，不支持查找的 Provider 也可以执行。建立关联和相关记忆遍历以同样方式接受这类 id。View 返回过的证据照常使用。Mnemon Native 用 `mnemon --readonly show` 查找，不改动存储。Provider 可以实现新增的可选方法 `get(body, id)`。
