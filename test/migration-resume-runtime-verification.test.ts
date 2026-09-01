import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { applyMigration } from '../src/migration.js';

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

test('re-verifying a committed no-verify migration must run runtime verification before marking it verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-resume-runtime-'));
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  const configDir = join(root, 'config');
  const binDir = join(root, 'bin');
  const planPath = join(root, 'plan.json');
  const oldPath = process.env.PATH;

  try {
    await mkdir(join(sourceRoot, 'skill', 'alpha'), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(sourceRoot, 'skill', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: alpha\n---\n\nbody marker\n',
      'utf8',
    );
    await writeFile(
      planPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedFrom: { sourceRoot },
        repositories: [{ id: 'demo-repo', action: 'CREATE_AND_MOVE', skills: ['alpha'], agents: [], libs: [] }],
      }, null, 2)}\n`,
      'utf8',
    );

    const opencode = join(binDir, 'opencode');
    await writeFile(
      opencode,
      `#!/usr/bin/env sh\nif [ "$1" = "debug" ] && [ "$2" = "skill" ]; then\n  printf '%s' '[{"name":"alpha"}]'\nfi\nexit 0\n`,
      'utf8',
    );
    await chmod(opencode, 0o755);

    await withConfigDir(configDir, async () => {
      const committed = await applyMigration({
        planPath,
        targetRoot,
        verify: false,
      });
      assert.equal(committed.status, 'committed');
      assert.equal(committed.verified, false);

      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
      await assert.rejects(
        () => applyMigration({
          planPath,
          targetRoot,
          runtimeVerifier: async context => ({
            ok: false,
            phase: context.phase,
            checks: [{ ok: false, command: 'resume runtime verifier', stdout: '', stderr: 'must run' }],
            diagnostics: {},
          }),
        }),
        /resume runtime verifier: must run/,
      );
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
