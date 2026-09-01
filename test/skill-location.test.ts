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
  const projectRoot = join(root, 'project');
  const agentRepo = join(root, 'agent-repo');
  try {
    await mkdir(join(skillRoot, 'example-skill'), { recursive: true });
    await mkdir(join(projectRoot, '.opencode', 'skills', 'project-skill'), { recursive: true });
    await mkdir(join(configDir, 'skills', 'global-skill'), { recursive: true });
    await mkdir(join(agentRepo, 'agents'), { recursive: true });
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await execFileAsync('git', ['init', '-q', agentRepo]);
    await writeFile(join(skillRoot, 'example-skill', 'SKILL.md'), '---\nname: displayed-skill\ndescription: test\n---\n', 'utf8');
    await writeFile(join(projectRoot, '.opencode', 'skills', 'project-skill', 'SKILL.md'), '---\nname: project-skill\ndescription: test\n---\n', 'utf8');
    await writeFile(join(configDir, 'skills', 'global-skill', 'SKILL.md'), '---\nname: global-skill\ndescription: test\n---\n', 'utf8');
    await writeFile(join(agentRepo, 'agents', 'worker.md'), '---\ndescription: test\n---\n', 'utf8');
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
    const skill = JSON.parse((await runLocator(['--kind', 'skill', '--name', 'example-skill', '--project-root', projectRoot], env)).stdout);
    assert.equal(skill.path, await realpath(join(skillRoot, 'example-skill', 'SKILL.md')));
    assert.equal(skill.sourceRoot, await realpath(skillRoot));
    assert.equal(skill.frontmatterName, 'displayed-skill');

    const projectSkill = JSON.parse((await runLocator(['--kind', 'skill', '--name', 'project-skill', '--project-root', projectRoot], env)).stdout);
    assert.equal(projectSkill.path, await realpath(join(projectRoot, '.opencode', 'skills', 'project-skill', 'SKILL.md')));

    const globalSkill = JSON.parse((await runLocator(['--kind', 'skill', '--name', 'global-skill', '--project-root', projectRoot], env)).stdout);
    assert.equal(globalSkill.path, await realpath(join(configDir, 'skills', 'global-skill', 'SKILL.md')));

    const agent = JSON.parse((await runLocator(['--kind', 'agent', '--name', 'external-repo/worker', '--project-root', projectRoot], env)).stdout);
    assert.equal(agent.path, await realpath(join(agentRepo, 'agents', 'worker.md')));
    assert.equal(agent.frontmatterName, null);
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
    const skill = '---\nname: displayed-first\ndescription: test\n---\n';
    await writeFile(join(first, 'same', 'SKILL.md'), skill, 'utf8');
    await writeFile(join(second, 'same', 'SKILL.md'), skill, 'utf8');
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({ skills: { paths: [first, second] } }), 'utf8');

    await assert.rejects(
      () => runLocator(['--kind', 'skill', '--name', 'same'], { ...process.env, OPENCODE_CONFIG_DIR: configDir }),
      error => locatorFailure(error) && error.stderr.includes('resource is ambiguous'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves OpenCode V1 names and legacy agent roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  const configDir = join(root, 'opencode');
  const projectRoot = join(root, 'project');
  const skillRoot = join(root, 'skills');
  const projectAgent = join(projectRoot, '.opencode', 'agent');
  const globalMode = join(configDir, 'mode');
  try {
    await mkdir(join(skillRoot, 'group', 'release'), { recursive: true });
    await mkdir(projectAgent, { recursive: true });
    await mkdir(globalMode, { recursive: true });
    await mkdir(join(configDir, 'agents'), { recursive: true });
    await writeFile(join(skillRoot, 'group', 'release', 'SKILL.md'), '---\nname: release\ndescription: test\n---\n', 'utf8');
    await writeFile(join(projectAgent, 'reviewer.md'), '---\ndescription: test\nmode: subagent\n---\n', 'utf8');
    await writeFile(join(globalMode, 'planner.md'), '---\ndescription: test\n---\n', 'utf8');
    await writeFile(join(configDir, 'agents', 'worker.md'), '---\nname: renamed-worker\ndescription: test\n---\n', 'utf8');
    await writeFile(join(configDir, 'opencode.jsonc'), JSON.stringify({ skills: [skillRoot] }), 'utf8');

    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };
    const skill = JSON.parse((await runLocator(['--kind', 'skill', '--name', 'release', '--project-root', projectRoot], env)).stdout);
    assert.equal(skill.path, await realpath(join(skillRoot, 'group', 'release', 'SKILL.md')));
    assert.equal(skill.id, 'release');
    assert.equal(skill.identifiers.includes('group/release'), true);
    assert.equal(skill.repoRoot, await realpath(root));
    assert.equal(skill.layout, 'skillrepo');

    const reviewer = JSON.parse((await runLocator(['--kind', 'agent', '--name', 'reviewer', '--project-root', projectRoot], env)).stdout);
    assert.equal(reviewer.path, await realpath(join(projectAgent, 'reviewer.md')));

    const planner = JSON.parse((await runLocator(['--kind', 'agent', '--name', 'planner', '--project-root', projectRoot], env)).stdout);
    assert.equal(planner.path, await realpath(join(globalMode, 'planner.md')));

    const renamed = JSON.parse((await runLocator(['--kind', 'agent', '--name', 'renamed-worker', '--project-root', projectRoot], env)).stdout);
    assert.equal(renamed.path, await realpath(join(configDir, 'agents', 'worker.md')));
    assert.equal(renamed.identifiers.includes('worker'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves nested OpenCode V1 agent IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  const configDir = join(root, 'opencode');
  const projectRoot = join(root, 'project');
  const nestedAgent = join(projectRoot, '.opencode', 'agent', 'team', 'reviewer.md');
  try {
    await mkdir(dirname(nestedAgent), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(nestedAgent, '---\ndescription: nested V1 agent\nmode: subagent\n---\n', 'utf8');
    await writeFile(join(configDir, 'opencode.jsonc'), '{}\n', 'utf8');

    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };
    const found = JSON.parse((await runLocator([
      '--kind', 'agent',
      '--name', 'team/reviewer',
      '--project-root', projectRoot,
    ], env)).stdout);
    assert.equal(found.path, await realpath(nestedAgent));
    assert.equal(found.id, 'team/reviewer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves OpenCode V1 relative skill paths from the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  const configDir = join(root, 'opencode');
  const projectRoot = join(root, 'project');
  const skill = join(projectRoot, 'team-skills', 'configured', 'SKILL.md');
  try {
    await mkdir(dirname(skill), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(skill, '---\nname: configured\ndescription: V1 relative path\n---\n', 'utf8');
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      JSON.stringify({ skills: { paths: ['./team-skills'] } }),
      'utf8',
    );

    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };
    const found = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'configured',
      '--project-root', projectRoot,
    ], env)).stdout);
    assert.equal(found.path, await realpath(skill));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not discover nested legacy V1 mode files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-'));
  const configDir = join(root, 'opencode');
  const projectRoot = join(root, 'project');
  const nestedMode = join(configDir, 'mode', 'nested', 'planner.md');
  try {
    await mkdir(dirname(nestedMode), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(nestedMode, '---\ndescription: nested legacy mode\n---\n', 'utf8');
    await writeFile(join(configDir, 'opencode.jsonc'), '{}\n', 'utf8');

    const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir };
    await assert.rejects(
      () => runLocator(['--kind', 'agent', '--name', 'planner', '--project-root', projectRoot], env),
      error => locatorFailure(error) && error.stderr.includes('resource not found'),
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

test('returns the package repository root and layout instead of the .apm directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-package-'));
  const repo = join(root, 'package-repo');
  const sourceRoot = join(repo, '.apm', 'skills');
  const skill = join(sourceRoot, 'new-skill', 'SKILL.md');
  const configDir = join(root, 'opencode');
  try {
    await mkdir(dirname(skill), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await execFileAsync('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
    await writeFile(skill, '---\nname: new-skill\ndescription: package skill\n---\n', 'utf8');
    await writeFile(join(configDir, 'opencode.jsonc'), JSON.stringify({ skills: { paths: [sourceRoot] } }), 'utf8');

    const found = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'new-skill',
      '--project-root', root,
    ], { ...process.env, OPENCODE_CONFIG_DIR: configDir })).stdout);

    assert.equal(found.path, await realpath(skill));
    assert.equal(found.sourceRoot, await realpath(sourceRoot));
    assert.equal(found.sourceRelativePath, 'new-skill/SKILL.md');
    assert.equal(found.repoRoot, await realpath(repo));
    assert.equal(found.layout, 'apm');
    assert.equal(found.git.gitRoot, await realpath(repo));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
