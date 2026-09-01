import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditMigrationCommitReadiness } from '../src/readiness.js';

async function writePlan(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot: '/unused' },
    repositories: [
      { id: 'ready-repo', action: 'CREATE_AND_MOVE', skills: [], agents: [], libs: [] },
    ],
  }, null, 2)}\n`, 'utf8');
}

test('ignored local virtual environments do not block commit readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-readiness-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'ready-repo');
  const plan = join(root, 'migration-plan.json');

  try {
    await writePlan(plan);
    await mkdir(join(repo, '.venv', 'bin'), { recursive: true });
    await writeFile(join(repo, '.venv', 'bin', 'python'), 'local runtime\n', 'utf8');
    await writeFile(join(repo, '.gitignore'), '.venv/\n', 'utf8');

    const result = await auditMigrationCommitReadiness({ planPath: plan, targetRoot });
    const audited = result.repositories[0]!;
    assert.deepEqual(audited.findings, []);
    assert.deepEqual(audited.ignoreCandidates, []);
    assert.equal(audited.readyForInitialCommit, true);
    assert.equal(result.summary.reviews, 0);
    assert.equal(result.readyForInitialCommit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unignored local virtual environments still block commit readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-readiness-unignored-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'ready-repo');
  const plan = join(root, 'migration-plan.json');

  try {
    await writePlan(plan);
    await mkdir(join(repo, '.venv', 'bin'), { recursive: true });
    await writeFile(join(repo, '.venv', 'bin', 'python'), 'local runtime\n', 'utf8');

    const result = await auditMigrationCommitReadiness({ planPath: plan, targetRoot });
    const audited = result.repositories[0]!;
    assert.equal(audited.findings.some(item => item.code === 'local-runtime-environment'), true);
    assert.equal(audited.ignoreCandidates.some(item => item.pattern === '.venv/'), true);
    assert.equal(audited.readyForInitialCommit, false);
    assert.equal(result.readyForInitialCommit, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
