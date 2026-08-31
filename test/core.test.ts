import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { opencodeConfigFile, registerRepo, unregisterRepo } from '../src/core.js';

async function makeRepo(
  root: string,
  name: string,
  skillId: string,
  agentName: string,
): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, 'skills', skillId), { recursive: true });
  await mkdir(join(repo, 'agents'), { recursive: true });
  await writeFile(
    join(repo, 'skills', skillId, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: test\n---\n`,
    'utf8',
  );
  await writeFile(
    join(repo, 'agents', `${agentName}.md`),
    `---\nname: ${agentName}\ndescription: test\nmode: subagent\n---\n`,
    'utf8',
  );
  return repo;
}

async function fixture(): Promise<{ root: string; repo: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-'));
  const repo = await makeRepo(root, 'example-repo', 'hello', 'worker');
  return { root, repo, configDir: join(root, 'opencode') };
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

test('register is idempotent and unregister removes only registration', async () => {
  const f = await fixture();
  try {
    await withConfigDir(f.configDir, async () => {
      await registerRepo(f.repo);
      await registerRepo(f.repo);
      const config = await readFile(join(f.configDir, 'opencode.jsonc'), 'utf8');
      const matches = config.match(new RegExp(join(f.repo, 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [];
      assert.equal(matches.length, 1);
      assert.deepEqual(JSON.parse(config).skills.paths, [join(f.repo, 'skills')]);
      assert.equal(await readlink(join(f.configDir, 'agents', 'example-repo')), join(f.repo, 'agents'));

      await unregisterRepo(f.repo);
      const after = await readFile(join(f.configDir, 'opencode.jsonc'), 'utf8');
      assert.equal(after.includes(join(f.repo, 'skills')), false);
      assert.equal((await readFile(join(f.repo, 'agents', 'worker.md'), 'utf8')).includes('worker'), true);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('register rejects agents without a stable name', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'agents', 'worker.md'), '---\ndescription: test\n---\n', 'utf8');
    await withConfigDir(f.configDir, async () => {
      await assert.rejects(() => registerRepo(f.repo), /missing stable frontmatter name/);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('register reuses an existing opencode.json and preserves comments', async () => {
  const f = await fixture();
  try {
    await mkdir(f.configDir, { recursive: true });
    await writeFile(
      join(f.configDir, 'opencode.json'),
      '{\n  // keep me\n  "skills": []\n}\n',
      'utf8',
    );

    await withConfigDir(f.configDir, async () => {
      assert.equal(opencodeConfigFile(), join(f.configDir, 'opencode.json'));
      await registerRepo(f.repo);
      const config = await readFile(join(f.configDir, 'opencode.json'), 'utf8');
      assert.match(config, /\/\/ keep me/);
      assert.match(config, /example-repo/);
      await assert.rejects(access(join(f.configDir, 'opencode.jsonc')));
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('legacy mixed skill sources split local paths from remote URLs', async () => {
  const f = await fixture();
  try {
    await mkdir(f.configDir, { recursive: true });
    await writeFile(
      join(f.configDir, 'opencode.json'),
      JSON.stringify({ skills: ['https://example.com/skills', join(f.repo, 'skills')] }, null, 2) + '\n',
      'utf8',
    );

    await withConfigDir(f.configDir, async () => {
      await registerRepo(f.repo);
      const registered = JSON.parse(await readFile(join(f.configDir, 'opencode.json'), 'utf8'));
      assert.deepEqual(registered.skills.paths, [join(f.repo, 'skills')]);
      assert.deepEqual(registered.skills.urls, ['https://example.com/skills']);

      await unregisterRepo(f.repo);
      const unregistered = JSON.parse(await readFile(join(f.configDir, 'opencode.json'), 'utf8'));
      assert.deepEqual(unregistered.skills.paths, []);
      assert.deepEqual(unregistered.skills.urls, ['https://example.com/skills']);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('ambiguous json and jsonc config files are blocked', async () => {
  const f = await fixture();
  try {
    await mkdir(f.configDir, { recursive: true });
    await writeFile(join(f.configDir, 'opencode.json'), '{}\n', 'utf8');
    await writeFile(join(f.configDir, 'opencode.jsonc'), '{}\n', 'utf8');
    await withConfigDir(f.configDir, async () => {
      assert.throws(() => opencodeConfigFile(), /Both .*opencode\.jsonc.*opencode\.json exist/);
      await assert.rejects(() => registerRepo(f.repo), /Both .*opencode\.jsonc.*opencode\.json exist/);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('register blocks duplicate skill IDs across registered repos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-'));
  const configDir = join(root, 'opencode');
  try {
    const first = await makeRepo(root, 'first', 'shared-skill', 'first-agent');
    const second = await makeRepo(root, 'second', 'shared-skill', 'second-agent');
    await withConfigDir(configDir, async () => {
      await registerRepo(first);
      await assert.rejects(() => registerRepo(second), /Skill ID collision 'shared-skill'/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('register blocks duplicate agent names across registered repos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-'));
  const configDir = join(root, 'opencode');
  try {
    const first = await makeRepo(root, 'first', 'first-skill', 'shared-agent');
    const second = await makeRepo(root, 'second', 'second-skill', 'shared-agent');
    await withConfigDir(configDir, async () => {
      await registerRepo(first);
      await assert.rejects(() => registerRepo(second), /Agent name collision 'shared-agent'/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('register refuses to overwrite a broken agent symlink', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.configDir, 'agents'), { recursive: true });
    await symlink(join(f.root, 'missing-agents'), join(f.configDir, 'agents', 'example-repo'), 'dir');
    await withConfigDir(f.configDir, async () => {
      await assert.rejects(() => registerRepo(f.repo), /Agent symlink collision/);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
