import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { classifyMigrationPortability, renderMigrationPortability } from '../src/portability.js';

const execFileAsync = promisify(execFile);

async function writePlan(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot: '/unused' },
    repositories: [
      { id: 'portable-repo', action: 'CREATE_AND_MOVE', skills: [], agents: [], libs: [] },
    ],
  }, null, 2)}\n`, 'utf8');
}

async function buildFixture(root: string): Promise<{ targetRoot: string; repo: string; plan: string; files: string[] }> {
  const targetRoot = join(root, 'repos');
  const repo = join(targetRoot, 'portable-repo');
  const plan = join(root, 'migration-plan.json');

  await writePlan(plan);
  await mkdir(join(repo, 'skills', 'frontmatter'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(join(repo, 'tests'), { recursive: true });

  const frontmatter = join(repo, 'skills', 'frontmatter', 'SKILL.md');
  const markdown = join(repo, 'docs', 'usage.md');
  const testFile = join(repo, 'tests', 'test_paths.py');
  const runtime = join(repo, 'run.py');

  await writeFile(
    frontmatter,
    '---\nname: frontmatter\nmcp:\n  demo:\n    command: ["/Users/example/tools/demo"]\n---\nBody.\n',
    'utf8',
  );
  await writeFile(markdown, 'Run `/Users/example/tools/demo` for the old example.\n', 'utf8');
  await writeFile(testFile, 'FIXTURE = "/Users/example/project/input.pdf"\n', 'utf8');
  await writeFile(runtime, 'ROOT = "/Users/example/project/runtime"\n', 'utf8');

  return { targetRoot, repo, plan, files: [frontmatter, markdown, testFile, runtime] };
}

test('migration portability classifies audit findings without changing repository contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-portability-'));

  try {
    const fixture = await buildFixture(root);
    const before = new Map<string, string>();
    for (const file of fixture.files) before.set(file, await readFile(file, 'utf8'));

    const result = await classifyMigrationPortability({ planPath: fixture.plan, targetRoot: fixture.targetRoot });
    assert.equal(result.summary.files, 4);
    assert.equal(result.summary.frontmatterRuntime, 1);
    assert.equal(result.summary.markdownBody, 1);
    assert.equal(result.summary.test, 1);
    assert.equal(result.summary.runtimeCode, 1);

    const byPath = new Map(result.items.map(item => [item.path, item]));
    assert.equal(byPath.get('skills/frontmatter/SKILL.md')?.kind, 'FRONTMATTER-RUNTIME');
    assert.deepEqual(byPath.get('skills/frontmatter/SKILL.md')?.lines, [5]);
    assert.equal(byPath.get('docs/usage.md')?.kind, 'MARKDOWN-BODY');
    assert.equal(byPath.get('tests/test_paths.py')?.kind, 'TEST');
    assert.equal(byPath.get('run.py')?.kind, 'RUNTIME-CODE');

    const rendered = renderMigrationPortability(result);
    assert.match(rendered, /4 file\(s\)/);
    assert.match(rendered, /FRONTMATTER-RUNTIME/);
    assert.match(rendered, /MARKDOWN-BODY/);
    assert.match(rendered, /RUNTIME-CODE/);
    assert.equal(rendered.includes('/Users/example/'), false, 'rendered output must not echo local home paths');

    for (const [file, content] of before) assert.equal(await readFile(file, 'utf8'), content);
    await assert.rejects(access(join(fixture.repo, '.git')), 'portability classification must not initialize Git');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration portability CLI emits machine-readable classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-portability-cli-'));

  try {
    const fixture = await buildFixture(root);
    const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      'migration',
      'portability',
      '--plan', fixture.plan,
      '--target-root', fixture.targetRoot,
      '--json',
    ]);

    assert.equal(stderr, '');
    const parsed = JSON.parse(stdout) as {
      summary: { files: number; frontmatterRuntime: number; markdownBody: number; test: number; runtimeCode: number };
      items: Array<{ kind: string; path: string }>;
    };
    assert.deepEqual(parsed.summary, {
      files: 4,
      frontmatterRuntime: 1,
      markdownBody: 1,
      test: 1,
      runtimeCode: 1,
    });
    assert.equal(parsed.items.some(item => item.kind === 'FRONTMATTER-RUNTIME'), true);
    assert.equal(stdout.includes('/Users/example/'), false, 'JSON output must not echo local home paths');
    await assert.rejects(access(join(fixture.repo, '.git')), 'CLI portability classification must not initialize Git');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
