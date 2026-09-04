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
3. Run its locator with the explicit skill ID in authoring mode:

```bash
node /absolute/path/to/skills/skill-development-location/scripts/locate-resource.mjs \
  --kind skill \
  --name <skill-id> \
  --project-root "$(pwd)" \
  --authoring
```

4. Treat the locator's `path`, `sourceRoot`, `sourceRelativePath`, `repoRoot`,
   `layout`, `config`, `frontmatterName`, and `git` fields as the resource
   identity. `repoRoot` is the repository root used for repository-relative
   resources; it is never inferred by taking the parent of `.apm`. The Git root
   is `git.gitRoot`, and Git ownership is `git.managed`. The successful
   authoring result is the only editable source.
5. If the result is `authoritative source not found`, missing, or ambiguous,
   stop and ask for clarification. `authoritative source not found` means the
   only matches are runtime/deployment copies listed in `consumerMatches`;
   locate, register, or provide the real source repository instead of editing
   a copy. Never choose a path from a similar directory name, search order, or
   recent modification time.
6. If the path is in a compatibility shell, symlink, cache, or generated
   mirror, stop and locate the real Git source instead.

The locator supports both repository authoring layouts:

```text
<repo>/skills/<skill-id>/SKILL.md
<repo>/.apm/skills/<skill-id>/SKILL.md
```

The result's `layout` is `skillrepo` for the first form and `apm` for the
second. For package layout, `sourceRoot` is `<repo>/.apm/skills` while
`repoRoot` remains `<repo>`.

The locator's configuration precedence is authoritative: `OPENCODE_CONFIG`,
then `OPENCODE_CONFIG_DIR/opencode.jsonc`, then
`OPENCODE_CONFIG_DIR/opencode.json`, then the default config location. If both
JSON and JSONC files exist, stop rather than selecting one silently.

## Redeploy Instead Of Editing Copies

`consumerMatches` in an authoring result are runtime/deployment copies. They
must not be edited directly, and a consumer copy must never be selected by
directory order, timestamp, or Git-state heuristics.

- If a non-OpenCode deployment is already known from the task or context,
  redeploy it through its owning package manager instead of editing the copy.
- For an APM deployment, reuse the known existing scope and target and rerun
  `apm install`. Do not infer or invent `--global`, `--target`, the package
  identity, or the install root from the consumer path alone.
- Verify the consumer after redeploying with the deployment runtime's
  supported verification. Use APM install/audit/drift tooling only when the
  owning APM context is actually known.
- If the provenance or scope is not known, report the consumer match as
  requiring redeploy; do not overwrite it.

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
be launched from OpenCode, calculate the resource path from the locator's
`repoRoot` and use the installed `skillrepo exec <repo-id>
<repo-relative-resource>` command rather than guessing an installation path. A
package-layout resource such as `<repo>/.apm/skills/foo/scripts/run.sh` is
passed as `.apm/skills/foo/scripts/run.sh`, not as a path relative to `.apm`.

## Validate After Editing

1. Run the authoring locator again with the same `--authoring` call and confirm
   the exact target file, `repoRoot`, `layout`, and `sourceRoot` are unchanged.
   A changed source identity is a failure.
2. Parse the frontmatter and confirm the expected stable skill ID and field
   types.
3. Run focused tests, then the target repository's full tests.
4. Run `skillrepo doctor` or the repository's equivalent registration check.
5. Run `opencode debug skill` without a skill ID argument. Parse its JSON list
   and check the expected ID in the list.
6. Run `npm run test:opencode-runtime` or the repository equivalent when the
   change affects discovery or model-visible behavior.
7. When a known non-OpenCode deployment exists for the edited source, redeploy
   it through its owning package manager as described in
   "Redeploy Instead Of Editing Copies" and verify the deployed consumer.

Do not report success when a required verification fails. Preserve the failed
state and explain whether the cause is an unavailable OpenCode binary, config
ambiguity, an external edit, or a resource problem.

## Audit Before A Formal Commit

When the repository is Git-managed, perform a complete pre-commit
publication/privacy audit of every file and line included in the formal commit.
Do not limit this to secrets. Review for real corpus traces or semantic
combinations that fingerprint the corpus domain; private workflows, benchmark
values, internal development or debug records; real people or names, email
addresses, physical addresses, URLs or links; real institutions such as
universities, laboratories, research organizations, or companies; values that
look like real keys, tags, identifiers, environment-specific links, or other
deployment-specific data; and real publication venues used by the source
corpus.

Delete or generalize anything in those categories unless an end user needs it
to understand the current functional contract. Use generic placeholders for
venues, institutions, people, identifiers, and environment-specific values.
Semantic examples must not retain a combination of corpus-domain terms that can
reconstruct the original corpus fingerprint.

Documentation must state the final current contract only. Remove or rewrite
internal history, migration, or evolution narratives about previous workflows,
steps being moved, or old mechanisms becoming new ones; keep only the rule the
user needs now.

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
