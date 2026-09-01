import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('dist/src/cli.js'), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

async function fixture(): Promise<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
  planPath: string;
  configDir: string;
  templatePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-handoff-cli-'));
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  const configDir = join(root, 'config');
  const planPath = join(root, 'plan.json');
  const templatePath = join(root, 'handoff.md');

  await mkdir(join(sourceRoot, 'skill', 'demo'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'skill', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: demo\n---\n\nbody\n',
    'utf8',
  );
  await writeFile(
    planPath,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedFrom: { sourceRoot },
      repositories: [{ id: 'demo-repo', action: 'CREATE_AND_MOVE', skills: ['demo'], agents: [], libs: [] }],
    }, null, 2)}\n`,
    'utf8',
  );
  await mkdir(configDir, { recursive: true });
  return { root, sourceRoot, targetRoot, planPath, configDir, templatePath };
}

test('migration CLI emits an unverified handoff and never overwrites template-out', async () => {
  const f = await fixture();
  const env = { ...process.env, OPENCODE_CONFIG_DIR: f.configDir };
  try {
    const applied = await runCli([
      'migration', 'apply', '--plan', f.planPath, '--target-root', f.targetRoot,
      '--execute', '--no-verify', '--template-out', f.templatePath,
    ], env);
    assert.equal(applied.code, 0, applied.stderr);
    const template = await readFile(f.templatePath, 'utf8');
    assert.match(template, /unverified/);
    assert.match(template, /target\/demo-repo\/skills\/demo\/SKILL\.md/);
    assert.match(applied.stdout, /Skill modification handoff written/);

    const second = await runCli([
      'migration', 'apply', '--plan', f.planPath, '--target-root', f.targetRoot,
      '--execute', '--no-verify', '--template-out', f.templatePath,
    ], env);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /without overwriting/);
    assert.equal(await readFile(f.templatePath, 'utf8'), template);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('migration CLI rejects template-out for a dry-run without moving the skill', async () => {
  const f = await fixture();
  const env = { ...process.env, OPENCODE_CONFIG_DIR: f.configDir };
  try {
    const result = await runCli([
      'migration', 'apply', '--plan', f.planPath, '--target-root', f.targetRoot,
      '--template-out', f.templatePath,
    ], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /requires a committed migration/);
    await access(join(f.sourceRoot, 'skill', 'demo', 'SKILL.md'));
    await assert.rejects(access(join(f.targetRoot, 'demo-repo', 'skills', 'demo', 'SKILL.md')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
