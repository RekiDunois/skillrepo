import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { assertNoRuntimeCollisions, doctor, inspectRepo } from '../src/core.js';

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

async function makeSkillDiscoveryFixture(output: string): Promise<{
  root: string;
  configDir: string;
  binDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-doctor-skills-'));
  const configDir = join(root, 'opencode');
  const skillsDir = join(root, 'repo', 'skills');
  const binDir = join(root, 'bin');

  await mkdir(join(skillsDir, 'alpha'), { recursive: true });
  await mkdir(join(skillsDir, 'beta'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha\n---\n', 'utf8');
  await writeFile(join(skillsDir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: beta\n---\n', 'utf8');
  await writeFile(join(configDir, 'opencode.jsonc'), `${JSON.stringify({ skills: { paths: [skillsDir] } })}\n`, 'utf8');

  const opencode = join(binDir, 'opencode');
  await writeFile(
    opencode,
    `#!/usr/bin/env sh
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then
  printf '%s\\n' ${JSON.stringify(output)}
fi
exit 0
`,
    'utf8',
  );
  await chmod(opencode, 0o755);

  return { root, configDir, binDir };
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

test('doctor reports configured skills missing from OpenCode discovery', async () => {
  const fixture = await makeSkillDiscoveryFixture(JSON.stringify([{ name: 'alpha' }]));
  try {
    const result = await withDoctorEnv(fixture.configDir, fixture.binDir, () => doctor());
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.includes('missing configured skill IDs: beta')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('doctor does not report success when OpenCode has no registered target source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-doctor-empty-'));
  const configDir = join(root, 'opencode');
  const binDir = join(root, 'bin');
  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    const opencode = join(binDir, 'opencode');
    await writeFile(opencode, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
    await chmod(opencode, 0o755);

    const result = await withDoctorEnv(configDir, binDir, () => doctor());
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.includes('No registered skill or agent target source')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor accepts configured skills present in OpenCode discovery', async () => {
  const fixture = await makeSkillDiscoveryFixture(JSON.stringify([{ name: 'alpha' }, { name: 'beta' }]));
  try {
    const result = await withDoctorEnv(fixture.configDir, fixture.binDir, () => doctor());
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('doctor does not count a skill ID mentioned in another discovery entry as discovered', async () => {
  const fixture = await makeSkillDiscoveryFixture(JSON.stringify([{ name: 'alpha', description: 'mentions beta' }]));
  try {
    const result = await withDoctorEnv(fixture.configDir, fixture.binDir, () => doctor());
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.includes('missing configured skill IDs: beta')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('collision pre-check fails closed when skill discovery JSON is truncated', async () => {
  const fixture = await makeSkillDiscoveryFixture('[{"name":"beta"},');
  const candidate = join(fixture.root, 'candidate');
  try {
    await mkdir(join(candidate, 'skills', 'beta'), { recursive: true });
    await writeFile(
      join(candidate, 'skills', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: candidate beta\n---\n',
      'utf8',
    );
    const inventory = await inspectRepo(candidate);
    await withDoctorEnv(fixture.configDir, fixture.binDir, async () => {
      await assert.rejects(() => assertNoRuntimeCollisions(inventory));
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
