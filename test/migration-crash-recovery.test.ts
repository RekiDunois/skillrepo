import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration } from '../src/migration.js';

async function fixture(): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  planPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-migration-crash-'));
  const sourceRoot = join(root, 'opencode');
  const targetRoot = join(root, 'repos');
  const planPath = join(root, 'migration-plan.json');

  await mkdir(join(sourceRoot, 'skill', 'alpha', 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'agents'), { recursive: true });
  await mkdir(join(sourceRoot, 'lib'), { recursive: true });
  await writeFile(join(sourceRoot, 'skill', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: test\n---\n', 'utf8');
  await writeFile(join(sourceRoot, 'skill', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  await writeFile(join(sourceRoot, 'agents', 'worker.md'), '---\ndescription: test\nmode: subagent\n---\nworker\n', 'utf8');
  await writeFile(join(sourceRoot, 'agents', 'helper.py'), 'print("helper")\n', 'utf8');
  await writeFile(join(sourceRoot, 'lib', 'shared.js'), 'export const answer = 42;\n', 'utf8');
  await writeFile(planPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot },
    repositories: [{
      id: 'demo-repo',
      action: 'CREATE_AND_MOVE',
      skills: ['alpha'],
      agents: ['worker.md', 'helper.py'],
      libs: ['lib/shared.js'],
    }],
  }, null, 2)}\n`, 'utf8');

  return { root, sourceRoot, targetRoot, planPath };
}

async function runCrash(f: Awaited<ReturnType<typeof fixture>>, label: string): Promise<void> {
  const migrationUrl = pathToFileURL(join(process.cwd(), 'dist', 'src', 'migration.js')).href;
  const script = `import { applyMigration } from ${JSON.stringify(migrationUrl)};
await applyMigration({
  planPath: ${JSON.stringify(f.planPath)},
  targetRoot: ${JSON.stringify(f.targetRoot)},
  verify: false,
});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENCODE_CONFIG_DIR: f.sourceRoot,
      SKILLREPO_TEST_CRASH_AFTER: label,
    },
    stdio: 'ignore',
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
}

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

const CRASH_POINTS = [
  'journal-created',
  'lock-owner-staged',
  'staging-published',
  'directory-created',
  'skill-shim-published',
  'skill-compatibility-symlink-created',
  'file-compatibility-symlink-created',
  'agent-registration-symlink-created',
] as const;

test('migration rollback recovers after each transactional crash point', { skip: process.platform === 'win32' }, async t => {
  for (const label of CRASH_POINTS) {
    await t.test(label, async () => {
      const f = await fixture();
      try {
        await runCrash(f, label);
        await withConfigDir(f.sourceRoot, async () => {
          await assert.rejects(
            () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
            /rollback-complete/,
          );
        });

        await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
        await access(join(f.sourceRoot, 'skill', 'alpha', 'scripts', 'run.sh'));
        await access(join(f.sourceRoot, 'agents', 'worker.md'));
        await access(join(f.sourceRoot, 'agents', 'helper.py'));
        await access(join(f.sourceRoot, 'lib', 'shared.js'));
        await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
        await assert.rejects(access(join(f.sourceRoot, '.skillrepo-migration.lock')));
        const journals = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
        assert.equal(journals.length, 1);
        const journal = JSON.parse(await readFile(join(f.sourceRoot, '.skillrepo-migrations', journals[0]!), 'utf8')) as {
          status: string;
        };
        assert.equal(journal.status, 'rollback-complete');
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
});

test('migration rejects a pre-existing staging parent symlink', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside-staging');
  try {
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(f.sourceRoot, '.skillrepo-migration-staging'));
    await assert.rejects(
      () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false }),
      /staging parent is not a real directory/,
    );
    await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
