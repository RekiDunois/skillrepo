import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyMigrationPortabilityFixes } from '../src/portability_fix.js';

const execFileAsync = promisify(execFile);

async function buildFixture(root: string): Promise<{ targetRoot: string; repo: string; plan: string }> {
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'portable-repo');
  const plan = join(root, 'migration-plan.json');
  const sourceRoot = '/Users/example/.config/opencode';

  await mkdir(join(repo, 'skills', 'demo'), { recursive: true });
  await mkdir(join(repo, 'skills', 'block'), { recursive: true });
  await mkdir(join(repo, 'skills', 'tool', 'scripts'), { recursive: true });
  await mkdir(join(repo, 'tests'), { recursive: true });

  await writeFile(plan, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot },
    repositories: [
      {
        id: 'portable-repo',
        action: 'CREATE_AND_MOVE',
        skills: ['demo', 'block', 'tool'],
        agents: [],
        libs: [],
      },
    ],
  }, null, 2)}\n`, 'utf8');

  await writeFile(
    join(repo, 'skills', 'demo', 'SKILL.md'),
    [
      '---',
      'name: demo',
      'mcp:',
      '  demo:',
      '    command: ["/Users/example/.config/opencode/skill/tool/scripts/server.sh", "--stdio"]',
      '---',
      'Legacy docs: `/Users/example/.config/opencode/skill/tool/scripts/server.sh`.',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(repo, 'skills', 'block', 'SKILL.md'),
    [
      '---',
      'name: block',
      'mcp:',
      '  demo:',
      '    command:',
      '      - /Users/example/.config/opencode/skill/tool/scripts/server.sh',
      '      - --block',
      '---',
      'Body.',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(repo, 'skills', 'tool', 'scripts', 'server.sh'), '#!/usr/bin/env bash\n', 'utf8');
  await writeFile(join(repo, 'tests', 'test_path.py'), 'FIXTURE = "/Users/example/project/input.pdf"\n', 'utf8');
  await writeFile(join(repo, 'runtime.py'), 'ROOT = "/Users/example/project/runtime"\n', 'utf8');

  return { targetRoot, repo, plan };
}

test('portability fix rewrites only provably safe repo commands and migrated docs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-portability-fix-'));

  try {
    const fixture = await buildFixture(root);
    const demo = join(fixture.repo, 'skills', 'demo', 'SKILL.md');
    const block = join(fixture.repo, 'skills', 'block', 'SKILL.md');
    const testFile = join(fixture.repo, 'tests', 'test_path.py');
    const runtime = join(fixture.repo, 'runtime.py');
    const beforeDemo = await readFile(demo, 'utf8');
    const beforeBlock = await readFile(block, 'utf8');
    const beforeTest = await readFile(testFile, 'utf8');
    const beforeRuntime = await readFile(runtime, 'utf8');

    const dryRun = await applyMigrationPortabilityFixes({
      planPath: fixture.plan,
      targetRoot: fixture.targetRoot,
      dryRun: true,
    });
    assert.equal(dryRun.summary.autoActions, 3);
    assert.equal(dryRun.summary.manualActions, 2);
    assert.equal(dryRun.summary.changedFiles, 2);
    assert.equal(await readFile(demo, 'utf8'), beforeDemo, 'dry-run must not rewrite mixed Markdown');
    assert.equal(await readFile(block, 'utf8'), beforeBlock, 'dry-run must not rewrite block command');

    const applied = await applyMigrationPortabilityFixes({
      planPath: fixture.plan,
      targetRoot: fixture.targetRoot,
      dryRun: false,
    });
    assert.equal(applied.summary.changedFiles, 2);

    const afterDemo = await readFile(demo, 'utf8');
    assert.match(
      afterDemo,
      /command: \["skillrepo","exec","portable-repo","skills\/tool\/scripts\/server\.sh","--stdio"\]/,
    );
    assert.match(afterDemo, /~\/\.config\/opencode\/skill\/tool\/scripts\/server\.sh/);
    assert.equal(afterDemo.includes('/Users/example/'), false);

    const afterBlock = await readFile(block, 'utf8');
    assert.match(
      afterBlock,
      /command: \["skillrepo","exec","portable-repo","skills\/tool\/scripts\/server\.sh","--block"\]/,
    );
    assert.equal(afterBlock.includes('/Users/example/'), false);

    assert.equal(await readFile(testFile, 'utf8'), beforeTest, 'test fixture must remain manual');
    assert.equal(await readFile(runtime, 'utf8'), beforeRuntime, 'runtime code must remain manual');
    await assert.rejects(access(join(fixture.repo, '.git')), 'portability fix must not initialize Git');

    const second = await applyMigrationPortabilityFixes({
      planPath: fixture.plan,
      targetRoot: fixture.targetRoot,
      dryRun: false,
    });
    assert.equal(second.summary.autoActions, 0);
    assert.equal(second.summary.manualActions, 2);
    assert.equal(second.summary.changedFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('portability fix CLI is dry-run by default and exposes JSON plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-portability-fix-cli-'));

  try {
    const fixture = await buildFixture(root);
    const demo = join(fixture.repo, 'skills', 'demo', 'SKILL.md');
    const before = await readFile(demo, 'utf8');
    const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      'migration',
      'portability',
      'fix',
      '--plan', fixture.plan,
      '--target-root', fixture.targetRoot,
      '--json',
    ]);

    assert.equal(stderr, '');
    const parsed = JSON.parse(stdout) as {
      dryRun: boolean;
      summary: { autoActions: number; manualActions: number; changedFiles: number };
    };
    assert.equal(parsed.dryRun, true);
    assert.deepEqual(parsed.summary, { files: 4, autoActions: 3, manualActions: 2, changedFiles: 2 });
    assert.equal(await readFile(demo, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
