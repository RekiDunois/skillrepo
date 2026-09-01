# 迁移流程事务化改造计划

## 背景

当前 `migration apply` 的核心流程是：

1. 预检移动操作。
2. 执行全部 `mv`。
3. 移动完成后逐个仓库解析 `SKILL.md`、注册 skill 和 agent。
4. 调用 OpenCode 做发现验证。

注册阶段仍会重新扫描和解析目标仓库的 YAML frontmatter。只要其中一个文件解析失败，前面的文件已经移动，但 `opencode.jsonc` 可能尚未更新，最终形成：

- 目标仓库已有文件；
- 源目录只剩兼容壳或兼容链接；
- OpenCode 没有登记目标 skill source；
- 没有自动回撤路径。

相关现状：

- `src/migration.ts` 在移动完成后才进入注册阶段。
- `src/core.ts` 的 `registerRepo()` 先调用 `inspectRepo()`，解析所有 skill/agent frontmatter 后才修改配置。
- 当前迁移失败不会撤销已完成的移动、配置修改或链接创建。

## 改造目标

- 将迁移变成可追踪、可验证、可回撤的事务。
- 在任何写操作前完成全部可预见的 frontmatter 和命名校验。
- 只有目标内容准备完成后才切换 OpenCode 配置。
- OpenCode 验证失败时回撤整个迁移批次，而不是只处理失败的仓库。
- 保留当前兼容行为：旧 skill 路径兼容壳、共享 lib 链接和非 Markdown agent 资源链接。
- 支持进程中断后的安全恢复，不依赖猜测文件是否属于本次迁移。

## 非目标

- 不自动决定仓库分组或修改 migration plan 的业务边界。
- 不移动 `HOLD_PENDING_APPROVAL` 或 `KEEP_DEFER` 项。
- 不自动修复无法证明安全的路径引用。
- 不初始化 Git、提交 Git 或修改远程仓库。
- 不通过保留 `SKILL.md` 副本的方式制造重复 skill discovery。

## 设计原则

### 1. 映射先于写入

先建立内存中的完整映射和持久化事务日志，而不是提前写入正式 OpenCode 配置。

每个操作至少记录：

```text
kind: skill | agent | lib
repoId
source
target
expectedSkillId / expectedAgentName
source fingerprint
target precondition
state
```

“skill 名称 -> 新路径”的映射用于预检、配置生成和验证；它不等同于提前创建永久链接。

### 2. 所有 frontmatter 在首次移动前解析

预检阶段应使用与 OpenCode 兼容的 parser，完整扫描：

- 所有待迁移 `SKILL.md`；
- 所有待迁移 Markdown agent；
- 需要自动补充 stable `name` 的 agent；
- 迁移后需要由 `inspectRepo()` 读取的全部目标文件。

任何解析错误、重复 ID、重复 agent name 或无法确定的名称都必须在首个写操作前阻止迁移。

### 3. 配置只指向已准备好的目标

不要在目标目录尚未存在时把 source 写入 `opencode.jsonc`。目标内容必须先完成并通过静态校验，再以原子方式更新配置。

### 4. 回撤必须覆盖整个批次

迁移包含多个仓库时，仓库 A 已注册而仓库 B 验证失败，也必须回撤 A 和 B 的全部本次变更。不能只回撤最后一个失败操作。

### 5. 不覆盖并发修改

提交阶段必须确认以下内容仍符合事务开始时的 fingerprint：

- `opencode.jsonc`；
- 尚未移动的源路径；
- 事务声称拥有的目标路径和链接。

发现用户或其他进程修改后应中止并保留事务日志，不能覆盖未知修改。

## 建议流程

### Phase 0：建立事务

- 为本次 apply 生成唯一 transaction ID。
- 保存原始 `opencode.jsonc` 内容及 fingerprint。
- 创建事务日志，记录计划版本、source root、target root 和完整操作列表。
- 防止同一 source root 上同时运行两个迁移事务。

### Phase 1：只读预检

- 读取并固定 migration plan。
- 构建 skill、agent、lib 的完整映射。
- 解析全部源 frontmatter，并计算最终 ID/name。
- 检查重复名称、源类型、目标存在性、源/目标重叠、路径安全性和 filesystem 限制。
- 检查保留项不会被误纳入操作。
- 计算迁移后的预期 OpenCode skill/agent 清单。
- 生成 prospective config，但此阶段不写正式 `opencode.jsonc`。

预检失败时不得创建目标内容、兼容链接或配置修改。

### Phase 2：准备目标内容

优先采用可回撤的 staging 方式：

- 在目标 root 下建立带 transaction ID 的 staging 目录；或
- 在同一 filesystem 内将源路径先改名到事务暂存区，保留原始内容。

不要直接删除源文件。所有 staging/暂存路径必须写入事务日志，并带有 owner marker 或 fingerprint。

目标内容准备完成后，验证目录结构、文件数量、fingerprint 和 frontmatter。自动补充 agent `name` 时保存修改前的原始内容。

### Phase 3：提交文件布局

