# 迁移后 Skill 修改指导 Skill 计划

## 状态

- 状态：已实现
- 实现内容：指导 skill、文件级迁移映射、handoff 模板渲染、CLI 集成和 runtime/回归测试

## 背景

迁移完成后，skill 的原始 OpenCode 路径可能只剩兼容壳和 runtime 资源链接。真正可编辑的 `SKILL.md` 位于迁移目标仓库中，且该仓库通过 OpenCode 的 `skills.paths` 注册。

如果 agent 根据旧路径、目录名、当前工作目录或自己的经验直接编辑，可能产生以下问题：

- 编辑了没有 `SKILL.md` 的旧兼容壳，OpenCode 实际内容没有变化。
- 在多个配置文件同时存在时选错 `opencode.json` 或 `opencode.jsonc`。
- 跳过项目级 skill、全局 skill、`.agents/skills` 等有效来源。
- 把 symlink、缓存目录或 OpenCode 管理镜像当成 Git 源文件修改。
- 修改 frontmatter 后没有验证 skill ID、description 或 OpenCode 实际发现结果。
- 迁移尚未提交或已经回滚时，误把不完整路径当成可编辑源。

现有 `skill-development-location` 已经实现了资源定位、配置优先级和 Git 状态检查，但它更偏向底层定位规则。需要一个面向“修改 skill”意图的入口 skill，让 agent 在用户说“修改 skill”时加载固定流程，并且能消费迁移成功后的准确路径映射。

## 目标

1. 新增一个 OpenCode 可发现、可加载的 skill，建议稳定 ID 为 `skill-modification`。
2. 用户提出“修改 skill”“编辑 skill”“改一下这个 skill”等意图时，description 会随 skill 元数据展示给模型，并通过 runtime 测试验证可被正确使用。
3. 修改前始终使用现有 locator 找到唯一真实 `SKILL.md`，不允许通过猜测路径选文件。
4. 明确区分真实 Git 源、迁移目标、旧兼容壳、symlink 和缓存文件。
5. 在迁移事务成功提交并完成 OpenCode discovery 验证后，输出可直接交给 agent 使用的修改模板。
6. 用 OpenCode 真实 discovery/runtime 测试证明新 skill 能被解析和通过 `skill()` 工具加载。

## 非目标

- 不让新 skill 重新实现 `skill-development-location` 的配置扫描和路径解析。
- 不添加未经 OpenCode 支持的 frontmatter `trigger`、`when` 或自定义配置字段。
- 不自动修改用户的 OpenCode 配置、迁移计划、Git ignore 或远程仓库。
- 不把旧兼容壳恢复为带 `SKILL.md` 的副本；这会造成重复 discovery。
- 不在没有唯一定位结果时按目录顺序、最近修改时间或名称相似度猜选目标。
- 不把迁移 dry-run、preflight、rollback-complete 或 rollback-incomplete 当作成功迁移。

## 目标资源与命名

建议新增以下资源：

```text
skills/
└── skill-modification/
    └── SKILL.md

templates/
└── skill-modification-handoff.md
```

`skills/skill-modification/SKILL.md` 是 agent 的行为规范；`templates/skill-modification-handoff.md` 是带占位符的可渲染模板，不包含真实本机路径、用户目录、token、cookie 或生成日志。

skill frontmatter 只使用 OpenCode 已支持且仓库已验证的字段：

```yaml
---
name: skill-modification
description: Use when the user asks to modify, edit, update, debug, or review an OpenCode skill, especially a skill moved by skillrepo migration. Resolve the authoritative source path before editing and verify OpenCode discovery after the change.
---
```

description 应明确包含中英文常见意图，例如“修改 skill”“编辑 skill”“更新 skill”“迁移后的 skill”，但不引入自定义触发字段。自动加载依赖 OpenCode 的 skill discovery/匹配行为，最终必须由真实 runtime 测试确认，而不是只检查文件存在。

## 核心工作流

### 1. 判断是否应该加载

新 skill 的说明应覆盖以下请求：

- 修改或编辑一个已有 skill 的 `SKILL.md`。
- 修改迁移到外部仓库后的 skill。
- 调整 skill 的 frontmatter、说明、执行步骤或脚本引用。
- 检查修改后的 skill 是否仍能被 OpenCode 正确发现。
- 用户只给出 skill ID、旧路径、模糊目录或自然语言名称。

纯粹创建一个全新 skill、修改普通应用代码或只阅读 skill 内容时，不应把本流程当成唯一入口；若同时涉及修改已有 skill，应优先加载本 skill。

