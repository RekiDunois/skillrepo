---
name: skill-creation
description: Use when creating a brand-new OpenCode skill. Establish the target Git repository and unambiguous authoring layout before creating files, prevent overwrites, and verify the real source is registered and discoverable.
---

# Skill Creation

Use this workflow only when the requested skill does not already exist. For an
existing skill, load `skill-modification` instead. This workflow never copies a
skill into an OpenCode installation directory.

## Establish The Target

Do not create a skill in the current directory merely because it is convenient.
First confirm the target repository from the user's request. If the repository
is not clear, ask the user to choose one; do not choose by directory name,
search order, or recent modification time.

Run `pwd` and preserve its result when passing paths to later commands. Resolve
the target repository's real Git root:

```bash
git -C <repo> rev-parse --show-toplevel
```

The repository root, not `.apm`, is the value used for repository-relative
resources and `skillrepo exec`.

## Select One Layout

Inspect the confirmed repository before creating anything. Use exactly one
authoring layout:

```text
<repo>/skills/<SKILL_ID>/SKILL.md
<repo>/agents/
```

or:

```text
<repo>/apm.yml
<repo>/.apm/skills/<SKILL_ID>/SKILL.md
<repo>/.apm/agents/
```

If an existing repository has one layout, use that layout. If both supported
layouts are present, stop because the layout is ambiguous. If neither layout
exists in an existing repository, ask the user which layout to establish; do
not silently invent a directory. For a genuinely new empty repository, use
the package layout by default:

```bash
skillrepo init <repo>
```

`skillrepo init` creates `apm.yml` with the current minimum `name` and
`version: 0.1.0` fields, plus `.apm/skills`, by default. Use
`skillrepo init --layout legacy <repo>` only when the user explicitly requests
the legacy layout. `init` does not initialize Git or register the repository.

## Check Before Writing

The requested skill ID must be stable, valid, and used as the directory name.
Search the selected source directory and the configured OpenCode sources for an
existing skill with the same ID. If the skill already exists, refuse to
overwrite it and switch to the modification workflow only after confirming that
it is the intended existing skill. Do not infer identity from a nearby
directory.

Create only the selected source path. The new `SKILL.md` must have stable
OpenCode frontmatter:

```yaml
---
name: <SKILL_ID>
description: <when to use it and what problem it solves>
---
```

Use only OpenCode-supported frontmatter fields. Keep scripts in the skill's
own `scripts/` directory and keep references/assets repo-relative. Never put
absolute user paths, credentials, cookies, browser profiles, session state,
caches, or generated logs in the skill.

## Register And Verify

After the file is created, register the confirmed repository if it is not
already registered:

```bash
skillrepo register <repo>
```

Registration must point OpenCode at the selected source root and must not copy
the new skill. If registration reports an ambiguous layout or a duplicate
skill ID, stop and resolve that error rather than choosing a source.

Run the locator in authoring mode with the exact new ID and verify all of
these fields:

```bash
node <skill-development-location>/scripts/locate-resource.mjs \
  --kind skill \
  --name <SKILL_ID> \
  --project-root "$(pwd)" \
  --authoring
```

The result must carry `selectionMode: "authoring"` and identify exactly one
real `SKILL.md`, the expected `repoRoot`, the selected `layout`, the selected
`sourceRoot`, the expected `sourceRelativePath`, and managed Git state.
Re-run the authoring locator after any edit; `authoritative source not found`,
missing, or ambiguous results are failures. `consumerMatches` entries are
runtime/deployment copies and must not be edited directly.

If the repository is already deployed to another agent through a known
deployment, rerun that established deployment after the new skill is created
and verify the consumer with the deployment runtime's supported verification
(for APM, rerun `apm install` with the known existing scope and target). Do
not attempt to discover or overwrite unknown consumer trees automatically.

For runtime files, calculate paths from the returned repository root and use:

```text
skillrepo exec <repo-id> <repo-relative-resource>
```

For a package-layout skill, `.apm/skills/<SKILL_ID>/...` is part of the
repository-relative resource path. Never use `<repo>/.apm` as the repository
root.

## Audit Before A Formal Commit

When the repository is Git-managed, perform a complete pre-commit
publication/privacy audit of every file and line that will be included before a
formal commit. This is broader than secret scanning. Review for real corpus
traces or semantic combinations that fingerprint the corpus domain; private
workflows, benchmark values, internal development or debug records; real people
or names, email addresses, physical addresses, URLs or links; real institutions
such as universities, laboratories, research organizations, or companies; and
values that look like real keys, tags, identifiers, environment-specific links,
or other deployment-specific data. Also review for real publication venues from
the source corpus.

Delete or generalize any such material unless it is required for an end user to
understand the current functional contract. Use generic placeholders for venues,
institutions, people, identifiers, and environment-specific values. Example
semantics must not preserve a combination of corpus-domain terms that can
reconstruct the original corpus fingerprint.

Documentation committed with the skill must describe the final current contract,
not internal history. Remove or rewrite historical, migration, or evolution
narratives about how the workflow used to work, which step moved, or how an old
mechanism became a new one; state only the rule users need now.

Finally, parse the frontmatter, run focused tests and the repository test suite,
run `skillrepo doctor`, and verify the new ID in the JSON list from
`opencode debug skill` without passing a skill ID argument. Run the real
OpenCode runtime verification when the new skill changes model-visible
behavior.

<!-- SKILLREPO_SKILL_CREATION_RUNTIME_MARKER_2026 -->