- 将 staging 内容原子切换到最终目标路径。
- 创建旧 skill 路径的兼容壳，但不保留 `SKILL.md`。
- 创建允许的 runtime resource/lib compatibility links。
- 创建 agent 注册所需的目录链接。
- 每个操作完成后更新事务日志。

若任何操作失败，立即进入全批次 rollback，不继续处理后续仓库。

### Phase 4：原子切换 OpenCode 配置

- 根据完整映射生成待写入的 `skills` source 列表。
- 保留原 JSONC 注释和未相关字段。
- 写入同目录临时文件并执行原子 rename。
- 记录新配置 fingerprint 和本次新增/删除的具体条目。
- 配置切换必须发生在目标内容已经存在之后。

### Phase 5：独立进程验证

使用全新的 OpenCode 进程验证，不依赖已有会话的缓存：

- 所有预期 skill ID 均可发现；
- 所有预期 agent name 均可发现；
- 没有重复 skill ID 或 agent name；
- 发现结果指向目标仓库，而不是旧兼容壳；
- 所有 target source 均存在且可读；
- `skill`、`agent list` 和必要的 debug 命令均返回成功。

验证必须使用预检生成的期望清单，不能只检查命令 exit code。

### Phase 6：提交事务

只有所有仓库、skill、agent 和 OpenCode discovery 均通过后，才：

- 写入 transaction committed 状态；
- 清理 staging/暂存目录；
- 输出完整迁移结果和映射摘要。

## Rollback 设计

回撤顺序应尽量先恢复 OpenCode 可见状态，再恢复文件布局：

1. 用原始 fingerprint 恢复 `opencode.jsonc`。
2. 删除本次创建的 agent 注册链接。
3. 删除本次创建的 skill/lib/runtime compatibility links。
4. 删除目标仓库中由本事务创建的内容，或将其移回事务暂存区。
5. 恢复源目录及原始文件内容。
6. 恢复被自动补充 stable name 的 agent 文件。
7. 验证源文件、配置和链接状态已回到事务开始时的 fingerprint。
8. 如果任一步发现路径已被外部修改，停止自动删除，标记 `rollback-incomplete` 并保留日志供人工处理。

Rollback 必须是幂等的，可以在进程中断后重新执行；不得根据“路径看起来像已移动”进行猜测。

## 恢复与幂等

- `--resume` 应只接受事务日志中明确记录、且 fingerprint/owner marker 匹配的状态。
- 已完成并已验证的事务重复执行时不得重复添加配置项或链接。
- 已移动但未注册的旧事务，应进入明确的 `moved-uncommitted` 状态：优先回撤，不能直接当作成功迁移。
- 已注册但验证失败的事务，应回撤全部本事务配置变更和链接。
- 缺少日志或 fingerprint 不匹配时必须停止，不自动猜测。

## 需要修改的代码区域

- `src/migration.ts`
  - 引入 transaction/journal 状态。
  - 将完整 frontmatter 解析和命名计算前移到 preflight。
  - 拆分 prepare、commit、verify、rollback 阶段。
  - 记录所有 rename、compatibility link、agent link 和配置变更。
- `src/core.ts`
  - 提供可复用的 repo inventory 和预期 discovery 校验。
  - 为配置更新提供原子写入和 fingerprint 检查。
  - 区分“已登记”和“已验证”，避免空配置导致 `doctor` 假通过。
- `src/cli.ts`
  - 展示 transaction ID、当前阶段和 rollback 结果。
  - 对失败状态给出明确的 `rollback-complete` 或 `rollback-incomplete`。
  - 保持 dry-run 完全只读。
- `README.md`
  - 更新迁移流程、事务日志、恢复和回撤语义。

## 测试计划

新增或补充以下测试：

1. 任意源 skill YAML 无法解析时，源、目标、配置和链接均不变化。
2. 目标准备阶段失败时，事务自动回撤且不留下半成品。
3. 所有 move 完成后，注册阶段失败时，整个批次回撤。
4. 第 N 个仓库 OpenCode 验证失败时，前 N-1 个仓库也全部回撤。
5. `opencode.jsonc` 在事务期间被外部修改时，迁移中止且不覆盖配置。
6. agent stable name 自动补充后验证失败时，agent 内容恢复原文。
7. compatibility links 和 agent links 只删除本事务拥有的链接。
8. 成功迁移后，所有预期 skill ID、agent name 和目标路径均通过验证。
9. committed 事务重复执行保持幂等。
10. 进程中断后 `--resume` 只接受日志和 fingerprint 可证明的状态。
11. HOLD/DEFER/backup 项不会被误移动或误回撤。
12. `doctor` 在没有任何已登记 target source 时不能报告为完整迁移成功。

## 验收标准

- 任意可预见的 YAML/frontmatter 问题都在第一次写操作前报告。
- 失败迁移不会留下未登记的目标 skill，或能自动完整恢复。
- OpenCode 配置只在目标内容准备完成后切换。
- 验证覆盖完整期望清单，而不是只验证一个仓库或 exit code。
- 并发修改和未知文件状态不会被覆盖或删除。
- 迁移中断后可以安全恢复或明确报告需要人工处理。
- 现有 dry-run、兼容路径和 deferred/held 语义保持不变。
