import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

// Regression fixture for large OpenCode skill discovery (issue #35).
//
// The upstream `opencode debug skill` command exits 0 but delivers only the
// bytes that fit in the stdout pipe buffer when its stdout is a pipe; a
// regular-file stdout receives the complete document. skillrepo must consume
// this command through a transport that survives that upstream defect.
//
// The stub below reproduces the observed upstream behavior deterministically:
// full output to a regular file, a 64 KiB prefix to any other stdout. It is
// generated per test run inside a private temporary directory, placed first on
// a temporary PATH, and never committed or reused.

const FILLER_SKILL_COUNT = 64;
const FILLER_DESCRIPTION_BYTES = 32 * 1024;
const LARGE_OUTPUT_FLOOR_BYTES = 1024 * 1024;
const PIPE_TRUNCATION_BYTES = 64 * 1024;
const CANDIDATE_SKILL_ID = 'candidate-fixture-skill';

const STUB_SOURCE = [
  "import { existsSync, fstatSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';",
  "import { basename, dirname, join } from 'node:path';",
  '',
  'const args = process.argv.slice(2);',
  'const stdoutIsRegularFile = (() => {',
  '  try { return fstatSync(1).isFile(); } catch { return false; }',
  '})();',
  '',
  'function writeOut(text) {',
  '  const bytes = Buffer.from(text, "utf8");',
  '  if (stdoutIsRegularFile) {',
  '    let offset = 0;',
  '    while (offset < bytes.length) offset += writeSync(1, bytes.subarray(offset));',
  '    return;',
  '  }',
  '  // Upstream pipe defect: the process exits 0 after only the bytes that fit',
  '  // in the pipe buffer have been delivered; the remainder is never flushed.',
  '  writeSync(1, bytes.subarray(0, Math.min(bytes.length, ' + String(PIPE_TRUNCATION_BYTES) + ')));',
  '}',
  '',
  'function configuredSkillPaths() {',
  '  const candidates = [];',
  '  if (process.env.OPENCODE_CONFIG) candidates.push(process.env.OPENCODE_CONFIG);',
  '  else {',
  '    const dir = process.env.OPENCODE_CONFIG_DIR',
  '      || join(process.env.HOME || ".", ".config", "opencode");',
  '    candidates.push(join(dir, "opencode.jsonc"), join(dir, "opencode.json"));',
  '  }',
  '  for (const candidate of candidates) {',
  '    if (!existsSync(candidate)) continue;',
  '    const parsed = JSON.parse(readFileSync(candidate, "utf8"));',
  '    const skills = parsed && typeof parsed === "object" ? parsed.skills : undefined;',
  '    if (Array.isArray(skills)) return skills.filter(entry => typeof entry === "string");',
  '    if (skills && typeof skills === "object" && Array.isArray(skills.paths)) {',
  '      return skills.paths.filter(entry => typeof entry === "string");',
  '    }',
  '    return [];',
  '  }',
  '  return [];',
  '}',
  '',
  'function* skillFiles(dir) {',
  '  for (const entry of readdirSync(dir, { withFileTypes: true })) {',
  '    const path = join(dir, entry.name);',
  '    if (entry.isDirectory()) yield* skillFiles(path);',
  '    else if (entry.isFile() && entry.name === "SKILL.md") yield path;',
  '  }',
  '}',
  '',
  'function frontmatterField(text, field) {',
  '  const block = text.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);',
  '  if (!block) return "";',
  '  const line = block[1].split(/\\r?\\n/).find(candidate => candidate.startsWith(field + ":"));',
  '  return line ? line.slice(field.length + 1).trim() : "";',
  '}',
  '',
  'function discoveredSkills() {',
  '  const records = [];',
  '  for (const source of configuredSkillPaths()) {',
  '    if (!existsSync(source) || !statSync(source).isDirectory()) continue;',
  '    for (const file of skillFiles(source)) {',
  '      const text = readFileSync(file, "utf8");',
  '      const name = frontmatterField(text, "name") || basename(dirname(file));',
  '      records.push({ name, description: frontmatterField(text, "description"), location: file });',
  '    }',
  '  }',
  '  return records;',
  '}',
  '',
  'if (args[0] === "debug" && args[1] === "skill") {',
  '  writeOut(JSON.stringify(discoveredSkills(), null, 2) + "\\n");',
  '  process.exit(0);',
  '}',
  'if (args[0] === "--version") {',
  '  writeOut("opencode test stub 0.0.0\\n");',
  '  process.exit(0);',
  '}',
  'process.exit(0);',
  '',
].join('\n');

type CliRun = { code: number | null; stdout: string; stderr: string };

function runSkillrepoCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('dist/src/cli.js'), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