### 2. 先定位，再读写

加载后第一步固定为运行 `pwd`，并原样保留返回路径。随后加载并遵循 `skill-development-location`，使用它提供的 locator，而不是自行拼接配置路径。

locator 的当前 JSON 契约必须按现有实现消费：配置文件路径是顶层 `config`，Git 状态位于 `git` 对象中，Git 根目录是 `git.gitRoot`。本计划不新增兼容 alias，也不把这些字段重命名为 `configPath` 或顶层 `gitRoot`。

定位规则必须明确：

1. 配置优先级遵循 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR/opencode.jsonc`、`OPENCODE_CONFIG_DIR/opencode.json` 和默认配置位置。
2. `opencode.json` 与 `opencode.jsonc` 同时存在时停止并请求用户明确选择。
3. 使用用户给出的明确 skill ID；没有明确 ID 时先询问，不用模糊匹配替代确认。
4. 使用 locator 返回的真实 `path`、`sourceRoot`、`sourceRelativePath`、`config`、`frontmatterName` 和 Git 状态；Git 根目录读取 `git.gitRoot`，并检查 `git.managed`。
5. locator 返回 missing 或 ambiguous 时停止修改并报告原因。
6. 若返回的 `path` 位于 symlink、兼容壳、缓存或 OpenCode 生成镜像中，停止并重新定位 Git 源。

定位结果应作为本次任务的唯一资源身份。迁移计划、旧路径和目录名只能用于辅助解释，不能覆盖 locator 的结果。若未来需要 `configPath` 或顶层 `gitRoot` alias，应先单独修改 locator 并补充旧字段兼容测试；本计划的实现直接使用现有 `config` / `git.gitRoot` 契约。

### 3. 修改前的 Git 安全检查

在编辑真实源文件前执行：

```bash
git status --short --branch
git diff
git log --oneline -10
```

检查要求：

- 当前仓库必须是 locator 返回的 Git 根或其工作树。
- 保留用户已有改动，不重置、不清理、不覆盖无关文件。
- 若用户要求新分支或存在并行 agent，使用主检出目录旁的 sibling `worktrees/`，每个 agent 只拥有自己的文件边界。
- 若目标仓库不是 Git 仓库，不自动初始化；向用户报告并继续仅限于用户明确允许的安全范围。
- 只把真实源 `SKILL.md` 作为 skill 内容编辑，不编辑旧兼容壳中的 runtime symlink。

### 4. 修改内容约束

- 保持 `name` 稳定；需要改 skill ID 时必须先说明会影响调用方和 discovery，并单独验证。
- 保持 frontmatter 为 OpenCode 可解析格式；修改后检查 frontmatter 的完整性和字段类型。
- description 要说明“何时使用”和“解决什么问题”，不要加入未验证的配置键。
- 脚本、MCP command 和文档引用不得硬编码本机绝对路径或用户目录。
- 迁移后的仓库内 runtime 文件优先使用仓库相对路径；需要从 OpenCode 启动注册仓库内文件时使用已安装且可验证的 `skillrepo exec <repo-id> <repo-relative-resource>`。
- 不把 `.venv`、浏览器 profile、cookie、token、session state、构建产物或本地日志写入 skill。
- 只有在行为变化确实需要时才新增脚本、配置和测试，优先做最小修改。

### 5. 修改后验证

验证顺序如下：

1. 对修改后的文件重新运行 locator，确认仍得到唯一真实路径。
2. 检查 frontmatter 能被 OpenCode 兼容 parser 解析，且 `name` 与预期 skill ID 一致。
3. 运行目标仓库文档规定的 focused test，再运行必要的完整测试。
4. 运行 `skillrepo doctor` 或等价的注册状态检查，确认 source linkage 没有断裂。
5. 运行 `opencode debug skill`，解析 JSON 列表并按目标 skill ID 检查 discovery 结果；该命令不接 skill ID 参数。
6. 若修改了 agent 或 agent 相关资源，额外运行 `opencode agent list` 并检查名称无重复。
7. 对会影响模型读取行为的修改运行 `npm run test:opencode-runtime` 或仓库等价的真实 `skill()` runtime 测试。
8. 报告测试结果、实际编辑路径、Git 根和仍需人工确认的项目。

验证失败时不宣称修改成功，也不自动回滚用户改动。若失败由外部并发修改、配置歧义或 OpenCode 不可用造成，保留现场并明确指出阻塞项。

## 迁移成功后的模板输出

### 输出时机

完整成功 handoff 只在以下条件全部满足后输出：

- `migration apply` 非 dry-run。
- 事务状态为 `committed`。
- 目标内容、兼容链接、agent 注册链接和 OpenCode 配置已完成。
- 独立 OpenCode discovery 验证通过。
- 迁移结果中的持久化 `skillMappings` 可以直接提供每个 discovered skill 的目标仓库内 `SKILL.md` target path。

以下状态不输出“可编辑成功”模板：

- dry-run 或仅 preflight 成功。
- `moved-uncommitted`。
- `rollback-complete` 或 `rollback-incomplete`。
- `preflight-failed`。
- 只迁移了 agent/lib、没有 skill 的事务。

用户明确使用 `--no-verify` 时，可以输出只带迁移映射和未验证警告的降级 handoff，但必须标记为 `unverified`，不能标记为 `committed-and-verified`。

### 输出形式

建议在 `migration apply` 成功输出后追加一段明确标记的 Markdown 模板。默认输出到 stdout，避免未经用户同意创建可被提交的本地文件；如果实现提供 `--template-out <file>`，该选项必须是显式 opt-in，且不能覆盖已存在文件。

输出边界建议如下：

```text
SKILL_MODIFICATION_HANDOFF_BEGIN
...
SKILL_MODIFICATION_HANDOFF_END
```

模板内容只填充迁移结果和已验证状态中的事实，不重新扫描并猜测路径。每个 discovered skill 输出一个独立条目，不能把一个目录级 move operation 当成只有一个 skill。迁移支持一个 skill 目录包含根级和嵌套的多个 `SKILL.md`，因此 preflight 必须生成并持久化完整的 `skillMappings`：

```ts
type SkillMapping = {
  operationId?: string;
  repoId: string;
  skillId: string;
  sourceFile: string;
  targetFile: string;
};
```

`skillMappings` 应由 `collectSkillIdsInTree()` 的每个 `{ path, id }` 直接计算：`targetFile` 是 move target 加上该文件相对 skill source directory 的路径。根级 `SKILL.md`、嵌套 `SKILL.md`、frontmatter `name` 和目录路径不能相互推断替代。它必须进入事务 journal/result，供新事务、resume 和 committed handoff 统一消费；`expectedSkillIds` 继续用于 discovery 集合校验，但不能替代文件级映射。

`operationId` 可以在 journal 创建时绑定到对应 move operation；在此之前 mapping 的 `repoId`、`sourceFile` 和 `targetFile` 必须已经唯一确定。任何旧 journal 若没有文件级映射，都必须经过显式、可验证的 schema 迁移，否则不能生成完整 handoff。

模板每个 mapping 至少包括：

- `skill_id`：预检和最终 discovery 使用的稳定 ID。
- `skill_file`：`skillMappings.targetFile` 提供的目标仓库内真实 `SKILL.md` 路径；不从 skill ID 反推目录名。
- `repo_id`：迁移计划和注册结果中的仓库 ID。
- `repo_root`：目标仓库路径。
- `config_path`：本次事务实际使用的 OpenCode 配置路径。
- `transaction_id` 和 journal 路径。
- `source_root`、`target_root` 和目标仓库的 Git 状态。
- locator 的推荐调用方式，以及“定位结果不唯一时停止”的要求。
- 修改前检查、修改步骤、修改后 discovery/runtime 验证清单。

模板中的本机路径属于运行时输出，不得写入仓库中的静态模板。静态文件只保留合成占位符，例如 `<skill-id>`、`<target-path>`、`<repo-root>` 和 `<config-path>`。

### 模板示例

渲染后的结构建议保持简短稳定：

```markdown
# Skill 修改任务

