import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { applyMigrationIgnores } from '../src/ignore.js';

async function locateGit(): Promise<string> {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ }
    }
  }
  throw new Error('Git executable not found on test PATH');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writePlan(path: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, repositories: [{ id: 'active-repo', action: 'CREATE_AND_MOVE' }] }, null, 2)}\n`,
    'utf8',
  );
}

test('gitignore staging creation failure never publishes a partial final file', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('permission-based staging failure fixture requires a non-root POSIX runner');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'skillrepo-gitignore-stage-failure-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const fakeGit = join(root, 'git');
  const gitignore = join(repo, '.gitignore');

  try {
    const realGit = await locateGit();
    await mkdir(repo, { recursive: true });
    await writePlan(plan);
    await writeFile(join(repo, 'debug.log'), 'runtime noise\n', 'utf8');
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "git version 2.0.0"; exit 0; fi',
      `if [ "$1" = "init" ]; then exec ${shellQuote(realGit)} "$@"; fi`,
      `${shellQuote(realGit)} "$@"`,
      'status=$?',
      'if [ -n "$GIT_WORK_TREE" ]; then chmod 0555 "$GIT_WORK_TREE"; fi',
      'exit "$status"',
      '',
    ].join('\n'), 'utf8');
    await chmod(fakeGit, 0o755);

    await assert.rejects(
      applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false, gitPath: fakeGit }),
    );

    await assert.rejects(
      access(gitignore),
      'a staging create/write lifecycle failure must not expose a final .gitignore',
    );
    const entries = await readdir(repo);
    assert.equal(
      entries.some(name => name.startsWith('.skillrepo-gitignore-')),
      false,
      'private staging names should be cleaned up when creation fails',
    );
  } finally {
    try { await chmod(repo, 0o755); } catch { /* fixture may not have reached chmod */ }
    await rm(root, { recursive: true, force: true });
  }
});
