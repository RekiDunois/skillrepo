import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepo } from '../src/core.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { applyMigration } from '../src/migration.js';

const colonDescription = 'Orchestrates the end-to-end example-workflow pipeline: chains 10 stages while preserving handoff state.';

test('frontmatter parser accepts the same unquoted-colon fallback as OpenCode', () => {
  const parsed = parseFrontmatter(`---\nname: admission-pipeline\ndescription: ${colonDescription}\nmode: subagent\npermission:\n  edit: deny\n---\nbody\n`);

  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.data.name, 'admission-pipeline');
  assert.equal(parsed.data.description, colonDescription);
  assert.equal(parsed.data.mode, 'subagent');
  assert.deepEqual(parsed.data.permission, { edit: 'deny' });
  assert.equal(parsed.content.trim(), 'body');
});

test('repo inspection uses the OpenCode-compatible frontmatter parser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-frontmatter-'));
  const repo = join(root, 'repo');
  try {
    await mkdir(join(repo, 'skills', 'admission-pipeline'), { recursive: true });
    await mkdir(join(repo, 'agents'), { recursive: true });
    await writeFile(
      join(repo, 'skills', 'admission-pipeline', 'SKILL.md'),
      `---\nname: admission-pipeline\ndescription: ${colonDescription}\n---\n`,
      'utf8',
    );
    await writeFile(
      join(repo, 'agents', 'admission-worker.md'),
      `---\nname: admission-worker\ndescription: ${colonDescription}\nmode: subagent\n---\n`,
      'utf8',
    );

    const inventory = await inspectRepo(repo);
    assert.deepEqual(inventory.skillIds, ['admission-pipeline']);
    assert.deepEqual(inventory.agentNames, ['admission-worker']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration can add a stable name without rejecting OpenCode-compatible frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-frontmatter-migration-'));
  const sourceRoot = join(root, 'opencode');
  const targetRoot = join(root, 'repos');
  const planPath = join(root, 'migration-plan.json');

  try {
    await mkdir(join(sourceRoot, 'skill', 'alpha'), { recursive: true });
    await mkdir(join(sourceRoot, 'agents'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'skill', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: test\n---\n',
      'utf8',
    );
    await writeFile(
      join(sourceRoot, 'agents', 'admission-worker.md'),
      `---\ndescription: ${colonDescription}\nmode: subagent\n---\nworker body\n`,
      'utf8',
    );
    await writeFile(
      planPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedFrom: { sourceRoot },
        repositories: [{
          id: 'demo-repo',
          action: 'CREATE_AND_MOVE',
          skills: ['alpha'],
          agents: ['admission-worker.md'],
          libs: [],
        }],
      }, null, 2)}\n`,
      'utf8',
    );

    const oldConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const oldConfig = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG_DIR = sourceRoot;
    delete process.env.OPENCODE_CONFIG;
    try {
      await applyMigration({ planPath, targetRoot, dryRun: false, verify: false });
    } finally {
      if (oldConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = oldConfigDir;
      if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = oldConfig;
    }

    const moved = join(targetRoot, 'demo-repo', 'agents', 'admission-worker.md');
    await access(moved);
    const text = await readFile(moved, 'utf8');
    assert.match(text, /^---\nname: admission-worker\n/);
    const parsed = parseFrontmatter(text);
    assert.equal(parsed.data.name, 'admission-worker');
    assert.equal(parsed.data.description, colonDescription);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
