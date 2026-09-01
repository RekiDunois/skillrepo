# skillrepo

`skillrepo` registers ordinary skill/agent repositories with OpenCode so they can stay outside OpenCode's default config directories while remaining directly discoverable from their working trees.

## v0 scope

```bash
skillrepo register <repo>
skillrepo unregister <repo>
skillrepo exec <repo-id> <repo-relative-resource> [args...]
skillrepo doctor

skillrepo migration apply --target-root <dir> [--plan <file>] [--execute] [--resume]
skillrepo migration audit --target-root <dir> [--plan <file>] [--git <path>] [--json]
skillrepo migration ignore --target-root <dir> [--plan <file>] [--git <path>] [--execute]
skillrepo migration portability --target-root <dir> [--plan <file>] [--git <path>] [--json]
skillrepo migration portability fix --target-root <dir> [--plan <file>] [--git <path>] [--execute] [--json]
```

A registered repo can use either the legacy layout or a standard package authoring layout:

```text
repo/
├── skills/
└── agents/
```

```text
repo/
├── apm.yml
└── .apm/
    ├── skills/
    └── agents/
```

`register` adds the selected source directory (`repo/skills` or `repo/.apm/skills`) to OpenCode's global `skills` sources and creates one repo-level directory symlink under OpenCode's global `agents/` directory. Agent Markdown files must declare a stable frontmatter `name`. The source directories are linked directly; `skillrepo` never copies their contents.

Only one supported layout may be present in a repository. If both layouts contain a `skills` or `agents` source directory, inspection fails closed rather than guessing.

Registration and unregistration are intended to be idempotent. `unregister` only removes linkage owned by the requested repo; it never removes repo contents.

By default, mutating commands run an OpenCode CLI post-check. `--no-verify` exists for isolated unit tests and recovery cases:

```bash
skillrepo register ./example --no-verify
```

`doctor` checks filesystem/config linkage, requires at least one registered skill or agent target source, verifies every skill ID found in configured `skills` sources against `opencode debug skill`, and invokes documented OpenCode CLI commands so errors can be separated into local registration problems versus OpenCode discovery/runtime problems.

## Registered runtime resources

`skillrepo exec` resolves a registered repo from OpenCode's existing registration state; it does not maintain a second registry. Skill-backed repos are resolved from OpenCode's configured `skills` sources and agent-only repos can be resolved from their repo-level `agents/<repo-id>` symlink.

```bash
skillrepo exec browser-pdf-tools skills/browser-pdf-core/chrome-mcp-wrapper.sh --scan
```

The resource path must be repo-relative, remain inside the registered repo, and resolve to a file. Absolute resource paths and `..` escapes are rejected. This command is intended for portable runtime frontmatter that must launch a file inside a repo without hard-coding the repo's installation directory or the user's home directory.

## Thin migration apply

## Transactional migration apply

Migration execution is deliberately mechanical. Repository grouping belongs in `migration-plan.json`; `migration apply` does not regroup, infer dependencies, initialize Git repositories, commit, push, or manage remotes.

The command is a dry-run unless `--execute` is explicitly supplied:

```bash
skillrepo migration apply \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos

# after reviewing every source -> target move
skillrepo migration apply \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos \
  --execute
```

After a committed migration, `migration apply` prints a skill-modification
handoff for each migrated root or nested `SKILL.md`. The handoff is generated
from file-level transaction mappings, not from guessed directory names:

```bash
skillrepo migration apply \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos \
  --execute \
  --template-out ./skill-modification-handoff.md
```

`--template-out` is opt-in and refuses to overwrite an existing file. A
`--no-verify` migration may print only an `unverified` handoff; dry-runs,
rollback states, and migrations without skills do not produce a successful
skill handoff.

The current schema consumes repositories whose action is `CREATE_AND_MOVE` and mechanically maps:

```text
<sourceRoot>/skill/<id>      -> <targetRoot>/<repo>/skills/<id>
<sourceRoot>/agents/<file>   -> <targetRoot>/<repo>/agents/<file>
<sourceRoot>/<lib path>      -> <targetRoot>/<repo>/<lib path>
```

