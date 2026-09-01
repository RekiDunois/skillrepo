import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const locator = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/skill-development-location/scripts/locate-resource.mjs');

async function runLocator(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [locator, ...args], { env, encoding: 'utf8' });
}

test('prefers OpenCode V1 primary names over path-derived compatibility aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-v1-'));
  const configDir = join(root, 'opencode');
  const projectRoot = join(root, 'project');
  const skillRoot = join(root, 'skills');
  const agentsRoot = join(configDir, 'agents');
  try {
    await mkdir(join(skillRoot, 'alpha'), { recursive: true });
    await mkdir(join(skillRoot, 'target'), { recursive: true });
    await mkdir(agentsRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    const primarySkill = join(skillRoot, 'alpha', 'SKILL.md');
    const aliasSkill = join(skillRoot, 'target', 'SKILL.md');
    await writeFile(primarySkill, '---\nname: target\ndescription: V1 primary name\n---\n', 'utf8');
    await writeFile(aliasSkill, '---\nname: other-skill\ndescription: path alias collision\n---\n', 'utf8');

    const primaryAgent = join(agentsRoot, 'alpha.md');
    const aliasAgent = join(agentsRoot, 'target-agent.md');
    await writeFile(primaryAgent, '---\nname: target-agent\ndescription: V1 primary name\n---\n', 'utf8');
    await writeFile(aliasAgent, '---\nname: other-agent\ndescription: path alias collision\n---\n', 'utf8');

    await writeFile(join(configDir, 'opencode.jsonc'), JSON.stringify({ skills: { paths: [skillRoot] } }), 'utf8');
    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };

    const skill = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'target',
      '--project-root', projectRoot,
    ], env)).stdout);
    assert.equal(skill.path, await realpath(primarySkill));
    assert.equal(skill.id, 'target');

    const agent = JSON.parse((await runLocator([
      '--kind', 'agent',
      '--name', 'target-agent',
      '--project-root', projectRoot,
    ], env)).stdout);
    assert.equal(agent.path, await realpath(primaryAgent));
    assert.equal(agent.id, 'target-agent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discovers V1 ancestor .opencode and .agents skill roots from pwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-v1-'));
  const configDir = join(root, 'opencode');
  const worktree = join(root, 'workspace');
  const cwd = join(worktree, 'packages', 'app');
  const ancestorAgent = join(worktree, '.opencode', 'agents', 'team', 'reviewer.md');
  const ancestorSkill = join(worktree, '.agents', 'skills', 'ancestor-skill', 'SKILL.md');
  try {
    await mkdir(dirname(ancestorAgent), { recursive: true });
    await mkdir(dirname(ancestorSkill), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await execFileAsync('git', ['init', '-q', worktree]);
    await writeFile(ancestorAgent, '---\ndescription: ancestor V1 agent\nmode: subagent\n---\n', 'utf8');
    await writeFile(ancestorSkill, '---\nname: ancestor-skill\ndescription: ancestor V1 skill\n---\n', 'utf8');
    await writeFile(join(configDir, 'opencode.jsonc'), '{}\n', 'utf8');

    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };
    const agent = JSON.parse((await runLocator([
      '--kind', 'agent',
      '--name', 'team/reviewer',
      '--project-root', cwd,
    ], env)).stdout);
    assert.equal(agent.path, await realpath(ancestorAgent));

    const skill = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'ancestor-skill',
      '--project-root', cwd,
    ], env)).stdout);
    assert.equal(skill.path, await realpath(ancestorSkill));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
