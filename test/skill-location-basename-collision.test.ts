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

async function runLocator(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [locator, ...args], { env, encoding: 'utf8' });
}

test('does not confuse a skill named skills with the package source root through a compatibility symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-location-symlink-name-'));
  const repo = join(root, 'package-repo');
  const sourceRoot = join(repo, '.apm', 'skills');
  const compatibilityRoot = join(root, 'compatibility-skills');
  const skill = join(sourceRoot, 'skills', 'SKILL.md');
  const configDir = join(root, 'opencode');

  try {
    await mkdir(dirname(skill), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await execFileAsync('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\nversion: 0.1.0\n', 'utf8');
    await writeFile(skill, '---\nname: skills\ndescription: package skill\n---\n', 'utf8');
    await mkdir(compatibilityRoot, { recursive: true });
    await symlink(join(sourceRoot, 'skills'), join(compatibilityRoot, 'skills'), 'dir');
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      JSON.stringify({ skills: { paths: [compatibilityRoot] } }),
      'utf8',
    );

    const found = JSON.parse((await runLocator([
      '--kind', 'skill',
      '--name', 'skills',
      '--project-root', root,
    ], { ...process.env, OPENCODE_CONFIG_DIR: configDir })).stdout);

    assert.equal(found.path, await realpath(skill));
    assert.equal(found.sourceRoot, await realpath(sourceRoot));
    assert.equal(found.sourceRelativePath, 'skills/SKILL.md');
    assert.equal(found.repoRoot, await realpath(repo));
    assert.equal(found.layout, 'apm');
    assert.equal(found.path, join(found.sourceRoot, found.sourceRelativePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
