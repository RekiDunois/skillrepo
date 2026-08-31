import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