`migration apply` is transactional. Before the first filesystem mutation it fixes the plan fingerprint, parses every migrated skill and Markdown agent with the OpenCode-compatible frontmatter parser, derives all skill IDs and agent names, checks duplicate names, path overlap, source types, target preconditions, and filesystem boundaries, and builds the prospective JSONC configuration in memory.
Before the first rename, all sources and targets are preflighted. Duplicate/overlapping sources, missing sources, existing targets, symlink sources, unsafe paths, invalid migrated frontmatter, and cross-filesystem moves are blocked before mutation begins.

If a previous migration already completed its mechanical moves but stopped during registration/verification, `--resume` accepts only states that `skillrepo` can prove were produced by its own migration compatibility layout. Unknown mixed states still block.

Execution records a journal under `<sourceRoot>/.skillrepo-migrations/<transaction-id>.json`, takes a source-root lock, and first renames source entries into a transaction-owned staging directory. Target content and compatibility links are then committed, followed by repo-level agent links and one atomic JSON/JSONC replacement. The original config fingerprint and all source/target/link fingerprints are recorded in the journal.

Unless `--no-verify` is used, fresh OpenCode processes check the complete expected skill and agent lists, target source configuration, and target readability. A failed preparation, registration, or discovery check rolls back the entire batch. Rollback only removes paths whose recorded owner, symlink target, and fingerprint still match; external changes produce `rollback-incomplete` and leave the journal and lock for manual recovery.

`--resume` is journal-driven. A committed transaction is safely idempotent. An interrupted or `moved-uncommitted` transaction is first rolled back and reported as `rollback-complete`; missing or mismatched journals and fingerprints are never treated as proof that a path was migrated. Dry-run remains fully read-only and creates no lock, journal, staging directory, link, or config file.
After a skill directory moves, its old directory is recreated **without `SKILL.md`** and its remaining top-level runtime resources are symlinked to the new location. This keeps existing absolute paths such as `.../skill/foo/scripts/...` and `.../skill/foo/.venv/...` working without making OpenCode discover the same skill twice. Shared `lib/` paths and non-Markdown agent runtime resources get compatibility symlinks. Markdown agent files do not get old-path symlinks because that would create duplicate agent discovery; missing agent frontmatter `name` is filled mechanically from the filename before registration.

Finally, each new repo is registered through the normal `registerRepo` path. Unless `--no-verify` is used, a migration with skills first moves and registers one skill as a canary, then starts a fresh full OpenCode runtime with the user's environment and checks TUI `/skill` state plus a deterministic real `skill()` call. The remaining moves are committed only after that gate passes. A final full-inventory/runtime check runs before commit; either runtime failure writes a redacted diagnostic beside the journal and rolls back the transaction. The verifier injects its mock provider through a temporary config and never writes test credentials to the user's config. `--no-verify` explicitly skips runtime compatibility verification.

## Commit-readiness workflow

Post-migration Git preparation is intentionally separate from migration itself. None of these commands initializes Git or creates commits.

Commit-readiness has an explicit Git trust boundary:

> skillrepo MAY produce safe ignore suggestions, but MUST NOT interpret effective `.gitignore` semantics itself. Effective-ignore decisions are delegated to the selected Git executable.

Commands that consume the commit-readiness audit oracle (`migration audit`, `migration ignore`, `migration portability`, and `migration portability fix`) require a usable Git executable and accept the same `--git <path>` selector. They preflight the selected Git before repository scanning. By default `git` is resolved from `PATH`. There is no parser-based fallback that can return `COMMIT-READY: YES` when Git is unavailable.

For ignore probes, skillrepo uses `git check-ignore --no-index`. If the migrated target already has valid Git worktree metadata, the probe runs in that repository's real Git context so repository-local excludes such as `.git/info/exclude` and local ignore configuration are honored. Only uninitialized targets use temporary Git metadata with `GIT_WORK_TREE` pointed at the migrated repository. Skillrepo never runs `git init` in the migrated target and never creates `<repo>/.git` itself.

### Audit

```bash
skillrepo migration audit \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos
```

The audit is read-only. It reports commit blockers, manual review items, and observed **effectively unignored** candidates while avoiding secret-value echoing. It does not follow runtime/cache directories such as browser profiles. A local virtual environment no longer blocks commit readiness only when the selected Git implementation confirms that the observed path is ignored.

