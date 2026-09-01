import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration } from '../src/migration.js';

async function withConfigDir<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  const oldDir = process.env.OPENCODE_CONFIG_DIR;
  const oldConfig = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  delete process.env.OPENCODE_CONFIG;
  try {
    return await fn();
  } finally {
    if (oldDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = oldDir;
    if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = oldConfig;
  }
}

async function fixture(): Promise<{ root: string; sourceRoot: string; targetRoot: string; planPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-v1-journal-compat-'));
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  const configDir = join(root, 'config');
  const planPath = join(root, 'plan.json');
  await mkdir(join(sourceRoot, 'skill', 'demo'), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(sourceRoot, 'skill', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: demo\n---\n\nbody\n',
    'utf8',
  );
  await writeFile(
    planPath,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedFrom: { sourceRoot },
      repositories: [{ id: 'demo-repo', action: 'CREATE_AND_MOVE', skills: ['demo'], agents: [], libs: [] }],
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, sourceRoot, targetRoot, planPath };
}

async function writeLegacyJournal(
  sourceRoot: string,
  values: { planPath: string; targetRoot: string; status: string },
): Promise<void> {
  const directory = join(sourceRoot, '.skillrepo-migrations');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'legacy.json'), `${JSON.stringify({
    schemaVersion: 1,
    transactionId: 'legacy-transaction',
    planPath: values.planPath,
    planFingerprint: 'legacy-plan-fingerprint',
    sourceRoot,
    targetRoot: values.targetRoot,
    status: values.status,
    operations: [],
  }, null, 2)}\n`, 'utf8');
}

test('an unrelated minimal schema-v1 journal does not block a new migration dry-run', async () => {
  const f = await fixture();
  try {
    const journalDir = join(f.sourceRoot, '.skillrepo-migrations');
    await mkdir(journalDir, { recursive: true });
    // This is sufficient to be accepted by the schema-v1 loader shipped before
    // this PR. It intentionally belongs to a different historical transaction.
    await writeFile(
      join(journalDir, 'legacy.json'),
      `${JSON.stringify({ schemaVersion: 1, transactionId: 'legacy-tx', operations: [] }, null, 2)}\n`,
      'utf8',
    );

    await withConfigDir(join(f.root, 'config'), async () => {
      const result = await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        dryRun: true,
        verify: false,
      });
      assert.equal(result.status, 'dry-run');
      assert.deepEqual(result.repositories, ['demo-repo']);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a related incomplete v1 journal remains a migration blocker', async () => {
  const f = await fixture();
  try {
    await writeLegacyJournal(f.sourceRoot, {
      planPath: f.planPath,
      targetRoot: f.targetRoot,
      status: 'moved-uncommitted',
    });
    await withConfigDir(join(f.root, 'config'), async () => {
      await assert.rejects(
        () => applyMigration({
          planPath: f.planPath,
          targetRoot: f.targetRoot,
          dryRun: true,
          verify: false,
        }),
        /manual recovery required/i,
      );
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
