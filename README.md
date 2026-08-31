# skillrepo

`skillrepo` registers ordinary skill/agent repositories with OpenCode so they can stay outside OpenCode's default config directories while remaining directly discoverable from their working trees.

## v0 scope

```bash
skillrepo register <repo>
skillrepo unregister <repo>
skillrepo doctor
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

## Development

Requires Node.js 22+.

```bash
npm install
npm test
```

GitHub Actions additionally installs the real OpenCode CLI, registers a fixture repository, and verifies discovery through OpenCode itself.

Migration/analyzer functionality is intentionally not part of this first milestone.
