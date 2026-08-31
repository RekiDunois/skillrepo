import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const locator = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/skill-development-location/scripts/locate-resource.mjs');

async function runLocator(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [locator, ...args], { env, encoding: 'utf8' });
}

function locatorFailure(error: unknown): error is { code: number; stderr: string } {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return candidate.code === 1 && typeof candidate.stderr === 'string';
}

test('locates a configured skill and follows an agent directory symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  const configDir = join(root, 'opencode');
  const skillRoot = join(root, 'skill-source');
  const agentRepo = join(root, 'agent-repo');
  try {
    await mkdir(join(skillRoot, 'example-skill'), { recursive: true });
    await mkdir(join(agentRepo, 'agents'), { recursive: true });
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await execFileAsync('git', ['init', '-q', agentRepo]);
    await writeFile(join(skillRoot, 'example-skill', 'SKILL.md'), '---\nname: example-skill\ndescription: test\n---\n', 'utf8');
    await writeFile(join(agentRepo, 'agents', 'worker.md'), '---\nname: example-worker\ndescription: test\n---\n', 'utf8');
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      `{
        // The source is deliberately config-relative and uses a glob.
        "skills": { "paths": ["../skill-*",], },
      }\n`,
      'utf8',
    );
    await symlink(join(agentRepo, 'agents'), join(configDir, 'agents', 'external-repo'), 'dir');

    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };
    const skill = JSON.parse((await runLocator(['--kind', 'skill', '--name', 'example-skill'], env)).stdout);
    assert.equal(skill.path, await realpath(join(skillRoot, 'example-skill', 'SKILL.md')));
    assert.equal(skill.sourceRoot, await realpath(skillRoot));

    const agent = JSON.parse((await runLocator(['--kind', 'agent', '--name', 'example-worker'], env)).stdout);
    assert.equal(agent.path, await realpath(join(agentRepo, 'agents', 'worker.md')));
    assert.equal(agent.git.managed, true);
    assert.equal(agent.git.gitRoot, await realpath(agentRepo));
    assert.equal(agent.git.dirty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects duplicate configured resources instead of guessing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  try {
    const configDir = join(root, 'opencode');
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(join(first, 'same'), { recursive: true });
    await mkdir(join(second, 'same'), { recursive: true });
    await mkdir(configDir, { recursive: true });
    const skill = '---\nname: same-skill\ndescription: test\n---\n';
    await writeFile(join(first, 'same', 'SKILL.md'), skill, 'utf8');
    await writeFile(join(second, 'same', 'SKILL.md'), skill, 'utf8');
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({ skills: { paths: [first, second] } }), 'utf8');

    await assert.rejects(
      () => runLocator(['--kind', 'skill', '--name', 'same-skill'], { ...process.env, OPENCODE_CONFIG_DIR: configDir }),
      error => locatorFailure(error) && error.stderr.includes('resource is ambiguous'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses an explicit config and reports missing resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  try {
    const config = join(root, 'custom.jsonc');
    await writeFile(config, '{\n  "skills": []\n}\n', 'utf8');
    await assert.rejects(
      () => runLocator(['--config', config, '--kind', 'skill', '--name', 'missing'], process.env),
      error => locatorFailure(error) && error.stderr.includes('resource not found'),
    );
    assert.equal((await readFile(config, 'utf8')).includes('skills'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