Git, rather than skillrepo, decides negation/last-match ordering, nested `.gitignore` behavior, escaping, directory-relative patterns, `**`, repository-local exclude sources, and other ignore semantics.

### Safe ignore generation

```bash
# dry-run
skillrepo migration ignore --plan ./migration-plan.json --target-root ~/skill-repos

# create only a brand-new reviewed safe ignore file
skillrepo migration ignore --plan ./migration-plan.json --target-root ~/skill-repos --execute
```

Ignore generation uses an explicit safe-pattern allowlist for runtime/cache noise. It never automatically hides credential/privacy blockers such as `.env`, key material, or session state merely because the audit found them.

For v0, skillrepo **never auto-rewrites an existing `.gitignore`**, including symlinks. Repositories with an existing file and remaining safe suggestions are reported as manual review. If no `.gitignore` exists, `--execute` stages the complete generated content in a private same-directory file and publishes it with a no-clobber operation only after staging write/sync/close succeeds, so a partial final file is never exposed and a `.gitignore` that appears concurrently is never overwritten. Every observed candidate path is then re-probed with the selected Git executable. Verification failure is an error and is never reported as a successful fix; the published generated `.gitignore` is deliberately left in place for manual review because skillrepo never performs a racy pathname rollback/delete after publication.

### Portability review

```bash
skillrepo migration portability \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos
```

Absolute home-path findings are classified by scope: frontmatter runtime configuration, Markdown body, tests, or runtime code. Mixed Markdown files preserve separate frontmatter/body segments so later fixes do not treat the whole file as runtime configuration. Unix home paths and Windows home paths using either `C:\\Users\\name\\...` or `C:/Users/name/...` separators are recognized.

### Portability fixes

```bash
# dry-run by default
skillrepo migration portability fix \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos

# apply only actions marked AUTO
skillrepo migration portability fix \
  --plan ./migration-plan.json \
  --target-root ~/skill-repos \
  --execute
```

Automatic fixes are deliberately narrow. An MCP `command[0]` is rewritten to `skillrepo exec <repo-id> <repo-relative-resource>` only when the migration plan proves that the executable moved into an active registered repo and the executable is not inside a local virtual environment. Markdown body paths are normalized automatically only when they point into the standard migrated OpenCode source root. Test fixtures, general runtime code, external runtime dependencies, and ambiguous frontmatter remain manual.

Before applying any `AUTO-REPO-EXEC` rewrite, the CLI verifies that the installed `skillrepo` on `PATH` actually supports the `exec` command. This prevents a source-tree invocation from rewriting OpenCode frontmatter to depend on a missing or older installed CLI.

## Development

Requires Node.js 22+ and Git for commit-readiness tests/features.

```bash
npm install
npm test
```

GitHub Actions runs the full unit suite plus packaged CLI/OpenCode integration on Ubuntu. The OpenCode install is pinned to `1.18.25`; existing `debug skill` and `agent list` checks are CLI discovery diagnostics only, while `npm run test:opencode-runtime` separately compares full TUI/serve `/skill` state and executes the real `skill()` tool in both runtimes against a deterministic local provider. The headless `serve` backend is used instead of `web`, so the test never opens a browser. A separate Windows job builds the project and runs the commit-readiness/Git-ignore unit subset, including the target-filesystem `core.ignoreCase` regression, so the filesystem-sensitive Windows branch is exercised without claiming that unrelated POSIX symlink/runtime tests are Windows-portable.

## Skill and agent development

The `skill-development-location` skill defines the safe workflow for changing an OpenCode skill or agent that may be stored outside the default config directory. Load it before development; its locator reads the configured source paths and returns the unique real file path, source root, and Git state:

```bash
node skills/skill-development-location/scripts/locate-resource.mjs \
  --kind skill --name <skill-name>
```

It also documents parallel work ownership, Conventional Commit rules, staged-diff checks, and the push/PR handoff.

This repository also ships the `skill-modification` entry skill. Register this
repository with OpenCode to make it discoverable:

```bash
skillrepo register /path/to/skillrepo
```

Then start a new OpenCode session and explicitly request `skill-modification`
when a task changes an existing skill. The skill uses
`skill-development-location` to resolve the authoritative source before any
edit; it does not add custom `trigger` or `when` frontmatter fields.
