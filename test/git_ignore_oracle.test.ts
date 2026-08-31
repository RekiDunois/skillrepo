import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { auditMigrationRepos } from '../src/audit.js';
import { applyMigrationIgnores } from '../src/ignore.js';
import { classifyMigrationPortability } from '../src/portability.js';
import { applyMigrationPortabilityFixes } from '../src/portability_fix.js';
import { auditMigrationCommitReadiness } from '../src/readiness.js';

const execFileAsync = promisify(execFile);

async function writePlan(path: string, repoId: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, repositories: [{ id: repoId, action: 'CREATE_AND_MOVE' }] }, null, 2)}\n`, 'utf8');
}

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

async function fixture(prefix: string, repoId: string): Promise<{ root: string; targetRoot: string; repo: string; plan: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, repoId);
  const plan = join(root, 'migration-plan.json');
  await mkdir(repo, { recursive: true });
  await writePlan(plan, repoId);
  return { root, targetRoot, repo, plan };
}

test('Git preflight fails before plan scanning when Git is unavailable', async () => {
  await assert.rejects(
    auditMigrationCommitReadiness({
      planPath: '/definitely/missing/migration-plan.json',
      targetRoot: '/definitely/missing/repos',
      env: { ...process.env, PATH: '' },
    }),
    /Git is required.*unavailable/i,
  );
});

test('portability fix preflights Git before reading the migration plan', async () => {
  await assert.rejects(
    applyMigrationPortabilityFixes({
      planPath: '/definitely/missing/migration-plan.json',
      targetRoot: '/definitely/missing/repos',
      env: { ...process.env, PATH: '' },
    }),
    /Git is required.*unavailable/i,
  );
});

test('explicit Git path works when ordinary PATH lookup is unavailable', async () => {
  const gitPath = await locateGit();
  const f = await fixture('skillrepo-git-explicit-', 'explicit-repo');
  try {
    await mkdir(join(f.repo, '.venv'));
    await writeFile(join(f.repo, '.gitignore'), '.venv/\n', 'utf8');
    const result = await auditMigrationCommitReadiness({
      planPath: f.plan,
      targetRoot: f.targetRoot,
      gitPath,
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.readyForInitialCommit, true);
    await assert.rejects(access(join(f.repo, '.git')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('CLI explicit --git path works when ordinary Git lookup is unavailable', async () => {
  const gitPath = await locateGit();
  const f = await fixture('skillrepo-git-cli-explicit-', 'cli-explicit-repo');
  try {
    await mkdir(join(f.repo, '.venv'));
    await writeFile(join(f.repo, '.gitignore'), '.venv/\n', 'utf8');
    const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, 'migration', 'audit', '--plan', f.plan, '--target-root', f.targetRoot, '--git', gitPath, '--json'],
      { env: { ...process.env, PATH: '' } },
    );
    assert.equal(stderr, '');
    const parsed = JSON.parse(stdout) as { readyForInitialCommit: boolean };
    assert.equal(parsed.readyForInitialCommit, true);
    await assert.rejects(access(join(f.repo, '.git')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('invalid explicit Git path fails with no parser fallback', async () => {
  await assert.rejects(
    auditMigrationCommitReadiness({
      planPath: '/definitely/missing/migration-plan.json',
      targetRoot: '/definitely/missing/repos',
      gitPath: '/definitely/missing/git',
    }),
    /Git is required.*unavailable/i,
  );
});

test('Git decides negation and last-match ordering', async () => {
  const f = await fixture('skillrepo-git-negation-', 'negation-repo');
  try {
    await mkdir(join(f.repo, '.venv'));
    await writeFile(join(f.repo, 'important.log'), 'keep me\n', 'utf8');
    await writeFile(join(f.repo, '.gitignore'), '.venv/\n!.venv/\n*.log\n!important.log\n', 'utf8');
    const result = await auditMigrationCommitReadiness({ planPath: f.plan, targetRoot: f.targetRoot });
    const repo = result.repositories[0]!;
    assert.ok(repo.ignoreCandidates.some(item => item.pattern === '.venv/' && item.paths.includes('.venv')));
    assert.ok(repo.ignoreCandidates.some(item => item.pattern === '*.log' && item.paths.includes('important.log')));
    assert.ok(repo.findings.some(item => item.code === 'local-runtime-environment'));
    assert.equal(result.readyForInitialCommit, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Git respects nested gitignore rules and escaped leading markers', async () => {
  const f = await fixture('skillrepo-git-nested-', 'nested-repo');
  try {
    await mkdir(join(f.repo, 'sub'));
    await writeFile(join(f.repo, 'sub', '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(f.repo, 'sub', 'debug.log'), 'ignored nested log\n', 'utf8');
    await writeFile(join(f.repo, '.gitignore'), '\\!literal.log\n\\#literal.log\n', 'utf8');
    await writeFile(join(f.repo, '!literal.log'), 'ignored bang\n', 'utf8');
    await writeFile(join(f.repo, '#literal.log'), 'ignored hash\n', 'utf8');
    const result = await auditMigrationRepos({ planPath: f.plan, targetRoot: f.targetRoot });
    const paths = result.repositories[0]!.ignoreCandidates.flatMap(item => item.paths);
    assert.equal(paths.includes('sub/debug.log'), false);
    assert.equal(paths.includes('!literal.log'), false);
    assert.equal(paths.includes('#literal.log'), false);
    await assert.rejects(access(join(f.repo, '.git')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('existing gitignore is manual-only and is never rewritten', async () => {
  const f = await fixture('skillrepo-git-manual-', 'manual-repo');
  try {
    await writeFile(join(f.repo, 'important.log'), 'keep\n', 'utf8');
    const original = '*.log\n!important.log\n';
    await writeFile(join(f.repo, '.gitignore'), original, 'utf8');
    const result = await applyMigrationIgnores({ planPath: f.plan, targetRoot: f.targetRoot, dryRun: false });
    assert.equal(result.repositories.length, 0);
    assert.equal(result.manualRepositories.length, 1);
    assert.equal(await readFile(join(f.repo, '.gitignore'), 'utf8'), original);
    await assert.rejects(access(join(f.repo, '.git')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('brand-new gitignore is created only for safe candidates and verified by Git', async () => {
  const f = await fixture('skillrepo-git-create-', 'create-repo');
  try {
    await mkdir(join(f.repo, '__pycache__'));
    const result = await applyMigrationIgnores({ planPath: f.plan, targetRoot: f.targetRoot, dryRun: false });
    assert.equal(result.repositories.length, 1);
    assert.equal(result.manualRepositories.length, 0);
    assert.match(await readFile(join(f.repo, '.gitignore'), 'utf8'), /__pycache__\//);
    const ready = await auditMigrationCommitReadiness({ planPath: f.plan, targetRoot: f.targetRoot });
    assert.equal(ready.readyForInitialCommit, true);
    await assert.rejects(access(join(f.repo, '.git')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('gitignore symlink is not followed or rewritten by skillrepo', async t => {
  if (process.platform === 'win32') { t.skip('symlink creation is not reliable on Windows CI'); return; }
  const f = await fixture('skillrepo-git-symlink-', 'symlink-repo');
  const outside = join(f.root, 'outside-ignore');
  try {
    await writeFile(outside, '*.log\n', 'utf8');
    await symlink(outside, join(f.repo, '.gitignore'));
    await writeFile(join(f.repo, 'debug.log'), 'not ignored because Git does not follow .gitignore symlinks\n', 'utf8');
    const audit = await auditMigrationRepos({ planPath: f.plan, targetRoot: f.targetRoot });
    assert.ok(audit.repositories[0]!.ignoreCandidates.some(item => item.paths.includes('debug.log')));
    const result = await applyMigrationIgnores({ planPath: f.plan, targetRoot: f.targetRoot, dryRun: false });
    assert.equal(result.repositories.length, 0);
    assert.equal(result.manualRepositories.length, 1);
    assert.equal(await readFile(outside, 'utf8'), '*.log\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Windows forward-slash home paths are detected and classified', async () => {
  const f = await fixture('skillrepo-win-home-', 'windows-home-repo');
  try {
    await writeFile(join(f.repo, 'notes.md'), 'path: C:/Users/example/project/tool\n', 'utf8');
    const audit = await auditMigrationRepos({ planPath: f.plan, targetRoot: f.targetRoot });
    assert.ok(audit.repositories[0]!.findings.some(item => item.code === 'absolute-home-path' && item.path === 'notes.md'));
    const portability = await classifyMigrationPortability({ planPath: f.plan, targetRoot: f.targetRoot });
    assert.equal(portability.items.length, 1);
    assert.deepEqual(portability.items[0]!.lines, [1]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