// POSIX spawn resolves a bare program name through the parent's environment,
// so every stub invocation goes through the launcher's absolute path to stay
// independent of the machine's real OpenCode installation.
function runStub(
  launcherPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdout: 'pipe' | 'file',
  capturePath?: string,
): Promise<{
  code: number | null;
  stdout: string;
}> {
  if (stdout === 'pipe') {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(launcherPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', data => { out += data; });
      child.once('error', reject);
      child.once('close', code => resolvePromise({ code, stdout: out }));
    });
  }

  return (async () => {
    const handle = await open(capturePath!, 'w+', 0o600);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolvePromise, reject) => {
        const child = spawn(launcherPath, args, { env, stdio: ['ignore', handle.fd, 'pipe'] });
        child.once('error', reject);
        child.once('close', exitCode => resolvePromise(exitCode));
      });
    } finally {
      // The child writes through a shared open-file description, so this
      // handle's position sits at EOF; read the capture with a fresh handle.
      await handle.close();
    }
    try {
      return { code, stdout: await readFile(capturePath!, 'utf8') };
    } finally {
      await rm(capturePath!, { force: true });
    }
  })();
}

function fillerDescription(index: number): string {
  const words: string[] = [];
  const sentence = 'synthetic inventory filler sentence for transport coverage';
  while (words.join(' ').length < FILLER_DESCRIPTION_BYTES) {
    words.push(`${sentence} record ${index} part ${words.length}`);
  }
  return words.join(' ');
}

async function makeFixture(): Promise<{
  root: string;
  configDir: string;
  binDir: string;
  launcherPath: string;
  inventorySkills: string;
  candidateRepo: string;
  cliEnv: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-large-discovery-'));
  const inventorySkills = join(root, 'inventory', 'skills');
  const candidateRepo = join(root, 'candidate');
  const configDir = join(root, 'opencode');
  const binDir = join(root, 'bin');

  await mkdir(inventorySkills, { recursive: true });
  await mkdir(join(candidateRepo, 'skills', CANDIDATE_SKILL_ID), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  for (let index = 0; index < FILLER_SKILL_COUNT; index += 1) {
    const skillDir = join(inventorySkills, `inventory-filler-${String(index).padStart(3, '0')}`);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: inventory-filler-${String(index).padStart(3, '0')}\ndescription: ${fillerDescription(index)}\n---\nInventory filler.\n`,
      'utf8',
    );
  }
  await writeFile(
    join(candidateRepo, 'skills', CANDIDATE_SKILL_ID, 'SKILL.md'),
    `---\nname: ${CANDIDATE_SKILL_ID}\ndescription: candidate fixture for large discovery transport\n---\nCandidate fixture.\n`,
    'utf8',
  );
  await writeFile(
    join(configDir, 'opencode.jsonc'),
    `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', skills: { paths: [inventorySkills] } }, null, 2)}\n`,
    'utf8',
  );

  const stubPath = join(binDir, 'opencode-test-stub.mjs');
  await writeFile(stubPath, STUB_SOURCE, 'utf8');
  const launcherPath = join(binDir, 'opencode');
  await writeFile(
    launcherPath,
    `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`,
    'utf8',
  );
  await chmod(launcherPath, 0o755);

  const { OPENCODE_CONFIG: _ignored, ...restEnv } = process.env;
  const cliEnv: NodeJS.ProcessEnv = {
    ...restEnv,
    OPENCODE_CONFIG_DIR: configDir,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  };

  return { root, configDir, binDir, launcherPath, inventorySkills, candidateRepo, cliEnv };
}

test('stub delivers complete large discovery to a regular file but truncates on a pipe', { skip: process.platform === 'win32' }, async () => {
  const fixture = await makeFixture();
  try {
    const fileRun = await runStub(fixture.launcherPath, ['debug', 'skill'], fixture.cliEnv, 'file', join(fixture.root, 'file-discovery.json'));
    assert.equal(fileRun.code, 0);
    assert.ok(Buffer.byteLength(fileRun.stdout) > LARGE_OUTPUT_FLOOR_BYTES);
    const parsed = JSON.parse(fileRun.stdout);
    assert.ok(Array.isArray(parsed));
    const names = parsed.map(entry => entry?.name);
    assert.ok(names.includes('inventory-filler-000'));

    const pipeRun = await runStub(fixture.launcherPath, ['debug', 'skill'], fixture.cliEnv, 'pipe');
    assert.equal(pipeRun.code, 0);
    assert.equal(Buffer.byteLength(pipeRun.stdout), PIPE_TRUNCATION_BYTES);
    assert.throws(() => JSON.parse(pipeRun.stdout));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('register, doctor, and unregister consume a large discovery inventory', { skip: process.platform === 'win32' }, async () => {
  const fixture = await makeFixture();
  try {
    const registered = await runSkillrepoCli(['register', fixture.candidateRepo], fixture.cliEnv);
    assert.equal(registered.code, 0, `register failed: ${registered.stderr}`);
    assert.match(registered.stdout, /Registered/);

    const doctorAfterRegister = await runSkillrepoCli(['doctor'], fixture.cliEnv);
    assert.equal(doctorAfterRegister.code, 0, `doctor failed: ${doctorAfterRegister.stderr}`);

    const unregistered = await runSkillrepoCli(['unregister', fixture.candidateRepo], fixture.cliEnv);
    assert.equal(unregistered.code, 0, `unregister failed: ${unregistered.stderr}`);

    const doctorAfterUnregister = await runSkillrepoCli(['doctor'], fixture.cliEnv);
    assert.equal(doctorAfterUnregister.code, 0, `doctor after unregister failed: ${doctorAfterUnregister.stderr}`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
