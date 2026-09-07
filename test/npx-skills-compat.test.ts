import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Issue #42 acceptance: every newly produced skill-bearing package must expose
// the externally visible Agent Skills shape `skills/<skill-name>/SKILL.md`
// (with nested resources) at the repository root, so `npx skills add
// owner/repo` can consume the repository without network access or any APM
// dependency emulation. The test drives the real compiled CLI end to end.

const cliPath = resolve('dist/src/cli.js');

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, [cliPath, ...args], { cwd, env }, error => {
      if (!error) {
        resolvePromise({ code: 0, stdout: '', stderr: '' });
        return;
      }
      const result = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
      resolvePromise({
        code: typeof result.code === 'number' ? result.code : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? result.message,
      });
    });
    child.on('error', reject);
  });
}

async function makeFixture(options: { skills: string[]; agents: string[] }): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  planPath: string;
  repoId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-npx-skills-compat-'));
  const sourceRoot = join(root, 'opencode');
  const targetRoot = join(root, 'repos');
  const planPath = join(root, 'migration-plan.json');
  const repoId = 'demo-repo';

  await mkdir(join(sourceRoot, 'skill', 'alpha', 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'skill', 'alpha', 'references'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'skill', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: npx skills compatibility test\n---\n',
    'utf8',
  );
  await writeFile(join(sourceRoot, 'skill', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  await writeFile(join(sourceRoot, 'skill', 'alpha', 'references', 'guide.md'), '# guide\n', 'utf8');
  if (options.agents.length > 0) await mkdir(join(sourceRoot, 'agents'), { recursive: true });
  for (const agent of options.agents) {
    await writeFile(
      join(sourceRoot, 'agents', agent),
      '---\ndescription: npx skills compatibility test\nmode: subagent\n---\nagent body\n',
      'utf8',
    );
  }
  await writeFile(planPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot },
    repositories: [{ id: repoId, action: 'CREATE_AND_MOVE', skills: options.skills, agents: options.agents, libs: [] }],
  }, null, 2)}\n`, 'utf8');
  return { root, sourceRoot, targetRoot, planPath, repoId };
}

test('a migrated skill-only package exposes the npx skills repository shape', async () => {
  const f = await makeFixture({ skills: ['alpha'], agents: [] });
  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: f.sourceRoot,
    OPENCODE_CONFIG: '',
  } as NodeJS.ProcessEnv;
  delete env.OPENCODE_CONFIG;
  try {
    const result = await runCli(['migration', 'apply', '--plan', f.planPath, '--target-root', f.targetRoot, '--execute', '--no-verify'], f.root, env);
    assert.equal(result.code, 0, result.stderr);

    const repo = join(f.targetRoot, f.repoId);
    // The externally visible Agent Skills shape lives at the repository root.
    assert.deepEqual((await readdir(repo)).sort(), ['apm.yml', 'skills'].sort());
    await access(join(repo, 'skills', 'alpha', 'SKILL.md'));
    await access(join(repo, 'skills', 'alpha', 'scripts', 'run.sh'));
    await access(join(repo, 'skills', 'alpha', 'references', 'guide.md'));
    // Skill-only packages have no duplicated canonical tree.
    await assert.rejects(access(join(repo, '.apm', 'skills')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a migrated mixed package exposes the npx skills shape through its managed projection', async () => {
  const f = await makeFixture({ skills: ['alpha'], agents: ['worker.md'] });
  const env = { ...process.env, OPENCODE_CONFIG_DIR: f.sourceRoot } as NodeJS.ProcessEnv;
  delete env.OPENCODE_CONFIG;
  try {
    const result = await runCli(['migration', 'apply', '--plan', f.planPath, '--target-root', f.targetRoot, '--execute', '--no-verify'], f.root, env);
    assert.equal(result.code, 0, result.stderr);

    const repo = join(f.targetRoot, f.repoId);
    await access(join(repo, 'skills', 'alpha', 'SKILL.md'));
    await access(join(repo, 'skills', 'alpha', 'scripts', 'run.sh'));
    await access(join(repo, 'skills', 'alpha', 'references', 'guide.md'));
    await access(join(repo, '.apm', 'skills', 'alpha', 'SKILL.md'));
    await access(join(repo, '.apm', 'agents', 'worker.agent.md'));

    const marker = JSON.parse(await readFile(join(repo, 'skills', '.skillrepo-projection.json'), 'utf8')) as {
      schemaVersion: number;
      owner: string;
      kind: string;
      source: string;
      target: string;
      fingerprintAlgorithm: string;
      fingerprint: string;
    };
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.owner, 'skillrepo');
    assert.equal(marker.kind, 'agent-skills-projection');
    assert.equal(marker.source, '.apm/skills');
    assert.equal(marker.target, 'skills');
    assert.equal(marker.fingerprintAlgorithm, 'sha256-tree-v1');
    assert.match(marker.fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
