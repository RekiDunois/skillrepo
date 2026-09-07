import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectRepo } from '../src/core.js';
import { applyMigration } from '../src/migration.js';

const cliPath = resolve('dist/src/cli.js');

function runCli(args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, [cliPath, ...args], { cwd }, error => {
      if (!error) {
        resolvePromise({ code: 0, stderr: '' });
        return;
      }
      const result = error as NodeJS.ErrnoException & { code?: number; stderr?: string };
      resolvePromise({
        code: typeof result.code === 'number' ? result.code : 1,
        stderr: result.stderr ?? result.message,
      });
    });
    child.on('error', reject);
  });
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

type PlanRepo = {
  id: string;
  action: 'CREATE_AND_MOVE';
  skills: string[];
  agents: string[];
  libs: string[];
};

async function writePlan(path: string, sourceRoot: string, repository: PlanRepo): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot },
    repositories: [repository],
  }, null, 2)}\n`, 'utf8');
}

async function makeMigrationFixture(options: { skills: string[]; agents: string[] }): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  planPath: string;
  repoId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-issue-42-migration-'));
  const sourceRoot = join(root, 'opencode');
  const targetRoot = join(root, 'repos');
  const planPath = join(root, 'migration-plan.json');
  const repoId = 'demo-repo';

  await mkdir(sourceRoot, { recursive: true });
  for (const skill of options.skills) {
    await mkdir(join(sourceRoot, 'skill', skill, 'scripts'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'skill', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: issue 42 test\n---\n`,
      'utf8',
    );
    await writeFile(join(sourceRoot, 'skill', skill, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  }
  if (options.agents.length > 0) await mkdir(join(sourceRoot, 'agents'), { recursive: true });
  for (const agent of options.agents) {
    await writeFile(
      join(sourceRoot, 'agents', agent),
      '---\ndescription: issue 42 test\nmode: subagent\n---\nagent body\n',
      'utf8',
    );
  }

  await writePlan(planPath, sourceRoot, {
    id: repoId,
    action: 'CREATE_AND_MOVE',
    skills: options.skills,
    agents: options.agents,
    libs: [],
  });
  return { root, sourceRoot, targetRoot, planPath, repoId };
}

test('issue #42: default APM init is composition-neutral', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-issue-42-init-'));
  const repo = join(root, 'package-repo');
  try {
    const result = await runCli(['init', repo], root);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await readdir(repo)).sort(), ['.gitignore', 'apm.yml'].sort());
    await assert.rejects(access(join(repo, '.apm')));
    await assert.rejects(access(join(repo, 'skills')));
    await assert.rejects(access(join(repo, 'agents')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('issue #42: apm.yml plus root skills is an APM skill-only package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-issue-42-root-skills-'));
  const repo = join(root, 'package-repo');
  try {
    await mkdir(join(repo, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
    await writeFile(
      join(repo, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: issue 42 test\n---\n',
      'utf8',
    );

    const inventory = await inspectRepo(repo);
    assert.equal(inventory.layout, 'apm');
    assert.equal(inventory.skillsDir, join(repo, 'skills'));
    assert.deepEqual(inventory.skillIds, ['alpha']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('issue #42: skill-only migration creates an APM manifest and keeps root skills authoritative', async () => {
  const f = await makeMigrationFixture({ skills: ['alpha'], agents: [] });
  try {
    await withConfigDir(f.sourceRoot, async () => {
      await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
      const repo = join(f.targetRoot, f.repoId);

      await access(join(repo, 'apm.yml'));
      await access(join(repo, 'skills', 'alpha', 'SKILL.md'));
      await access(join(repo, 'skills', 'alpha', 'scripts', 'run.sh'));
      await assert.rejects(access(join(repo, '.apm', 'skills')));

      const inventory = await inspectRepo(repo);
      assert.equal(inventory.layout, 'apm');
      assert.equal(inventory.skillsDir, join(repo, 'skills'));

      const config = JSON.parse(await readFile(join(f.sourceRoot, 'opencode.jsonc'), 'utf8')) as {
        skills?: { paths?: string[] };
      };
      assert.deepEqual(config.skills?.paths, [join(repo, 'skills')]);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('issue #42: mixed migration keeps .apm authoritative and publishes root Agent Skills projection', async () => {
  const f = await makeMigrationFixture({ skills: ['alpha'], agents: ['worker.md'] });
  try {
    await withConfigDir(f.sourceRoot, async () => {
      await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
      const repo = join(f.targetRoot, f.repoId);

      await access(join(repo, 'apm.yml'));
      await access(join(repo, '.apm', 'skills', 'alpha', 'SKILL.md'));
      await access(join(repo, '.apm', 'skills', 'alpha', 'scripts', 'run.sh'));
      await access(join(repo, '.apm', 'agents', 'worker.agent.md'));
      await access(join(repo, 'skills', 'alpha', 'SKILL.md'));
      await access(join(repo, 'skills', 'alpha', 'scripts', 'run.sh'));

      const marker = JSON.parse(await readFile(join(repo, 'skills', '.skillrepo-projection.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(marker.schemaVersion, 1);
      assert.equal(marker.owner, 'skillrepo');
      assert.equal(marker.kind, 'agent-skills-projection');
      assert.equal(marker.source, '.apm/skills');
      assert.equal(marker.target, 'skills');
      assert.equal(marker.fingerprintAlgorithm, 'sha256-tree-v1');
      assert.match(String(marker.fingerprint), /^[0-9a-f]{64}$/);

      const inventory = await inspectRepo(repo);
      assert.equal(inventory.layout, 'apm');
      assert.equal(inventory.skillsDir, join(repo, '.apm', 'skills'));
      assert.equal(inventory.agentsDir, join(repo, '.apm', 'agents'));

      const config = JSON.parse(await readFile(join(f.sourceRoot, 'opencode.jsonc'), 'utf8')) as {
        skills?: { paths?: string[] };
      };
      assert.deepEqual(config.skills?.paths, [join(repo, '.apm', 'skills')]);
      assert.equal(config.skills?.paths?.includes(join(repo, 'skills')), false);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('issue #42: agent-only migration does not invent a root skills tree', async () => {
  const f = await makeMigrationFixture({ skills: [], agents: ['worker.md'] });
  try {
    await withConfigDir(f.sourceRoot, async () => {
      await applyMigration({ planPath: f.planPath, targetRoot: f.targetRoot, verify: false });
      const repo = join(f.targetRoot, f.repoId);

      await access(join(repo, 'apm.yml'));
      await access(join(repo, '.apm', 'agents', 'worker.agent.md'));
      await assert.rejects(access(join(repo, 'skills')));
      await assert.rejects(access(join(repo, '.apm', 'skills')));

      const inventory = await inspectRepo(repo);
      assert.equal(inventory.layout, 'apm');
      assert.equal(inventory.skillsDir, undefined);
      assert.equal(inventory.agentsDir, join(repo, '.apm', 'agents'));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
