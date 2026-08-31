import { access, lstat, mkdir, readFile, readdir, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import {
  assertNoRuntimeCollisions,
  inspectRepo,
  registerRepo,
  verifyRepoRegistered,
  type VerifyResult,
} from './core.js';

type MigrationRepoPlan = {
  id: string;
  action: string;
  skills?: string[];
  agents?: string[];
  libs?: string[];
};

type MigrationPlan = {
  schemaVersion: number;
  generatedFrom: { sourceRoot: string };
  repositories: MigrationRepoPlan[];
};

type MoveKind = 'skill' | 'agent' | 'lib';
type MoveState = 'pending' | 'moved';

type MoveOperation = {
  kind: MoveKind;
  repoId: string;
  source: string;
  target: string;
  relativeSource: string;
};

export type MigrationApplyOptions = {
  planPath: string;
  targetRoot: string;
  dryRun?: boolean;
  verify?: boolean;
  resume?: boolean;
};

export type MigrationApplyResult = {
  dryRun: boolean;
  sourceRoot: string;
  targetRoot: string;
  repositories: string[];
  moves: MoveOperation[];
  resumedMoves: MoveOperation[];
  compatibilityPaths: string[];
  verification: VerifyResult[];
};

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function lexists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function tryLstat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function assertStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function parsePlan(text: string): MigrationPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Migration plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('Migration plan must be a JSON object');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error(`Unsupported migration plan schemaVersion: ${String(value.schemaVersion)}`);

  const generatedFrom = value.generatedFrom;
  if (!generatedFrom || typeof generatedFrom !== 'object') throw new Error('Migration plan generatedFrom is missing');
  const sourceRoot = (generatedFrom as Record<string, unknown>).sourceRoot;
  if (typeof sourceRoot !== 'string' || !sourceRoot.trim()) throw new Error('Migration plan generatedFrom.sourceRoot is missing');

  if (!Array.isArray(value.repositories)) throw new Error('Migration plan repositories must be an array');
  const repositories = value.repositories.map((item, index): MigrationRepoPlan => {
    if (!item || typeof item !== 'object') throw new Error(`repositories[${index}] must be an object`);
    const repo = item as Record<string, unknown>;
    if (typeof repo.id !== 'string' || !repo.id.trim()) throw new Error(`repositories[${index}].id is missing`);
    if (typeof repo.action !== 'string' || !repo.action.trim()) throw new Error(`repositories[${index}].action is missing`);
    return {
      id: repo.id,
      action: repo.action,
      skills: assertStringArray(repo.skills, `repositories[${index}].skills`),
      agents: assertStringArray(repo.agents, `repositories[${index}].agents`),
      libs: assertStringArray(repo.libs, `repositories[${index}].libs`),
    };
  });

  return { schemaVersion: 1, generatedFrom: { sourceRoot }, repositories };
}

function assertRepoId(id: string): void {
  if (basename(id) !== id || id === '.' || id === '..' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Unsafe repository id in migration plan: ${id}`);
  }
}

function assertLeafName(name: string, label: string): void {
  if (basename(name) !== name || name === '.' || name === '..') {
    throw new Error(`Unsafe ${label} in migration plan: ${name}`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) throw new Error(`Path escapes migration root: ${relativePath}`);
  return path;
}

function normalizeLibSpec(spec: string): string {
  const normalized = spec.endsWith('/**') ? spec.slice(0, -3) : spec;
  if (!normalized || /[*?[\]{}!]/.test(normalized)) {
    throw new Error(`Unsupported lib path pattern in migration plan: ${spec}`);
  }
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Unsafe lib path in migration plan: ${spec}`);
  }
  return normalized;
}

function buildOperations(plan: MigrationPlan, sourceRoot: string, targetRoot: string): MoveOperation[] {
  const operations: MoveOperation[] = [];

  for (const repo of plan.repositories) {
    if (repo.action !== 'CREATE_AND_MOVE') continue;
    assertRepoId(repo.id);
    const repoRoot = resolveWithin(targetRoot, repo.id);

    for (const skill of repo.skills ?? []) {
      assertLeafName(skill, 'skill name');
      const relativeSource = join('skill', skill);
      operations.push({
        kind: 'skill',
        repoId: repo.id,
        source: resolveWithin(sourceRoot, relativeSource),
        target: resolveWithin(repoRoot, join('skills', skill)),
        relativeSource,
      });
    }

    for (const agent of repo.agents ?? []) {
      assertLeafName(agent, 'agent file');
      const relativeSource = join('agents', agent);
      operations.push({
        kind: 'agent',
        repoId: repo.id,
        source: resolveWithin(sourceRoot, relativeSource),
        target: resolveWithin(repoRoot, join('agents', agent)),
        relativeSource,
      });
    }

    for (const libSpec of repo.libs ?? []) {
      const relativeSource = normalizeLibSpec(libSpec);
      operations.push({
        kind: 'lib',
        repoId: repo.id,
        source: resolveWithin(sourceRoot, relativeSource),
        target: resolveWithin(repoRoot, relativeSource),
        relativeSource,
      });
    }
  }

  return operations;
}

