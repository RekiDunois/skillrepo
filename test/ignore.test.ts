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

test('migration ignore dry-run is read-only and execute appends only safe observed patterns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const gitignore = join(repo, '.gitignore');

  try {
    await writePlan(plan);
    await mkdir(join(repo, 'skills', 'demo', '__pycache__'), { recursive: true });
    await mkdir(join(repo, 'skills', 'browser', 'chrome-profile'), { recursive: true });
    await mkdir(join(repo, '.venv'), { recursive: true });
    await writeFile(join(repo, '.env'), 'PRIVATE_CONFIG=local-only\n', 'utf8');
    await writeFile(join(repo, '.DS_Store'), 'finder\n', 'utf8');
    await writeFile(gitignore, '# keep my rules\ncustom.tmp\n', 'utf8');

    const dryRun = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.repositories.length, 1);
    assert.deepEqual(
      dryRun.repositories[0]!.patterns,
      ['.DS_Store', '.venv/', '__pycache__/', 'chrome-profile/'],
    );
    assert.doesNotMatch(renderMigrationIgnore(dryRun), /\.env/);
    assert.equal(await readFile(gitignore, 'utf8'), '# keep my rules\ncustom.tmp\n');
    await assert.rejects(access(join(repo, '.git')));

    const applied = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    assert.equal(applied.patterns, 4);
    const text = await readFile(gitignore, 'utf8');
    assert.match(text, /^# keep my rules\ncustom\.tmp\n/);
    assert.match(text, /# skillrepo: generated runtime\/cache ignores/);
    assert.match(text, /^\.DS_Store$/m);
    assert.match(text, /^\.venv\/$/m);
    assert.match(text, /^__pycache__\/$/m);
    assert.match(text, /^chrome-profile\/$/m);
    assert.doesNotMatch(text, /^\.env$/m);
    await assert.rejects(access(join(repo, '.git')));

    const second = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false });
    assert.equal(second.patterns, 0, 'second execution must be idempotent');
    assert.equal(await readFile(gitignore, 'utf8'), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
