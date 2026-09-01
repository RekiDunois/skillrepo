import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { applyMigration, type RuntimeVerificationResult } from '../src/migration.js';

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

async function fixture(): Promise<{ root: string; sourceRoot: string; targetRoot: string; planPath: string; bin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-migration-runtime-'));
  const sourceRoot = join(root, 'opencode');
  const targetRoot = join(root, 'repos');
  const planPath = join(root, 'migration-plan.json');
  const bin = join(root, 'bin');
  await mkdir(join(sourceRoot, 'skill', 'alpha'), { recursive: true });
  await mkdir(join(sourceRoot, 'skill', 'beta'), { recursive: true });
  await writeFile(join(sourceRoot, 'skill', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha\n---\nalpha marker\n', 'utf8');
  await writeFile(join(sourceRoot, 'skill', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: beta\n---\nbeta marker\n', 'utf8');
  await writeFile(join(sourceRoot, 'opencode.jsonc'), '{}\n', 'utf8');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "debug" ] && [ "$2" = "skill" ] && [ -f "$OPENCODE_CONFIG_DIR/../repos/demo-repo/skills/alpha/SKILL.md" ]; then
  if [ ! -f "$OPENCODE_CONFIG_DIR/.runtime-probe-seen" ]; then
    touch "$OPENCODE_CONFIG_DIR/.runtime-probe-seen"
    printf '[]'
  else
    printf '[{"name":"alpha"},{"name":"beta"}]'
  fi
else
  printf '[]'
fi
exit 0
`, 'utf8');
  await chmod(join(bin, 'opencode'), 0o755);
  await writeFile(planPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: { sourceRoot },
    repositories: [{ id: 'demo-repo', action: 'CREATE_AND_MOVE', skills: ['alpha', 'beta'], agents: [], libs: [] }],
  }, null, 2)}\n`, 'utf8');
  return { root, sourceRoot, targetRoot, planPath, bin };
}

function passed(phase: 'canary-runtime-verification' | 'final-runtime-verification'): RuntimeVerificationResult {
  return {
    ok: true,
    phase,
    checks: [{ ok: true, command: `runtime ${phase}`, stdout: 'ok', stderr: '' }],
    diagnostics: {},
  };
}

test('canary runtime failure stops the batch, writes diagnostics, and rolls back all changes', async () => {
  const f = await fixture();
  const phases: string[] = [];
  const oldPath = process.env.PATH;
  try {
    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${f.bin}${delimiter}${oldPath ?? ''}`;
      await assert.rejects(
        () => applyMigration({
          planPath: f.planPath,
          targetRoot: f.targetRoot,
          projectDir: f.root,
          runtimeVerifier: async context => {
            phases.push(context.phase);
            return {
              ...passed('canary-runtime-verification'),
              ok: false,
              diagnostics: { error: 'TUI runtime could not load canary', apiKey: 'secret-value' },
            };
          },
        }),
        /canary-runtime-verification.*rollback-complete/s,
      );
      assert.deepEqual(phases, ['canary-runtime-verification']);
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await access(join(f.sourceRoot, 'skill', 'beta', 'SKILL.md'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo')));

      const journalName = (await readdir(join(f.sourceRoot, '.skillrepo-migrations')))
        .find(name => name.endsWith('.json') && !name.includes('.diagnostic.'))!;
      const journalPath = join(f.sourceRoot, '.skillrepo-migrations', journalName);
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        status: string;
        runtimeVerification?: { diagnosticsPath?: string };
      };
      assert.equal(journal.status, 'rollback-complete');
      assert.ok(journal.runtimeVerification?.diagnosticsPath);
      const diagnostic = await readFile(journal.runtimeVerification.diagnosticsPath!, 'utf8');
      assert.match(diagnostic, /"rollback": "complete"/);
      assert.match(diagnostic, /\[REDACTED\]/);
      assert.doesNotMatch(diagnostic, /secret-value/);
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a successful canary does not replace final runtime verification', async () => {
  const f = await fixture();
  const phases: string[] = [];
  const oldPath = process.env.PATH;
  try {
    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${f.bin}${delimiter}${oldPath ?? ''}`;
      const result = await applyMigration({
        planPath: f.planPath,
        targetRoot: f.targetRoot,
        projectDir: f.root,
        runtimeVerifier: async context => {
          phases.push(context.phase);
          return passed(context.phase);
        },
      });
      assert.equal(result.status, 'committed');
      assert.deepEqual(phases, ['canary-runtime-verification', 'final-runtime-verification']);
      await access(join(f.targetRoot, 'demo-repo', 'skills', 'alpha', 'SKILL.md'));
      await access(join(f.targetRoot, 'demo-repo', 'skills', 'beta', 'SKILL.md'));
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('final runtime failure rolls back the complete batch', async () => {
  const f = await fixture();
  const oldPath = process.env.PATH;
  const phases: string[] = [];
  try {
    await withConfigDir(f.sourceRoot, async () => {
      process.env.PATH = `${f.bin}${delimiter}${oldPath ?? ''}`;
      await assert.rejects(
        () => applyMigration({
          planPath: f.planPath,
          targetRoot: f.targetRoot,
          projectDir: f.root,
          runtimeVerifier: async context => {
            phases.push(context.phase);
            return context.phase === 'final-runtime-verification'
              ? { ...passed(context.phase), ok: false, diagnostics: { error: 'final inventory mismatch' } }
              : passed(context.phase);
          },
        }),
        /final-runtime-verification.*rollback-complete/s,
      );
      assert.deepEqual(phases, ['canary-runtime-verification', 'final-runtime-verification']);
      await access(join(f.sourceRoot, 'skill', 'alpha', 'SKILL.md'));
      await access(join(f.sourceRoot, 'skill', 'beta', 'SKILL.md'));
      await assert.rejects(access(join(f.targetRoot, 'demo-repo')));
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(f.root, { recursive: true, force: true });
  }
});
