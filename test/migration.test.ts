import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, lstat, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
      assert.equal(result.resumedMoves.length, 0);
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
      assert.equal(result.verified, false);
      assert.deepEqual(result.skillMappings, [
        {
          operationId: 'op-0001',
          repoId: 'demo-repo',
          skillId: 'alpha',
          sourceFile: join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'),
          targetFile: join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md'),
        },
      ]);

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
      const journal = JSON.parse(await readFile(result.journalPath!, 'utf8')) as {
        config: { originalText?: string };
        prospectiveConfigText: string;
        skillMappings: Array<{ operationId: string; skillId: string; sourceFile: string; targetFile: string }>;
        operations: Array<{ generatedAgentBackupPath?: string }>;
      };
      assert.equal(journal.config.originalText, undefined);
      assert.equal(journal.prospectiveConfigText, '');
      assert.deepEqual(journal.skillMappings, [
        {
          operationId: 'op-0001',
          repoId: 'demo-repo',
          skillId: 'alpha',
          sourceFile: join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'),
          targetFile: join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md'),
        },
      ]);
      assert.equal(journal.operations.some(operation => operation.generatedAgentBackupPath), false);
      assert.equal((await lstat(result.journalPath!)).mode & 0o077, 0);
      assert.equal((await lstat(join(f.sourceRoot, '.skillrepo-migrations'))).mode & 0o777, 0o700);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a committed journal does not block a later revision of the same plan', async () => {
  const f = await fixture();
  try {
    await withConfigDir(f.sourceRoot, async () => {
      await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
      await writeFile(f.planPath, `${JSON.stringify({
        schemaVersion: 1,
        generatedFrom: { sourceRoot: f.sourceRoot },
        repositories: [{ id: 'held-repo', action: 'CREATE_AND_MOVE', skills: ['held'], agents: [], libs: [] }],
      }, null, 2)}\n`, 'utf8');

      const result = await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
      assert.equal(result.status, 'committed');
      await access(join(f.targetRoot, 'held-repo', 'skills', 'held', 'SKILL.md'));
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

test('migration validates YAML frontmatter before the first rename', async () => {
  const f = await fixture();
  try {
    const skill = join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md');
    await writeFile(
      skill,
      '---\nname: alpha\ndescription: [deprecated] text after flow sequence\ndisable-model-invocation: true\n---\n',
      'utf8',
    );

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({
          planPath: f.planPath,
          targetRoot: f.targetRoot,
          verify: false,
        }),
        error => {
          assert.match(String(error), /alpha[/\\]SKILL\.md/);
          assert.match(String(error), /invalid YAML frontmatter/);
          return true;
        },
      );

      await access(skill);
      await access(join(f.sourceRoot, 'agents', 'worker.md'));
      await access(join(f.sourceRoot, 'agents', 'agent-helper.py'));
      await access(join(f.sourceRoot, 'lib', 'shared.js'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md')));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration resume recognizes skillrepo-produced moved state and re-registers idempotently', async () => {
  const f = await fixture();
  try {
    await withConfigDir(f.sourceRoot, async () => {
      await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        verify: false,
      });

      const dryRun = await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        dryRun: true,
        resume: true,
        verify: false,
      });
      assert.equal(dryRun.resumedMoves.length, 4);

      const resumed = await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        resume: true,
        verify: false,
      });
      assert.equal(resumed.resumedMoves.length, 4);
      await access(join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md'));
      assert.equal(
        await readlink(join(f.sourceRoot, 'agents', 'agent-helper.py')),
        join(f.targetRoot, 'demo-repo', 'agents', 'agent-helper.py'),
      );
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration verification failure rolls back the complete batch and records rollback-complete', async () => {
  const f = await fixture();
  const binDir = join(f.root, 'bin');
  const oldPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    const opencode = join(binDir, 'opencode');
    await writeFile(opencode, '#!/usr/bin/env sh\nprintf "not-migrated\\n"\nexit 0\n', 'utf8');
    await chmod(opencode, 0o755);

    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot }),
        /rollback-complete/,
      );

      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await access(join(f.sourceRoot, 'agents', 'worker.md'));
      await access(join(f.sourceRoot, 'agents', 'agent-helper.py'));
      await access(join(f.sourceRoot, 'lib', 'shared.js'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
      await assert.rejects(access(join(f.sourceRoot, 'opencode.jsonc')));
      await assert.rejects(readlink(join(f.sourceRoot, 'agents', 'agent-helper.py')));
      await assert.rejects(readlink(join(f.sourceRoot, 'agents', 'demo-repo')));

      const journals = await readdir(join(f.sourceRoot, '.skillrepo-migrations'));
      assert.equal(journals.length, 1);
      const journal = JSON.parse(await readFile(join(f.sourceRoot, '.skillrepo-migrations', journals[0]!), 'utf8')) as {
        status: string;
        phase: string;
      };
      assert.equal(journal.status, 'rollback-complete');
      assert.equal(journal.phase, 'rolled-back');
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration verification failure rolls back repositories that completed earlier in the batch', async () => {
  const f = await fixture();
  const binDir = join(f.root, 'bin');
  const oldPath = process.env.PATH;
  try {
    await mkdir(join(f.sourceRoot, 'skill', 'beta'), { recursive: true });
    await writeFile(join(f.sourceRoot, 'skill', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: beta\n---\n', 'utf8');
    await writeFile(join(f.sourceRoot, 'agents', 'second.md'), '---\nname: second\ndescription: second\n---\n', 'utf8');
    await writeFile(
      f.planPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedFrom: { sourceRoot: f.sourceRoot },
        repositories: [
          { id: 'demo-repo', action: 'CREATE_AND_MOVE', skills: ['alpha'], agents: ['worker.md', 'agent-helper.py'], libs: ['lib/shared.js'] },
          { id: 'second-repo', action: 'CREATE_AND_MOVE', skills: ['beta'], agents: ['second.md'], libs: [] },
        ],
      }, null, 2)}\n`,
      'utf8',
    );
    await mkdir(binDir, { recursive: true });
    const opencode = join(binDir, 'opencode');
    await writeFile(opencode, '#!/usr/bin/env sh\nprintf "not-migrated\\n"\nexit 0\n', 'utf8');
    await chmod(opencode, 0o755);

    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot }),
        /rollback-complete/,
      );
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await access(join(f.sourceRoot, 'skill', 'beta', 'SKILL.md'));
      await access(join(f.sourceRoot, 'agents', 'worker.md'));
      await access(join(f.sourceRoot, 'agents', 'second.md'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
      await assert.rejects(access(join(f.targetRoot, 'second-repo')));
      await assert.rejects(access(join(f.sourceRoot, 'opencode.jsonc')));
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration rejects duplicate derived agent names before creating a journal or moving files', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sourceRoot, 'agents', 'other.md'), '---\nname: worker\ndescription: duplicate\n---\n', 'utf8');
    await writeFile(
      f.planPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedFrom: { sourceRoot: f.sourceRoot },
        repositories: [{
          id: 'demo-repo',
          action: 'CREATE_AND_MOVE',
          skills: ['alpha'],
          agents: ['worker.md', 'other.md'],
          libs: ['lib/shared.js'],
        }],
      }, null, 2)}\n`,
      'utf8',
    );

    await withConfigDir(f.sourceRoot, async () => {
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false }),
        /Duplicate agent name 'worker'/,
      );
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await access(join(f.sourceRoot, 'agents', 'worker.md'));
      await access(join(f.sourceRoot, 'agents', 'other.md'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
      await assert.rejects(access(join(f.sourceRoot, '.skillrepo-migrations')));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration preflights nested skill frontmatter and preserves directory-derived root IDs', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'), '---\ndescription: no explicit name\n---\n', 'utf8');
    await mkdir(join(f.sourceRoot, 'skill', 'alpha', 'nested'), { recursive: true });
    await writeFile(join(f.sourceRoot, 'skill', 'alpha', 'nested', 'SKILL.md'), '---\nname: nested\ndescription: nested\n---\n', 'utf8');

    await withConfigDir(f.sourceRoot, async () => {
      const result = await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
      assert.equal(result.status, 'committed');
      assert.equal(result.moves[0]!.expectedSkillId, 'alpha');
      assert.deepEqual(result.skillMappings, [
        {
          operationId: 'op-0001',
          repoId: 'demo-repo',
          skillId: 'alpha',
          sourceFile: join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'),
          targetFile: join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md'),
        },
        {
          operationId: 'op-0001',
          repoId: 'demo-repo',
          skillId: 'nested',
          sourceFile: join(f.sourceRoot, 'skill', 'alpha', 'nested', 'SKILL.md'),
          targetFile: join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'nested', 'SKILL.md'),
        },
      ]);
      await access(join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md'));
      await access(join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'nested', 'SKILL.md'));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration never overwrites an external config change during rollback', async () => {
  const f = await fixture();
  const binDir = join(f.root, 'bin');
  const oldPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    const opencode = join(binDir, 'opencode');
    await writeFile(
      opencode,
      '#!/usr/bin/env sh\nif [ "$1" = "debug" ]; then\n  printf "external edit\\n" > "$OPENCODE_CONFIG_DIR/opencode.jsonc"\n  exit 1\nfi\nexit 0\n',
      'utf8',
    );
    await chmod(opencode, 0o755);

    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
      await assert.rejects(
        () => applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot }),
        /rollback-incomplete/,
      );
      assert.equal(await readFile(join(f.sourceRoot, 'opencode.jsonc'), 'utf8'), 'external edit\n');
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration verifies the complete expected discovery set after registration', async () => {
  const f = await fixture();
  const binDir = join(f.root, 'bin');
  const oldPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    const opencode = join(binDir, 'opencode');
    await writeFile(
      opencode,
      `#!/usr/bin/env sh
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then
  if [ -f "$OPENCODE_CONFIG_DIR/opencode.jsonc" ] || [ -f "$OPENCODE_CONFIG_DIR/opencode.json" ]; then
    printf '%s' '[{"name":"alpha"}]'
  else
    printf '%s' '[]'
  fi
fi
if [ "$1" = "agent" ] && [ -L "$OPENCODE_CONFIG_DIR/agents/demo-repo" ]; then
  printf "worker\\n"
fi
exit 0
`,
      'utf8',
    );
    await chmod(opencode, 0o755);

    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
      const result = await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot });
      assert.equal(result.status, 'committed');
      assert.equal(result.verified, true);
      assert.equal(result.verification.every(item => item.ok), true);
      assert.ok(result.verification.some(item => item.command === 'skillrepo migration targets'));
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});
