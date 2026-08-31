# skillrepo

`skillrepo` registers ordinary skill/agent repositories with OpenCode so they can stay outside OpenCode's default config directories while remaining directly discoverable from their working trees.

## v0 scope

```bash
skillrepo register <repo>
skillrepo unregister <repo>
skillrepo doctor
skillrepo migration apply --target-root <dir> [--plan <file>] [--execute]
```

A registered repo follows this convention:

```text
repo/
├── skills/
└── agents/
```

`register` adds the absolute `repo/skills` path to OpenCode's global `skills` sources and creates one repo-level directory symlink under OpenCode's global `agents/` directory. Agent Markdown files must declare a stable frontmatter `name`.

Registration and unregistration are intended to be idempotent. `unregister` only removes linkage owned by the requested repo; it never removes repo contents.

By default, mutating commands run an OpenCode CLI post-check. `--no-verify` exists for isolated unit tests and recovery cases:

```bash
skillrepo register ./example --no-verify
```

`doctor` checks filesystem/config linkage, requires at least one registered skill or agent target source, verifies every skill ID found in configured `skills` sources against `opencode debug skill`, and invokes documented OpenCode CLI commands so errors can be separated into local registration problems versus OpenCode discovery/runtime problems.

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

The current schema consumes repositories whose action is `CREATE_AND_MOVE` and mechanically maps:

```text
<sourceRoot>/skill/<id>      -> <targetRoot>/<repo>/skills/<id>
<sourceRoot>/agents/<file>   -> <targetRoot>/<repo>/agents/<file>
<sourceRoot>/<lib path>      -> <targetRoot>/<repo>/<lib path>
```

`migration apply` is transactional. Before the first filesystem mutation it fixes the plan fingerprint, parses every migrated skill and Markdown agent with the OpenCode-compatible frontmatter parser, derives all skill IDs and agent names, checks duplicate names, path overlap, source types, target preconditions, and filesystem boundaries, and builds the prospective JSONC configuration in memory.

After a skill directory moves, its old directory is recreated **without `SKILL.md`** and its remaining top-level runtime resources are symlinked to the new location. This keeps existing absolute paths such as `.../skill/foo/scripts/...` and `.../skill/foo/.venv/...` working without making OpenCode discover the same skill twice. Shared `lib/` paths get a direct compatibility symlink. Agent files do not get old-path symlinks because that would create duplicate agent discovery; missing agent frontmatter `name` is filled mechanically from the filename before registration.

Execution records a journal under `<sourceRoot>/.skillrepo-migrations/<transaction-id>.json`, takes a source-root lock, and first renames source entries into a transaction-owned staging directory. Target content and compatibility links are then committed, followed by repo-level agent links and one atomic JSON/JSONC replacement. The original config fingerprint and all source/target/link fingerprints are recorded in the journal.

Unless `--no-verify` is used, fresh OpenCode processes check the complete expected skill and agent lists, target source configuration, and target readability. A failed preparation, registration, or discovery check rolls back the entire batch. Rollback only removes paths whose recorded owner, symlink target, and fingerprint still match; external changes produce `rollback-incomplete` and leave the journal and lock for manual recovery.

`--resume` is journal-driven. A committed transaction is safely idempotent. An interrupted or `moved-uncommitted` transaction is first rolled back and reported as `rollback-complete`; missing or mismatched journals and fingerprints are never treated as proof that a path was migrated. Dry-run remains fully read-only and creates no lock, journal, staging directory, link, or config file.

## Development

Requires Node.js 22+.

```bash
npm install
npm test
```

GitHub Actions additionally installs the real OpenCode CLI, registers a fixture repository, and verifies discovery through OpenCode itself.
