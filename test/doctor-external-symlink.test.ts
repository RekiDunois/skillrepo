import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { doctor } from '../src/core.js';

async function withDoctorEnv<T>(configDir: string, binDir: string, fn: () => Promise<T>): Promise<T> {
  const oldDir = process.env.OPENCODE_CONFIG_DIR;
  const oldConfig = process.env.OPENCODE_CONFIG;
  const oldPath = process.env.PATH;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  delete process.env.OPENCODE_CONFIG;
  process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
  try {
    return await fn();
  } finally {
    if (oldDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = oldDir;
    if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = oldConfig;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

test('doctor accepts pre-existing external agent directories and runtime file symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-doctor-symlink-'));
  const configDir = join(root, 'opencode');
  const externalAgents = join(root, 'external-repo', 'agents');
  const binDir = join(root, 'bin');

  try {
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await mkdir(externalAgents, { recursive: true });
    await mkdir(binDir, { recursive: true });

    await writeFile(
      join(externalAgents, 'external-agent.md'),
      '---\ndescription: external OpenCode symlink probe\nmode: subagent\n---\nprobe\n',
      'utf8',
    );
    await writeFile(join(externalAgents, 'runtime-helper.py'), 'print("ok")\n', 'utf8');
    await symlink(externalAgents, join(configDir, 'agents', 'manual-agent-repo'), 'dir');
    await symlink(
      join(externalAgents, 'runtime-helper.py'),
      join(configDir, 'agents', 'runtime-helper.py'),
    );

    const opencode = join(binDir, 'opencode');
    await writeFile(opencode, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
    await chmod(opencode, 0o755);

    const result = await withDoctorEnv(configDir, binDir, () => doctor());
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