function assertNoOverlaps(operations: MoveOperation[]): void {
  const seenSources = new Map<string, MoveOperation>();
  const seenTargets = new Map<string, MoveOperation>();
  for (const operation of operations) {
    const duplicateSource = seenSources.get(operation.source);
    if (duplicateSource) {
      throw new Error(`Migration source is claimed twice: ${operation.source} (${duplicateSource.repoId}, ${operation.repoId})`);
    }
    const duplicateTarget = seenTargets.get(operation.target);
    if (duplicateTarget) {
      throw new Error(`Migration target is claimed twice: ${operation.target} (${duplicateTarget.repoId}, ${operation.repoId})`);
    }
    seenSources.set(operation.source, operation);
    seenTargets.set(operation.target, operation);
  }

  const sources = [...seenSources.keys()].sort();
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const left = sources[i]!;
      const right = sources[j]!;
      if (right.startsWith(`${left}${sep}`)) {
        throw new Error(`Migration sources overlap: ${left} contains ${right}`);
      }
    }
  }
}

async function resolvedSymlinkTarget(path: string): Promise<string | undefined> {
  const stat = await tryLstat(path);
  if (!stat?.isSymbolicLink()) return undefined;
  return resolve(dirname(path), await readlink(path));
}

async function skillCompatTarget(path: string): Promise<string | undefined> {
  const marker = join(path, '.skillrepo-compat.json');
  try {
    const value = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>;
    return typeof value.target === 'string' ? resolve(value.target) : undefined;
  } catch {
    return undefined;
  }
}

async function classifyOperation(operation: MoveOperation, resume: boolean): Promise<MoveState> {
  const sourceStat = await tryLstat(operation.source);
  const targetStat = await tryLstat(operation.target);

  const sourceIsPending = Boolean(
    sourceStat
    && !sourceStat.isSymbolicLink()
    && (operation.kind === 'skill' ? sourceStat.isDirectory() : operation.kind === 'agent' ? sourceStat.isFile() : true),
  );

  if (sourceIsPending && !targetStat) return 'pending';

  if (!resume) {
    if (!sourceStat) throw new Error(`Migration source does not exist: ${operation.source}`);
    if (sourceStat.isSymbolicLink()) throw new Error(`Refusing to migrate symlink source: ${operation.source}`);
    if (operation.kind === 'skill' && !sourceStat.isDirectory()) {
      throw new Error(`Skill source is not a directory: ${operation.source}`);
    }
    if (operation.kind === 'agent' && !sourceStat.isFile()) {
      throw new Error(`Agent source is not a file: ${operation.source}`);
    }
    if (targetStat) throw new Error(`Migration target already exists: ${operation.target}`);
    throw new Error(`Migration source has an unsupported type: ${operation.source}`);
  }

  if (operation.kind === 'skill') {
    const markerTarget = sourceStat?.isDirectory() ? await skillCompatTarget(operation.source) : undefined;
    if (
      targetStat?.isDirectory()
      && sourceStat?.isDirectory()
      && markerTarget === operation.target
      && !(await lexists(join(operation.source, 'SKILL.md')))
    ) {
      return 'moved';
    }
  } else if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
    if (!sourceStat && targetStat?.isFile()) return 'moved';
  } else {
    const linkTarget = await resolvedSymlinkTarget(operation.source);
    if (targetStat && linkTarget === operation.target) return 'moved';
  }

  throw new Error(
    `Migration resume state is not recognized: ${operation.source} -> ${operation.target}. `
    + 'Refusing to guess whether this path was moved by skillrepo.',
  );
}

