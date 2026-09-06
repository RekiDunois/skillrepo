import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const locator = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/skill-development-location/scripts/locate-resource.mjs');

interface LocatorFailure {
  code: number;
  stderr: string;
}

async function runLocator(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [locator, ...args], { env, encoding: 'utf8' });
}

function locatorFailure(error: unknown): error is LocatorFailure {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return candidate.code === 1 && typeof candidate.stderr === 'string';
}

async function runLocatorExpectingFailure(args: string[], env: NodeJS.ProcessEnv): Promise<LocatorFailure> {
  try {
    await runLocator(args, env);
  } catch (error) {
    if (locatorFailure(error)) return error;
    throw error;
  }
  throw new Error('expected the locator to fail');
}

function structuredError(stderr: string): Record<string, any> {
  const marker = '\nlocate-resource: ';
  const index = stderr.indexOf(marker);
  assert.ok(index > 0, `expected a structured result before the failure message: ${stderr}`);
  return JSON.parse(stderr.slice(0, index));
}

interface Fixture {
  root: string;
  home: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
}

async function createFixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `skill-location-deploy-${label}-`));
  const home = join(root, 'home');
  const configDir = join(root, 'opencode');
  await mkdir(home, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'opencode.jsonc'), '{}\n', 'utf8');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_CONFIG_DIR: configDir,
  };
  return { root, home, configDir, env };
}

