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

`doctor` checks filesystem/config linkage and invokes documented OpenCode CLI commands so errors can be separated into local registration problems versus OpenCode discovery/runtime problems.

## Thin migration apply

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

Before the first rename, all sources and targets are preflighted. Duplicate/overlapping sources, missing sources, existing targets, symlink sources, unsafe paths, and cross-filesystem moves are blocked before mutation begins.

After a skill directory moves, its old directory is recreated **without `SKILL.md`** and its remaining top-level runtime resources are symlinked to the new location. This keeps existing absolute paths such as `.../skill/foo/scripts/...` and `.../skill/foo/.venv/...` working without making OpenCode discover the same skill twice. Shared `lib/` paths get a direct compatibility symlink. Agent files do not get old-path symlinks because that would create duplicate agent discovery; missing agent frontmatter `name` is filled mechanically from the filename before registration.

Finally, each new repo is registered through the normal `registerRepo` path. Unless `--no-verify` is used, the migration then requires the real OpenCode CLI to discover every migrated skill and agent. A failed OpenCode discovery check is reported as a migration failure; there is intentionally no separate migration dependency solver or semantic repair engine.

## Development

Requires Node.js 22+.

```bash
npm install
npm test
```

GitHub Actions additionally installs the pinned OpenCode CLI, registers a fixture repository, and runs two runtime checks. The existing `debug skill` and `agent list` commands are CLI discovery diagnostics only; `npm run test:opencode-runtime` separately compares full TUI/Web `/skill` state and executes the real `skill()` tool in both runtimes against a deterministic local provider.
