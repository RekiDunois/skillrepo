import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { applyMigrationIgnores, renderMigrationIgnore } from '../src/ignore.js';

async function writePlan(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot: '/unused' },
    repositories: [
      { id: 'active-repo', action: 'CREATE_AND_MOVE', skills: [], agents: [], libs: [] },
    ],
  }, null, 2)}\n`, 'utf8');
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function makeNoise(repo: string): Promise<void> {
  await mkdir(join(repo, 'skills', 'demo', '__pycache__'), { recursive: true });
  await mkdir(join(repo, 'skills', 'browser', 'chrome-profile'), { recursive: true });
  await mkdir(join(repo, '.venv'), { recursive: true });
  await writeFile(join(repo, '.env'), 'PRIVATE_CONFIG=local-only\n', 'utf8');
  await writeFile(join(repo, '.DS_Store'), 'finder\n', 'utf8');
}

test('migration ignore never rewrites an existing gitignore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-existing-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const gitignore = join(repo, '.gitignore');

  try {
    await writePlan(plan);
    await makeNoise(repo);
    const original = '# keep my rules\ncustom.tmp\n';
    await writeFile(gitignore, original, 'utf8');

    const dryRun = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: true });
    assert.equal(dryRun.repositories.length, 0);
    assert.equal(dryRun.manualRepositories.length, 1);
    assert.deepEqual(
      dryRun.manualRepositories[0]!.patterns,
      ['.DS_Store', '.venv/', '__pycache__/', 'chrome-profile/'],
    );
    assert.match(renderMigrationIgnore(dryRun), /\[MANUAL\]/);
    assert.doesNotMatch(renderMigrationIgnore(dryRun), /\.env/);
    assert.equal(await readFile(gitignore, 'utf8'), original);

    const applied = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    assert.equal(applied.patterns, 0);
    assert.equal(applied.repositories.length, 0);
    assert.equal(applied.manualRepositories.length, 1);
    assert.equal(await readFile(gitignore, 'utf8'), original);
    await assert.rejects(access(join(repo, '.git')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration ignore creates and verifies a brand-new gitignore from safe observed patterns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-new-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const gitignore = join(repo, '.gitignore');

  try {
    await writePlan(plan);
    await makeNoise(repo);

    const dryRun = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: true });
    assert.equal(dryRun.repositories.length, 1);
    assert.equal(dryRun.manualRepositories.length, 0);
    assert.deepEqual(dryRun.repositories[0]!.patterns, ['.DS_Store', '.venv/', '__pycache__/', 'chrome-profile/']);
    await assert.rejects(access(gitignore));

    const applied = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    assert.equal(applied.patterns, 4);
    const text = await readFile(gitignore, 'utf8');
    assert.match(text, /# skillrepo: generated runtime\/cache ignores/);
    assert.match(text, /^\.DS_Store$/m);
    assert.match(text, /^\.venv\/$/m);
    assert.match(text, /^__pycache__\/$/m);
    assert.match(text, /^chrome-profile\/$/m);
    assert.doesNotMatch(text, /^\.env$/m);
    await assert.rejects(access(join(repo, '.git')));

    const second = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    assert.equal(second.patterns, 0);
    assert.equal(second.repositories.length, 0);
    assert.equal(second.manualRepositories.length, 0, 'all observed safe paths are already ignored according to Git');
    assert.equal(await readFile(gitignore, 'utf8'), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated file-noise patterns cover every concrete observed path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-exact-patterns-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const gitignore = join(repo, '.gitignore');

  try {
    await writePlan(plan);
    await mkdir(repo, { recursive: true });
    for (const name of ['scratch.temp', 'editor.swo', 'yarn-error.log', 'thumbs.db', 'COVERAGE.XML']) {
      await writeFile(join(repo, name), 'runtime noise\n', 'utf8');
    }

    const dryRun = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: true });
    assert.equal(dryRun.repositories.length, 1);
    assert.deepEqual(
      [...dryRun.repositories[0]!.patterns].sort(),
      ['*.swo', '*.temp', 'COVERAGE.XML', 'thumbs.db', 'yarn-error.log'].sort(),
    );

    await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    const text = await readFile(gitignore, 'utf8');
    for (const pattern of ['*.temp', '*.swo', 'yarn-error.log', 'thumbs.db', 'COVERAGE.XML']) {
      assert.ok(text.split(/\r?\n/).includes(pattern), `expected exact safe pattern ${pattern}`);
    }
    const second = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    assert.equal(second.patterns, 0, 'Git must confirm every concrete observed path is ignored after creation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification failure leaves the atomically published gitignore for manual review', async t => {
  if (process.platform === 'win32') { t.skip('shell wrapper fixture is POSIX-only'); return; }
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-verification-failure-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const gitignore = join(repo, '.gitignore');
  const fakeGit = join(root, 'git');

  try {
    const realGit = await locateGit();
    await writePlan(plan);
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'debug.log'), 'runtime noise\n', 'utf8');
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "git version 2.0.0"; exit 0; fi',
      `if [ "$1" = "init" ]; then exec ${shellQuote(realGit)} "$@"; fi`,
      'cat >/dev/null',
      'exit 1',
      '',
    ].join('\n'), 'utf8');
    await chmod(fakeGit, 0o755);

    await assert.rejects(
      applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false, gitPath: fakeGit }),
      /left in place for manual review.*never deletes a published \.gitignore/,
    );
    const text = await readFile(gitignore, 'utf8');
    assert.match(text, /# skillrepo: generated runtime\/cache ignores/);
    assert.match(text, /^\*\.log$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification failure never deletes a concurrently edited published gitignore', async t => {
  if (process.platform === 'win32') { t.skip('shell wrapper fixture is POSIX-only'); return; }
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-verification-edit-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const gitignore = join(repo, '.gitignore');
  const fakeGit = join(root, 'git');

  try {
    const realGit = await locateGit();
    await writePlan(plan);
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'debug.log'), 'runtime noise\n', 'utf8');
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "git version 2.0.0"; exit 0; fi',
      `if [ "$1" = "init" ]; then exec ${shellQuote(realGit)} "$@"; fi`,
      'cat >/dev/null',
      'if [ -f "$GIT_WORK_TREE/.gitignore" ]; then printf "# user edit\\n" >> "$GIT_WORK_TREE/.gitignore"; fi',
      'exit 1',
      '',
    ].join('\n'), 'utf8');
    await chmod(fakeGit, 0o755);

    await assert.rejects(
      applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false, gitPath: fakeGit }),
      /left in place for manual review.*never deletes a published \.gitignore/,
    );
    assert.match(await readFile(gitignore, 'utf8'), /# user edit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
