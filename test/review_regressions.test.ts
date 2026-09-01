import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditMigrationRepos } from '../src/audit.js';
import { applyMigrationIgnores } from '../src/ignore.js';
import { applyMigrationPortabilityFixes } from '../src/portability_fix.js';
import { auditMigrationCommitReadiness } from '../src/readiness.js';
import { resolveRegisteredResource } from '../src/runtime.js';

async function writePlan(path: string, repoId: string, sourceRoot: string, skills: string[] = []): Promise<void> {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, generatedFrom: { sourceRoot }, repositories: [{ id: repoId, action: 'CREATE_AND_MOVE', skills, agents: [], libs: [] }] }, null, 2)}\n`, 'utf8');
}
async function registerSkills(configDir: string, skillsDir: string | null): Promise<NodeJS.ProcessEnv> {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'opencode.jsonc'), `${JSON.stringify(skillsDir ? { skills: [skillsDir] } : {})}\n`, 'utf8');
  return { ...process.env, OPENCODE_CONFIG_DIR: configDir };
}

test('registered resource resolver rejects repo-local symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-symlink-')); const repo = join(root, 'runtime-repo'); const configDir = join(root, 'opencode'); const outside = join(root, 'outside.sh');
  try {
    await mkdir(join(repo, 'skills'), { recursive: true }); await mkdir(join(repo, 'bin'), { recursive: true }); await writeFile(outside, '#!/usr/bin/env bash\n', 'utf8'); await symlink(outside, join(repo, 'bin', 'tool')); const env = await registerSkills(configDir, join(repo, 'skills'));
    await assert.rejects(resolveRegisteredResource('runtime-repo', 'bin/tool', env), /escapes registered repo/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('commit-readiness streaming scan catches 2-10 MiB secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-large-secret-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'large-secret-repo'); const plan = join(root, 'migration-plan.json'); const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  try {
    await mkdir(repo, { recursive: true }); await writePlan(plan, 'large-secret-repo', '/unused'); await writeFile(join(repo, 'payload.txt'), `${'x'.repeat(3 * 1024 * 1024)}\nAWS_ACCESS_KEY_ID=${secret}\n`, 'utf8');
    const result = await auditMigrationRepos({ planPath: plan, targetRoot }); const audited = result.repositories[0]!; assert.ok(audited.findings.some(item => item.code === 'aws-access-key-content' && item.severity === 'blocker')); assert.equal(audited.findings.some(item => item.code === 'large-file'), false); assert.equal(result.readyForInitialCommit, false); assert.equal(JSON.stringify(result).includes(secret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('streaming scan reports review when text-candidate content contains NUL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-nul-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'nul-repo'); const plan = join(root, 'migration-plan.json');
  try {
    await mkdir(repo, { recursive: true }); await writePlan(plan, 'nul-repo', '/unused'); await writeFile(join(repo, 'payload.txt'), Buffer.concat([Buffer.from('prefix\0'), Buffer.from('AKIA' + 'ABCDEFGHIJKLMNOP\n')]));
    const result = await auditMigrationRepos({ planPath: plan, targetRoot }); const audited = result.repositories[0]!; assert.ok(audited.findings.some(item => item.code === 'content-scan-skipped' && item.severity === 'review')); assert.equal(result.readyForInitialCommit, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('streaming scan reports review when a text-candidate file is unreadable', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('permission-based unreadable fixture is not reliable on this platform/user'); return; }
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-unreadable-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'unreadable-repo'); const plan = join(root, 'migration-plan.json'); const file = join(repo, 'payload.txt');
  try {
    await mkdir(repo, { recursive: true }); await writePlan(plan, 'unreadable-repo', '/unused'); await writeFile(file, 'secret-looking content\n', 'utf8'); await chmod(file, 0o000);
    const result = await auditMigrationRepos({ planPath: plan, targetRoot }); const audited = result.repositories[0]!; assert.ok(audited.findings.some(item => item.code === 'content-scan-failed' && item.severity === 'review')); assert.equal(result.readyForInitialCommit, false);
  } finally { try { await chmod(file, 0o600); } catch {} await rm(root, { recursive: true, force: true }); }
});

test('ambiguous coverage directory is scanned and never auto-ignored by basename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-ignore-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'coverage-repo'); const plan = join(root, 'migration-plan.json'); const gitignore = join(repo, '.gitignore');
  try {
    await mkdir(join(repo, 'coverage'), { recursive: true }); await writePlan(plan, 'coverage-repo', '/unused'); await writeFile(join(repo, 'coverage', 'source.ts'), 'export const coverage = "source";\n', 'utf8');
    const audit = await auditMigrationRepos({ planPath: plan, targetRoot }); const audited = audit.repositories[0]!; assert.equal(audited.stats.files, 1); assert.equal(audited.stats.prunedNoiseDirectories, 0); assert.equal(audited.ignoreCandidates.some(item => item.pattern === 'coverage/'), false); assert.equal(audited.readyForInitialCommit, true);
    const ignore = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false }); assert.equal(ignore.patterns, 0); await assert.rejects(access(gitignore));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration ignore treats a symlinked .gitignore as manual and does not modify its target', async t => {
  if (process.platform === 'win32') { t.skip('symlink creation is not reliable on Windows CI'); return; }
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-ignore-symlink-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'ignore-repo'); const plan = join(root, 'migration-plan.json'); const outside = join(root, 'shared-ignore');
  try {
    await mkdir(join(repo, '__pycache__'), { recursive: true }); await writePlan(plan, 'ignore-repo', '/unused'); await writeFile(outside, '# shared\n', 'utf8'); await symlink(outside, join(repo, '.gitignore'));
    const result = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false }); assert.equal(result.repositories.length, 0); assert.equal(result.manualRepositories.length, 1); assert.equal(await readFile(outside, 'utf8'), '# shared\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('commit readiness delegates negation semantics to Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-ignore-negation-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'negation-repo'); const plan = join(root, 'migration-plan.json');
  try {
    await mkdir(join(repo, '.venv'), { recursive: true }); await writePlan(plan, 'negation-repo', '/unused'); await writeFile(join(repo, '.gitignore'), '.venv/\n!.venv/\n', 'utf8');
    const result = await auditMigrationCommitReadiness({ planPath: plan, targetRoot }); const audited = result.repositories[0]!; assert.ok(audited.findings.some(item => item.code === 'local-runtime-environment')); assert.ok(audited.ignoreCandidates.some(item => item.pattern === '.venv/')); assert.equal(result.readyForInitialCommit, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration ignore preserves log negation semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-log-negation-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'log-repo'); const plan = join(root, 'migration-plan.json'); const gitignore = join(repo, '.gitignore'); const original = '*.log\n!important.log\n';
  try {
    await mkdir(repo, { recursive: true }); await writePlan(plan, 'log-repo', '/unused'); await writeFile(join(repo, 'important.log'), 'generated\n', 'utf8'); await writeFile(gitignore, original, 'utf8');
    const result = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false }); assert.equal(result.patterns, 0); assert.equal(result.repositories.length, 0); assert.equal(result.manualRepositories.length, 1); assert.equal(await readFile(gitignore, 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration ignore preserves virtualenv negation semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-venv-negation-')); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'venv-repo'); const plan = join(root, 'migration-plan.json'); const gitignore = join(repo, '.gitignore'); const original = '.venv/\n!.venv/\n';
  try {
    await mkdir(join(repo, '.venv'), { recursive: true }); await writePlan(plan, 'venv-repo', '/unused'); await writeFile(gitignore, original, 'utf8');
    const result = await applyMigrationIgnores({ planPath: plan, targetRoot, dryRun: false }); assert.equal(result.patterns, 0); assert.equal(result.repositories.length, 0); assert.equal(result.manualRepositories.length, 1); assert.equal(await readFile(gitignore, 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('root .git file and symlink are recognized as existing Git metadata', async () => {
  for (const kind of ['file', 'symlink'] as const) {
    const root = await mkdtemp(join(tmpdir(), `skillrepo-review-root-git-${kind}-`)); const targetRoot = join(root, 'repos'); const repo = join(targetRoot, `${kind}-repo`); const plan = join(root, 'migration-plan.json');
    try {
      await mkdir(repo, { recursive: true }); await writePlan(plan, `${kind}-repo`, '/unused');
      if (kind === 'file') await writeFile(join(repo, '.git'), 'gitdir: /tmp/worktree\n', 'utf8'); else { const target = join(root, 'git-metadata'); await mkdir(target); await symlink(target, join(repo, '.git')); }
      const result = await auditMigrationRepos({ planPath: plan, targetRoot }); assert.ok(result.repositories[0]!.findings.some(item => item.code === 'git-already-initialized' && item.path === '.git')); assert.equal(result.readyForInitialCommit, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

async function buildPortabilityFixture(root: string): Promise<{ targetRoot: string; repo: string; plan: string; skillFile: string }> {
  const targetRoot = join(root, 'repos'); const repo = join(targetRoot, 'portable-repo'); const plan = join(root, 'migration-plan.json'); const sourceRoot = join(homedir(), '.config', 'opencode'); const server = join(sourceRoot, 'skill', 'tool', 'scripts', 'server.sh'); const skillFile = join(repo, 'skills', 'demo', 'SKILL.md');
  await mkdir(join(repo, 'skills', 'demo'), { recursive: true }); await mkdir(join(repo, 'skills', 'tool', 'scripts'), { recursive: true }); await writePlan(plan, 'portable-repo', sourceRoot, ['demo', 'tool']); await writeFile(join(repo, 'skills', 'tool', 'scripts', 'server.sh'), '#!/usr/bin/env bash\n', 'utf8');
  await writeFile(skillFile, ['---','name: demo','mcp:','  first:',`    command: [${JSON.stringify(server)}, "--one"]`,'  second:','    command:',`      - ${server}`,'      - --two','---','Body.',''].join('\n'), 'utf8');
  return { targetRoot, repo, plan, skillFile };
}

test('portability fix rewrites shared MCP executables by entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-shared-mcp-'));
  try {
    const fixture = await buildPortabilityFixture(root); const env = await registerSkills(join(root, 'opencode'), join(fixture.repo, 'skills')); const result = await applyMigrationPortabilityFixes({ planPath: fixture.plan, targetRoot: fixture.targetRoot, dryRun: false, env });
    assert.equal(result.summary.autoActions, 2); assert.equal(result.summary.changedFiles, 1); const text = await readFile(fixture.skillFile, 'utf8'); assert.match(text, /command: \["skillrepo","exec","portable-repo","skills\/tool\/scripts\/server\.sh","--one"\]/); assert.match(text, /command: \["skillrepo","exec","portable-repo","skills\/tool\/scripts\/server\.sh","--two"\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('portability fix ignores nested same-name MCP keys and rewrites the direct entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-nested-mcp-'));
  try {
    const fixture = await buildPortabilityFixture(root); const server = join(homedir(), '.config', 'opencode', 'skill', 'tool', 'scripts', 'server.sh');
    await writeFile(fixture.skillFile, ['---','name: demo','mcp:','  first:','    options:','      second:',`        command: [${JSON.stringify(server)}, "--nested"]`,'  second:',`    command: [${JSON.stringify(server)}, "--actual"]`,'---','Body.',''].join('\n'), 'utf8');
    const env = await registerSkills(join(root, 'opencode'), join(fixture.repo, 'skills')); const result = await applyMigrationPortabilityFixes({ planPath: fixture.plan, targetRoot: fixture.targetRoot, dryRun: false, env });
    assert.equal(result.summary.autoActions, 1); const text = await readFile(fixture.skillFile, 'utf8'); assert.match(text, new RegExp(`command: \\[${JSON.stringify(server).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, \\"--nested\\"\\]`)); assert.match(text, /command: \["skillrepo","exec","portable-repo","skills\/tool\/scripts\/server\.sh","--actual"\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AUTO-REPO-EXEC downgrades when registration or target proof is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-review-runtime-proof-'));
  try {
    const fixture = await buildPortabilityFixture(root); const unregisteredEnv = await registerSkills(join(root, 'unregistered-config'), null); const before = await readFile(fixture.skillFile, 'utf8');
    const unregistered = await applyMigrationPortabilityFixes({ planPath: fixture.plan, targetRoot: fixture.targetRoot, dryRun: true, env: unregisteredEnv }); assert.equal(unregistered.summary.autoActions, 0); assert.ok(unregistered.files[0]!.actions.some(action => action.kind === 'MANUAL-FRONTMATTER')); assert.equal(unregistered.summary.changedFiles, 0);
    const registeredEnv = await registerSkills(join(root, 'registered-config'), join(fixture.repo, 'skills')); await rm(join(fixture.repo, 'skills', 'tool', 'scripts', 'server.sh')); const missing = await applyMigrationPortabilityFixes({ planPath: fixture.plan, targetRoot: fixture.targetRoot, dryRun: false, env: registeredEnv }); assert.equal(missing.summary.autoActions, 0); assert.equal(missing.summary.changedFiles, 0); assert.equal(await readFile(fixture.skillFile, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
