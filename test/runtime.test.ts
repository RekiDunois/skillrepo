import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  installedSkillrepoSupportsExec,
  resolveRegisteredRepo,
  resolveRegisteredResource,
} from '../src/runtime.js';

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('dist/src/cli.js'), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

test('registered resource resolver derives repo from OpenCode skill registration and exec forwards args', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-runtime-'));
  const configDir = join(root, 'opencode');
  const repo = join(root, 'runtime-repo');
  const skills = join(repo, 'skills');
  const script = join(repo, 'bin', 'fixture.sh');
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };

  try {
    await mkdir(skills, { recursive: true });
    await mkdir(join(repo, 'bin'), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'opencode.jsonc'), `{"skills":[${JSON.stringify(skills)}]}\n`, 'utf8');
    await writeFile(script, '#!/usr/bin/env bash\nprintf "runtime:%s\\n" "$1"\n', 'utf8');
    await chmod(script, 0o755);

    assert.equal(await resolveRegisteredRepo('runtime-repo', env), repo);
    assert.equal(await resolveRegisteredResource('runtime-repo', 'bin/fixture.sh', env), await realpath(script));
    await assert.rejects(
      resolveRegisteredResource('runtime-repo', '../outside.sh', env),
      /escapes registered repo/,
    );
    await assert.rejects(
      resolveRegisteredResource('runtime-repo', script, env),
      /repo-relative/,
    );

    const executed = await runCli(['exec', 'runtime-repo', 'bin/fixture.sh', '--probe'], env);
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(executed.stdout, 'runtime:--probe\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registered resource resolver can derive an agent-only repo without a second registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-runtime-agent-'));
  const configDir = join(root, 'opencode');
  const repo = join(root, 'agent-only-repo');
  const agents = join(repo, 'agents');
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };

  try {
    await mkdir(agents, { recursive: true });
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await writeFile(join(configDir, 'opencode.jsonc'), '{}\n', 'utf8');
    await symlink(agents, join(configDir, 'agents', 'agent-only-repo'), 'dir');

    assert.equal(await resolveRegisteredRepo('agent-only-repo', env), repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime capability check distinguishes current exec-capable CLI from a missing binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-runtime-capability-'));
  const bin = join(root, 'bin');
  const empty = join(root, 'empty');
  const fake = join(bin, 'skillrepo');

  try {
    await mkdir(bin, { recursive: true });
    await mkdir(empty, { recursive: true });
    await writeFile(
      fake,
      '#!/usr/bin/env bash\necho "  skillrepo exec <repo-id> <repo-relative-resource> [args...]" >&2\nexit 2\n',
      'utf8',
    );
    await chmod(fake, 0o755);

    const withFake = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
    assert.equal(await installedSkillrepoSupportsExec(withFake), true);
    assert.equal(await installedSkillrepoSupportsExec({ ...process.env, PATH: empty }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
