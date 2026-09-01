import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRegisteredRepo } from '../src/runtime.js';

test('registered repo resolver preserves a legacy repo whose basename is .apm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-runtime-dot-apm-'));
  const configDir = join(root, 'opencode');
  const repo = join(root, '.apm');
  const skills = join(repo, 'skills');
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };

  try {
    await mkdir(skills, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'opencode.jsonc'), `{"skills":[${JSON.stringify(skills)}]}\n`, 'utf8');

    assert.equal(await resolveRegisteredRepo('.apm', env), repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
