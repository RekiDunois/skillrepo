import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditMigrationRepos, renderMigrationAudit } from '../src/audit.js';

async function fixturePlan(path: string, activeRepo = 'active-repo'): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot: '/unused-for-audit' },
    repositories: [
      { id: activeRepo, action: 'CREATE_AND_MOVE', skills: [], agents: [], libs: [] },
      { id: 'held-repo', action: 'HOLD_PENDING_APPROVAL', skills: [], agents: [], libs: [] },
    ],
  }, null, 2)}\n`, 'utf8');
}

test('migration audit is read-only and reports privacy/commit blockers without echoing secret values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-audit-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'active-repo');
  const plan = join(root, 'migration-plan.json');
  const fakeSecret = 'AKIA' + 'ABCDEFGHIJKLMNOP';

  try {
    await fixturePlan(plan);
    await mkdir(join(repo, 'skills', 'demo'), { recursive: true });
    await mkdir(join(repo, '.venv', 'bin'), { recursive: true });
    await mkdir(join(repo, 'vendor', 'embedded', '.git'), { recursive: true });
    await mkdir(join(targetRoot, 'outside'), { recursive: true });
    await writeFile(join(repo, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n', 'utf8');
    await writeFile(join(repo, '.env'), `AWS_ACCESS_KEY_ID=${fakeSecret}\n`, 'utf8');
    await writeFile(join(repo, '.venv', 'bin', 'python'), 'local-runtime\n', 'utf8');
    await writeFile(join(repo, 'vendor', 'embedded', '.git', 'config'), '[core]\n', 'utf8');
    await writeFile(join(repo, 'server.log'), 'runtime log\n', 'utf8');
    await writeFile(join(repo, 'script.py'), 'ROOT = "/Users/example/private/tool"\n', 'utf8');
    await symlink('../outside', join(repo, 'external-link'));

    const result = await auditMigrationRepos({ planPath: plan, targetRoot });
    assert.equal(result.repositories.length, 1, 'HOLD repos must not be audited as migration targets');
    assert.equal(result.readyForInitialCommit, false);

    const audited = result.repositories[0]!;
    assert.equal(audited.repoId, 'active-repo');
    assert.ok(audited.findings.some(item => item.code === 'sensitive-env-path' && item.severity === 'blocker'));
    assert.ok(audited.findings.some(item => item.code === 'aws-access-key-content' && item.severity === 'blocker'));
    assert.ok(audited.findings.some(item => item.code === 'embedded-git' && item.severity === 'blocker'));
    assert.ok(audited.findings.some(item => item.code === 'local-runtime-environment' && item.severity === 'review'));
    assert.ok(audited.findings.some(item => item.code === 'absolute-home-path' && item.severity === 'review'));
    assert.ok(audited.findings.some(item => item.code === 'external-symlink' && item.severity === 'review'));

    const ignorePatterns = audited.ignoreCandidates.map(item => item.pattern);
    assert.ok(ignorePatterns.includes('.env'));
    assert.ok(ignorePatterns.includes('.venv/'));
    assert.ok(ignorePatterns.includes('*.log'));

    const serialized = JSON.stringify(result);
    const rendered = renderMigrationAudit(result);
    assert.equal(serialized.includes(fakeSecret), false, 'audit JSON must not echo detected secret values');
    assert.equal(rendered.includes(fakeSecret), false, 'human audit output must not echo detected secret values');
    assert.match(rendered, /COMMIT-READY: NO/);
    await assert.rejects(access(join(repo, '.gitignore')), 'audit must not create .gitignore');
    await assert.rejects(access(join(repo, '.git')), 'audit must not initialize Git');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing exact ignore rules suppress observed noise suggestions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-audit-clean-'));
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'clean-repo');
  const plan = join(root, 'migration-plan.json');

  try {
    await fixturePlan(plan, 'clean-repo');
    await mkdir(join(repo, 'skills', 'demo'), { recursive: true });
    await writeFile(join(repo, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n', 'utf8');
    await writeFile(join(repo, '.gitignore'), '*.log\n', 'utf8');
    await writeFile(join(repo, 'server.log'), 'ignored runtime log\n', 'utf8');

    const result = await auditMigrationRepos({ planPath: plan, targetRoot });
    const audited = result.repositories[0]!;
    assert.equal(audited.gitignorePresent, true);
    assert.deepEqual(audited.findings, []);
    assert.deepEqual(audited.ignoreCandidates, []);
    assert.equal(audited.readyForInitialCommit, true);
    assert.equal(result.readyForInitialCommit, true);
    assert.match(renderMigrationAudit(result), /COMMIT-READY: YES/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
