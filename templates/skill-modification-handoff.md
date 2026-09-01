SKILL_MODIFICATION_HANDOFF_BEGIN
# Skill Modification Task

- handoff_status: `<status>`
- config_path: `<config-path>`
- transaction_id: `<transaction-id>`
- journal_path: `<journal-path>`
- source_root: `<source-root>`
- target_root: `<target-root>`

## Skill Mapping

### `<skill-id>`

- skill_id: `<skill-id>`
- skill_file: `<target-path>`
- source_file: `<source-path>`
- repo_id: `<repo-id>`
- repo_root: `<repo-root>`
- git_state: `<git-state>`

## Before Editing

1. Run the locator and confirm the exact real `SKILL.md`.
2. Stop if the locator result is missing or ambiguous.
3. Check `git status --short --branch`, `git diff`, and `git log --oneline -10`.
4. Do not edit compatibility shells, symlinks, caches, or generated mirrors.

## After Editing

1. Re-run the locator and validate frontmatter.
2. Run focused and full repository tests.
3. Run `opencode debug skill` and check the ID in its JSON list.
4. Run the real `skill()` runtime test when behavior is model-visible.

SKILL_MODIFICATION_HANDOFF_END