- Skill ID: `<skill-id>`
- 真实文件: `<target-path-from-migration-mapping>`
- Repo ID: `<repo-id>`
- OpenCode 配置: `<config-path>`
- Migration transaction: `<transaction-id>`
- Migration status: `committed`

## 修改前

1. 运行 locator，确认返回的 `path` 与上面的真实文件一致。
2. 检查 `git status --short --branch`、`git diff` 和 `git log --oneline -10`。
3. 不编辑旧兼容壳、symlink、缓存或构建产物。

## 修改后

1. 重新解析 frontmatter，保持稳定 `name`；不要假设 `name` 等于目录名。
2. 运行目标仓库测试。
3. 运行 `opencode debug skill`，再按 skill ID 解析列表结果。
4. 对行为变化运行真实 `skill()` runtime 测试。
```

## 计划中的代码变更

### A. 新增指导 skill

文件：`skills/skill-modification/SKILL.md`

内容分为：

1. 触发范围和不适用范围。
2. locator 前置流程。
3. 迁移目标、旧兼容壳和 symlink 的区别。
4. 配置选择和歧义处理。
5. Git/worktree 与并行编辑规则。
6. frontmatter、绝对路径和 runtime 资源约束。
7. 修改后的 discovery、测试和 runtime 验证。
8. 迁移成功模板的使用方式。

skill 本身不硬编码当前机器的绝对路径。它只引用已加载的 `skill-development-location` 规则和仓库内公开的 `skillrepo` 命令格式。

### B. 新增模板与渲染器

静态模板：`templates/skill-modification-handoff.md`。

如果选择将模板集成到迁移命令，新增一个小型渲染模块，例如 `src/skill_modification_template.ts`，职责仅限于：

- 接收已提交事务的明确结果。
- 按持久化的 `skillMappings` 生成每个 root/nested skill 的稳定条目。
- 对路径和文本做 Markdown 安全转义。
- 拒绝 dry-run、未提交或验证失败状态。
- 不读取或输出 journal 中不必要的原始配置内容。

不应让渲染器再次遍历用户目录或通过目录名反推 skill。配置路径应来自事务 journal/result，skill 文件应来自已验证的文件级 `skillMappings`。由于 journal 是 resume 的持久化输入，需要为新增字段制定 journal schema 版本或对 skillrepo 自有旧 journal 做明确、可验证的迁移；缺少文件级映射时不能静默生成不完整 handoff。

### C. 迁移 CLI 集成

建议对 `src/cli.ts` 做最小集成：

1. 保留现有迁移状态、transaction 和 journal 输出。
2. 在成功 `committed` 且验证通过后输出 handoff 模板。
3. 可选增加 `--template-out <file>`，默认不写文件，目标已存在时拒绝覆盖。
4. `--no-verify` 时最多输出带“未经过 OpenCode discovery 验证”警告的降级 handoff，不输出完整成功模板，也不能把未验证结果伪装成完全成功。
5. 对没有 skill move 的事务输出“不生成 skill 修改模板”的明确说明。

必要时扩展 `MigrationApplyResult`，只增加模板所需的结构化事实，例如事务配置路径和明确的 `skillMappings`，不把完整 journal 或敏感原始配置暴露给 CLI 输出。迁移 journal 同步保存 `skillMappings`，并通过 schema 版本或受限的旧 journal 迁移保持 resume 行为可验证。

### D. OpenCode 解析与模型可见性验证

如果该仓库的迁移计划会把新 skill 纳入某个 skill repo，必须在迁移成功后用真实 OpenCode 检查：

- `opencode debug skill` 的 JSON 列表中能发现 `skill-modification`，并按 ID 解析结果，不给该命令传入 skill ID。
- skill ID 没有与现有资源重复。
- `SKILL.md` 的 frontmatter 被正确解析。
- 模型请求中实际包含 `skill-modification` 的 description/advertisement 信息。
- 在 advertisement 断言通过后，模型会话中内置 `skill()` 工具能加载该 skill，并返回一个唯一正文标记。

验证应复用现有 `scripts/opencode-runtime-test.mjs` 的 deterministic provider 思路，不用开发者本机真实模型结果作为唯一依据。测试可以控制 mock 的 tool call，但不能据此声称 OpenCode 自己完成了“根据用户意图选择 skill”；它只能证明 skill 元数据被广告给模型，且真实 `skill()` 执行成功。

## 测试计划

### 指导 skill 静态测试

新增 `test/skill-modification.test.ts`，覆盖：

1. `SKILL.md` 存在且 frontmatter 可解析。
2. `name` 等于 `skill-modification`，description 包含修改/edit/update 触发语义。
3. 不存在自定义 `trigger`、`when` 或其他未经支持的 frontmatter 字段。
4. 文档明确要求加载 locator、拒绝 ambiguity、禁止编辑兼容壳。
5. 文档不包含开发者本机绝对路径、凭据样例或真实用户目录。

同时补充 locator contract 测试，按当前输出字段断言：

```ts
assert.equal(found.config, configPath);
assert.equal(found.git.gitRoot, await realpath(repoRoot));
assert.equal(found.git.managed, true);
```

测试不得断言不存在的顶层 `configPath` 或 `gitRoot` alias。若以后决定增加 alias，必须先修改 locator、保留现有字段并单独覆盖兼容行为。

### 模板渲染测试

新增渲染器 focused tests，覆盖：

1. committed 且验证通过时，为每个 `skillMappings` 条目输出一个条目。
2. dry-run、preflight-failed、moved-uncommitted 和 rollback 状态不输出成功模板。
3. agent/lib-only 事务不生成 skill 条目。
4. 根级和嵌套 `SKILL.md` 都有准确的 `skillId`、`sourceFile` 和 `targetFile`，输出使用文件级映射而不是目录级 operation 或 ID 反推。
5. 输出使用迁移结果中的 target/config path，不从旧路径猜测。
6. Markdown 特殊字符和路径空格不会破坏模板。
7. `--template-out` 不覆盖已存在文件，且写入失败不会改变迁移结果。
8. 输出不泄露完整原始 JSONC、secret-like 值、cookie 或 journal 私密内容。

### 迁移回归测试

在现有迁移测试基础上补充：

1. 成功迁移多个仓库时，模板中的 skill/repo 映射完整且不串位。
2. OpenCode verification 失败并 rollback 时，不产生成功 handoff。
3. committed journal 的 `--resume` 验证成功时，模板可以幂等重现。
4. migration plan 只含 HOLD/DEFER 或没有 skill 时，模板状态明确而不是空白成功。
5. 事务期间配置被外部修改时，不生成模板，也不覆盖配置。
6. 一个 skill 目录包含根级和嵌套 `SKILL.md` 时，`skillMappings` 为每个 discovered skill 保存准确文件路径，且 handoff 不遗漏嵌套 skill。

### 真实 OpenCode runtime 测试

使用 CI 固定的 `opencode-ai@1.18.25`（或 `OPENCODE_BIN` 指定的同等测试二进制）运行：

```bash
npm test
npm run test:opencode-runtime
```

并在已注册的测试 fixture 上执行：

```bash
opencode debug skill
```

测试必须先解析 `opencode debug skill` 的 JSON 列表并按 ID 找到目标 skill，而不是给命令传入 skill ID，也不能只确认 exit code。runtime mock 的第一轮请求必须包含用户的“修改 skill”请求、`skill-modification` ID 和 description/advertisement 文本；只有 advertisement 断言通过后才返回 `skill()` tool call。随后保留第二轮正文 marker 断言，确认真实 `skill()` 工具执行成功。该测试证明的是元数据进入 model-facing advertisement 和工具可执行，不把模型的选择行为错误归因于 OpenCode。

## 验收标准

- 用户说“修改 skill”时，OpenCode 会向模型广告 `skill-modification` 的稳定 description，且真实 runtime 能加载它；模型是否选择调用由模型行为决定，不将其归因于 OpenCode 自身。
- agent 不会凭旧路径或目录名编辑迁移兼容壳。
- 配置冲突、资源缺失、路径歧义和非 Git 源都会停止并给出原因。
- 修改流程使用 locator 的真实 `path`、`sourceRoot`、`sourceRelativePath`、`config` 和 `git.gitRoot`，并检查 `git.managed`。
- migration 只有在 `committed` 且 discovery 验证完成后才输出成功 handoff。
- handoff 中每个 skill 的路径来自事务映射，静态模板不含真实本机路径。
- 模板输出可供后续 agent 直接执行，不要求 agent 重新猜测配置文件或目标仓库。
- 现有迁移、注册、doctor、portability 和 runtime 测试保持通过。
- 不新增凭据、私有路径、生成库存、部署产物或未经请求的 Git 提交。

## 实施顺序

1. 先实现 `skill-modification` 的文档契约和静态测试。
2. 实现静态 handoff 模板与纯函数渲染器。
3. 将渲染器以最小方式接入 committed migration CLI 输出。
4. 补齐迁移成功、回滚、resume 和多仓库测试。
5. 运行完整单元测试和真实 OpenCode runtime 测试。
6. 检查最终 diff，确认只包含本 skill、模板、实现、测试和必要文档。

## 待实现时的决策点

- 默认只 stdout 输出模板，还是同时提供显式 `--template-out`：建议两者都支持，但文件输出必须 opt-in 且 no-clobber。
- `--no-verify` 是否输出降级模板：建议输出带“未验证”警告的模板，不能输出完全成功标记。
- 是否把事务配置路径和 `skillMappings` 直接加入 `MigrationApplyResult`：建议只加入模板真正需要且不会泄露额外 journal 内容的字段；locator 仍使用现有的 `config` / `git.gitRoot` 字段。
- 新 skill 随 skillrepo 自身发布；通过 `skillrepo register <skillrepo-root>` 注册 `skills/`，并由真实 OpenCode discovery/runtime 测试验证。
