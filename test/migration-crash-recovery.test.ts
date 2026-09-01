import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

async function runCrash(
  f: Awaited<ReturnType<typeof fixture>>,
  label: string,
  resume = false,
): Promise<void> {
  const migrationUrl = pathToFileURL(join(process.cwd(), 'dist', 'src', 'migration.js')).href;
  const script = `import { applyMigration } from ${JSON.stringify(migrationUrl)};
await applyMigration({
  planPath: ${JSON.stringify(f.planPath)},
  targetRoot: ${JSON.stringify(f.targetRoot)},
  resume: ${resume},
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
  'directory-published',
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

test('migration rollback resumes after rollback itself is killed', { skip: process.platform === 'win32' }, async t => {
  const cases = [
    { initial: 'config-written', rollback: 'rollback-config-restored' },
    { initial: 'agent-registration-symlink-created', rollback: 'rollback-agent-link-removed' },
    { initial: 'file-compatibility-symlink-created', rollback: 'rollback-target-restored' },
    { initial: 'skill-compatibility-symlink-created', rollback: 'rollback-skill-shim-marker-removed' },
    { initial: 'config-written', rollback: 'rollback-agent-backup-removed' },
  ] as const;

  for (const scenario of cases) {
    await t.test(`${scenario.initial} -> ${scenario.rollback}`, async () => {
      const f = await fixture();
      try {
        await runCrash(f, scenario.initial);
        await runCrash(f, scenario.rollback, true);
        await withConfigDir(f.sourceRoot, async () => {
          await assert.rejects(
            () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
            /rollback-complete/,
          );
        });
        await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
        await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
});

test('rollback preserves staging content modified after rollback begins', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'directory-published');
    await runCrash(f, 'rollback-started', true);

    const names = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
    const journalPath = join(f.sourceRoot, '.skillrepo-migrations', names.find(name => name.endsWith('.json'))!);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ source: string; stagePath: string }>;
    };
    const operation = journal.operations.find(item => item.source.endsWith(`${join('agents', 'helper.py')}`))!;
    await writeFile(operation.stagePath, 'external edit\n', 'utf8');

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-incomplete/,
      );
    });
    assert.equal(await readFile(operation.stagePath, 'utf8'), 'external edit\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration never follows a pre-existing agent backup symlink', async () => {
  const f = await fixture();
  const journalDir = join(f.sourceRoot, '.skillrepo-migrations');
  const outside = join(f.root, 'outside.txt');
  try {
    await mkdir(journalDir, { recursive: true });
    await writeFile(outside, 'sentinel\n', 'utf8');
    await symlink(outside, join(journalDir, 'op-0002.original'));

    await withConfigDir(f.sourceRoot, async () => {
      await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
    });
    assert.equal(await readFile(outside, 'utf8'), 'sentinel\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback recovers after stable agent rewrite is killed', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'agent-stable-name-written');
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
    await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback recovers after generated-agent rewrite is killed mid-write', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'agent-stable-name-partial-write');
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback resumes after generated-agent restore is killed mid-write', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'config-written');
    await runCrash(f, 'rollback-agent-restore-partial-write', true);
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback never deletes a temp path created after temp intent', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'agent-temp-intent-persisted');
    const names = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
    const journalPath = join(f.sourceRoot, '.skillrepo-migrations', names.find(name => name.endsWith('.json'))!);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ source: string; generatedAgentTemporaryPath?: string }>;
    };
    const operation = journal.operations.find(item => item.source.endsWith(join('agents', 'worker.md')))!;
    assert.ok(operation.generatedAgentTemporaryPath);
    await writeFile(operation.generatedAgentTemporaryPath!, 'external temp\n', 'utf8');

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-incomplete/,
      );
    });
    assert.equal(await readFile(operation.generatedAgentTemporaryPath!, 'utf8'), 'external temp\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback recovers across stable-agent atomic publish boundaries', { skip: process.platform === 'win32' }, async t => {
  for (const label of [
    'agent-stable-name-published',
    'agent-stable-name-proof-unlinked',
    'agent-stable-name-proof-relinked',
  ] as const) {
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
        assert.equal(
          await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
          '---\ndescription: test\nmode: subagent\n---\nworker\n',
        );
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
});

test('rollback recovers after rewrite temp creation before identity persist', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'agent-rewrite-temp-created-before-identity');
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback resumes after restore temp creation before identity persist', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'config-written');
    await runCrash(f, 'rollback-agent-temp-created-before-identity', true);
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback never adopts a same-content replacement after agent restore publish', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'config-written');
    await runCrash(f, 'rollback-agent-restore-published-before-identity', true);

    const source = join(f.sourceRoot, 'agents', 'worker.md');
    const original = await readFile(source, 'utf8');
    const replacement = `${source}.external`;
    await writeFile(replacement, original, 'utf8');
    await rename(replacement, source);

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({
          planPath: f.planPath,
          targetRoot: f.targetRoot,
          resume: true,
          verify: false,
        }),
        /rollback-incomplete/,
      );
    });
    assert.equal(await readFile(source, 'utf8'), original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback recovers when publish state is persisted before rename', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'agent-stable-name-publish-state-persisted');
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('resume never adopts a same-content recreated stage', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'source-staged-op-0003');
    const names = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
    const journalPath = join(f.sourceRoot, '.skillrepo-migrations', names.find(name => name.endsWith('.json'))!);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ operationId: string; source: string; stagePath: string }>;
    };
    const operation = journal.operations.find(item => item.operationId === 'op-0003')!;
    const text = await readFile(operation.stagePath, 'utf8');
    await rm(operation.stagePath, { force: true });
    await writeFile(operation.stagePath, text, 'utf8');

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-incomplete/,
      );
    });
    await access(operation.stagePath);
    await assert.rejects(access(operation.source));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback never restores a modified generated-agent backup', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'config-written');
    const names = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
    const journalPath = join(f.sourceRoot, '.skillrepo-migrations', names.find(name => name.endsWith('.json'))!);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ source: string; generatedAgentBackupPath?: string }>;
    };
    const operation = journal.operations.find(item => item.source.endsWith(join('agents', 'worker.md')))!;
    assert.ok(operation.generatedAgentBackupPath);
    await writeFile(operation.generatedAgentBackupPath!, 'external backup edit\n', 'utf8');

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-incomplete/,
      );
    });
    const sourceText = await readFile(operation.source, 'utf8').catch(() => undefined);
    assert.notEqual(sourceText, 'external backup edit\n');
    assert.equal(await readFile(operation.generatedAgentBackupPath!, 'utf8'), 'external backup edit\n');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback recovers when killed after agent backup intent', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'agent-backup-intent-persisted');
    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-complete/,
      );
    });
    assert.equal(
      await readFile(join(f.sourceRoot, 'agents', 'worker.md'), 'utf8'),
      '---\ndescription: test\nmode: subagent\n---\nworker\n',
    );
    await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rollback preserves stage when its ownership proof disappears', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await runCrash(f, 'source-staged-op-0003');
    const names = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
    const journalPath = join(f.sourceRoot, '.skillrepo-migrations', names.find(name => name.endsWith('.json'))!);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ operationId: string; source: string; stagePath: string; stageOwnershipPath?: string }>;
    };
    const operation = journal.operations.find(item => item.operationId === 'op-0003')!;
    assert.ok(operation.stageOwnershipPath);
    await rm(operation.stageOwnershipPath!, { force: true });

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, resume: true, verify: false }),
        /rollback-incomplete/,
      );
    });
    await access(operation.stagePath);
    await assert.rejects(access(operation.source));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
