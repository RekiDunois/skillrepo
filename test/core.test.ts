import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepo, unregisterRepo } from '../src/core.js';

async function fixture(): Promise<{ root: string; repo: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-'));
  const repo = join(root, 'example-repo');
  const configDir = join(root, 'opencode');
  await mkdir(join(repo, 'skills', 'hello'), { recursive: true });
  await mkdir(join(repo, 'agents'), { recursive: true });
  await writeFile(join(repo, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: test\n---\n', 'utf8');
  await writeFile(join(repo, 'agents', 'worker.md'), '---\nname: worker\ndescription: test\nmode: subagent\n---\n', 'utf8');
  return { root, repo, configDir };
}

async function withConfigDir<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  const oldDir = process.env.OPENCODE_CONFIG_DIR;
  const oldConfig = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  delete process.env.OPENCODE_CONFIG;
  try { return await fn(); }
  finally {
    if (oldDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = oldDir;
    if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = oldConfig;
  }
}

test('register is idempotent and unregister removes only registration', async () => {
  const f = await fixture();
  try {
    await withConfigDir(f.configDir, async () => {
      await registerRepo(f.repo);
      await registerRepo(f.repo);
      const config = await readFile(join(f.configDir, 'opencode.jsonc'), 'utf8');
      const matches = config.match(new RegExp(join(f.repo, 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [];
      assert.equal(matches.length, 1);
      assert.equal(await readlink(join(f.configDir, 'agents', 'example-repo')), join(f.repo, 'agents'));

      await unregisterRepo(f.repo);
      const after = await readFile(join(f.configDir, 'opencode.jsonc'), 'utf8');
      assert.equal(after.includes(join(f.repo, 'skills')), false);
      assert.equal((await readFile(join(f.repo, 'agents', 'worker.md'), 'utf8')).includes('worker'), true);
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('register rejects agents without a stable name', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'agents', 'worker.md'), '---\ndescription: test\n---\n', 'utf8');
    await withConfigDir(f.configDir, async () => {
      await assert.rejects(() => registerRepo(f.repo), /missing stable frontmatter name/);
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
