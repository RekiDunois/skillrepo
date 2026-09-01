---
name: skill-modification
description: Use when the user asks to modify, edit, update, debug, or review an OpenCode skill, especially a skill moved by skillrepo migration. Resolve the authoritative source path before editing and verify OpenCode discovery after the change.
---

# Skill Modification

Use this skill when the task changes an existing OpenCode skill, including its
`SKILL.md`, frontmatter, scripts, references, or runtime resource paths. It is
an entry workflow for modification; it does not replace the lower-level
`skill-development-location` locator.

Do not use this as the only workflow for creating a brand-new skill, changing
ordinary application code, or only reading a skill. If a request both reads
and changes an existing skill, use this workflow first.

## Locate Before Editing

1. Run `pwd` and pass that exact returned path to later commands.
2. Load `skill-development-location` before reading or changing the target.
3. Run its locator with the explicit skill ID:

```bash
node /absolute/path/to/skills/skill-development-location/scripts/locate-resource.mjs \
  --kind skill \
  --name <skill-id> \
  --project-root "$(pwd)"
```

4. Treat the locator's `path`, `sourceRoot`, `sourceRelativePath`, `config`,
   `frontmatterName`, and `git` fields as the resource identity. The Git root
   is `git.gitRoot`, and Git ownership is `git.managed`.
5. If the result is missing or ambiguous, stop and ask for clarification.
   Never choose a path from a similar directory name, search order, or recent
   modification time.
6. If the path is in a compatibility shell, symlink, cache, or generated
   mirror, stop and locate the real Git source instead.

The locator's configuration precedence is authoritative: `OPENCODE_CONFIG`,
then `OPENCODE_CONFIG_DIR/opencode.jsonc`, then
`OPENCODE_CONFIG_DIR/opencode.json`, then the default config location. If both
JSON and JSONC files exist, stop rather than selecting one silently.

## Inspect And Edit Safely

Before changing the located source, run:

```bash
git status --short --branch
git diff
git log --oneline -10
```

Keep unrelated user changes. If a new branch or parallel agent is requested,
use a sibling `worktrees/` directory next to the primary checkout and keep one
owner per file boundary. Do not reset or clean another agent's work.

Keep the skill's `name` stable unless the user explicitly approves an ID
change. Use only OpenCode-supported frontmatter fields. A description should
state when the skill is useful and what it solves; do not invent `trigger`,
`when`, or other custom activation fields.

Do not put absolute user paths, credentials, cookies, browser profiles,
session state, build output, or local logs into a skill. Runtime commands must
use repository-relative resources. When a registered repository resource must
be launched from OpenCode, use the installed `skillrepo exec <repo-id>
<repo-relative-resource>` command rather than guessing an installation path.

## Validate After Editing

1. Run the locator again and confirm it still identifies the exact file edited.
2. Parse the frontmatter and confirm the expected stable skill ID and field
   types.
3. Run focused tests, then the target repository's full tests.
4. Run `skillrepo doctor` or the repository's equivalent registration check.
5. Run `opencode debug skill` without a skill ID argument. Parse its JSON list
   and check the expected ID in the list.
6. Run `npm run test:opencode-runtime` or the repository equivalent when the
   change affects discovery or model-visible behavior.

Do not report success when a required verification fails. Preserve the failed
state and explain whether the cause is an unavailable OpenCode binary, config
ambiguity, an external edit, or a resource problem.

## Migration Handoff

Use a migration handoff only when the migration is non-dry-run, committed, and
OpenCode discovery verification has passed. The real skill file must come from
the persisted file-level `skillMappings` result, including nested
`SKILL.md` files; do not reconstruct it from a skill ID or directory name.

An `--no-verify` result may produce only a clearly marked `unverified`
handoff. Dry-run, preflight failure, moved-uncommitted, rollback, and
agent/lib-only results must not be presented as an editable successful
handoff.

<!-- SKILLREPO_SKILL_MODIFICATION_RUNTIME_MARKER_2026 -->