async function validateFrontmatter(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${path}: cannot read frontmatter source: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    parseFrontmatter(text);
  } catch (error) {
    throw new Error(`${path}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function preflight(
  operations: MoveOperation[],
  resume: boolean,
): Promise<Map<string, MoveState>> {
  assertNoOverlaps(operations);
  const states = new Map<string, MoveState>();

  for (const operation of operations) {
    const state = await classifyOperation(operation, resume);
    states.set(operation.target, state);

    if (operation.kind === 'skill') {
      await validateFrontmatter(join(state === 'moved' ? operation.target : operation.source, 'SKILL.md'));
    } else if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
      await validateFrontmatter(state === 'moved' ? operation.target : operation.source);
    }
  }

  return states;
}

function frontmatter(text: string): Record<string, unknown> | null {
  const parsed = parseFrontmatter(text);
  return parsed.hasFrontmatter ? parsed.data : null;
}

async function ensureStableAgentName(path: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  const meta = frontmatter(text);
  const currentName = meta && typeof meta.name === 'string' ? meta.name.trim() : '';
  if (currentName) return;

  const stableName = basename(path, '.md');
  if (!meta) {
    await writeFile(path, `---\nname: ${stableName}\n---\n${text}`, 'utf8');
    return;
  }

  const firstLineEnd = text.indexOf('\n');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const insertAt = firstLineEnd >= 0 ? firstLineEnd + 1 : 4;
  await writeFile(path, `${text.slice(0, insertAt)}name: ${stableName}${newline}${text.slice(insertAt)}`, 'utf8');
}

async function subtreeContainsSkill(path: string): Promise<boolean> {
  return await lexists(join(path, 'SKILL.md'));
}

async function createSkillCompatibilityShim(source: string, target: string): Promise<string[]> {
  await mkdir(source, { recursive: true });
  const linked: string[] = [];
  const skipped: string[] = [];

  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === 'SKILL.md' || entry.name === '.git') continue;
    const targetChild = join(target, entry.name);
    if (entry.isDirectory() && await subtreeContainsSkill(targetChild)) {
      skipped.push(entry.name);
      continue;
    }
    const sourceChild = join(source, entry.name);
    await symlink(targetChild, sourceChild);
    linked.push(sourceChild);
  }

  await writeFile(
    join(source, '.skillrepo-compat.json'),
    `${JSON.stringify({ target, linked: linked.map(path => basename(path)), skipped }, null, 2)}\n`,
    'utf8',
  );
  return linked;
}

async function createFileCompatibilityShim(source: string, target: string): Promise<string[]> {
  await mkdir(dirname(source), { recursive: true });
  await symlink(target, source);
  return [source];
}

async function moveOperation(operation: MoveOperation): Promise<string[]> {
  await mkdir(dirname(operation.target), { recursive: true });
  try {
    await rename(operation.source, operation.target);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'EXDEV') {
      throw new Error(`Cannot mechanically mv across filesystems: ${operation.source} -> ${operation.target}. Choose a target root on the same filesystem.`);
    }
    throw error;
  }

  if (operation.kind === 'agent') {
    if (operation.target.endsWith('.md')) {
      await ensureStableAgentName(operation.target);
      return [];
    }
    return await createFileCompatibilityShim(operation.source, operation.target);
  }
  if (operation.kind === 'lib') {
    return await createFileCompatibilityShim(operation.source, operation.target);
  }
  return await createSkillCompatibilityShim(operation.source, operation.target);
}

export async function applyMigration(options: MigrationApplyOptions): Promise<MigrationApplyResult> {
  const planPath = resolve(expandHome(options.planPath));
  const targetRoot = resolve(expandHome(options.targetRoot));
  const plan = parsePlan(await readFile(planPath, 'utf8'));
  const sourceRoot = resolve(expandHome(plan.generatedFrom.sourceRoot));
  if (sourceRoot === targetRoot) throw new Error('Migration source root and target root must be different');

  const operations = buildOperations(plan, sourceRoot, targetRoot);
  if (!operations.length) throw new Error('Migration plan has no CREATE_AND_MOVE operations');
  const states = await preflight(operations, options.resume === true);
  const resumedMoves = operations.filter(operation => states.get(operation.target) === 'moved');

  const repositories = [...new Set(operations.map(operation => operation.repoId))];
  if (options.dryRun) {
    return {
      dryRun: true,
      sourceRoot,
      targetRoot,
      repositories,
      moves: operations,
      resumedMoves,
      compatibilityPaths: [],
      verification: [],
    };
  }

  const compatibilityPaths: string[] = [];
  for (const operation of operations) {
    if (states.get(operation.target) === 'moved') continue;
    compatibilityPaths.push(...await moveOperation(operation));
  }

  // A resumed run may start from a state produced by an older failed apply.
  // Re-assert stable names for all moved Markdown agents before registration.
  for (const operation of operations) {
    if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
      await ensureStableAgentName(operation.target);
    }
  }

  const verification: VerifyResult[] = [];
  for (const repoId of repositories) {
    const repoPath = join(targetRoot, repoId);
    const inventory = await inspectRepo(repoPath);
    if (options.verify !== false) await assertNoRuntimeCollisions(inventory);
    await registerRepo(repoPath);
    if (options.verify !== false) {
      const results = await verifyRepoRegistered(inventory);
      verification.push(...results);
      const failures = results.filter(result => !result.ok);
      if (failures.length) {
        throw new Error(`OpenCode did not discover migrated repo ${repoId}:\n${failures.map(result => `${result.command}: ${result.stderr.trim() || 'verification failed'}`).join('\n')}`);
      }
    }
  }

  return {
    dryRun: false,
    sourceRoot,
    targetRoot,
    repositories,
    moves: operations,
    resumedMoves,
    compatibilityPaths,
    verification,
  };
}
