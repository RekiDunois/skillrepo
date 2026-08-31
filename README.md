# skillrepo

`skillrepo` registers ordinary skill/agent repositories with OpenCode so they can stay outside OpenCode's default config directories while remaining directly discoverable from their working trees.

Initial scope:

- `skillrepo register <path>`
- `skillrepo unregister <path>`
- `skillrepo doctor`

The repository is currently bootstrapping the OpenCode adapter first. Migration tooling will be added later.
