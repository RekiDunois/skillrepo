import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { auditMigrationRepos } from '../src/audit.js';
import { applyMigrationIgnores } from '../src/ignore.js';

const execFileAsync = promisify(execFile);

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

async function writePlan(path: string, repoId: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, repositories: [{ id: repoId, action: 'CREATE_AND_MOVE' }] }, null, 2)}\n`,
    'utf8',
  );
}

test('initialized repository ignores inherited GIT_COMMON_DIR from another repo', async () => {
  const gitPath = await locateGit();
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-git-common-dir-'));
  const targetRoot = join(root, 'repos');
  const targetRepo = join(targetRoot, 'target-repo');
  const otherRepo = join(root, 'other-repo');
  const plan = join(root, 'migration-plan.json');
  const targetExcludes = join(root, 'target-excludes');
  const otherExcludes = join(root, 'other-excludes');

  try {
    await mkdir(targetRepo, { recursive: true });
    await mkdir(otherRepo, { recursive: true });
    await writePlan(plan, 'target-repo');

    await execFileAsync(gitPath, ['init', '--quiet', targetRepo]);
    await execFileAsync(gitPath, ['init', '--quiet', otherRepo]);

    await writeFile(join(targetRepo, '.git', 'info', 'exclude'), '*.log\n', 'utf8');
    await writeFile(targetExcludes, '*.tmp\n', 'utf8');
    await execFileAsync(gitPath, ['-C', targetRepo, 'config', '--local', 'core.excludesFile', targetExcludes]);

    await writeFile(join(otherRepo, '.git', 'info', 'exclude'), '*.temp\n', 'utf8');
    await writeFile(otherExcludes, '*.swo\n', 'utf8');
    await execFileAsync(gitPath, ['-C', otherRepo, 'config', '--local', 'core.excludesFile', otherExcludes]);

    await writeFile(join(targetRepo, 'debug.log'), 'ignored by target info/exclude\n', 'utf8');
    await writeFile(join(targetRepo, 'scratch.tmp'), 'ignored by target local config\n', 'utf8');

    const pollutedEnv = { ...process.env, GIT_COMMON_DIR: join(otherRepo, '.git') };
    const audit = await auditMigrationRepos({ planPath: plan, targetRoot, gitPath, env: pollutedEnv });
    const candidates = audit.repositories[0]!.ignoreCandidates.flatMap(item => item.paths);
    assert.equal(candidates.includes('debug.log'), false, 'target info/exclude must win over inherited GIT_COMMON_DIR');
    assert.equal(candidates.includes('scratch.tmp'), false, 'target local core.excludesFile must win over inherited GIT_COMMON_DIR');

    const ignored = await applyMigrationIgnores({
      planPath: plan,
      targetRoot,
      dryRun: false,
      gitPath,
      env: pollutedEnv,
    });
    assert.equal(ignored.repositories.length, 0);
    assert.equal(ignored.manualRepositories.length, 0);
    await assert.rejects(
      access(join(targetRepo, '.gitignore')),
      'polluted GIT_COMMON_DIR must not cause a redundant root .gitignore',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uninitialized oracle does not inherit GIT_COMMON_DIR excludes from another repo', async () => {
  const gitPath = await locateGit();
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-git-common-dir-temp-'));
  const targetRoot = join(root, 'repos');
  const targetRepo = join(targetRoot, 'target-repo');
  const otherRepo = join(root, 'other-repo');
  const plan = join(root, 'migration-plan.json');

  try {
    await mkdir(targetRepo, { recursive: true });
    await mkdir(otherRepo, { recursive: true });
    await writePlan(plan, 'target-repo');
    await execFileAsync(gitPath, ['init', '--quiet', otherRepo]);
    await writeFile(join(otherRepo, '.git', 'info', 'exclude'), '*.tmp\n', 'utf8');
    await writeFile(join(targetRepo, 'scratch.tmp'), 'must remain unignored in uninitialized target\n', 'utf8');

    const pollutedEnv = { ...process.env, GIT_COMMON_DIR: join(otherRepo, '.git') };
    const audit = await auditMigrationRepos({ planPath: plan, targetRoot, gitPath, env: pollutedEnv });
    const candidates = audit.repositories[0]!.ignoreCandidates.flatMap(item => item.paths);
    assert.equal(candidates.includes('scratch.tmp'), true, 'temporary oracle must not inherit another repo info/exclude');
    await assert.rejects(access(join(targetRepo, '.git')), 'temporary oracle must not initialize the target repo');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
