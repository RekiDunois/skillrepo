import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration } from '../src/migration.js';

test('an unrelated schema-v1 journal does not block a new migration dry-run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-v1-journal-compat-'));
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  const configDir = join(root, 'config');
  const planPath = join(root, 'plan.json');
  const journalDir = join(sourceRoot, '.skillrepo-migrations');
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;

  try {
    process.env.OPENCODE_CONFIG_DIR = configDir;
    await mkdir(join(sourceRoot, 'skill', 'demo'), { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(journalDir, { recursive: true });
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

    // This is sufficient to be accepted by the schema-v1 loader shipped before
    // this PR. It intentionally belongs to a different historical transaction.
    await writeFile(
      join(journalDir, 'legacy.json'),
      `${JSON.stringify({ schemaVersion: 1, transactionId: 'legacy-tx', operations: [] }, null, 2)}\n`,
      'utf8',
    );

    const result = await applyMigration({
      planPath,
      targetRoot,
      dryRun: true,
      verify: false,
    });

    assert.equal(result.status, 'dry-run');
    assert.deepEqual(result.repositories, ['demo-repo']);
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  }
});
