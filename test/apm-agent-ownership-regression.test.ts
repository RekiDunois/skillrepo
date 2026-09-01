import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepo, unregisterRepo } from '../src/core.js';

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

test('package unregister preserves symlinks into its source tree that skillrepo did not create', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-apm-agent-ownership-'));
  const repo = join(root, 'package-repo');
  const source = join(repo, '.apm', 'agents', 'reviewer.agent.md');
  const configDir = join(root, 'opencode');
  const manualLink = join(configDir, 'agents', 'manual-reviewer.md');
  const ownedLink = join(configDir, 'agents', 'reviewer.md');

  try {
    await mkdir(join(repo, '.apm', 'agents'), { recursive: true });
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
    await writeFile(source, '---\ndescription: package agent\nmode: subagent\n---\n', 'utf8');
    await symlink(source, manualLink);

    await withConfigDir(configDir, async () => {
      await registerRepo(repo);
      assert.equal(await readlink(ownedLink), source);
      assert.equal(await readlink(manualLink), source);

      await unregisterRepo(repo);

      await assert.rejects(access(ownedLink));
      assert.equal(await readlink(manualLink), source);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package unregister preserves a pre-existing canonical projection that skillrepo reused but did not create', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-apm-agent-preexisting-'));
  const repo = join(root, 'package-repo');
  const source = join(repo, '.apm', 'agents', 'reviewer.agent.md');
  const configDir = join(root, 'opencode');
  const canonicalLink = join(configDir, 'agents', 'reviewer.md');

  try {
    await mkdir(join(repo, '.apm', 'agents'), { recursive: true });
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
    await writeFile(source, '---\ndescription: package agent\nmode: subagent\n---\n', 'utf8');
    await symlink(source, canonicalLink);

    await withConfigDir(configDir, async () => {
      await registerRepo(repo);
      assert.equal(await readlink(canonicalLink), source);

      await unregisterRepo(repo);

      assert.equal(await readlink(canonicalLink), source);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
