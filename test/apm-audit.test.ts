import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The APM audit contract is developed test-first (issue #40): the audit module
// does not exist in the first commit, so the import specifier must stay
// non-literal to keep `npm run build` green while `npm test` fails on the
// missing module. Once src/apm_audit.ts lands, this resolves like any static
// import of the compiled output.
const apmAuditModulePath = fileURLToPath(new URL('../src/apm_audit.js', import.meta.url));
const apmAudit = await import(apmAuditModulePath) as {
  auditApmReadiness: (options: { projectRoot?: string; env?: NodeJS.ProcessEnv }) => Promise<any>;
  renderApmAudit: (result: any) => string;
  classifySkill: (findings: Array<{ code: string }>) => string;
};

// Synthetic `opencode` executable used to model `opencode debug skill` without
// touching a real OpenCode installation. It discovers skills from the
// configured sources plus the standard OpenCode-native and consumer roots and
// reports the same JSON shape as the real command. OPENCODE_STUB_RENAMES may
// point at a JSON file mapping source identity to a differently reported id to
// model a runtime that exposes a skill under a divergent id.
const STUB_SOURCE = [
  "import { existsSync, fstatSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';",
  "import { basename, dirname, join } from 'node:path';",
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
  'function reportedName(name) {',
  '  const mapPath = process.env.OPENCODE_STUB_RENAMES;',
  '  if (!mapPath || !existsSync(mapPath)) return name;',
  '  const map = JSON.parse(readFileSync(mapPath, "utf8"));',
  '  return typeof map[name] === "string" ? map[name] : name;',
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
  '      const name = reportedName(frontmatterField(text, "name") || basename(dirname(file)));',
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
  const root = await mkdtemp(join(tmpdir(), `apm-audit-${label}-`));
  // The synthetic home intentionally sits under a `<root>/home/<user>` path so
  // that a literal reference to it matches the existing absolute-home-path
  // portability detector exactly like a real user-home path would.
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
  const frontmatter = name === '' ? '---\ndescription: synthetic\n---\n' : `---\nname: ${name}\ndescription: synthetic\n---\n`;
  await writeFile(path, `${frontmatter}${body}`, 'utf8');
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q', dir]);
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

async function writeRenames(fixture: Fixture, renames: Record<string, string>): Promise<void> {
  const path = join(fixture.root, 'opencode-stub-renames.json');
  await writeFile(path, JSON.stringify(renames, null, 2), 'utf8');
  fixture.env.OPENCODE_STUB_RENAMES = path;
}

function runAudit(fixture: Fixture): Promise<any> {
  return apmAudit.auditApmReadiness({ projectRoot: fixture.root, env: fixture.env });
}

function findingCodes(skill: any): string[] {
  return skill.findings.map((finding: any) => finding.code);
}

// ---------------------------------------------------------------------------
// Classification matrix
// ---------------------------------------------------------------------------

test('a direct legacy skill is classified DIRECT', async () => {
  const f = await createFixture('direct-legacy');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-direct-legacy', 'SKILL.md');
    await writeSkill(source, 'audit-direct-legacy');
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.summary, { skills: 1, direct: 1, needsChanges: 0, blocked: 0 });
    const skill = result.skills[0];
    assert.equal(skill.skillId, 'audit-direct-legacy');
    assert.equal(skill.classification, 'DIRECT');
    assert.equal(skill.layout, 'skillrepo');
    assert.equal(skill.alreadyPackaged, false);
    assert.equal(skill.authoritativeSource, await realpath(source));
    assert.equal(skill.repoRoot, await realpath(repo));
    assert.equal(skill.sourceRoot, await realpath(join(repo, 'skills')));
    assert.deepEqual(skill.consumerMatches, []);
    assert.deepEqual(skill.findings, []);
    assert.deepEqual(skill.relatedSkills, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an already packaged APM skill is DIRECT and reports the repository root', async () => {
  const f = await createFixture('already-apm');
  try {
    const repo = join(f.root, 'package-repo');
    await gitInit(repo);
    const source = join(repo, '.apm', 'skills', 'audit-apm-native', 'SKILL.md');
    await writeSkill(source, 'audit-apm-native');
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\nversion: 0.1.0\n', 'utf8');
    await registerSkillSource(f, join(repo, '.apm', 'skills'));

    const result = await runAudit(f);
    assert.equal(result.summary.direct, 1);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'DIRECT');
    assert.equal(skill.layout, 'apm');
    assert.equal(skill.alreadyPackaged, true);
    assert.equal(skill.authoritativeSource, await realpath(source));
    assert.notEqual(skill.repoRoot, await realpath(join(repo, '.apm')));
    assert.equal(skill.repoRoot, await realpath(repo));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an absolute home path in the authoritative source needs changes', async () => {
  const f = await createFixture('absolute-home');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-home-path', 'SKILL.md');
    await writeSkill(
      source,
      'audit-home-path',
      `Cache generated tools under ${f.home}/tools/cache when available.\n`,
    );
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'NEEDS_CHANGES');
    assert.deepEqual(findingCodes(skill), ['absolute-home-path']);
    assert.equal(skill.findings[0].path, await realpath(source));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a shared repository resource needs changes and groups related skills', async () => {
  const f = await createFixture('shared-resource');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const shared = join(repo, 'lib', 'shared-tool');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'run.sh'), '#!/bin/sh\necho synthetic\n', 'utf8');
    const first = join(repo, 'skills', 'audit-shared-one', 'SKILL.md');
    const second = join(repo, 'skills', 'audit-shared-two', 'SKILL.md');
    await writeSkill(first, 'audit-shared-one', 'Run ../../lib/shared-tool/run.sh for helper tasks.\n');
    await writeSkill(second, 'audit-shared-two', 'Run ../../lib/shared-tool/run.sh for helper tasks.\n');
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    assert.deepEqual(result.summary, { skills: 2, direct: 0, needsChanges: 2, blocked: 0 });
    const byId = new Map<string, any>(result.skills.map((skill: any): [string, any] => [skill.skillId, skill]));
    const one = byId.get('audit-shared-one');
    const two = byId.get('audit-shared-two');
    assert.equal(one.classification, 'NEEDS_CHANGES');
    assert.equal(two.classification, 'NEEDS_CHANGES');
    assert.ok(findingCodes(one).includes('shared-resource-boundary'));
    assert.ok(findingCodes(two).includes('shared-resource-boundary'));
    assert.equal(one.findings[0].relatedPath, await realpath(join(shared, 'run.sh')));
    assert.deepEqual(one.relatedSkills, ['audit-shared-two']);
    assert.deepEqual(two.relatedSkills, ['audit-shared-one']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an external file dependency needs changes', async () => {
  const f = await createFixture('external-dependency');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-external', 'SKILL.md');
    await writeSkill(
      source,
      'audit-external',
      'Invoke /opt/apm-audit-fixture-tool/bin/runner once configured.\n',
    );
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'NEEDS_CHANGES');
    assert.deepEqual(findingCodes(skill), ['external-runtime-path']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an unresolvable package boundary blocks the audit', async () => {
  const f = await createFixture('boundary-unknown');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-unknown', 'SKILL.md');
    await writeSkill(
      source,
      'audit-unknown',
      'Set ${APM_FIXTURE_TOOL_ROOT}/bin before running the runner.\n',
    );
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['package-boundary-unknown']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a consumer-only skill fails closed as BLOCKED without throwing', async () => {
  const f = await createFixture('consumer-only');
  try {
    const copy = join(f.home, '.agents', 'skills', 'audit-consumer-only', 'SKILL.md');
    await writeSkill(copy, 'audit-consumer-only');

    const result = await runAudit(f);
    assert.deepEqual(result.summary, { skills: 1, direct: 0, needsChanges: 0, blocked: 1 });
    const skill = result.skills[0];
    assert.equal(skill.classification, 'BLOCKED');
    assert.equal(skill.authoritativeSource, null);
    assert.deepEqual(findingCodes(skill), ['authoritative-source-not-found']);
    assert.equal(skill.consumerMatches.length, 1);
    assert.equal(skill.consumerMatches[0].path, await realpath(copy));
    assert.equal(skill.consumerMatches[0].origin, 'agents-skills');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a deployment copy stays diagnostic when the authoritative source exists', async () => {
  const f = await createFixture('source-and-consumer');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-deployed', 'SKILL.md');
    await writeSkill(source, 'audit-deployed');
    const copy = join(f.home, '.agents', 'skills', 'audit-deployed', 'SKILL.md');
    await writeSkill(copy, 'audit-deployed');
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'DIRECT');
    assert.equal(skill.authoritativeSource, await realpath(source));
    assert.equal(skill.consumerMatches.length, 1);
    assert.equal(skill.consumerMatches[0].path, await realpath(copy));
    assert.deepEqual(skill.findings, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('genuine source ambiguity fails closed while a consumer copy stays diagnostic', async () => {
  const f = await createFixture('source-ambiguity');
  try {
    const first = join(f.root, 'first-repo');
    const second = join(f.root, 'second-repo');
    await gitInit(first);
    await gitInit(second);
    const firstSource = join(first, 'skills', 'audit-duplicated', 'SKILL.md');
    const secondSource = join(second, 'skills', 'audit-duplicated', 'SKILL.md');
    await writeSkill(firstSource, 'audit-duplicated');
    await writeSkill(secondSource, 'audit-duplicated');
    const copy = join(f.home, '.agents', 'skills', 'audit-duplicated', 'SKILL.md');
    await writeSkill(copy, 'audit-duplicated');
    await registerSkillSource(f, join(first, 'skills'));
    await registerSkillSource(f, join(second, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['authoritative-source-ambiguous']);
    assert.notEqual(skill.findings[0].path, await realpath(copy));
    assert.equal(skill.consumerMatches.length, 1);
    assert.equal(skill.consumerMatches[0].path, await realpath(copy));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('invalid frontmatter blocks the audit', async () => {
  const f = await createFixture('invalid-frontmatter');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-broken', 'SKILL.md');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, '---\nname: [unclosed\ndescription: synthetic\n---\nBody.\n', 'utf8');
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['invalid-frontmatter']);
    assert.equal(skill.authoritativeSource, await realpath(source));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a duplicated stable skill identity inside one repository blocks', async () => {
  const f = await createFixture('id-collision');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const first = join(repo, 'skills', 'fronted', 'SKILL.md');
    const second = join(repo, 'skills', 'audit-collides', 'SKILL.md');
    await writeSkill(first, 'audit-collides');
    await writeSkill(second, '');
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.skillId, 'audit-collides');
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['skill-id-collision']);
    assert.equal(skill.findings[0].relatedPath, await realpath(second));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an ambiguous repository layout blocks the audit', async () => {
  const f = await createFixture('layout-ambiguity');
  try {
    const repo = join(f.root, 'mixed-repo');
    await gitInit(repo);
    const legacy = join(repo, 'skills', 'audit-mixed-legacy', 'SKILL.md');
    const packaged = join(repo, '.apm', 'skills', 'audit-mixed-apm', 'SKILL.md');
    await writeSkill(legacy, 'audit-mixed-legacy');
    await writeSkill(packaged, 'audit-mixed-apm');
    await writeFile(join(repo, 'apm.yml'), 'name: mixed-repo\nversion: 0.1.0\n', 'utf8');
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    assert.equal(result.summary.skills, 1);
    const skill = result.skills[0];
    assert.equal(skill.skillId, 'audit-mixed-legacy');
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['ambiguous-repo-layout']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an authoring source without a supported package boundary blocks', async () => {
  const f = await createFixture('unsupported-layout');
  try {
    const sourceDir = join(f.root, 'myskills');
    const source = join(sourceDir, 'audit-unrooted', 'SKILL.md');
    await writeSkill(source, 'audit-unrooted');
    await registerSkillSource(f, sourceDir);

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['unsupported-source-layout']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a runtime-reported identity that differs from the source identity blocks', async () => {
  const f = await createFixture('identity-mismatch');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    const source = join(repo, 'skills', 'audit-listed', 'SKILL.md');
    await writeSkill(source, 'audit-real');
    await writeRenames(f, { 'audit-real': 'audit-listed' });
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    const skill = result.skills[0];
    assert.equal(skill.skillId, 'audit-listed');
    assert.equal(skill.classification, 'BLOCKED');
    assert.deepEqual(findingCodes(skill), ['skill-identity-mismatch']);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Determinism, isolation, and read-only guarantees
// ---------------------------------------------------------------------------

async function determinismFixture(): Promise<Fixture> {
  const f = await createFixture('determinism');
  const repo = join(f.root, 'source-repo');
  await gitInit(repo);
  await writeSkill(join(repo, 'skills', 'audit-det-clean', 'SKILL.md'), 'audit-det-clean');
  await writeSkill(
    join(repo, 'skills', 'audit-det-home', 'SKILL.md'),
    'audit-det-home',
    `Reads templates from ${f.home}/templates.\n`,
  );
  await writeSkill(join(f.home, '.agents', 'skills', 'audit-det-lost', 'SKILL.md'), 'audit-det-lost');
  await registerSkillSource(f, join(repo, 'skills'));
  return f;
}

test('JSON output is deterministic across repeated audits', async () => {
  const f = await determinismFixture();
  try {
    const first = await runAudit(f);
    const second = await runAudit(f);
    assert.deepEqual(second, first);

    assert.equal(first.schemaVersion, 1);
    assert.deepEqual(first.summary, { skills: 3, direct: 1, needsChanges: 1, blocked: 1 });
    const ids = first.skills.map((skill: any) => skill.skillId);
    assert.deepEqual(ids, [...ids].sort());
    for (const skill of first.skills) {
      const findings = skill.findings.map((finding: any) => finding.code);
      assert.deepEqual(findings, [...findings].sort());
      const matches = skill.consumerMatches.map((match: any) => match.path);
      assert.deepEqual(matches, [...matches].sort());
      assert.deepEqual(skill.relatedSkills, [...skill.relatedSkills].sort());
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('human-readable rendering is deterministic and grouped', async () => {
  const f = await determinismFixture();
  try {
    const result = await runAudit(f);
    const first = apmAudit.renderApmAudit(result);
    const second = apmAudit.renderApmAudit(result);
    assert.equal(second, first);
    assert.ok(first.startsWith('APM AUDIT\n'));
    assert.match(first, /^APM AUDIT\n\nDIRECT: 1\nNEEDS_CHANGES: 1\nBLOCKED: 1\n/);
    assert.ok(first.indexOf('DIRECT (') < first.indexOf('NEEDS_CHANGES ('));
    assert.ok(first.indexOf('NEEDS_CHANGES (') < first.indexOf('BLOCKED ('));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the classification reducer keeps the strict precedence', () => {
  assert.equal(apmAudit.classifySkill([]), 'DIRECT');
  assert.equal(apmAudit.classifySkill([{ code: 'absolute-home-path' }]), 'NEEDS_CHANGES');
  assert.equal(apmAudit.classifySkill([{ code: 'absolute-home-path' }, { code: 'invalid-frontmatter' }]), 'BLOCKED');
  assert.equal(apmAudit.classifySkill([{ code: 'package-boundary-unknown' }]), 'BLOCKED');
});

test('unrelated repository content does not contaminate audited skills', async () => {
  const f = await createFixture('isolation');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    await writeSkill(join(repo, 'skills', 'audit-clean-one', 'SKILL.md'), 'audit-clean-one');
    await writeSkill(join(repo, 'skills', 'audit-clean-two', 'SKILL.md'), 'audit-clean-two');
    await writeFile(
      join(repo, 'unrelated-problematic-file'),
      `token = /home/otheruser/private\npassword = "totally-secret-value"\n`,
      'utf8',
    );
    await registerSkillSource(f, join(repo, 'skills'));

    const result = await runAudit(f);
    assert.deepEqual(result.summary, { skills: 2, direct: 2, needsChanges: 0, blocked: 0 });
    for (const skill of result.skills) assert.deepEqual(skill.findings, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the audit does not mutate the source tree, OpenCode config, or Git state', async () => {
  const f = await createFixture('read-only');
  try {
    const repo = join(f.root, 'source-repo');
    await gitInit(repo);
    await writeSkill(join(repo, 'skills', 'audit-readonly', 'SKILL.md'), 'audit-readonly');
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
    await writeFile(join(repo, 'apm.yml'), 'name: not-a-package-layout\nversion: 0.1.0\n', 'utf8');
    const copy = join(f.home, '.agents', 'skills', 'audit-readonly', 'SKILL.md');
    await writeSkill(copy, 'audit-readonly');
    await registerSkillSource(f, join(repo, 'skills'));

    const fingerprint = async (): Promise<Map<string, string>> => {
      const files = new Map<string, string>();
      const walk = async (dir: string): Promise<void> => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '.git') continue;
            await walk(path);
          } else if (entry.isFile()) {
            const digest = createHash('sha256').update(await readFile(path)).digest('hex');
            files.set(await realpath(path), digest);
          }
        }
      };
      await walk(f.root);
      return files;
    };
    const gitDirs = async (): Promise<string[]> => {
      const found: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.name === '.git') { found.push(await realpath(path)); continue; }
          if (entry.isDirectory() && !(await stat(path)).isSymbolicLink()) await walk(path);
        }
      };
      await walk(f.root);
      return found.sort();
    };

    const before = await fingerprint();
    const gitBefore = await gitDirs();
    await runAudit(f);
    await runAudit(f);
    const after = await fingerprint();
    const gitAfter = await gitDirs();

    assert.deepEqual([...after.entries()], [...before.entries()]);
    assert.deepEqual(gitAfter, gitBefore);
    assert.rejects(() => stat(join(repo, '.apm')));
    assert.rejects(() => stat(join(f.root, '.apm')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
