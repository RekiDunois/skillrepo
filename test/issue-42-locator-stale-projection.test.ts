import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stageProjection } from '../src/layout.js';

const execFileAsync = promisify(execFile);
const locator = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/skill-development-location/scripts/locate-resource.mjs');

function locatorFailure(error: unknown): error is { code: number; stderr: string } {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return candidate.code === 1 && typeof candidate.stderr === 'string';
}

test('issue #42: locator authoring fails closed when a managed projection has diverged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-issue-42-locator-stale-'));
  const configDir = join(root, 'opencode');
  const repo = join(root, 'package-repo');
  const canonical = join(repo, '.apm', 'skills');
  try {
    await mkdir(join(canonical, 'stale-skill'), { recursive: true });
    await mkdir(join(repo, '.apm', 'agents'), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await execFileAsync('git', ['init', '-q', repo]);
    await writeFile(
      join(canonical, 'stale-skill', 'SKILL.md'),
      '---\nname: stale-skill\ndescription: canonical\n---\n',
      'utf8',
    );
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\nversion: 0.1.0\n', 'utf8');
    await stageProjection(canonical, join(repo, 'skills'));

    // Keep the marker structurally valid but diverge the generated projection.
    // The locator must not trust the marker shape and silently hide this broken
    // second tree from authoring-source discovery.
    await writeFile(
      join(repo, 'skills', 'stale-skill', 'SKILL.md'),
      '---\nname: stale-skill\ndescription: externally modified projection\n---\n',
      'utf8',
    );
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      JSON.stringify({ skills: { paths: [join(repo, 'skills')] } }),
      'utf8',
    );

    await assert.rejects(
      () => execFileAsync(
        process.execPath,
        [locator, '--kind', 'skill', '--name', 'stale-skill', '--project-root', repo, '--authoring'],
        { env: { ...process.env, OPENCODE_CONFIG_DIR: configDir }, encoding: 'utf8' },
      ),
      error => locatorFailure(error) && error.stderr.includes('resource is ambiguous'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
