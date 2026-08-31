# OpenCode migration snapshot via drive-sync-harness

This workflow creates a stable Google Drive snapshot of an existing OpenCode config tree for migration analysis.

The `drive-sync-harness` repository builds the `sync-cli` CLI. Its profile source root is treated as the logical Gitignore root even when the source is not a Git repository. Root and nested `.gitignore` files are captured into a committed synchronization-policy snapshot. Global Git excludes and `.git/info/exclude` are not used.

Important behavior:

- `sync-cli profile add` captures the current `.gitignore` policy before the first synchronization is queued.
- Changing `.gitignore` later does not immediately change the active policy; use `sync-cli profile ignore update <profile>`.
- Local symlinks are skipped by the synchronization scan. They are not followed.
- `profile add` creates an enabled, ongoing synchronization profile. For migration analysis, disable it after the first ready state to freeze the Drive snapshot.

## 1. Prepare the source policy

The intended source is normally:

```bash
~/.config/opencode
```

Copy the migration policy template to the source root **before creating the sync profile**:

```bash
cp templates/opencode-migration.gitignore ~/.config/opencode/.gitignore
```

If `~/.config/opencode/.gitignore` already exists, merge the template into it instead of overwriting the existing file.

The template keeps config, skills, agents, scripts, references, assets, package manifests, lockfiles, and other human-authored material. It excludes obvious VCS metadata, dependency trees, caches, browser/session stores, local databases, logs, temporary files, backups, and common standalone credential files.

A `.gitignore` is not a content redactor. A secret embedded inside an otherwise included config/source file is still eligible for synchronization.

## 2. Export a structure inventory

From the `skillrepo` checkout:

```bash
npm install
npm run inventory:opencode -- ~/.config/opencode
```

Equivalent direct invocation:

```bash
node scripts/export-opencode-structure.mjs ~/.config/opencode
```

The default output directory is:

```text
~/.config/opencode/.skillrepo-inventory/
```

It contains:

- `structure.json` — machine-readable file/directory/symlink inventory.
- `structure.txt` — compact human-readable tree.
- `sensitive-paths.txt` — filename-based candidates that deserve review before synchronization.

The exporter does not read file contents. Known noisy VCS/dependency/cache directories are represented as pruned directory entries instead of dumping all of their children. Symlinks are recorded without following them, including whether their resolved target is inside or outside the OpenCode source root.

Before continuing, inspect `structure.json`:

- If `summary.externalSymlinks` is greater than zero, stop and decide how those targets should be captured. `sync-cli` will not upload the symlink targets through the source link.
- Review `sensitive-paths.txt`. It is only a filename heuristic and is not proof that the remaining files contain no secrets.

## 3. Create the Google Drive snapshot profile

Use a dedicated profile ID and remote path for this migration snapshot. Example placeholders:

```bash
sync-cli profile add \
  opencode-migration-snapshot \
  ~/.config/opencode \
  <remote> \
  '<remote-path>' \
  --type generic \
  --wait
```

`--wait` waits until the worker-owned initial synchronization reaches `ready`.

Because the `.gitignore` was installed before `profile add`, the first upload uses the intended policy snapshot. There is no need to run `profile ignore update` for the initial snapshot.

## 4. Verify the synchronized state

```bash
sync-cli profile ignore status opencode-migration-snapshot
sync-cli profile status opencode-migration-snapshot
```

The ignore status should report the current disk snapshot as clean and the policy refresh as ready. The profile should reach the ready state without a terminal error.

## 5. Freeze the snapshot

Once the initial upload is ready:

```bash
sync-cli profile disable opencode-migration-snapshot
```

Disabling stops the profile jobs while keeping the remote data. This gives migration analysis a stable Drive snapshot even if the local OpenCode tree changes later.

## If the ignore policy changes after profile creation

Prefer deciding the migration `.gitignore` before `profile add`. If it must change while the profile is still being used:

```bash
sync-cli profile ignore update opencode-migration-snapshot
sync-cli profile wait opencode-migration-snapshot
```

Do not assume a policy change retroactively cleans every object that may already have been uploaded under an older policy. For a clean migration snapshot, finalizing the policy before first synchronization is safer.

## After the snapshot is ready

Provide the Drive folder or enough identifying context to locate it. Migration analysis should use the synchronized files together with `.skillrepo-inventory/structure.json`, especially the recorded symlink and pruned-directory information.
