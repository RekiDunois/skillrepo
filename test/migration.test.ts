import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
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

async function writePlan(path: string, sourceRoot: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot },
    repositories: [
      {
        id: 'demo-repo',
        action: 'CREATE_AND_MOVE',
        skills: ['alpha'],
        agents: ['worker.md', 'agent-helper.py'],
        libs: ['lib/shared.js'],
      },
      {
        id: 'held-repo',
        action: 'HOLD_PENDING_APPROVAL',
        skills: ['held'],
        agents: [],
        libs: [],
      },
    ],
  }, null, 2)}\n`, 'utf8');
}

async function fixture(): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  planPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-migration-'));
  const sourceRoot = join(root, 'opencode');
  const targetRoot = join(root, 'repos');
  const planPath = join(root, 'migration-plan.json');

  await mkdir(join(sourceRoot, 'skill', 'alpha', 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'skill', 'held'), { recursive: true });
  await mkdir(join(sourceRoot, 'agents'), { recursive: true });
  await mkdir(join(sourceRoot, 'lib'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'skill', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: test\n---\n',
    'utf8',
  );
  await writeFile(join(sourceRoot, 'skill', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  await writeFile(
    join(sourceRoot, 'skill', 'held', 'SKILL.md'),
    '---\nname: held\ndescription: held\n---\n',
    'utf8',
  );
  await writeFile(
    join(sourceRoot, 'agents', 'worker.md'),
    '---\ndescription: test\nmode: subagent\n---\nworker body\n',
    'utf8',
  );
  await writeFile(join(sourceRoot, 'agents', 'agent-helper.py'), 'print("helper")\n', 'utf8');
  await writeFile(join(sourceRoot, 'lib', 'shared.js'), 'export const answer = 42;\n', 'utf8');
  await writePlan(planPath, sourceRoot);

  return { root, sourceRoot, targetRoot, planPath };
}

test('migration dry-run performs no writes', async () => {
  const f = await fixture();
  try {
    await withConfigDir(f.sourceRoot, async () => {
      const result = await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        dryRun: true,
        verify: false,
      });
      assert.equal(result.dryRun, true);
      assert.equal(result.moves.length, 4);
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md')));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration mechanically moves content, keeps runtime compatibility, and registers repo', async () => {
  const f = await fixture();
  try {
    await withConfigDir(f.sourceRoot, async () => {
      const result = await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        verify: false,
      });
      assert.equal(result.dryRun, false);
      assert.deepEqual(result.repositories, ['demo-repo']);

      const repo = join(f.targetRoot, 'demo-repo');
      await access(join(repo, 'skills', 'alpha', 'SKILL.md'));
      await access(join(repo, 'skills', 'alpha', 'scripts', 'run.sh'));
      assert.equal(
        await readlink(join(f.sourceRoot, 'skill', 'alpha', 'scripts')),
        join(repo, 'skills', 'alpha', 'scripts'),
      );
      await assert.rejects(access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md')));
      await access(join(f.sourceRoot, 'skill', 'held', 'SKILL.md'));

      assert.equal(
        await readlink(join(f.sourceRoot, 'lib', 'shared.js')),
        join(repo, 'lib', 'shared.js'),
      );

      const agent = await readFile(join(repo, 'agents', 'worker.md'), 'utf8');
      assert.match(agent, /^---\nname: worker\n/);
      assert.equal(await readFile(join(repo, 'agents', 'agent-helper.py'), 'utf8'), 'print("helper")\n');
      await assert.rejects(access(join(f.sourceRoot, 'agents', 'worker.md')));
      assert.equal(
        await readlink(join(f.sourceRoot, 'agents', 'agent-helper.py')),
        join(repo, 'agents', 'agent-helper.py'),
      );
      assert.equal(await readFile(join(f.sourceRoot, 'agents', 'agent-helper.py'), 'utf8'), 'print("helper")\n');
      assert.equal(
        await readlink(join(f.sourceRoot, 'agents', 'demo-repo')),
        join(repo, 'agents'),
      );

      const config = await readFile(join(f.sourceRoot, 'opencode.jsonc'), 'utf8');
      assert.match(config, /demo-repo/);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration preflight blocks target collisions before moving anything', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.targetRoot, 'demo-repo', 'skills', 'alpha'), { recursive: true });
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({
          planPath: f.planPath,
          targetRoot: f.targetRoot,
          dryRun: true,
          verify: false,
        }),
        /Migration target already exists/,
      );
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await access(join(f.sourceRoot, 'agents', 'worker.md'));
      await access(join(f.sourceRoot, 'agents', 'agent-helper.py'));
      await access(join(f.sourceRoot, 'lib', 'shared.js'));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
