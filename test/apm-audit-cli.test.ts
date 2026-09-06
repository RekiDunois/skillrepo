import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

// Same synthetic OpenCode runtime used by the module contract tests
// (test/apm-audit.test.ts): discovers skills from configured sources plus the
// standard OpenCode-native and consumer roots.
const STUB_SOURCE = [
  "import { existsSync, fstatSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';",
  "import { basename, join } from 'node:path';",
  '',
  'const args = process.argv.slice(2);',
  "if (args[0] === 'debug' && args[1] === 'skill') {",
  '  writeOut(JSON.stringify(discoveredSkills(), null, 2) + "\\n");',
  '  process.exit(0);',
  '}',
  "if (args[0] === '--version') {",
  "  writeOut('opencode test stub 0.0.0\\n');",
  '  process.exit(0);',
  '}',
  'process.exit(0);',
  '',
  'function writeOut(text) {',
  "  const bytes = Buffer.from(text, 'utf8');",
  '  let offset = 0;',
  '  while (offset < bytes.length) offset += writeSync(1, bytes.subarray(offset));',
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
  '  const configDir = process.env.OPENCODE_CONFIG_DIR',
  '    || join(process.env.HOME || ".", ".config", "opencode");',
  '  const home = process.env.HOME || ".";',
  '  const roots = [',
  '    ...configuredSkillPaths(),',
  "    join(process.cwd(), '.opencode', 'skills'),",
  "    join(configDir, 'skills'),",
  "    join(home, '.agents', 'skills'),",
  "    join(home, '.claude', 'skills'),",
  '  ];',
  '  const seen = new Set();',
  '  const records = [];',
  '  for (const source of roots) {',
  '    if (seen.has(source)) continue;',
  '    seen.add(source);',
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
].join('\n');

type Fixture = {
  root: string;
  home: string;
  configDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
};

async function createFixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `apm-audit-cli-${label}-`));
  const home = join(root, 'home', 'alice');
  const configDir = join(root, 'opencode');
  const binDir = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(configDir, 'opencode.jsonc'), '{}\n', 'utf8');

  const stubPath = join(binDir, 'opencode-test-stub.mjs');
  await writeFile(stubPath, STUB_SOURCE, 'utf8');
  const launcherPath = join(binDir, 'opencode');
  await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`, 'utf8');
  await chmod(launcherPath, 0o755);

  const { OPENCODE_CONFIG: _ignored, ...restEnv } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...restEnv,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_CONFIG_DIR: configDir,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  };
  return { root, home, configDir, configPath: join(configDir, 'opencode.jsonc'), env };
}

async function writeSkill(path: string, name: string, body = 'Synthetic skill body.\n'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: synthetic\n---\n${body}`, 'utf8');
}

async function registerSkillSource(fixture: Fixture, sourceDir: string): Promise<void> {
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  const paths = Array.isArray(config.skills)
    ? config.skills
    : Array.isArray(config.skills?.paths) ? config.skills.paths : [];
  const next = {
    $schema: 'https://opencode.ai/config.json',
    skills: { paths: [...paths, sourceDir] },
  };
  await writeFile(fixture.configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

test('BLOCKED audit results keep the CLI exit code at zero', async () => {
  const f = await createFixture('blocked-exit');
  try {
    const copy = join(f.home, '.agents', 'skills', 'cli-consumer-only', 'SKILL.md');
    await writeSkill(copy, 'cli-consumer-only');

    const human = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root], f.env);
    assert.equal(human.code, 0, `audit failed: ${human.stderr}`);
    assert.match(human.stdout, /^APM AUDIT\n\nDIRECT: 0\nNEEDS_CHANGES: 0\nBLOCKED: 1\n/);
    assert.match(human.stdout, /authoritative-source-not-found/);

    const json = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root, '--json'], f.env);
    assert.equal(json.code, 0);
    const result = JSON.parse(json.stdout);
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.summary, { skills: 1, direct: 0, needsChanges: 0, blocked: 1 });
    assert.equal(result.skills[0].classification, 'BLOCKED');
    assert.equal(result.skills[0].authoritativeSource, null);
    assert.equal(result.skills[0].consumerMatches[0].path, await realpath(copy));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('JSON output of the same audit is stable across runs', async () => {
  const f = await createFixture('cli-json-stable');
  try {
    const repo = join(f.root, 'source-repo');
    await execFileAsync('git', ['init', '-q', repo]);
    await writeSkill(join(repo, 'skills', 'cli-json-skill', 'SKILL.md'), 'cli-json-skill');
    await registerSkillSource(f, join(repo, 'skills'));

    const first = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root, '--json'], f.env);
    const second = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root, '--json'], f.env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a large OpenCode inventory flows through the file-backed discovery transport', { skip: process.platform === 'win32' }, async () => {
  const f = await createFixture('cli-large-inventory');
  try {
    const FILLER_COUNT = 64;
    const FILLER_BYTES = 32 * 1024;
    const repo = join(f.root, 'source-repo');
    await execFileAsync('git', ['init', '-q', repo]);
    await writeSkill(join(repo, 'skills', 'cli-large-candidate', 'SKILL.md'), 'cli-large-candidate');
    const sentence = 'large inventory filler sentence for transport coverage';
    for (let index = 0; index < FILLER_COUNT; index += 1) {
      const words: string[] = [];
      while (words.join(' ').length < FILLER_BYTES) {
        words.push(`filler-${String(index).padStart(3, '0')} part ${words.length} ${sentence}`);
      }
      await writeSkill(
        join(repo, 'skills', `cli-large-filler-${String(index).padStart(3, '0')}`, 'SKILL.md'),
        `cli-large-filler-${String(index).padStart(3, '0')}`,
        `${words.join(' ')}\n`,
      );
    }
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root, '--json'], f.env);
    assert.equal(result.code, 0, `audit failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.skills, FILLER_COUNT + 1);
    assert.equal(parsed.summary.blocked, 0);
    const ids = parsed.skills.map((skill: { skillId: string }) => skill.skillId);
    assert.ok(ids.includes('cli-large-candidate'));
    assert.ok(ids.includes('cli-large-filler-000'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an unusable OpenCode runtime makes the audit exit non-zero', async () => {
  const f = await createFixture('opencode-failure');
  try {
    const binDir = join(f.root, 'broken-bin');
    await mkdir(binDir, { recursive: true });
    const launcher = join(binDir, 'opencode');
    await writeFile(launcher, '#!/bin/sh\nprintf "stub boom" >&2\nexit 3\n', 'utf8');
    await chmod(launcher, 0o755);
    f.env.PATH = `${binDir}${delimiter}${f.env.PATH ?? ''}`;

    const result = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root, '--json'], f.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /OpenCode skill discovery failed/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('invalid discovery JSON makes the audit exit non-zero', async () => {
  const f = await createFixture('invalid-discovery-json');
  try {
    const binDir = join(f.root, 'broken-bin');
    await mkdir(binDir, { recursive: true });
    const stub = join(binDir, 'broken-stub.mjs');
    await writeFile(stub, "process.stdout.write('[not json');\nprocess.exit(0);\n", 'utf8');
    const launcher = join(binDir, 'opencode');
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, 'utf8');
    await chmod(launcher, 0o755);
    f.env.PATH = `${binDir}${delimiter}${f.env.PATH ?? ''}`;

    const result = await runSkillrepoCli(['apm', 'audit', '--project-root', f.root, '--json'], f.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /OpenCode skill discovery output is not valid JSON/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