async function writeSkill(path: string, name: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: synthetic\n---\n`, 'utf8');
}

function assertConsumerMatch(match: any, expectedPath: string, expectedOrigin: string): void {
  assert.equal(match.path, expectedPath);
  assert.equal(match.origin, expectedOrigin);
  assert.equal(match.layout, 'unknown');
  assert.equal(match.repoRoot, null);
}

test('default discovery still returns a standalone global agents copy', async () => {
  const f = await createFixture('consumer-only');
  try {
    const copy = join(f.home, '.agents', 'skills', 'orphan-skill', 'SKILL.md');
    await writeSkill(copy, 'orphan-skill');

    const discovery = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'orphan-skill',
      '--project-root', f.root,
    ], f.env)).stdout);
    assert.equal(discovery.path, await realpath(copy));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authoring mode returns an unregistered repository source over a global agents copy', async () => {
  const f = await createFixture('legacy-source');
  try {
    const repo = join(f.root, 'source-repo');
    const source = join(repo, 'skills', 'deployed-skill', 'SKILL.md');
    const copy = join(f.home, '.agents', 'skills', 'deployed-skill', 'SKILL.md');
    await execFileAsync('git', ['init', '-q', repo]);
    await writeSkill(source, 'deployed-skill');
    await writeSkill(copy, 'deployed-skill');

    const authoring = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'deployed-skill',
      '--project-root', repo,
      '--authoring',
    ], f.env)).stdout);
    assert.equal(authoring.selectionMode, 'authoring');
    assert.equal(authoring.path, await realpath(source));
    assert.equal(authoring.sourceRoot, await realpath(join(repo, 'skills')));
    assert.equal(authoring.repoRoot, await realpath(repo));
    assert.equal(authoring.layout, 'skillrepo');
    assert.equal(authoring.consumerMatches.length, 1);
    assertConsumerMatch(authoring.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authoring mode returns an unregistered package source over a global agents copy', async () => {
  const f = await createFixture('package-source');
  try {
    const repo = join(f.root, 'package-repo');
    const source = join(repo, '.apm', 'skills', 'deployed-skill', 'SKILL.md');
    const copy = join(f.home, '.agents', 'skills', 'deployed-skill', 'SKILL.md');
    await execFileAsync('git', ['init', '-q', repo]);
    await writeSkill(source, 'deployed-skill');
    await writeSkill(copy, 'deployed-skill');
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\nversion: 0.1.0\n', 'utf8');

    const authoring = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'deployed-skill',
      '--project-root', repo,
      '--authoring',
    ], f.env)).stdout);
    assert.equal(authoring.selectionMode, 'authoring');
    assert.equal(authoring.path, await realpath(source));
    assert.equal(authoring.sourceRoot, await realpath(join(repo, '.apm', 'skills')));
    assert.equal(authoring.sourceRelativePath, 'deployed-skill/SKILL.md');
    assert.equal(authoring.repoRoot, await realpath(repo));
    assert.equal(authoring.layout, 'apm');
    assert.equal(authoring.git.gitRoot, await realpath(repo));
    assert.equal(authoring.consumerMatches.length, 1);
    assertConsumerMatch(authoring.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authoring mode does not create ambiguity between a registered source and an agents copy', async () => {
  const f = await createFixture('registered-source');
  try {
    const repo = join(f.root, 'registered-repo');
    const source = join(repo, 'skills', 'registered-skill', 'SKILL.md');
    const copy = join(f.home, '.agents', 'skills', 'registered-skill', 'SKILL.md');
    await execFileAsync('git', ['init', '-q', repo]);
    await writeSkill(source, 'registered-skill');
    await writeSkill(copy, 'registered-skill');
    await writeFile(
      join(f.configDir, 'opencode.jsonc'),
      JSON.stringify({ skills: { paths: [join(repo, 'skills')] } }),
      'utf8',
    );

    await assert.rejects(
      () => runLocator(['--kind', 'skill', '--name', 'registered-skill', '--project-root', f.root], f.env),
      error => locatorFailure(error) && error.stderr.includes('resource is ambiguous'),
    );

    const authoring = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'registered-skill',
      '--project-root', f.root,
      '--authoring',
    ], f.env)).stdout);
    assert.equal(authoring.selectionMode, 'authoring');
    assert.equal(authoring.path, await realpath(source));
    assert.equal(authoring.repoRoot, await realpath(repo));
    assert.equal(authoring.consumerMatches.length, 1);
    assertConsumerMatch(authoring.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authoring mode fails closed when only a global agents copy matches', async () => {
  const f = await createFixture('consumer-only-authoring');
  try {
    const copy = join(f.home, '.agents', 'skills', 'orphan-skill', 'SKILL.md');
    await writeSkill(copy, 'orphan-skill');

    const failure = await runLocatorExpectingFailure([
      '--kind', 'skill',
      '--name', 'orphan-skill',
      '--project-root', f.root,
      '--authoring',
    ], f.env);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /authoritative source not found: skill 'orphan-skill'/);
    const result = structuredError(failure.stderr);
    assert.equal(result.selectionMode, 'authoring');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.consumerMatches.length, 1);
    assertConsumerMatch(result.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a project agents copy inside a Git worktree stays a consumer in authoring mode', async () => {
  const f = await createFixture('worktree-copy');
  try {
    const worktree = join(f.root, 'worktree');
    const copy = join(worktree, '.agents', 'skills', 'worktree-skill', 'SKILL.md');
    await execFileAsync('git', ['init', '-q', worktree]);
    await writeSkill(copy, 'worktree-skill');

    const failure = await runLocatorExpectingFailure([
      '--kind', 'skill',
      '--name', 'worktree-skill',
      '--project-root', worktree,
      '--authoring',
    ], f.env);
    assert.match(failure.stderr, /authoritative source not found: skill 'worktree-skill'/);
    const result = structuredError(failure.stderr);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.consumerMatches.length, 1);
    assertConsumerMatch(result.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authoring ambiguity contains only genuine sources while a consumer copy stays diagnostic', async () => {
  const f = await createFixture('ambiguity');
  try {
    const first = join(f.root, 'first');
    const second = join(f.root, 'second');
    await writeSkill(join(first, 'skills', 'duplicated-skill', 'SKILL.md'), 'duplicated-skill');
    await writeSkill(join(second, 'skills', 'duplicated-skill', 'SKILL.md'), 'duplicated-skill');
    const copy = join(f.home, '.agents', 'skills', 'duplicated-skill', 'SKILL.md');
    await writeSkill(copy, 'duplicated-skill');
    await writeFile(
      join(f.configDir, 'opencode.jsonc'),
      JSON.stringify({ skills: { paths: [join(first, 'skills'), join(second, 'skills')] } }),
      'utf8',
    );

    const failure = await runLocatorExpectingFailure([
      '--kind', 'skill',
      '--name', 'duplicated-skill',
      '--project-root', f.root,
      '--authoring',
    ], f.env);
    assert.match(failure.stderr, /resource is ambiguous: skill 'duplicated-skill'/);
    const result = structuredError(failure.stderr);
    assert.equal(result.candidates.length, 2);
    const candidatePaths = result.candidates.map((candidate: { path: string }) => resolve(candidate.path));
    assert.deepEqual(candidatePaths.sort(), [
      await realpath(join(first, 'skills', 'duplicated-skill', 'SKILL.md')),
      await realpath(join(second, 'skills', 'duplicated-skill', 'SKILL.md')),
    ].sort());
    assert.equal(result.consumerMatches.length, 1);
    assertConsumerMatch(result.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a compatibility symlink into the real source resolves to one authoring identity', async () => {
  const f = await createFixture('symlink');
  try {
    const repo = join(f.root, 'source-repo');
    const source = join(repo, 'skills', 'linked-skill', 'SKILL.md');
    await execFileAsync('git', ['init', '-q', repo]);
    await writeSkill(source, 'linked-skill');
    const link = join(f.home, '.agents', 'skills', 'linked-skill');
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(repo, 'skills', 'linked-skill'), link, 'dir');

    const authoring = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'linked-skill',
      '--project-root', repo,
      '--authoring',
    ], f.env)).stdout);
    assert.equal(authoring.selectionMode, 'authoring');
    assert.equal(authoring.path, await realpath(source));
    assert.equal(authoring.sourceRoot, await realpath(join(repo, 'skills')));
    assert.equal(authoring.layout, 'skillrepo');
    assert.deepEqual(authoring.consumerMatches, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('legacy codex copies stay diagnostics and out of default discovery', async () => {
  const f = await createFixture('codex');
  try {
    const projectCopy = join(f.root, 'project', '.codex', 'skills', 'codex-skill', 'SKILL.md');
    const homeCopy = join(f.home, '.codex', 'skills', 'codex-skill', 'SKILL.md');
    await writeSkill(projectCopy, 'codex-skill');
    await writeSkill(homeCopy, 'codex-skill');

    await assert.rejects(
      () => runLocator(['--kind', 'skill', '--name', 'codex-skill', '--project-root', join(f.root, 'project')], f.env),
      error => locatorFailure(error) && error.stderr.includes('resource not found'),
    );

    const failure = await runLocatorExpectingFailure([
      '--kind', 'skill',
      '--name', 'codex-skill',
      '--project-root', join(f.root, 'project'),
      '--authoring',
    ], f.env);
    assert.match(failure.stderr, /authoritative source not found: skill 'codex-skill'/);
    const result = structuredError(failure.stderr);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.consumerMatches.length, 2);
    const origins = result.consumerMatches.map((match: { origin: string }) => match.origin);
    assert.deepEqual(origins.sort(), ['codex-legacy', 'codex-legacy']);
    const consumerPaths = result.consumerMatches.map((match: { path: string }) => resolve(match.path));
    assert.deepEqual(consumerPaths.sort(), [await realpath(projectCopy), await realpath(homeCopy)].sort());
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('authoring mode applies V1 primary precedence and ignores consumer primary matches', async () => {
  const f = await createFixture('precedence');
  try {
    const sourceRoot = join(f.root, 'authored');
    const primarySource = join(sourceRoot, 'alpha', 'SKILL.md');
    const aliasSource = join(sourceRoot, 'target', 'SKILL.md');
    const copy = join(f.home, '.agents', 'skills', 'target', 'SKILL.md');
    await writeSkill(primarySource, 'target');
    await writeSkill(aliasSource, 'other-skill');
    await writeSkill(copy, 'target');
    await writeFile(
      join(f.configDir, 'opencode.jsonc'),
      JSON.stringify({ skills: { paths: [sourceRoot] } }),
      'utf8',
    );

    const authoring = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'target',
      '--project-root', f.root,
      '--authoring',
    ], f.env)).stdout);
    assert.equal(authoring.selectionMode, 'authoring');
    assert.equal(authoring.id, 'target');
    assert.equal(authoring.path, await realpath(primarySource));
    assert.equal(authoring.consumerMatches.length, 1);
    assertConsumerMatch(authoring.consumerMatches[0], await realpath(copy), 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
