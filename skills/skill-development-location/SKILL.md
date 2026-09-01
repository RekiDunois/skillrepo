---
name: skill-development-location
description: Locate the real source path for an OpenCode skill or agent before editing it, then apply safe parallel development and Git delivery rules.
---

# Skill and Agent Development

Load this skill before reading or changing any OpenCode skill or agent. The path shown by a symlink, editor search result, or cached inventory is not authoritative. The configured source path is authoritative.

## Locate the source first

1. Run `pwd` and keep the returned path unchanged when passing paths to tools or agents.
2. Resolve the OpenCode config in this order:
   - `OPENCODE_CONFIG`, when set.
   - `$OPENCODE_CONFIG_DIR/opencode.jsonc`.
   - `$OPENCODE_CONFIG_DIR/opencode.json`.
   - `~/.config/opencode/opencode.jsonc` as the default target when neither file exists.
   - If both config files exist, stop and ask for an explicit choice.
3. Use the bundled locator. It reads `skills.paths`, the legacy `skills` array, optional `agents.paths`, standard project/global OpenCode roots, and skill compatibility roots. It walks project roots upward to the Git worktree boundary, including `.agents/skills`; global skills include both `~/.claude/skills` and `~/.agents/skills`. Agent roots are limited to OpenCode config directories. It expands `~`, project-relative paths, and glob patterns, follows source symlinks, and reports the real file path.

```bash
node /absolute/path/to/skills/skill-development-location/scripts/locate-resource.mjs \
  --kind skill \
  --name <skill-id> \
  --project-root "$(pwd)"

node /absolute/path/to/skills/skill-development-location/scripts/locate-resource.mjs \
  --kind agent \
  --name <agent-id> \
  --project-root "$(pwd)"
```

The locator returns JSON containing the V1-compatible resource `id`, accepted `identifiers`, resolved real `path`, `sourceRoot`, source-relative path, config path, optional frontmatter metadata, and Git state. V1 primary identifiers always win over compatibility aliases. For V1, a skill uses frontmatter `name` when present and an agent uses frontmatter `name` when present; otherwise they fall back to the containing skill directory or the agent's source-relative path. The path-derived ID is also accepted as an alias only when no V1 primary match exists. Legacy `mode/` and `modes/` roots are scanned only at one level, matching V1. Use the returned `path` and `gitRoot`, not a guessed path. A non-zero result means the resource is missing or ambiguous; do not edit until the ambiguity is resolved.

Frontmatter `name` is returned as metadata and participates in V1 identity when present. Agents without a `name` field remain locatable by their source-relative path. Nameless skills are rejected because OpenCode V1 does not load them. Path-derived aliases preserve compatibility with newer discovery behavior without taking precedence over V1 names.

## Plan parallel work

- Split work by independent resource or file boundary, and run independent read-only exploration and validation tasks in parallel.
- Use multiple foreground agent calls in one message when parallelism is available. Do not use background agents for work that writes files.
- Assign one owner to each file. Never let two agents edit the same skill, agent, config, or lockfile concurrently.
- Keep shared changes, dependency updates, generated files, and integration tests in a single sequential owner after parallel work is complete.
- Before every editing task, each worker must run the locator and report the resolved real path and Git root.
- If the locator reports multiple matches, stop that worker rather than choosing by directory order.

## Edit safely

- Work in the resource's actual Git repository and branch. Do not edit an OpenCode-managed mirror or compatibility symlink.
- Inspect `git status --short --branch`, `git diff`, and the recent log before editing. Preserve unrelated user changes.
- Prefer the smallest change that satisfies the request. Keep skill and agent frontmatter valid and stable.
- Run the repository's documented tests and any focused validation for the changed resource.
- Do not add credentials, local paths, cookies, generated inventories, or deployment output.

## Commit rules

Only commit when the user requested delivery or explicitly approved it. Use a Conventional Commit subject:

```text
<type>(<scope>): <imperative summary>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, and `perf`. Keep the subject specific and under 72 characters. Use a body for non-obvious motivation or behavior. Use `!` and a `BREAKING CHANGE:` footer only for an intentional breaking change.

Before committing, stage only intended files and run all of these checks:

```bash
git status --short --branch
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Then run tests, inspect the staged diff again, and commit with the selected Conventional Commit message. Never amend a commit unless explicitly asked.

## Push and pull request

When delivery is requested:

1. Confirm the branch is not `main` and that the working tree contains no unintended changes.
2. Push with `git push -u origin <branch>`; never force-push.
3. Before creating a PR, inspect `git status`, `git diff`, `git log --oneline -10`, upstream tracking, and the complete diff against `main`.
4. Create the PR with `gh pr create --base main`, using a concise title and a body that states the problem, implementation, tests, and any known limitations.
5. Return the PR URL and test results. If no Git remote or GitHub authentication is available, stop after the commit and report the exact blocker.

Do not claim a path, commit, push, or PR exists unless the corresponding command succeeded.
