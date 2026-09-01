import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import {
  agentRegistrationPath,
  assertNoConfiguredIdentifierCollisions,
  assertNoRuntimeCollisions,
  fingerprintText,
  inspectRepo,
  opencodeConfigDir,
  opencodeConfigFile,
  prepareRegistration,
  prospectiveOpenCodeConfig,
  readOpenCodeConfigSnapshot,
  restoreOpenCodeConfig,
  verifyMigrationDiscovery,
  writeOpenCodeConfigAtomically,
  type OpenCodeConfigSnapshot,
  type RepoInventory,
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

export type MoveKind = 'skill' | 'agent' | 'lib';

export type MoveOperation = {
  kind: MoveKind;
  repoId: string;
  source: string;
  target: string;
  relativeSource: string;
  expectedSkillId?: string;
  expectedSkillIds?: string[];
  expectedAgentName?: string;
  sourceFingerprint?: string;
  sourceIdentity?: PathIdentity;
};

export type MigrationPhase =
  | 'preflight'
  | 'preparing'
  | 'committing'
  | 'registering'
  | 'verifying'
  | 'rollback'
  | 'committed'
  | 'rolled-back';

export type MigrationStatus =
  | 'in-progress'
  | 'moved-uncommitted'
  | 'rollback-in-progress'
  | 'committed'
  | 'rollback-complete'
  | 'rollback-incomplete'
  | 'preflight-failed';

type OperationState = 'pending' | 'staged' | 'prepared' | 'moved' | 'complete';

type PathIdentity = { dev: number; ino: number };
type CreatedDirectory = { path: string; identity: PathIdentity; markerPath?: string };
type CreatingDirectory = { path: string; temporary: string };

type JournalOperation = MoveOperation & {
  operationId: string;
  stagePath: string;
  state: OperationState;
  sourceFingerprint: string;
  sourceIdentity: PathIdentity;
  targetPrecondition: 'absent';
  stageOwnershipPath?: string;
  targetFingerprint?: string;
  targetIdentity?: PathIdentity;
  stagedFingerprint?: string;
  stagedIdentity?: PathIdentity;
  compatibilityPaths: string[];
  compatibilityIdentities: Record<string, PathIdentity>;
  fileCompatibilityTarget?: string;
  fileCompatibilityCreated?: boolean;
  fileCompatibilityIdentity?: PathIdentity;
  skillShimIdentity?: PathIdentity;
  skillShim?: {
    markerPath: string;
    linked: string[];
    skipped: string[];
    state?: 'creating' | 'complete';
    removalState?: 'removing-marker' | 'removed';
  };
  skillShimStagePath?: string;
  generatedAgentBackupPath?: string;
  generatedAgentOriginalFingerprint?: string;
  generatedAgentOriginalContentFingerprint?: string;
  generatedAgentRewrittenFingerprint?: string;
  generatedAgentTemporaryPath?: string;
  generatedAgentTemporaryIdentity?: PathIdentity;
  generatedAgentTemporaryToken?: string;
  generatedAgentPublishState?: 'publish-intent' | 'published' | 'proof-unlinked' | 'proof-relinked' | 'complete';
  generatedAgentPublishedIdentity?: PathIdentity;
  generatedAgentRestoreState?: 'pending' | 'restored';
  generatedAgentRestoredIdentity?: PathIdentity;
};

type JournalRegistration = {
  skillSources: string[];
  addedSkillSources: string[];
  agentLinks: Array<{ path: string; target: string; created: boolean; identity?: PathIdentity }>;
  inventories: RepoInventory[];
  prospectiveConfigText: string;
  prospectiveConfigFingerprint: string;
};

type MigrationJournal = {
  schemaVersion: 1;
  transactionId: string;
  planPath: string;
  planFingerprint: string;
  sourceRoot: string;
  targetRoot: string;
  journalPath: string;
  lockPath: string;
  stagingRoot: string;
  stagingMarkerPath: string;
  phase: MigrationPhase;
  status: MigrationStatus;
  createdAt: string;
  updatedAt: string;
  repositories: string[];
  operations: JournalOperation[];
  createdDirectories: CreatedDirectory[];
  creatingDirectories?: CreatingDirectory[];
  prospectiveConfigText: string;
  prospectiveConfigFingerprint: string;
  configDirectoryExisted: boolean;
  config: {
    path: string;
    existed: boolean;
    originalText?: string;
    originalFingerprint: string;
    originalIdentity?: PathIdentity;
    mode?: number;
    changed: boolean;
    newFingerprint?: string;
    newIdentity?: PathIdentity;
    newMode?: number;
    rollbackState?: 'pending' | 'restoring' | 'restored';
  };
  registration?: JournalRegistration;
};

type PreflightResult = {
  operations: MoveOperation[];
  repositories: string[];
  expectedSkillIds: string[];
  expectedAgentNames: string[];
  prospectiveConfig: ReturnType<typeof prospectiveOpenCodeConfig>;
  existingInventories: Map<string, RepoInventory>;
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
  transactionId?: string;
  journalPath?: string;
  phase?: MigrationPhase;
  status?: MigrationStatus | 'dry-run';
  rollbackStatus?: 'not-needed' | 'rollback-complete' | 'rollback-incomplete';
};

const JOURNAL_DIRECTORY = '.skillrepo-migrations';
const STAGING_DIRECTORY = '.skillrepo-migration-staging';
const LOCK_DIRECTORY = '.skillrepo-migration.lock';
const STAGING_MARKER = '.owner.json';
const DIRECTORY_MARKER = '.skillrepo-directory-owner.json';
const COMPAT_MARKER = '.skillrepo-compat.json';
const ABSENT_FINGERPRINT = 'absent';

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
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

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function fingerprintBuffer(prefix: string, value: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(prefix, 'utf8');
  hash.update(value);
  return hash.digest('hex');
}

async function fingerprintPath(path: string): Promise<string> {
  const pathStat = await tryLstat(path);
  if (!pathStat) return ABSENT_FINGERPRINT;

  if (pathStat.isSymbolicLink()) return fingerprintBuffer('symlink\0', await readlink(path));
  if (pathStat.isFile()) return fingerprintBuffer(`file\0${pathStat.mode & 0o7777}\0`, await readFile(path));
  if (pathStat.isDirectory()) {
    const hash = createHash('sha256');
    hash.update(`directory\0${pathStat.mode & 0o7777}\0`, 'utf8');
    const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      hash.update(entry.name, 'utf8');
      hash.update('\0', 'utf8');
      hash.update(await fingerprintPath(join(path, entry.name)), 'utf8');
      hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
  }

  return fingerprintBuffer(`other\0${pathStat.mode}\0`, '');
}

function identityFromStat(pathStat: Awaited<ReturnType<typeof lstat>>): PathIdentity {
  return { dev: Number(pathStat.dev), ino: Number(pathStat.ino) };
}

async function pathIdentity(path: string): Promise<PathIdentity | undefined> {
  const pathStat = await tryLstat(path);
  return pathStat ? identityFromStat(pathStat) : undefined;
}

function sameIdentity(left: PathIdentity | undefined, right: PathIdentity | undefined): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
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
  const components = normalized.split(/[\\/]/);
  if (
    normalized.startsWith('/')
    || components.some(component => component === '.' || component === '..' || !component)
  ) {
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

function assertNoOverlaps(operations: MoveOperation[], sourceRoot: string, targetRoot: string): void {
  if (pathsOverlap(sourceRoot, targetRoot)) {
    throw new Error(`Migration source root and target root overlap: ${sourceRoot} and ${targetRoot}`);
  }

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

  const allPaths = operations.flatMap(operation => [operation.source, operation.target]);
  for (let i = 0; i < allPaths.length; i += 1) {
    for (let j = i + 1; j < allPaths.length; j += 1) {
      const left = allPaths[i]!;
      const right = allPaths[j]!;
      if (!pathsOverlap(left, right)) continue;
      const leftOperation = operations[Math.floor(i / 2)]!;
      const rightOperation = operations[Math.floor(j / 2)]!;
      if (leftOperation === rightOperation && i % 2 === j % 2) continue;
      throw new Error(`Migration paths overlap: ${left} and ${right}`);
    }
  }
}

async function existingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  while (!(await lexists(current))) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot find filesystem ancestor for ${path}`);
    current = parent;
  }
  const pathStat = await lstat(current);
  if (pathStat.isSymbolicLink()) throw new Error(`Refusing symlinked migration root ancestor: ${current}`);
  if (!pathStat.isDirectory()) throw new Error(`Migration root ancestor is not a directory: ${current}`);
  return current;
}

async function assertNoSymlinkAncestors(path: string, root: string): Promise<void> {
  let current = resolve(path);
  const stop = resolve(root);
  while (true) {
    const pathStat = await tryLstat(current);
    if (pathStat?.isSymbolicLink()) throw new Error(`Refusing symlinked migration path component: ${current}`);
    if (current === stop) return;
    const parent = dirname(current);
    if (parent === current || !isPathWithin(stop, current)) {
      throw new Error(`Migration path is outside expected root: ${path}`);
    }
    current = parent;
  }
}

async function assertSameFilesystem(sourceRoot: string, targetRoot: string): Promise<void> {
  const sourceStat = await stat(sourceRoot);
  const targetAncestor = await existingAncestor(targetRoot);
  const targetStat = await stat(targetAncestor);
  if (sourceStat.dev !== targetStat.dev) {
    throw new Error(`Cannot mechanically mv across filesystems: ${sourceRoot} -> ${targetRoot}. Choose a target root on the same filesystem.`);
  }
}

function frontmatter(text: string): Record<string, unknown> {
  const parsed = parseFrontmatter(text);
  return parsed.data;
}

async function readFrontmatter(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${path}: cannot read frontmatter source: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return frontmatter(text);
  } catch (error) {
    throw new Error(`${path}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stableSkillId(path: string, meta: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(meta, 'name') && typeof meta.name !== 'string') {
    throw new Error(`${path}: frontmatter name must be a string`);
  }
  const value = typeof meta.name === 'string' ? meta.name.trim() : '';
  return value || basename(dirname(path));
}

function stableAgentName(path: string, meta: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(meta, 'name') && typeof meta.name !== 'string') {
    throw new Error(`${path}: frontmatter name must be a string`);
  }
  const value = typeof meta.name === 'string' ? meta.name.trim() : '';
  return value || basename(path, '.md');
}

async function collectSkillIdsInTree(root: string, rootFallback?: string): Promise<Array<{ path: string; id: string }>> {
  const result: Array<{ path: string; id: string }> = [];
  const seen = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') continue;
      const meta = await readFrontmatter(path);
      const id = path === join(root, 'SKILL.md') && !(typeof meta.name === 'string' && meta.name.trim()) && rootFallback
        ? rootFallback
        : stableSkillId(path, meta);
      const previous = seen.get(id);
      if (previous) throw new Error(`Duplicate skill ID '${id}' in ${path} (also ${previous})`);
      seen.set(id, path);
      result.push({ path, id });
    }
  }

  await walk(root);
  return result;
}

async function validateOperationSource(operation: MoveOperation): Promise<MoveOperation> {
  const sourceStat = await tryLstat(operation.source);
  if (!sourceStat) throw new Error(`Migration source does not exist: ${operation.source}`);
  if (sourceStat.isSymbolicLink()) throw new Error(`Refusing to migrate symlink source: ${operation.source}`);
  if (operation.kind === 'skill' && !sourceStat.isDirectory()) {
    throw new Error(`Skill source is not a directory: ${operation.source}`);
  }
  if (operation.kind === 'agent' && !sourceStat.isFile()) {
    throw new Error(`Agent source is not a file: ${operation.source}`);
  }

  let result: MoveOperation = {
    ...operation,
    sourceFingerprint: await fingerprintPath(operation.source),
    sourceIdentity: identityFromStat(sourceStat),
  };
  if (operation.kind === 'skill') {
    const skillPath = join(operation.source, 'SKILL.md');
    const skillStat = await tryLstat(skillPath);
    if (!skillStat?.isFile() || skillStat.isSymbolicLink()) throw new Error(`Skill source is missing SKILL.md: ${skillPath}`);
    const skills = await collectSkillIdsInTree(operation.source);
    const rootSkill = skills.find(skill => skill.path === skillPath);
    if (!rootSkill) throw new Error(`Skill source is missing SKILL.md: ${skillPath}`);
    result = {
      ...result,
      expectedSkillId: rootSkill.id,
      expectedSkillIds: skills.map(skill => skill.id),
    };
  } else if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
    const meta = await readFrontmatter(operation.source);
    result = { ...result, expectedAgentName: stableAgentName(operation.source, meta) };
  }
  return result;
}

async function inspectExistingTarget(repoPath: string): Promise<RepoInventory | undefined> {
  const repoStat = await tryLstat(repoPath);
  if (!repoStat) return undefined;
  if (repoStat.isSymbolicLink()) throw new Error(`Refusing symlinked migration target repository: ${repoPath}`);
  if (!repoStat.isDirectory()) throw new Error(`Migration target repository is not a directory: ${repoPath}`);

  const hasSkills = await lexists(join(repoPath, 'skills'));
  const hasAgents = await lexists(join(repoPath, 'agents'));
  if (!hasSkills && !hasAgents) return undefined;
  return await inspectRepo(repoPath);
}

async function preflight(
  operationsInput: MoveOperation[],
  sourceRoot: string,
  targetRoot: string,
  configSnapshot: OpenCodeConfigSnapshot,
): Promise<PreflightResult> {
  assertNoOverlaps(operationsInput, sourceRoot, targetRoot);
  const sourceRootStat = await lstat(sourceRoot);
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
    throw new Error(`Migration source root is not a real directory: ${sourceRoot}`);
  }
  await assertSameFilesystem(sourceRoot, targetRoot);
  const targetDevice = Number((await stat(await existingAncestor(targetRoot))).dev);

  const operations: MoveOperation[] = [];
  const expectedSkillIds: string[] = [];
  const expectedAgentNames: string[] = [];
  const skillOwners = new Map<string, string>();
  const agentOwners = new Map<string, string>();

  for (const operation of operationsInput) {
    const reservedSourcePaths = [journalDirectory(sourceRoot), join(sourceRoot, STAGING_DIRECTORY), lockPath(sourceRoot)];
    if (reservedSourcePaths.some(path => pathsOverlap(operation.source, path))) {
      throw new Error(`Migration source overlaps skillrepo transaction metadata: ${operation.source}`);
    }
    await assertNoSymlinkAncestors(operation.source, sourceRoot);
    await assertNoSymlinkAncestors(operation.target, targetRoot);
    if (await lexists(operation.target)) throw new Error(`Migration target already exists: ${operation.target}`);

    const operationWithMetadata = await validateOperationSource(operation);
    if (operationWithMetadata.sourceIdentity?.dev !== targetDevice) {
      throw new Error(`Cannot mechanically mv across filesystems: ${operation.source} -> ${operation.target}. Choose a target root on the same filesystem.`);
    }
    operations.push(operationWithMetadata);
    if (operationWithMetadata.expectedSkillIds?.length) {
      for (const skillId of operationWithMetadata.expectedSkillIds) {
        const previous = skillOwners.get(skillId);
        if (previous) throw new Error(`Duplicate skill ID '${skillId}' in migration batch (also ${previous})`);
        skillOwners.set(skillId, operationWithMetadata.source);
        expectedSkillIds.push(skillId);
      }
    }
    if (operationWithMetadata.expectedAgentName) {
      const previous = agentOwners.get(operationWithMetadata.expectedAgentName);
      if (previous) throw new Error(`Duplicate agent name '${operationWithMetadata.expectedAgentName}' in migration batch (also ${previous})`);
      agentOwners.set(operationWithMetadata.expectedAgentName, operationWithMetadata.source);
      expectedAgentNames.push(operationWithMetadata.expectedAgentName);
    }
  }

  const repositories = [...new Set(operations.map(operation => operation.repoId))];
  const registrationPaths = repositories.map(repoId => agentRegistrationPath(join(targetRoot, repoId)));
  for (const operation of operations) {
    if (registrationPaths.some(path => pathsOverlap(operation.source, path) || pathsOverlap(operation.target, path))) {
      throw new Error(`Migration path overlaps its agent registration link: ${operation.source} or ${operation.target}`);
    }
  }
  if (
    operations.some(operation => pathsOverlap(configSnapshot.path, operation.source) || pathsOverlap(configSnapshot.path, operation.target))
    || registrationPaths.some(path => pathsOverlap(configSnapshot.path, path))
  ) {
    throw new Error(`OpenCode config path overlaps a migration operation: ${configSnapshot.path}`);
  }
  const existingInventories = new Map<string, RepoInventory>();
  const existingSkillIds = new Set<string>();
  const existingAgentNames = new Set<string>();
  const existingSkillOwners = new Map<string, string>();
  const existingAgentOwners = new Map<string, string>();
  for (const repoId of repositories) {
    const inventory = await inspectExistingTarget(join(targetRoot, repoId));
    if (!inventory) continue;
    existingInventories.set(repoId, inventory);
    for (const id of inventory.skillIds) {
      const previous = existingSkillOwners.get(id);
      if (previous) throw new Error(`Duplicate skill ID '${id}' already exists in migration targets (${previous}, ${repoId})`);
      existingSkillOwners.set(id, repoId);
      existingSkillIds.add(id);
    }
    for (const name of inventory.agentNames) {
      const previous = existingAgentOwners.get(name);
      if (previous) throw new Error(`Duplicate agent name '${name}' already exists in migration targets (${previous}, ${repoId})`);
      existingAgentOwners.set(name, repoId);
      existingAgentNames.add(name);
    }
  }
  for (const id of expectedSkillIds) {
    if (existingSkillIds.has(id)) throw new Error(`Duplicate skill ID '${id}' already exists in migration target`);
  }
  for (const name of expectedAgentNames) {
    if (existingAgentNames.has(name)) throw new Error(`Duplicate agent name '${name}' already exists in migration target`);
  }

  for (const repoId of repositories) {
    const inventory = existingInventories.get(repoId);
    const needsAgentLink = operations.some(operation => operation.repoId === repoId && operation.kind === 'agent') || Boolean(inventory?.agentsDir);
    if (!needsAgentLink) continue;
    const path = agentRegistrationPath(join(targetRoot, repoId));
    const pathStat = await tryLstat(path);
    if (!pathStat) continue;
    if (!pathStat.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== join(targetRoot, repoId, 'agents')) {
      throw new Error(`Agent symlink collision: ${path}`);
    }
  }

  for (const repoId of repositories) {
    const inventory = existingInventories.get(repoId);
    const hasSkillOrAgent = operations.some(operation => operation.repoId === repoId && (operation.kind === 'skill' || operation.kind === 'agent'));
    if (!hasSkillOrAgent && !inventory?.skillsDir && !inventory?.agentsDir) {
      throw new Error(`Migration target repository ${repoId} has neither skills/ nor agents/`);
    }
  }

  const skillRepoIds = repositories.filter(repoId => {
    const inventory = existingInventories.get(repoId);
    return operations.some(operation => operation.repoId === repoId && operation.kind === 'skill') || Boolean(inventory?.skillsDir);
  });
  const skillSources = skillRepoIds.map(repoId => join(targetRoot, repoId, 'skills'));

  await assertNoConfiguredIdentifierCollisions(
    [...expectedSkillIds, ...existingSkillIds],
    [...expectedAgentNames, ...existingAgentNames],
    operations
      .filter(operation => operation.kind === 'agent')
      .map(operation => operation.source)
      .concat(registrationPaths),
    skillSources,
  );

  const prospectiveConfig = prospectiveOpenCodeConfig(configSnapshot, skillSources);

  return {
    operations,
    repositories,
    expectedSkillIds,
    expectedAgentNames,
    prospectiveConfig,
    existingInventories,
  };
}

function journalDirectory(sourceRoot: string): string {
  return join(sourceRoot, JOURNAL_DIRECTORY);
}

function stagingParent(sourceRoot: string): string {
  return join(sourceRoot, STAGING_DIRECTORY);
}

function lockPath(sourceRoot: string): string {
  return join(sourceRoot, LOCK_DIRECTORY);
}

function makeStagePath(stagingRoot: string, operationId: string): string {
  return join(stagingRoot, operationId);
}

function stagingTemporaryPath(journal: MigrationJournal): string {
  return join(stagingParent(journal.sourceRoot), `.${journal.transactionId}.tmp`);
}

function directoryTemporaryPath(journal: MigrationJournal, path: string): string {
  const suffix = createHash('sha256').update(path).digest('hex').slice(0, 16);
  return join(dirname(path), `.${basename(path)}.${journal.transactionId}.${suffix}.tmp`);
}

function now(): string {
  return new Date().toISOString();
}

function crashAfter(label: string): void {
  if (process.env.NODE_ENV === 'test' && process.env.SKILLREPO_TEST_CRASH_AFTER === label) {
    process.kill(process.pid, 'SIGKILL');
  }
}

async function replaceAgentFileAtomically(
  path: string,
  text: string,
  journal: MigrationJournal,
  operation: JournalOperation,
  partialCrashLabel?: string,
): Promise<PathIdentity> {
  if (operation.generatedAgentTemporaryPath) {
    const temporaryIssues = await clearGeneratedAgentTemporary(operation, journal);
    if (temporaryIssues.length) throw new Error(temporaryIssues.join('\n'));
  }

  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink()) throw new Error(`Generated agent path is not a regular file: ${path}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  operation.generatedAgentTemporaryPath = resolve(temporary);
  operation.generatedAgentTemporaryToken = randomUUID();
  await persistJournal(journal);
  crashAfter('agent-temp-intent-persisted');

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      current.mode & 0o7777,
    );
    await handle.writeFile(`${operation.generatedAgentTemporaryToken}\n`, { encoding: 'utf8' });
    await handle.sync();
    if (partialCrashLabel === 'agent-stable-name-partial-write') {
      crashAfter('agent-rewrite-temp-created-before-identity');
    } else if (partialCrashLabel === 'rollback-agent-restore-partial-write') {
      crashAfter('rollback-agent-temp-created-before-identity');
    }
    operation.generatedAgentTemporaryIdentity = await pathIdentity(temporary);
    if (!operation.generatedAgentTemporaryIdentity) {
      throw new Error(`Generated agent temporary path disappeared after creation: ${temporary}`);
    }
    await persistJournal(journal);
    await handle.close();
    handle = undefined;
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    );
    if (partialCrashLabel && process.env.NODE_ENV === 'test'
      && process.env.SKILLREPO_TEST_CRASH_AFTER === partialCrashLabel) {
      const partial = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      await handle.writeFile(partial, { encoding: 'utf8' });
      await handle.sync();
      crashAfter(partialCrashLabel);
    }
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, current.mode & 0o7777);
    if (partialCrashLabel === 'agent-stable-name-partial-write') {
      operation.generatedAgentPublishedIdentity = operation.generatedAgentTemporaryIdentity;
      operation.generatedAgentPublishState = 'publish-intent';
      await persistJournal(journal);
      crashAfter('agent-stable-name-publish-state-persisted');
    }
    await rename(temporary, path);
    if (partialCrashLabel === 'agent-stable-name-partial-write') {
      crashAfter('agent-stable-name-published');
    }
    operation.generatedAgentTemporaryPath = undefined;
    operation.generatedAgentTemporaryIdentity = undefined;
    operation.generatedAgentTemporaryToken = undefined;
    await persistJournal(journal);
    const identity = await pathIdentity(path);
    if (!identity) throw new Error(`Generated agent path disappeared after atomic replace: ${path}`);
    return identity;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    operation.generatedAgentTemporaryPath = undefined;
    operation.generatedAgentTemporaryIdentity = undefined;
    operation.generatedAgentTemporaryToken = undefined;
    await persistJournal(journal).catch(() => undefined);
    throw error;
  }
}

async function persistJournal(journal: MigrationJournal): Promise<void> {
  journal.updatedAt = now();
  const temporary = `${journal.journalPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, journal.journalPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid skillrepo transaction metadata ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid skillrepo transaction metadata ${path}`);
  return raw as Record<string, unknown>;
}

async function acquireLock(sourceRoot: string, transactionId: string): Promise<void> {
  const path = lockPath(sourceRoot);
  const temporary = join(journalDirectory(sourceRoot), `.${transactionId}.lock.tmp`);
  try {
    // A crash before the atomic publish can leave only this transaction's
    // private staging directory behind. It is safe to rebuild it from the
    // durable journal on the next resume.
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(
      join(temporary, 'owner.json'),
      `${JSON.stringify({ transactionId, sourceRoot, pid: process.pid, createdAt: now() }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    crashAfter('lock-owner-staged');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      let owner = 'unknown';
      try {
        const metadata = await readJson(join(path, 'owner.json'));
        if (typeof metadata.transactionId === 'string') owner = metadata.transactionId;
      } catch {
        // A published lock always contains its owner. Never remove an
        // incompatible or externally-created lock by guessing.
      }
      throw new Error(`Migration source root is locked by transaction ${owner}; use --resume only with its journal`);
    }
    throw error;
  }
}

async function lockOwner(sourceRoot: string): Promise<string | undefined> {
  const path = lockPath(sourceRoot);
  if (!(await lexists(path))) return undefined;
  const metadata = await readJson(join(path, 'owner.json'));
  return typeof metadata.transactionId === 'string' ? metadata.transactionId : undefined;
}

async function releaseLock(sourceRoot: string, transactionId: string): Promise<void> {
  const path = lockPath(sourceRoot);
  if (!(await lexists(path))) return;
  const owner = await lockOwner(sourceRoot);
  if (owner !== transactionId) throw new Error(`Refusing to remove migration lock owned by ${owner ?? 'unknown'}`);
  await rm(path, { recursive: true, force: true });
}

async function ensureDirectoryPath(path: string, journal: MigrationJournal): Promise<void> {
  const missing: string[] = [];
  let current = resolve(path);
  while (!(await lexists(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot create directory path: ${path}`);
    current = parent;
  }

  const existing = await lstat(current);
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`Migration directory path is not a real directory: ${current}`);
  }

  for (const directory of missing.reverse()) {
    journal.creatingDirectories ??= [];
    const temporary = directoryTemporaryPath(journal, directory);
    if (!journal.creatingDirectories.some(item => item.path === directory)) {
      journal.creatingDirectories.push({ path: directory, temporary });
      await persistJournal(journal);
    }
    if (await lexists(temporary)) throw new Error(`Migration directory staging path already exists: ${temporary}`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeFile(
        join(temporary, DIRECTORY_MARKER),
        `${JSON.stringify({ transactionId: journal.transactionId, path: directory }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      if (await lexists(directory)) throw new Error(`Migration directory was created externally: ${directory}`);
      await rename(temporary, directory);
      crashAfter('directory-published');
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      journal.creatingDirectories = journal.creatingDirectories.filter(item => item.path !== directory);
      await persistJournal(journal).catch(() => undefined);
      throw error;
    }
    const identity = await pathIdentity(directory);
    if (!identity) throw new Error(`Created migration directory disappeared: ${directory}`);
    const markerPath = join(directory, DIRECTORY_MARKER);
    journal.creatingDirectories = journal.creatingDirectories.filter(item => item.path !== directory);
    journal.createdDirectories.push({ path: directory, identity, markerPath });
    await persistJournal(journal);
    await unlink(markerPath);
    await persistJournal(journal);
  }
}

async function assertCurrentFingerprint(path: string, expected: string, label: string): Promise<void> {
  const actual = await fingerprintPath(path);
  if (actual !== expected) throw new Error(`${label} changed during migration: ${path}`);
}

async function writeStagingMarker(journal: MigrationJournal): Promise<void> {
  const parent = stagingParent(journal.sourceRoot);
  const parentStat = await tryLstat(parent);
  if (parentStat?.isSymbolicLink() || (parentStat && !parentStat.isDirectory())) {
    throw new Error(`Migration staging parent is not a real directory: ${parent}`);
  }
  if (!parentStat) await mkdir(parent, { mode: 0o700 });
  const refreshedParent = await tryLstat(parent);
  if (!refreshedParent?.isDirectory() || refreshedParent.isSymbolicLink()) {
    throw new Error(`Migration staging parent is not a real directory: ${parent}`);
  }
  const existingRoot = await tryLstat(journal.stagingRoot);
  if (existingRoot) {
    throw new Error(`Migration staging root already exists: ${journal.stagingRoot}`);
  }
  const temporary = stagingTemporaryPath(journal);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(
      join(temporary, STAGING_MARKER),
      `${JSON.stringify({ transactionId: journal.transactionId, sourceRoot: journal.sourceRoot, stagingRoot: journal.stagingRoot }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, journal.stagingRoot);
    crashAfter('staging-published');
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertStagingOwner(journal: MigrationJournal): Promise<void> {
  if (!(await lexists(journal.stagingRoot))) return;
  const rootStat = await tryLstat(journal.stagingRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Staging directory is not a real directory: ${journal.stagingRoot}`);
  }
  const markerStat = await tryLstat(journal.stagingMarkerPath);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`Staging owner marker is not a regular file: ${journal.stagingMarkerPath}`);
  }
  const metadata = await readJson(journal.stagingMarkerPath);
  if (metadata.transactionId !== journal.transactionId || metadata.stagingRoot !== journal.stagingRoot) {
    throw new Error(`Staging directory owner mismatch: ${journal.stagingRoot}`);
  }
}

function agentNameFromText(path: string, text: string): string {
  return stableAgentName(path, frontmatter(text));
}

function addStableAgentName(text: string, stableName: string, hasFrontmatter: boolean): string {
  if (!hasFrontmatter) return `---\nname: ${stableName}\n---\n${text}`;
  const openingEnd = text.indexOf('\n') + 1;
  const closingMatch = text.slice(openingEnd).match(/\r?\n---/);
  const closingStart = closingMatch?.index === undefined ? -1 : openingEnd + closingMatch.index;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (openingEnd > 0 && closingStart > openingEnd) {
    const header = text.slice(openingEnd, closingStart);
    const lines = header.split(/\r?\n/);
    const emptyName = lines.findIndex(line => /^name\s*:\s*(?:''|""|\s*)$/.test(line));
    if (emptyName >= 0) {
      lines[emptyName] = `name: ${stableName}`;
      return `${text.slice(0, openingEnd)}${lines.join(newline)}${text.slice(closingStart)}`;
    }
  }
  const firstLineEnd = text.indexOf('\n');
  const insertAt = firstLineEnd >= 0 ? firstLineEnd + 1 : 4;
  return `${text.slice(0, insertAt)}name: ${stableName}${newline}${text.slice(insertAt)}`;
}

async function stagedContentIsOwned(operation: JournalOperation): Promise<boolean> {
  if (!operation.stagedFingerprint) return false;
  const currentFingerprint = await fingerprintPath(operation.stagePath);
  if (currentFingerprint === operation.stagedFingerprint) return true;
  if (!operation.generatedAgentBackupPath || !operation.generatedAgentRewrittenFingerprint || !operation.expectedAgentName) return false;
  const backup = await readFile(operation.generatedAgentBackupPath, 'utf8');
  const rewritten = addStableAgentName(backup, operation.expectedAgentName, parseFrontmatter(backup).hasFrontmatter);
  return currentFingerprint === operation.generatedAgentRewrittenFingerprint
    && (await readFile(operation.stagePath, 'utf8')) === rewritten;
}

async function stagedContentIsOriginal(operation: JournalOperation): Promise<boolean> {
  if (!operation.stagedIdentity || await fingerprintPath(operation.stagePath) !== operation.sourceFingerprint) return false;
  if (!sameIdentity(await pathIdentity(operation.stagePath), operation.stagedIdentity)) return false;
  if (!operation.stageOwnershipPath) return true;
  const ownershipIdentity = await pathIdentity(operation.stageOwnershipPath);
  return sameIdentity(ownershipIdentity, operation.stagedIdentity)
    && sameIdentity(ownershipIdentity, await pathIdentity(operation.stagePath));
}

async function clearGeneratedAgentTemporary(
  operation: JournalOperation,
  journal: MigrationJournal,
): Promise<string[]> {
  if (!operation.generatedAgentTemporaryPath) return [];
  const path = operation.generatedAgentTemporaryPath;
  const pathStat = await tryLstat(path);
  if (pathStat) {
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return [`Generated agent temporary path is not a regular file: ${path}`];
    }
    if (!operation.generatedAgentTemporaryIdentity) {
      if (!operation.generatedAgentTemporaryToken) {
        return [`Generated agent temporary ownership is not provable: ${path}`];
      }
      if (await readFile(path, 'utf8') !== `${operation.generatedAgentTemporaryToken}\n`) {
        return [`Generated agent temporary ownership is not provable: ${path}`];
      }
    }
    if (operation.generatedAgentTemporaryIdentity
      && !sameIdentity(identityFromStat(pathStat), operation.generatedAgentTemporaryIdentity)) {
      return [`Generated agent temporary path was recreated outside transaction: ${path}`];
    }
    await unlink(path);
  }
  operation.generatedAgentTemporaryPath = undefined;
  operation.generatedAgentTemporaryIdentity = undefined;
  operation.generatedAgentTemporaryToken = undefined;
  await persistJournal(journal);
  return [];
}

async function recoverGeneratedAgentPublish(journal: MigrationJournal): Promise<void> {
  for (const operation of journal.operations) {
    const publishState = operation.generatedAgentPublishState;
    if (!publishState || publishState === 'complete') continue;
    const expectedIdentity = operation.generatedAgentPublishedIdentity;
    if (!expectedIdentity) throw new Error(`Generated agent publish ownership is not recorded: ${operation.operationId}`);

    let stageStat = await tryLstat(operation.stagePath);
    const temporaryStat = operation.generatedAgentTemporaryPath
      ? await tryLstat(operation.generatedAgentTemporaryPath)
      : undefined;
    if (temporaryStat) {
      if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()
        || !operation.generatedAgentTemporaryIdentity
        || !sameIdentity(identityFromStat(temporaryStat), operation.generatedAgentTemporaryIdentity)
        || !operation.generatedAgentRewrittenFingerprint
        || await fingerprintPath(operation.generatedAgentTemporaryPath!) !== operation.generatedAgentRewrittenFingerprint) {
        throw new Error(`Generated agent publish temporary path is not owned: ${operation.operationId}`);
      }
    }
    if (!stageStat && temporaryStat) {
      await rename(operation.generatedAgentTemporaryPath!, operation.stagePath);
      stageStat = await tryLstat(operation.stagePath);
    } else if (stageStat && temporaryStat && publishState === 'publish-intent'
      && sameIdentity(identityFromStat(stageStat), operation.stagedIdentity)) {
      await rename(operation.generatedAgentTemporaryPath!, operation.stagePath);
      stageStat = await tryLstat(operation.stagePath);
    } else if (stageStat && temporaryStat) {
      await unlink(operation.generatedAgentTemporaryPath!);
    }
    if (!stageStat?.isFile() || stageStat.isSymbolicLink()
      || !sameIdentity(identityFromStat(stageStat), expectedIdentity)) {
      throw new Error(`Generated agent published stage ownership is not provable: ${operation.stagePath}`);
    }

    operation.stagedIdentity = expectedIdentity;
    if (operation.stageOwnershipPath) {
      const ownershipStat = await tryLstat(operation.stageOwnershipPath);
      if (ownershipStat && !sameIdentity(identityFromStat(ownershipStat), operation.sourceIdentity)
        && !sameIdentity(identityFromStat(ownershipStat), expectedIdentity)) {
        throw new Error(`Generated agent stage ownership proof was replaced outside transaction: ${operation.stageOwnershipPath}`);
      }
      if (ownershipStat && !sameIdentity(identityFromStat(ownershipStat), expectedIdentity)) {
        await unlink(operation.stageOwnershipPath);
      }
      if (!(await lexists(operation.stageOwnershipPath))) await link(operation.stagePath, operation.stageOwnershipPath);
    }
    operation.generatedAgentTemporaryPath = undefined;
    operation.generatedAgentTemporaryIdentity = undefined;
    operation.generatedAgentTemporaryToken = undefined;
    operation.generatedAgentPublishState = 'complete';
    await persistJournal(journal);
  }
}

async function recoverCreatingDirectories(journal: MigrationJournal): Promise<void> {
  const creating = journal.creatingDirectories ?? [];
  if (!creating.length) return;
  let changed = false;
  const remaining: CreatingDirectory[] = [];
  for (const item of creating) {
    const path = item.path;
    const pathStat = await tryLstat(path);
    if (!pathStat) {
      if (await lexists(item.temporary)) remaining.push(item);
      else changed = true;
      continue;
    }
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
      throw new Error(`Interrupted created directory is not a real directory: ${path}`);
    }
    const markerPath = join(path, DIRECTORY_MARKER);
    const markerStat = await tryLstat(markerPath);
    if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
      throw new Error(`Interrupted created directory ownership is not provable: ${path}`);
    }
    const metadata = await readJson(markerPath);
    if (metadata.transactionId !== journal.transactionId || metadata.path !== path) {
      throw new Error(`Interrupted created directory owner mismatch: ${path}`);
    }
    if (!journal.createdDirectories.some(created => created.path === path)) {
      journal.createdDirectories.push({ path, identity: identityFromStat(pathStat), markerPath });
    }
    changed = true;
  }
  journal.creatingDirectories = remaining;
  if (changed || creating.length) await persistJournal(journal);
}

async function recoverCompatibilityOwnership(journal: MigrationJournal): Promise<void> {
  for (const operation of journal.operations) {
    if (operation.fileCompatibilityTarget && !operation.fileCompatibilityCreated) {
      const pathStat = await tryLstat(operation.source);
      if (pathStat?.isSymbolicLink()) {
        const target = resolve(dirname(operation.source), await readlink(operation.source));
        if (target !== operation.fileCompatibilityTarget) {
          throw new Error(`Interrupted compatibility link points elsewhere: ${operation.source} -> ${target}`);
        }
        operation.fileCompatibilityCreated = true;
        operation.fileCompatibilityIdentity = identityFromStat(pathStat);
        await persistJournal(journal);
      }
    }

    if (!operation.skillShim || !(await lexists(operation.source)) || !(await lexists(operation.target))) continue;
    const sourceStat = await tryLstat(operation.source);
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Interrupted skill compatibility path is not a real directory: ${operation.source}`);
    }
    const markerPath = join(operation.source, COMPAT_MARKER);
    operation.skillShim.markerPath = markerPath;
    operation.skillShimIdentity ??= identityFromStat(sourceStat);
    const markerStat = await tryLstat(markerPath);
    if (!markerStat && operation.skillShim.removalState === 'removing-marker') {
      if ((await readdir(operation.source)).length > 0) {
        throw new Error(`Interrupted skill compatibility shim contains unknown files: ${operation.source}`);
      }
      await persistJournal(journal);
      continue;
    }
    const metadata = await readJson(markerPath);
    if (metadata.transactionId !== journal.transactionId
      || metadata.operationId !== operation.operationId
      || metadata.target !== operation.target) {
      throw new Error(`Interrupted skill compatibility shim owner mismatch: ${operation.source}`);
    }
    const linked = Array.isArray(metadata.linked)
      ? metadata.linked.filter((value): value is string => typeof value === 'string')
      : [];
    for (const name of linked) {
      if (basename(name) !== name || name === '.' || name === '..') {
        throw new Error(`Unsafe compatibility link recorded in ${operation.source}: ${name}`);
      }
      const path = join(operation.source, name);
      const pathStat = await tryLstat(path);
      if (!pathStat?.isSymbolicLink()) continue;
      const target = resolve(dirname(path), await readlink(path));
      if (target !== join(operation.target, name)) {
        throw new Error(`Interrupted compatibility link points elsewhere: ${path} -> ${target}`);
      }
      operation.compatibilityIdentities[path] ??= identityFromStat(pathStat);
    }
    await persistJournal(journal);
  }
}

async function recoverAgentRegistrationOwnership(journal: MigrationJournal): Promise<void> {
  let changed = false;
  for (const link of journal.registration?.agentLinks ?? []) {
    if (!link.created || link.identity || !(await lexists(link.path))) continue;
    const pathStat = await tryLstat(link.path);
    if (!pathStat?.isSymbolicLink()) {
      throw new Error(`Interrupted agent registration path is not a symlink: ${link.path}`);
    }
    const target = resolve(dirname(link.path), await readlink(link.path));
    if (target !== link.target) {
      throw new Error(`Interrupted agent registration link points elsewhere: ${link.path} -> ${target}`);
    }
    link.identity = identityFromStat(pathStat);
    changed = true;
  }
  if (changed) await persistJournal(journal);
}

async function ensureStableAgentName(
  path: string,
  journal: MigrationJournal,
  operation: JournalOperation,
): Promise<void> {
  const text = await readFile(path, 'utf8');
  const current = agentNameFromText(path, text);
  if (current === operation.expectedAgentName) {
    // A filename-derived name is also returned by agentNameFromText. Check
    // the actual metadata so a missing name can be recorded as a mutation.
    const meta = frontmatter(text);
    if (typeof meta.name === 'string' && meta.name.trim()) return;
  }

  const backupPath = join(journal.journalPath, '..', `${journal.transactionId}.${operation.operationId}.original`);
  operation.generatedAgentBackupPath = resolve(backupPath);
  await persistJournal(journal);
  crashAfter('agent-backup-intent-persisted');
  const backupHandle = await open(
    backupPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await backupHandle.writeFile(text, { encoding: 'utf8' });
    await backupHandle.sync();
  } finally {
    await backupHandle.close();
  }
  const pathStat = await lstat(path);
  operation.generatedAgentOriginalFingerprint = fingerprintBuffer(`file\0${pathStat.mode & 0o7777}\0`, Buffer.from(text, 'utf8'));
  operation.generatedAgentOriginalContentFingerprint = fingerprintBuffer('agent-original\0', Buffer.from(text, 'utf8'));
  await persistJournal(journal);

  const stableName = operation.expectedAgentName ?? basename(path, '.md');
  const updated = addStableAgentName(text, stableName, parseFrontmatter(text).hasFrontmatter);
  operation.generatedAgentRewrittenFingerprint = fingerprintBuffer(`file\0${pathStat.mode & 0o7777}\0`, Buffer.from(updated, 'utf8'));
  await persistJournal(journal);
  operation.stagedIdentity = await replaceAgentFileAtomically(path, updated, journal, operation, 'agent-stable-name-partial-write');
  if (operation.stageOwnershipPath) {
    operation.generatedAgentPublishState = 'proof-unlinked';
    await persistJournal(journal);
    await unlink(operation.stageOwnershipPath);
    crashAfter('agent-stable-name-proof-unlinked');
    await link(path, operation.stageOwnershipPath);
    crashAfter('agent-stable-name-proof-relinked');
    operation.generatedAgentPublishState = 'proof-relinked';
  }
  operation.generatedAgentPublishState = 'complete';
  await persistJournal(journal);
  crashAfter('agent-stable-name-written');
}

async function subtreeContainsSkill(path: string): Promise<boolean> {
  return await lexists(join(path, 'SKILL.md'));
}

async function writeSkillShimMarker(
  operation: JournalOperation,
  journal: MigrationJournal,
  state: 'creating' | 'complete',
): Promise<void> {
  const shim = operation.skillShim!;
  shim.state = state;
  await writeFile(
    shim.markerPath,
    `${JSON.stringify({
      transactionId: journal.transactionId,
      operationId: operation.operationId,
      target: operation.target,
      linked: shim.linked.map(path => basename(path)),
      skipped: shim.skipped,
      state,
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function createSkillCompatibilityShim(
  operation: JournalOperation,
  journal: MigrationJournal,
): Promise<void> {
  if (await lexists(operation.source)) throw new Error(`Compatibility source path was recreated externally: ${operation.source}`);
  operation.skillShim ??= {
    markerPath: join(operation.source, COMPAT_MARKER),
    linked: [],
    skipped: [],
  };
  operation.skillShimStagePath ??= join(journal.stagingRoot, `${operation.operationId}-compat`);
  await persistJournal(journal);
  if (await lexists(operation.skillShimStagePath)) throw new Error(`Compatibility staging path already exists: ${operation.skillShimStagePath}`);
  await mkdir(operation.skillShimStagePath, { mode: 0o700 });
  operation.skillShim.markerPath = join(operation.skillShimStagePath, COMPAT_MARKER);
  await writeSkillShimMarker(operation, journal, 'creating');
  if (await lexists(operation.source)) throw new Error(`Compatibility source path was recreated externally: ${operation.source}`);
  await rename(operation.skillShimStagePath, operation.source);
  crashAfter('skill-shim-published');
  operation.skillShim.markerPath = join(operation.source, COMPAT_MARKER);
  operation.skillShimIdentity = await pathIdentity(operation.source);
  if (!operation.skillShimIdentity) throw new Error(`Compatibility directory disappeared after creation: ${operation.source}`);
  await persistJournal(journal);

  for (const entry of await readdir(operation.target, { withFileTypes: true })) {
    if (entry.name === 'SKILL.md' || entry.name === '.git') continue;
    const targetChild = join(operation.target, entry.name);
    if (entry.isDirectory() && await subtreeContainsSkill(targetChild)) {
      operation.skillShim.skipped.push(entry.name);
      await writeSkillShimMarker(operation, journal, 'creating');
      await persistJournal(journal);
      continue;
    }

    const sourceChild = join(operation.source, entry.name);
    if (await lexists(sourceChild)) throw new Error(`Compatibility path already exists: ${sourceChild}`);
    operation.skillShim.linked.push(sourceChild);
    operation.compatibilityPaths.push(sourceChild);
    await writeSkillShimMarker(operation, journal, 'creating');
    await persistJournal(journal);
    await symlink(targetChild, sourceChild);
    crashAfter('skill-compatibility-symlink-created');
    const identity = await pathIdentity(sourceChild);
    if (!identity) throw new Error(`Compatibility link disappeared after creation: ${sourceChild}`);
    operation.compatibilityIdentities[sourceChild] = identity;
    await writeSkillShimMarker(operation, journal, 'creating');
    await persistJournal(journal);
  }

  await writeSkillShimMarker(operation, journal, 'complete');
  await persistJournal(journal);
}

async function createFileCompatibilityShim(
  operation: JournalOperation,
  journal: MigrationJournal,
): Promise<void> {
  operation.fileCompatibilityTarget = operation.target;
  if (!operation.compatibilityPaths.includes(operation.source)) operation.compatibilityPaths.push(operation.source);
  await persistJournal(journal);
  if (await lexists(operation.source)) throw new Error(`Compatibility source path was recreated externally: ${operation.source}`);
  await symlink(operation.target, operation.source);
  crashAfter('file-compatibility-symlink-created');
  operation.fileCompatibilityCreated = true;
  const identity = await pathIdentity(operation.source);
  if (!identity) throw new Error(`Compatibility link disappeared after creation: ${operation.source}`);
  operation.fileCompatibilityIdentity = identity;
  await persistJournal(journal);
}

async function prepareOperations(journal: MigrationJournal): Promise<void> {
  journal.phase = 'preparing';
  journal.status = 'in-progress';
  await persistJournal(journal);
  await writeStagingMarker(journal);

  for (const operation of journal.operations) {
    await assertCurrentFingerprint(operation.source, operation.sourceFingerprint, 'Migration source');
    if (!sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) {
      throw new Error(`Migration source identity changed: ${operation.source}`);
    }
    if (await lexists(operation.stagePath)) throw new Error(`Transaction staging path already exists: ${operation.stagePath}`);
    if (await lexists(operation.target)) throw new Error(`Migration target already exists: ${operation.target}`);

    operation.stagedFingerprint = operation.sourceFingerprint;
    operation.stagedIdentity = operation.sourceIdentity;
    const sourceStat = await lstat(operation.source);
    if (sourceStat.isFile()) operation.stageOwnershipPath = join(journal.stagingRoot, `${operation.operationId}.ownership`);
    await persistJournal(journal);
    if (operation.stageOwnershipPath) {
      if (await lexists(operation.stageOwnershipPath)) {
        throw new Error(`Transaction staging ownership path already exists: ${operation.stageOwnershipPath}`);
      }
      await link(operation.source, operation.stageOwnershipPath);
    }
    await rename(operation.source, operation.stagePath);
    crashAfter(`source-staged-${operation.operationId}`);
    operation.state = 'staged';
    if (!sameIdentity(await pathIdentity(operation.stagePath), operation.stagedIdentity)) {
      throw new Error(`Staged migration content identity changed: ${operation.stagePath}`);
    }
    operation.stagedFingerprint = await fingerprintPath(operation.stagePath);
    await persistJournal(journal);

    if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
      await ensureStableAgentName(operation.stagePath, journal, operation);
    }

    if (operation.kind === 'skill') {
      const skills = await collectSkillIdsInTree(operation.stagePath, operation.expectedSkillId);
      const ids = skills.map(skill => skill.id);
      if (ids.length !== operation.expectedSkillIds?.length || ids.some((id, index) => id !== operation.expectedSkillIds?.[index])) {
        throw new Error(`Skill IDs changed while preparing ${operation.source}`);
      }
    } else if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
      const meta = await readFrontmatter(operation.stagePath);
      const name = stableAgentName(operation.stagePath, meta);
      if (name !== operation.expectedAgentName) throw new Error(`Agent name changed while preparing ${operation.source}: ${name}`);
    }

    operation.stagedFingerprint = await fingerprintPath(operation.stagePath);
    operation.state = 'prepared';
    await persistJournal(journal);
  }
}

async function moveOperation(operation: JournalOperation, journal: MigrationJournal): Promise<void> {
  if (operation.state !== 'prepared') throw new Error(`Operation ${operation.operationId} is not prepared`);
  await assertCurrentFingerprint(operation.stagePath, operation.stagedFingerprint!, 'Staged migration content');
  if (await lexists(operation.target)) throw new Error(`Migration target already exists: ${operation.target}`);

  await ensureDirectoryPath(dirname(operation.target), journal);
  const expectedTargetFingerprint = operation.stagedFingerprint!;
  const expectedTargetIdentity = operation.stagedIdentity ?? operation.sourceIdentity;
  if (!expectedTargetIdentity) throw new Error(`Operation has no source identity: ${operation.operationId}`);
  operation.targetFingerprint = expectedTargetFingerprint;
  operation.targetIdentity = expectedTargetIdentity;
  await persistJournal(journal);
  if (journal.status !== 'moved-uncommitted') {
    journal.status = 'moved-uncommitted';
    await persistJournal(journal);
  }
  await rename(operation.stagePath, operation.target);
  await assertCurrentFingerprint(operation.target, expectedTargetFingerprint, 'Committed migration target');
  const actualTargetIdentity = await pathIdentity(operation.target);
  if (!sameIdentity(actualTargetIdentity, expectedTargetIdentity)) {
    throw new Error(`Committed migration target identity changed: ${operation.target}`);
  }
  operation.state = 'moved';
  await persistJournal(journal);

  if (operation.kind === 'skill') {
    await createSkillCompatibilityShim(operation, journal);
  } else if (!(operation.kind === 'agent' && operation.target.endsWith('.md'))) {
    await createFileCompatibilityShim(operation, journal);
  }

  operation.state = 'complete';
  await persistJournal(journal);
}

async function inspectMigratedInventories(journal: MigrationJournal): Promise<RepoInventory[]> {
  const inventories: RepoInventory[] = [];
  for (const repoId of journal.repositories) {
    const inventory = await inspectRepo(join(journal.targetRoot, repoId));
    const operations = journal.operations.filter(operation => operation.repoId === repoId);
    for (const operation of operations) {
      if (!operation.targetFingerprint || (await fingerprintPath(operation.target)) !== operation.targetFingerprint) {
        throw new Error(`Migrated target changed before registration: ${operation.target}`);
      }
      if (!sameIdentity(await pathIdentity(operation.target), operation.targetIdentity)) {
        throw new Error(`Migrated target identity changed before registration: ${operation.target}`);
      }
      if (operation.kind === 'skill') {
        const issues = await verifySkillShim(operation, journal);
        if (issues.length) throw new Error(issues.join('\n'));
      } else if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
        if (await lexists(operation.source)) throw new Error(`Migrated Markdown agent source was recreated: ${operation.source}`);
      } else {
        const issues = await verifyFileCompatibility(operation);
        if (issues.length) throw new Error(issues.join('\n'));
      }
      for (const id of operation.expectedSkillIds ?? (operation.expectedSkillId ? [operation.expectedSkillId] : [])) {
        if (!inventory.skillIds.includes(id)) {
          throw new Error(`Migrated skill is missing from inspected repository ${repoId}: ${id}`);
        }
      }
      if (operation.expectedAgentName && !inventory.agentNames.includes(operation.expectedAgentName)) {
        throw new Error(`Migrated agent is missing from inspected repository ${repoId}: ${operation.expectedAgentName}`);
      }
    }
    inventories.push(inventory);
  }
  return inventories;
}

function snapshotFromJournal(journal: MigrationJournal): OpenCodeConfigSnapshot {
  return {
    path: journal.config.path,
    existed: journal.config.existed,
    text: journal.config.originalText ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    fingerprint: journal.config.originalFingerprint,
    mode: journal.config.mode,
    identity: journal.config.originalIdentity,
  };
}

async function assertConfigSnapshotCurrent(snapshot: OpenCodeConfigSnapshot): Promise<void> {
  const current = await readOpenCodeConfigSnapshot(snapshot.path);
  if (
    current.fingerprint !== snapshot.fingerprint
    || (!sameIdentity(current.identity, snapshot.identity) && Boolean(current.identity || snapshot.identity))
    || current.mode !== snapshot.mode
  ) {
    throw new Error(`OpenCode config changed during migration: ${snapshot.path}`);
  }
}

async function assertConfigPostWriteState(journal: MigrationJournal): Promise<void> {
  const snapshot = snapshotFromJournal(journal);
  const current = await readOpenCodeConfigSnapshot(snapshot.path);
  if (journal.config.changed) {
    if (!journal.config.newFingerprint || current.fingerprint !== journal.config.newFingerprint
      || !sameIdentity(current.identity, journal.config.newIdentity)
      || current.mode !== journal.config.newMode) {
      throw new Error(`OpenCode config changed after transaction write: ${snapshot.path}`);
    }
    return;
  }
  await assertConfigSnapshotCurrent(snapshot);
}

async function createAgentRegistrationLinks(journal: MigrationJournal): Promise<void> {
  if (!journal.registration) throw new Error('Transaction registration plan is missing');
  for (const link of journal.registration.agentLinks) {
    await ensureDirectoryPath(dirname(link.path), journal);
    const pathStat = await tryLstat(link.path);
    if (!pathStat) {
      link.created = true;
      await persistJournal(journal);
      await symlink(link.target, link.path, 'dir');
      crashAfter('agent-registration-symlink-created');
      link.identity = await pathIdentity(link.path);
      if (!link.identity) throw new Error(`Agent registration link disappeared after creation: ${link.path}`);
      await persistJournal(journal);
    } else if (pathStat.isSymbolicLink()) {
      const target = resolve(dirname(link.path), await readlink(link.path));
      if (target !== link.target) throw new Error(`Agent symlink collision: ${link.path} -> ${target}`);
      link.created = false;
      link.identity = identityFromStat(pathStat);
    } else {
      throw new Error(`Agent registration path exists and is not a symlink: ${link.path}`);
    }
    await persistJournal(journal);
  }
}

async function assertAgentRegistrationLinksCurrent(journal: MigrationJournal): Promise<void> {
  for (const link of journal.registration?.agentLinks ?? []) {
    const pathStat = await tryLstat(link.path);
    if (!pathStat?.isSymbolicLink()) throw new Error(`Agent registration link changed during migration: ${link.path}`);
    const target = resolve(dirname(link.path), await readlink(link.path));
    if (target !== link.target) throw new Error(`Agent registration link points elsewhere: ${link.path} -> ${target}`);
    if (link.created && !sameIdentity(link.identity, identityFromStat(pathStat))) {
      throw new Error(`Agent registration link identity changed during migration: ${link.path}`);
    }
  }
}

async function assertMigratedLayoutCurrent(journal: MigrationJournal): Promise<void> {
  for (const operation of journal.operations) {
    if (!operation.targetFingerprint || (await fingerprintPath(operation.target)) !== operation.targetFingerprint
      || !sameIdentity(await pathIdentity(operation.target), operation.targetIdentity)) {
      throw new Error(`Migrated target changed before commit: ${operation.target}`);
    }
    if (operation.kind === 'skill') {
      const issues = await verifySkillShim(operation, journal);
      if (issues.length) throw new Error(issues.join('\n'));
    } else if (!(operation.kind === 'agent' && operation.target.endsWith('.md'))) {
      const issues = await verifyFileCompatibility(operation);
      if (issues.length) throw new Error(issues.join('\n'));
    }
  }
}

async function registerTransaction(
  journal: MigrationJournal,
  preflightResult: PreflightResult,
  verifyRuntime: boolean,
): Promise<void> {
  journal.phase = 'registering';
  await persistJournal(journal);
  const snapshot = snapshotFromJournal(journal);
  await assertConfigSnapshotCurrent(snapshot);

  const inventories = await inspectMigratedInventories(journal);
  if (verifyRuntime) {
    for (const inventory of inventories) await assertNoRuntimeCollisions(inventory);
  }
  const registration = await prepareRegistration(inventories, snapshot);
  const prospective = prospectiveOpenCodeConfig(snapshot, registration.skillSources);
  if (
    prospective.text !== preflightResult.prospectiveConfig.text
    || prospective.text !== journal.prospectiveConfigText
  ) {
    throw new Error('Prospective OpenCode config changed between preflight and registration');
  }

  journal.registration = {
    skillSources: registration.skillSources,
    addedSkillSources: registration.addedSkillSources,
    agentLinks: registration.agentLinks.map(link => ({ ...link, created: false })),
    inventories,
    prospectiveConfigText: prospective.text,
    prospectiveConfigFingerprint: fingerprintText(prospective.text),
  };
  await persistJournal(journal);

  await createAgentRegistrationLinks(journal);
  await assertAgentRegistrationLinksCurrent(journal);
  await assertConfigSnapshotCurrent(snapshot);

  journal.config.changed = registration.addedSkillSources.length > 0;
  if (journal.config.changed) journal.config.newFingerprint = journal.registration.prospectiveConfigFingerprint;
  await persistJournal(journal);

  if (journal.config.changed) {
    await ensureDirectoryPath(dirname(snapshot.path), journal);
    const actualFingerprint = await writeOpenCodeConfigAtomically(snapshot, prospective.text);
    if (actualFingerprint !== journal.config.newFingerprint) {
      throw new Error(`OpenCode config fingerprint mismatch after atomic write: ${snapshot.path}`);
    }
    const currentConfig = await readOpenCodeConfigSnapshot(snapshot.path);
    if (currentConfig.fingerprint !== journal.config.newFingerprint || !currentConfig.identity) {
      throw new Error(`OpenCode config changed immediately after atomic write: ${snapshot.path}`);
    }
    journal.config.newIdentity = currentConfig.identity;
    journal.config.newMode = currentConfig.mode;
  }
  await assertAgentRegistrationLinksCurrent(journal);
  await persistJournal(journal);
  crashAfter('config-written');
}

async function verifySkillShim(operation: JournalOperation, journal: MigrationJournal): Promise<string[]> {
  const issues: string[] = [];
  const sourceStat = await tryLstat(operation.source);
  if (!sourceStat) return [`Missing skill compatibility shim: ${operation.source}`];
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return [`Skill compatibility path is not a directory: ${operation.source}`];
  if (!sameIdentity(operation.skillShimIdentity, identityFromStat(sourceStat))) {
    return [`Skill compatibility directory was recreated: ${operation.source}`];
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = await readJson(join(operation.source, COMPAT_MARKER));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (metadata.transactionId !== journal.transactionId || metadata.operationId !== operation.operationId || metadata.target !== operation.target) {
    issues.push(`Skill compatibility shim owner mismatch: ${operation.source}`);
  }
  if (await lexists(join(operation.source, 'SKILL.md'))) issues.push(`Skill compatibility shim contains SKILL.md: ${operation.source}`);

  const linked = Array.isArray(metadata.linked) ? metadata.linked.filter((value): value is string => typeof value === 'string') : [];
  for (const name of linked) {
    if (basename(name) !== name || name === '.' || name === '..') {
      issues.push(`Unsafe compatibility link recorded in ${operation.source}: ${name}`);
      continue;
    }
    const path = join(operation.source, name);
    const pathStat = await tryLstat(path);
    if (!pathStat?.isSymbolicLink()) {
      if (metadata.state !== 'creating') issues.push(`Missing compatibility link: ${path}`);
      continue;
    }
    if (!sameIdentity(operation.compatibilityIdentities[path], identityFromStat(pathStat))) {
      issues.push(`Compatibility link identity changed: ${path}`);
      continue;
    }
    const target = resolve(dirname(path), await readlink(path));
    if (target !== join(operation.target, name)) issues.push(`Compatibility link points elsewhere: ${path} -> ${target}`);
  }
  const expectedEntries = new Set([COMPAT_MARKER, ...linked]);
  const unknown = (await readdir(operation.source)).filter(name => !expectedEntries.has(name));
  if (unknown.length) issues.push(`Unknown files remain in skill compatibility shim ${operation.source}: ${unknown.join(', ')}`);
  return issues;
}

async function removeSkillShim(operation: JournalOperation, journal: MigrationJournal): Promise<string[]> {
  const shim = operation.skillShim;
  if (!shim) return [];
  if (!(await lexists(operation.source))) return [];
  const issues: string[] = [];
  const sourceStat = await tryLstat(operation.source);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) return [`Refusing to remove unknown skill compatibility path: ${operation.source}`];
  if (!(await lexists(operation.target))
    && await fingerprintPath(operation.source) === operation.sourceFingerprint
    && sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) return [];
  if (!sameIdentity(operation.skillShimIdentity, identityFromStat(sourceStat))) {
    return [`Refusing to remove externally recreated skill compatibility path: ${operation.source}`];
  }

  const markerPath = join(operation.source, COMPAT_MARKER);
  if (!(await lexists(markerPath))) {
    if (shim.removalState !== 'removing-marker') {
      return [`Refusing to remove skill compatibility shim without its owner marker: ${operation.source}`];
    }
    if ((await readdir(operation.source)).length > 0) {
      return [`Unknown files remain in skill compatibility shim ${operation.source}`];
    }
    await rm(operation.source, { recursive: true, force: true });
    shim.removalState = 'removed';
    await persistJournal(journal);
    return [];
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = await readJson(markerPath);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (metadata.transactionId !== journal.transactionId || metadata.operationId !== operation.operationId || metadata.target !== operation.target) {
    return [`Skill compatibility shim owner mismatch: ${operation.source}`];
  }

  const linked = Array.isArray(metadata.linked) ? metadata.linked.filter((value): value is string => typeof value === 'string') : [];
  for (const name of linked) {
    if (basename(name) !== name || name === '.' || name === '..') {
      issues.push(`Unsafe compatibility link recorded in ${operation.source}: ${name}`);
      continue;
    }
    const path = join(operation.source, name);
    if (!(await lexists(path))) continue;
    const pathStat = await tryLstat(path);
    if (!pathStat?.isSymbolicLink()) {
      issues.push(`Refusing to remove non-symlink compatibility path: ${path}`);
      continue;
    }
    if (!sameIdentity(operation.compatibilityIdentities[path], identityFromStat(pathStat))) {
      issues.push(`Refusing to remove externally recreated compatibility link: ${path}`);
      continue;
    }
    const target = resolve(dirname(path), await readlink(path));
    if (target !== join(operation.target, name)) {
      issues.push(`Refusing to remove externally changed compatibility link: ${path} -> ${target}`);
      continue;
    }
    await unlink(path);
    crashAfter('rollback-compatibility-link-removed');
  }

  const remaining = await readdir(operation.source);
  const unknown = remaining.filter(name => name !== COMPAT_MARKER);
  if (unknown.length) {
    issues.push(`Unknown files remain in skill compatibility shim ${operation.source}: ${unknown.join(', ')}`);
    return issues;
  }
  shim.removalState = 'removing-marker';
  await persistJournal(journal);
  await unlink(markerPath).catch(error => {
    issues.push(`Cannot remove compatibility marker ${operation.source}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!issues.length) {
    crashAfter('rollback-skill-shim-marker-removed');
    await rm(operation.source, { recursive: true }).catch(error => {
      issues.push(`Cannot remove compatibility directory ${operation.source}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!issues.length) {
      shim.removalState = 'removed';
      await persistJournal(journal);
    }
  }
  return issues;
}

async function removeFileCompatibility(operation: JournalOperation): Promise<string[]> {
  if (!operation.fileCompatibilityCreated) return [];
  const issues: string[] = [];
  const sourceStat = await tryLstat(operation.source);
  if (sourceStat && !sourceStat.isSymbolicLink()
    && await fingerprintPath(operation.source) === operation.sourceFingerprint
    && sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) return [];
  for (const path of operation.compatibilityPaths) {
    if (!(await lexists(path))) continue;
    const pathStat = await tryLstat(path);
    if (!pathStat?.isSymbolicLink()) {
      issues.push(`Refusing to remove non-symlink compatibility path: ${path}`);
      continue;
    }
    if (!sameIdentity(operation.fileCompatibilityIdentity, identityFromStat(pathStat))) {
      issues.push(`Refusing to remove externally recreated compatibility link: ${path}`);
      continue;
    }
    const target = resolve(dirname(path), await readlink(path));
    if (target !== operation.fileCompatibilityTarget) {
      issues.push(`Refusing to remove externally changed compatibility link: ${path} -> ${target}`);
      continue;
    }
    await unlink(path);
    crashAfter('rollback-compatibility-link-removed');
  }
  return issues;
}

async function removeAgentRegistrationLinks(journal: MigrationJournal): Promise<string[]> {
  const issues: string[] = [];
  for (const link of journal.registration?.agentLinks ?? []) {
    if (!link.created || !(await lexists(link.path))) continue;
    const pathStat = await tryLstat(link.path);
    if (!pathStat?.isSymbolicLink()) {
      issues.push(`Refusing to remove non-symlink agent registration path: ${link.path}`);
      continue;
    }
    if (!sameIdentity(link.identity, identityFromStat(pathStat))) {
      issues.push(`Refusing to remove externally recreated agent registration path: ${link.path}`);
      continue;
    }
    const target = resolve(dirname(link.path), await readlink(link.path));
    if (target !== link.target) {
      issues.push(`Refusing to remove externally changed agent registration link: ${link.path} -> ${target}`);
      continue;
    }
    await unlink(link.path);
    crashAfter('rollback-agent-link-removed');
  }
  return issues;
}

async function restoreMovedOperation(operation: JournalOperation, journal: MigrationJournal): Promise<string[]> {
  const issues: string[] = [];
  issues.push(...await clearGeneratedAgentTemporary(operation, journal));
  if (issues.length) return issues;
  const sourceIdentity = await pathIdentity(operation.source);
  const sourceIsOriginal = await fingerprintPath(operation.source) === operation.sourceFingerprint
    && (sameIdentity(sourceIdentity, operation.sourceIdentity)
      || sameIdentity(sourceIdentity, operation.generatedAgentRestoredIdentity));
  const stageIsOriginal = await stagedContentIsOriginal(operation);
  let generatedAgentOriginal: string | undefined;
  if (operation.generatedAgentBackupPath && !sourceIsOriginal && !stageIsOriginal) {
    const backupStat = await tryLstat(operation.generatedAgentBackupPath);
    if (!backupStat?.isFile() || backupStat.isSymbolicLink()) {
      return [`Generated agent backup is not a regular file: ${operation.generatedAgentBackupPath}`];
    }
    if (!operation.generatedAgentOriginalContentFingerprint) {
      return [`Generated agent backup ownership proof is missing: ${operation.generatedAgentBackupPath}`];
    }
    try {
      generatedAgentOriginal = await readFile(operation.generatedAgentBackupPath, 'utf8');
    } catch (error) {
      return [`Cannot read generated agent backup ${operation.generatedAgentBackupPath}: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (fingerprintBuffer('agent-original\0', Buffer.from(generatedAgentOriginal, 'utf8'))
      !== operation.generatedAgentOriginalContentFingerprint) {
      return [`Generated agent backup was modified outside transaction: ${operation.generatedAgentBackupPath}`];
    }
  }
  const targetExists = await lexists(operation.target);
  if (targetExists) {
    if (!operation.targetFingerprint) return [`Transaction operation has no target fingerprint: ${operation.operationId}`];
    const targetFingerprint = await fingerprintPath(operation.target);
    if (targetFingerprint !== operation.targetFingerprint) {
      return [`Target was modified outside transaction; refusing rollback: ${operation.target}`];
    }
    const targetIdentity = await pathIdentity(operation.target);
    if (!sameIdentity(targetIdentity, operation.targetIdentity)) {
      return [`Target was recreated outside transaction; refusing rollback: ${operation.target}`];
    }
  }

  if (operation.kind === 'skill' && operation.skillShim) issues.push(...await removeSkillShim(operation, journal));
  else if (!(operation.kind === 'agent' && operation.target.endsWith('.md'))) issues.push(...await removeFileCompatibility(operation));
  if (issues.length) return issues;

  const stageExists = await lexists(operation.stagePath);
  if (targetExists) {
    const sourceExists = await lexists(operation.source);
    if (sourceExists) {
      const sourceFingerprint = await fingerprintPath(operation.source);
      if (sourceFingerprint !== operation.sourceFingerprint
        || !sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) {
        return [`Source path is occupied during rollback: ${operation.source}`];
      }
      await rm(operation.target, { recursive: true, force: true });
    } else {
      await rename(operation.target, operation.source);
      crashAfter('rollback-target-restored');
    }
  } else if (stageExists) {
    if (!(await stagedContentIsOwned(operation))) return [`Staging content was modified outside transaction: ${operation.stagePath}`];
    if (operation.stagedIdentity && !sameIdentity(await pathIdentity(operation.stagePath), operation.stagedIdentity)) {
      return [`Staging content was recreated outside transaction: ${operation.stagePath}`];
    }
    if (operation.stageOwnershipPath) {
      if (!sameIdentity(await pathIdentity(operation.stageOwnershipPath), operation.stagedIdentity)
        || !sameIdentity(await pathIdentity(operation.stagePath), await pathIdentity(operation.stageOwnershipPath))) {
        return [`Staging content ownership proof changed outside transaction: ${operation.stagePath}`];
      }
    }
    if (await lexists(operation.source)) {
      const sourceFingerprint = await fingerprintPath(operation.source);
      if (sourceFingerprint !== operation.sourceFingerprint
        || !sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) {
        return [`Source path is occupied during rollback: ${operation.source}`];
      }
      await rm(operation.stagePath, { recursive: true, force: true });
    } else {
      await rename(operation.stagePath, operation.source);
      crashAfter('rollback-target-restored');
    }
  } else if (!(await lexists(operation.source))) {
    return [`Cannot restore migration source: ${operation.source}`];
  }

  if (operation.generatedAgentBackupPath) {
    const current = await fingerprintPath(operation.source);
    if (current === operation.sourceFingerprint) {
      const identity = await pathIdentity(operation.source);
      if (!sameIdentity(identity, operation.sourceIdentity)) {
        if (operation.generatedAgentRestoreState !== 'pending' && operation.generatedAgentRestoreState !== 'restored') {
          return [`Restored agent source identity is not recognized: ${operation.source}`];
        }
        operation.generatedAgentRestoredIdentity = identity;
        operation.generatedAgentRestoreState = 'restored';
        await persistJournal(journal);
      }
      return issues;
    }
    if (current !== operation.targetFingerprint
      && current !== operation.stagedFingerprint
      && current !== operation.generatedAgentRewrittenFingerprint) {
      return [`Agent source changed during rollback: ${operation.source}`];
    }
    if (generatedAgentOriginal === undefined) {
      return [`Generated agent backup was not validated before source restore: ${operation.generatedAgentBackupPath}`];
    }
    operation.generatedAgentRestoreState = 'pending';
    await persistJournal(journal);
    operation.generatedAgentRestoredIdentity = await replaceAgentFileAtomically(
      operation.source,
      generatedAgentOriginal,
      journal,
      operation,
      'rollback-agent-restore-partial-write',
    );
    operation.generatedAgentRestoreState = 'restored';
    await persistJournal(journal);
  }

  await assertCurrentFingerprint(operation.source, operation.sourceFingerprint, 'Restored migration source');
  if (!sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)
    && !sameIdentity(await pathIdentity(operation.source), operation.generatedAgentRestoredIdentity)) {
    throw new Error(`Restored migration source identity does not match: ${operation.source}`);
  }
  return issues;
}

async function cleanCreatedDirectories(journal: MigrationJournal): Promise<string[]> {
  const issues: string[] = [];
  for (const created of [...journal.createdDirectories].reverse()) {
    const path = created.path;
    if (!(await lexists(path))) continue;
    const pathStat = await tryLstat(path);
    if (!pathStat?.isDirectory() || pathStat.isSymbolicLink()) {
      issues.push(`Created directory was replaced externally: ${path}`);
      continue;
    }
    if (!sameIdentity(identityFromStat(pathStat), created.identity)) {
      issues.push(`Created directory was recreated externally: ${path}`);
      continue;
    }
    if (created.markerPath && await lexists(created.markerPath)) {
      const markerStat = await tryLstat(created.markerPath);
      if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
        issues.push(`Created directory ownership marker was replaced externally: ${created.markerPath}`);
        continue;
      }
      const metadata = await readJson(created.markerPath);
      if (metadata.path !== path || metadata.transactionId !== journal.transactionId) {
        issues.push(`Created directory ownership marker mismatch: ${created.markerPath}`);
        continue;
      }
      await unlink(created.markerPath);
    }
    const entries = await readdir(path);
    if (entries.length) {
      issues.push(`Created directory is not empty during rollback: ${path}`);
      continue;
    }
    await rm(path, { recursive: true });
  }
  return issues;
}

async function cleanCreatingDirectoryTemporaries(journal: MigrationJournal): Promise<string[]> {
  const issues: string[] = [];
  for (const item of journal.creatingDirectories ?? []) {
    if (!(await lexists(item.temporary))) continue;
    const temporaryStat = await tryLstat(item.temporary);
    if (!temporaryStat?.isDirectory() || temporaryStat.isSymbolicLink()) {
      issues.push(`Migration directory temporary path is not a real directory: ${item.temporary}`);
      continue;
    }
    const markerPath = join(item.temporary, DIRECTORY_MARKER);
    if (await lexists(markerPath)) {
      const markerStat = await tryLstat(markerPath);
      if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
        issues.push(`Migration directory temporary marker is not a regular file: ${markerPath}`);
        continue;
      }
      const metadata = await readJson(markerPath);
      if (metadata.transactionId !== journal.transactionId || metadata.path !== item.path) {
        issues.push(`Migration directory temporary owner mismatch: ${item.temporary}`);
        continue;
      }
    } else if ((await readdir(item.temporary)).length > 0) {
      issues.push(`Unknown files remain in migration directory temporary path: ${item.temporary}`);
      continue;
    }
    await rm(item.temporary, { recursive: true, force: true });
  }
  return issues;
}

async function cleanStaging(journal: MigrationJournal): Promise<string[]> {
  const issues: string[] = [];
  try {
    const parent = stagingParent(journal.sourceRoot);
    const parentStat = await tryLstat(parent);
    if (parentStat?.isSymbolicLink() || (parentStat && !parentStat.isDirectory())) {
      return [`Migration staging parent is not a real directory: ${parent}`];
    }

    if (await lexists(journal.stagingRoot)) {
      await assertStagingOwner(journal);
      const entries = await readdir(journal.stagingRoot);
      const ownedEntries = new Set([
        STAGING_MARKER,
        ...journal.operations.flatMap(operation => [
          operation.stagePath,
          operation.stageOwnershipPath ?? '',
          operation.skillShimStagePath ?? '',
          operation.generatedAgentTemporaryPath ?? '',
        ])
          .filter(path => path && dirname(path) === journal.stagingRoot)
          .map(path => basename(path)),
      ]);
      const unknown = entries.filter(name => !ownedEntries.has(name));
      if (unknown.length) return [`Unknown files remain in transaction staging: ${unknown.join(', ')}`];
      for (const operation of journal.operations) {
        const temporaryIssues = await clearGeneratedAgentTemporary(operation, journal);
        if (temporaryIssues.length) return temporaryIssues;
        const stageExists = await lexists(operation.stagePath);
        const ownershipExists = operation.stageOwnershipPath ? await lexists(operation.stageOwnershipPath) : false;
        if (stageExists) {
          if (operation.stageOwnershipPath && !ownershipExists) {
            return [`Staging ownership proof is missing: ${operation.stageOwnershipPath}`];
          }
          if (!(await stagedContentIsOwned(operation))) {
            return [`Staging content was modified outside transaction: ${operation.stagePath}`];
          }
          if (operation.stagedIdentity && !sameIdentity(await pathIdentity(operation.stagePath), operation.stagedIdentity)) {
            return [`Staging content was recreated outside transaction: ${operation.stagePath}`];
          }
        }
        if (operation.stageOwnershipPath && ownershipExists) {
          const ownershipIdentity = await pathIdentity(operation.stageOwnershipPath);
          if (!sameIdentity(ownershipIdentity, operation.stagedIdentity)) {
            return [`Staging ownership proof was replaced outside transaction: ${operation.stageOwnershipPath}`];
          }
          if (stageExists && !sameIdentity(await pathIdentity(operation.stagePath), ownershipIdentity)) {
            return [`Staging content ownership proof changed outside transaction: ${operation.stagePath}`];
          }
        }
      }
      for (const operation of journal.operations) {
        if (!operation.skillShimStagePath || !(await lexists(operation.skillShimStagePath))) continue;
        const marker = join(operation.skillShimStagePath, COMPAT_MARKER);
        if (await lexists(marker)) {
          const metadata = await readJson(marker);
          if (metadata.transactionId !== journal.transactionId
            || metadata.operationId !== operation.operationId
            || metadata.target !== operation.target) {
            return [`Skill compatibility staging owner mismatch: ${operation.skillShimStagePath}`];
          }
        } else if ((await readdir(operation.skillShimStagePath)).length > 0) {
          return [`Unknown files remain in skill compatibility staging: ${operation.skillShimStagePath}`];
        }
      }
      await rm(journal.stagingRoot, { recursive: true, force: true });
    }

    const temporary = stagingTemporaryPath(journal);
    if (await lexists(temporary)) {
      const temporaryStat = await tryLstat(temporary);
      if (!temporaryStat?.isDirectory() || temporaryStat.isSymbolicLink()) {
        return [`Migration staging temporary path is not a real directory: ${temporary}`];
      }
      const marker = join(temporary, STAGING_MARKER);
      if (await lexists(marker)) {
        const markerStat = await tryLstat(marker);
        if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
          return [`Migration staging owner marker is not a regular file: ${marker}`];
        }
        const metadata = await readJson(marker);
        if (metadata.transactionId !== journal.transactionId || metadata.stagingRoot !== journal.stagingRoot) {
          return [`Staging temporary path owner mismatch: ${temporary}`];
        }
      } else if ((await readdir(temporary)).length > 0) {
        return [`Unknown files remain in staging temporary path: ${temporary}`];
      }
      await rm(temporary, { recursive: true, force: true });
    }

    const refreshedParent = await tryLstat(parent);
    if (refreshedParent?.isDirectory() && !refreshedParent.isSymbolicLink() && (await readdir(parent)).length === 0) {
      await rm(parent, { recursive: true });
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

async function rollbackConfig(journal: MigrationJournal): Promise<string[]> {
  const snapshot = snapshotFromJournal(journal);
  let current: OpenCodeConfigSnapshot;
  try {
    current = await readOpenCodeConfigSnapshot(snapshot.path);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  if (journal.config.rollbackState === 'restored') {
    if (current.fingerprint === snapshot.fingerprint && current.mode === snapshot.mode) return [];
    return [`OpenCode config changed after rollback: ${snapshot.path}`];
  }

  if (current.fingerprint === snapshot.fingerprint) {
    if (current.mode === snapshot.mode) {
      journal.config.rollbackState = 'restored';
      await persistJournal(journal);
      return [];
    }
    return [`OpenCode config was replaced outside transaction; refusing rollback: ${snapshot.path}`];
  }
  if (!journal.config.changed || !journal.config.newFingerprint) {
    return [`OpenCode config changed outside transaction; refusing rollback: ${snapshot.path}`];
  }
  if (current.fingerprint !== journal.config.newFingerprint) {
    return [`OpenCode config was changed outside transaction; refusing rollback: ${snapshot.path}`];
  }

  if (journal.config.newIdentity && !sameIdentity(current.identity, journal.config.newIdentity)) {
    return [`OpenCode config was replaced outside transaction; refusing to rollback: ${snapshot.path}`];
  }
  if (journal.config.newMode !== undefined && current.mode !== journal.config.newMode) {
    return [`OpenCode config mode changed outside transaction; refusing to rollback: ${snapshot.path}`];
  }

  try {
    journal.config.rollbackState = 'restoring';
    await persistJournal(journal);
    await restoreOpenCodeConfig(snapshot, journal.config.newFingerprint, current.identity);
    crashAfter('rollback-config-restored');
    journal.config.rollbackState = 'restored';
    await persistJournal(journal);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

async function cleanConfigDirectory(journal: MigrationJournal): Promise<string[]> {
  if (journal.configDirectoryExisted || !(await lexists(dirname(journal.config.path)))) return [];
  const path = dirname(journal.config.path);
  const created = journal.createdDirectories.find(item => item.path === path);
  if (!created) return [`Config directory appeared outside transaction: ${path}`];
  const pathStat = await tryLstat(path);
  if (!pathStat?.isDirectory() || pathStat.isSymbolicLink()) return [`Config directory was replaced externally: ${path}`];
  if (!sameIdentity(identityFromStat(pathStat), created.identity)) return [`Config directory was recreated externally: ${path}`];
  if ((await readdir(path)).length) return [`Created config directory is not empty during rollback: ${path}`];
  await rm(path, { recursive: true });
  return [];
}

async function rollbackTransaction(journal: MigrationJournal): Promise<{ complete: boolean; issues: string[] }> {
  if (journal.status === 'rollback-complete') return { complete: true, issues: [] };
  const issues: string[] = [];
  journal.phase = 'rollback';
  journal.status = 'rollback-in-progress';
  await persistJournal(journal);
  crashAfter('rollback-started');

  try {
    await recoverCreatingDirectories(journal);
    await recoverCompatibilityOwnership(journal);
    await recoverAgentRegistrationOwnership(journal);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  issues.push(...await rollbackConfig(journal));
  issues.push(...await removeAgentRegistrationLinks(journal));
  for (const operation of [...journal.operations].reverse()) {
    try {
      issues.push(...await restoreMovedOperation(operation, journal));
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  issues.push(...await cleanStaging(journal));
  issues.push(...await cleanCreatingDirectoryTemporaries(journal));
  issues.push(...await cleanCreatedDirectories(journal));
  issues.push(...await cleanConfigDirectory(journal));

  if (!issues.length) {
    for (const operation of journal.operations) {
      if (!operation.generatedAgentBackupPath) continue;
      await unlink(operation.generatedAgentBackupPath).catch(() => undefined);
      crashAfter('rollback-agent-backup-removed');
      operation.generatedAgentBackupPath = undefined;
      await persistJournal(journal);
    }
  }

  if (!issues.length) {
    try {
      await releaseLock(journal.sourceRoot, journal.transactionId);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  journal.phase = 'rolled-back';
  journal.status = issues.length ? 'rollback-incomplete' : 'rollback-complete';
  await persistJournal(journal);
  return { complete: issues.length === 0, issues };
}

async function verifyFileCompatibility(operation: JournalOperation): Promise<string[]> {
  const issues: string[] = [];
  for (const path of operation.compatibilityPaths) {
    const pathStat = await tryLstat(path);
    if (!pathStat?.isSymbolicLink()) {
      issues.push(`Missing compatibility link: ${path}`);
      continue;
    }
    if (!sameIdentity(operation.fileCompatibilityIdentity, identityFromStat(pathStat))) {
      issues.push(`Compatibility link identity changed: ${path}`);
      continue;
    }
    const target = resolve(dirname(path), await readlink(path));
    if (target !== operation.fileCompatibilityTarget) issues.push(`Compatibility link points elsewhere: ${path} -> ${target}`);
  }
  return issues;
}

async function validateCommittedState(journal: MigrationJournal): Promise<void> {
  if (journal.status !== 'committed') throw new Error(`Transaction ${journal.transactionId} is not committed: ${journal.status}`);
  const snapshot = snapshotFromJournal(journal);
  const config = await readOpenCodeConfigSnapshot(snapshot.path);
  const expectedConfig = journal.config.changed ? journal.config.newFingerprint : snapshot.fingerprint;
  if (!expectedConfig || config.fingerprint !== expectedConfig) {
    throw new Error(`Committed transaction config fingerprint does not match: ${snapshot.path}`);
  }
  if (journal.config.changed && !sameIdentity(config.identity, journal.config.newIdentity)) {
    throw new Error(`Committed transaction config identity does not match: ${snapshot.path}`);
  }
  if (journal.config.changed && config.mode !== journal.config.newMode) {
    throw new Error(`Committed transaction config mode does not match: ${snapshot.path}`);
  }
  if (!journal.config.changed && !sameIdentity(config.identity, snapshot.identity) && (config.identity || snapshot.identity)) {
    throw new Error(`Committed transaction config identity does not match: ${snapshot.path}`);
  }
  if (!journal.registration) throw new Error(`Committed transaction has no registration record: ${journal.transactionId}`);

  for (const operation of journal.operations) {
    if (operation.state !== 'complete' || !operation.targetFingerprint) {
      throw new Error(`Committed transaction operation is incomplete: ${operation.operationId}`);
    }
    if ((await fingerprintPath(operation.target)) !== operation.targetFingerprint) {
      throw new Error(`Committed transaction target was modified: ${operation.target}`);
    }
    if (!sameIdentity(await pathIdentity(operation.target), operation.targetIdentity)) {
      throw new Error(`Committed transaction target identity was modified: ${operation.target}`);
    }
    if (operation.kind === 'skill') {
      if (!operation.skillShim) throw new Error(`Committed skill compatibility record is missing: ${operation.operationId}`);
      const issues = await verifySkillShim(operation, journal);
      if (issues.length) throw new Error(issues.join('\n'));
    } else if (operation.kind === 'agent' && operation.target.endsWith('.md')) {
      if (await lexists(operation.source)) throw new Error(`Committed Markdown agent source still exists: ${operation.source}`);
    } else {
      if (!operation.fileCompatibilityCreated || operation.fileCompatibilityTarget !== operation.target) {
        throw new Error(`Committed file compatibility record is missing: ${operation.operationId}`);
      }
      const issues = await verifyFileCompatibility(operation);
      if (issues.length) throw new Error(issues.join('\n'));
    }
  }

  for (const link of journal.registration.agentLinks) {
    const pathStat = await tryLstat(link.path);
    if (!pathStat?.isSymbolicLink()) throw new Error(`Committed agent registration link is missing: ${link.path}`);
    if (!sameIdentity(link.identity, identityFromStat(pathStat))) throw new Error(`Committed agent registration link identity changed: ${link.path}`);
    const target = resolve(dirname(link.path), await readlink(link.path));
    if (target !== link.target) throw new Error(`Committed agent registration link points elsewhere: ${link.path} -> ${target}`);
  }
  if (await lexists(journal.stagingRoot)) throw new Error(`Committed transaction still has staging content: ${journal.stagingRoot}`);
}

async function validateInterruptedState(journal: MigrationJournal): Promise<void> {
  await recoverCreatingDirectories(journal);
  await recoverCompatibilityOwnership(journal);
  await recoverAgentRegistrationOwnership(journal);
  await recoverGeneratedAgentPublish(journal);
  const snapshot = snapshotFromJournal(journal);
  const config = await readOpenCodeConfigSnapshot(snapshot.path);
  const allowedConfig = new Set([snapshot.fingerprint]);
  if (journal.config.newFingerprint) allowedConfig.add(journal.config.newFingerprint);
  if (!allowedConfig.has(config.fingerprint)) {
    throw new Error(`Interrupted transaction config fingerprint is not recognized: ${snapshot.path}`);
  }
  if (config.fingerprint === snapshot.fingerprint && (config.identity || snapshot.identity) && !sameIdentity(config.identity, snapshot.identity)) {
    throw new Error(`Interrupted transaction config identity is not recognized: ${snapshot.path}`);
  }
  if (config.fingerprint === snapshot.fingerprint && config.mode !== snapshot.mode) {
    throw new Error(`Interrupted transaction config mode is not recognized: ${snapshot.path}`);
  }
  if (journal.config.newFingerprint && config.fingerprint === journal.config.newFingerprint && journal.config.newIdentity
    && !sameIdentity(config.identity, journal.config.newIdentity)) {
    throw new Error(`Interrupted transaction config identity is not recognized: ${snapshot.path}`);
  }
  if (journal.config.newFingerprint && config.fingerprint === journal.config.newFingerprint && journal.config.newMode !== undefined
    && config.mode !== journal.config.newMode) {
    throw new Error(`Interrupted transaction config mode is not recognized: ${snapshot.path}`);
  }

  if (await lexists(journal.stagingRoot)) await assertStagingOwner(journal);
  for (const operation of journal.operations) {
    const targetExists = await lexists(operation.target);
    const stageExists = await lexists(operation.stagePath);
    if (targetExists && stageExists) throw new Error(`Interrupted transaction has both target and staging content: ${operation.operationId}`);
    if (targetExists) {
      if (!operation.targetFingerprint || !operation.targetIdentity) throw new Error(`Interrupted operation lacks target ownership proof: ${operation.operationId}`);
      if ((await fingerprintPath(operation.target)) !== operation.targetFingerprint || !sameIdentity(await pathIdentity(operation.target), operation.targetIdentity)) {
        throw new Error(`Interrupted transaction target was modified: ${operation.target}`);
      }
    }
    if (stageExists) {
      if (!operation.stagedFingerprint) throw new Error(`Interrupted operation lacks staging fingerprint: ${operation.operationId}`);
      if (!(await stagedContentIsOwned(operation))) {
        throw new Error(`Interrupted transaction staging was modified: ${operation.stagePath}`);
      }
    }
    const sourceExists = await lexists(operation.source);
    if (sourceExists && !operation.skillShim && !operation.fileCompatibilityCreated) {
      if ((await fingerprintPath(operation.source)) !== operation.sourceFingerprint
        || !sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) {
        throw new Error(`Interrupted transaction source was modified: ${operation.source}`);
      }
    }

    if (operation.kind === 'skill' && operation.skillShim && await lexists(operation.source)) {
      const issues = await verifySkillShim(operation, journal);
      if (issues.length) throw new Error(issues.join('\n'));
    }
    if (operation.fileCompatibilityCreated) {
      const issues = await verifyFileCompatibility(operation);
      if (issues.length) throw new Error(issues.join('\n'));
    }
  }

  for (const link of journal.registration?.agentLinks ?? []) {
    if (!(await lexists(link.path))) {
      continue;
    }
    const pathStat = await tryLstat(link.path);
    if (!pathStat?.isSymbolicLink()) throw new Error(`Interrupted transaction agent link is not a symlink: ${link.path}`);
    if (link.identity && !sameIdentity(link.identity, identityFromStat(pathStat))) {
      throw new Error(`Interrupted transaction agent link was recreated: ${link.path}`);
    }
    const target = resolve(dirname(link.path), await readlink(link.path));
    if (target !== link.target) throw new Error(`Interrupted transaction agent link points elsewhere: ${link.path} -> ${target}`);
  }
}

function operationMatches(left: MoveOperation, right: MoveOperation): boolean {
  return left.kind === right.kind
    && left.repoId === right.repoId
    && left.source === right.source
    && left.target === right.target
    && left.relativeSource === right.relativeSource;
}

function journalMatchesPlan(
  journal: MigrationJournal,
  planPath: string,
  planFingerprint: string,
  sourceRoot: string,
  targetRoot: string,
  operations: MoveOperation[],
): boolean {
  if (
    journal.schemaVersion !== 1
    || journal.planPath !== planPath
    || journal.planFingerprint !== planFingerprint
    || journal.sourceRoot !== sourceRoot
    || journal.targetRoot !== targetRoot
    || journal.operations.length !== operations.length
  ) return false;
  return operations.every(operation => journal.operations.some(candidate => operationMatches(candidate, operation)));
}

function journalNeedsRecovery(journal: MigrationJournal): boolean {
  return journal.status === 'in-progress'
    || journal.status === 'moved-uncommitted'
    || journal.status === 'rollback-in-progress'
    || journal.status === 'rollback-incomplete';
}

async function loadJournals(sourceRoot: string): Promise<MigrationJournal[]> {
  const directory = journalDirectory(sourceRoot);
  if (!(await lexists(directory))) return [];
  const directoryStat = await tryLstat(directory);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`Migration journal directory is not a real directory: ${directory}`);

  const journals: MigrationJournal[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Migration journal entry is a symlink: ${join(directory, entry.name)}`);
    if (!entry.isFile()) throw new Error(`Migration journal entry is not a file: ${join(directory, entry.name)}`);
    const path = join(directory, entry.name);
    const value = await readJson(path);
    if (value.schemaVersion !== 1 || typeof value.transactionId !== 'string' || !Array.isArray(value.operations)) {
      throw new Error(`Unsupported or invalid migration journal: ${path}`);
    }
    journals.push(value as unknown as MigrationJournal);
  }
  return journals;
}

async function matchingJournal(
  sourceRoot: string,
  planPath: string,
  planFingerprint: string,
  targetRoot: string,
  operations: MoveOperation[],
): Promise<MigrationJournal | undefined> {
  const journals = await loadJournals(sourceRoot);
  const related = journals.filter(journal => (
    journal.planPath === planPath && journal.sourceRoot === sourceRoot && journal.targetRoot === targetRoot
  ));
  const changedPlan = related
    .filter(journalNeedsRecovery)
    .find(journal => journal.planFingerprint !== planFingerprint);
  if (changedPlan) throw new Error(`Migration plan changed since transaction ${changedPlan.transactionId}; refusing to resume or overwrite it`);
  const matches = related
    .filter(journal => journal.status !== 'rollback-complete' && journal.status !== 'preflight-failed')
    .filter(journal => journalMatchesPlan(journal, planPath, planFingerprint, sourceRoot, targetRoot, operations));
  if (matches.length > 1) throw new Error(`Multiple migration journals match the same plan and roots; refusing to guess`);
  return matches[0];
}

function resultFromJournal(
  journal: MigrationJournal,
  options: MigrationApplyOptions,
  verification: VerifyResult[],
): MigrationApplyResult {
  return {
    dryRun: options.dryRun === true,
    sourceRoot: journal.sourceRoot,
    targetRoot: journal.targetRoot,
    repositories: journal.repositories,
    moves: journal.operations,
    resumedMoves: journal.operations.filter(operation => operation.state === 'moved' || operation.state === 'complete'),
    compatibilityPaths: journal.operations.flatMap(operation => operation.compatibilityPaths),
    verification,
    transactionId: journal.transactionId,
    journalPath: journal.journalPath,
    phase: journal.phase,
    status: journal.status,
    rollbackStatus: 'not-needed',
  };
}

async function cleanCommittedSecrets(journal: MigrationJournal): Promise<void> {
  for (const operation of journal.operations) {
    if (operation.generatedAgentBackupPath) {
      await unlink(operation.generatedAgentBackupPath).catch(() => undefined);
      operation.generatedAgentBackupPath = undefined;
    }
  }
  // A committed transaction no longer needs the original config or agent
  // contents for rollback.
  journal.config.originalText = undefined;
  journal.prospectiveConfigText = '';
  if (journal.registration) journal.registration.prospectiveConfigText = '';
  await persistJournal(journal);
}

async function createJournal(
  transactionId: string,
  planPath: string,
  planFingerprint: string,
  sourceRoot: string,
  targetRoot: string,
  preflightResult: PreflightResult,
  configSnapshot: OpenCodeConfigSnapshot,
): Promise<MigrationJournal> {
  const directory = journalDirectory(sourceRoot);
  const directoryStat = await tryLstat(directory);
  if (directoryStat?.isSymbolicLink() || (directoryStat && !directoryStat.isDirectory())) {
    throw new Error(`Migration journal directory is not a real directory: ${directory}`);
  }
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);

  const journalPath = join(directory, `${transactionId}.json`);
  const stagingRoot = join(sourceRoot, STAGING_DIRECTORY, transactionId);
  const operations: JournalOperation[] = preflightResult.operations.map((operation, index) => ({
    ...operation,
    operationId: `op-${String(index + 1).padStart(4, '0')}`,
    stagePath: makeStagePath(stagingRoot, `op-${String(index + 1).padStart(4, '0')}`),
    state: 'pending',
    sourceFingerprint: operation.sourceFingerprint!,
    sourceIdentity: operation.sourceIdentity!,
    targetPrecondition: 'absent',
    compatibilityPaths: [],
    compatibilityIdentities: {},
  }));
  const configDirectoryExisted = await lexists(dirname(configSnapshot.path));
  const journal: MigrationJournal = {
    schemaVersion: 1,
    transactionId,
    planPath,
    planFingerprint,
    sourceRoot,
    targetRoot,
    journalPath,
    lockPath: lockPath(sourceRoot),
    stagingRoot,
    stagingMarkerPath: join(stagingRoot, STAGING_MARKER),
    phase: 'preflight',
    status: 'in-progress',
    createdAt: now(),
    updatedAt: now(),
    repositories: preflightResult.repositories,
    operations,
    createdDirectories: [],
    creatingDirectories: [],
    prospectiveConfigText: preflightResult.prospectiveConfig.text,
    prospectiveConfigFingerprint: fingerprintText(preflightResult.prospectiveConfig.text),
    configDirectoryExisted,
    config: {
      path: configSnapshot.path,
      existed: configSnapshot.existed,
      originalText: configSnapshot.existed ? configSnapshot.text : undefined,
      originalFingerprint: configSnapshot.fingerprint,
      originalIdentity: configSnapshot.identity,
      mode: configSnapshot.mode,
      changed: false,
      rollbackState: 'pending',
    },
  };
  await persistJournal(journal);
  return journal;
}

async function assertFreshState(
  operations: MoveOperation[],
  configSnapshot: OpenCodeConfigSnapshot,
): Promise<void> {
  for (const operation of operations) {
    await assertCurrentFingerprint(operation.source, operation.sourceFingerprint!, 'Migration source');
    if (!sameIdentity(await pathIdentity(operation.source), operation.sourceIdentity)) {
      throw new Error(`Migration source identity changed before transaction start: ${operation.source}`);
    }
    if (await lexists(operation.target)) throw new Error(`Migration target changed before transaction start: ${operation.target}`);
  }
  await assertConfigSnapshotCurrent(configSnapshot);
}

async function executeTransaction(
  journal: MigrationJournal,
  preflightResult: PreflightResult,
  options: MigrationApplyOptions,
): Promise<MigrationApplyResult> {
  await prepareOperations(journal);

  journal.phase = 'committing';
  await persistJournal(journal);
  for (const operation of journal.operations) await moveOperation(operation, journal);

  await registerTransaction(journal, preflightResult, options.verify !== false);

  let verification: VerifyResult[] = [];
  if (options.verify !== false) {
    journal.phase = 'verifying';
    await persistJournal(journal);
    if (!journal.registration) throw new Error('Transaction registration plan is missing during verification');
    verification = await verifyMigrationDiscovery(journal.registration.inventories, {
      skillSources: journal.registration.skillSources,
      agentLinks: journal.registration.agentLinks,
    });
    const failures = verification.filter(result => !result.ok);
    if (failures.length) {
      throw new Error(`OpenCode discovery verification failed:\n${failures.map(result => `${result.command}: ${result.stderr.trim() || 'verification failed'}`).join('\n')}`);
    }
  }
  await assertConfigPostWriteState(journal);
  await assertAgentRegistrationLinksCurrent(journal);
  await assertMigratedLayoutCurrent(journal);

  const stagingIssues = await cleanStaging(journal);
  if (stagingIssues.length) throw new Error(stagingIssues.join('\n'));

  journal.phase = 'committed';
  journal.status = 'committed';
  await persistJournal(journal);
  await cleanCommittedSecrets(journal);
  await releaseLock(journal.sourceRoot, journal.transactionId);

  return {
    dryRun: false,
    sourceRoot: journal.sourceRoot,
    targetRoot: journal.targetRoot,
    repositories: journal.repositories,
    moves: journal.operations,
    resumedMoves: [],
    compatibilityPaths: journal.operations.flatMap(operation => operation.compatibilityPaths),
    verification,
    transactionId: journal.transactionId,
    journalPath: journal.journalPath,
    phase: journal.phase,
    status: journal.status,
    rollbackStatus: 'not-needed',
  };
}

function ensureJournalIdentity(
  journal: MigrationJournal,
  planPath: string,
  planFingerprint: string,
  sourceRoot: string,
  targetRoot: string,
  operations: MoveOperation[],
): void {
  if (!journalMatchesPlan(journal, planPath, planFingerprint, sourceRoot, targetRoot, operations)) {
    throw new Error(`Migration transaction journal does not match the current plan: ${journal.transactionId}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(journal.transactionId)) {
    throw new Error(`Migration transaction ID is not recognized: ${journal.transactionId}`);
  }
  if (journal.journalPath !== join(journalDirectory(sourceRoot), `${journal.transactionId}.json`)) {
    throw new Error(`Migration journal path is not owned by its transaction: ${journal.transactionId}`);
  }
  if (journal.lockPath !== lockPath(sourceRoot)) throw new Error(`Migration lock path is not owned by its transaction: ${journal.transactionId}`);
  const expectedStaging = join(sourceRoot, STAGING_DIRECTORY, journal.transactionId);
  if (journal.stagingRoot !== expectedStaging || journal.stagingMarkerPath !== join(expectedStaging, STAGING_MARKER)) {
    throw new Error(`Migration staging path is not owned by its transaction: ${journal.transactionId}`);
  }
  if (journal.config.path !== resolve(opencodeConfigFile())) {
    throw new Error(`Migration journal config path is not owned by its transaction: ${journal.transactionId}`);
  }

  for (let index = 0; index < journal.operations.length; index += 1) {
    const operation = journal.operations[index]!;
    const expected = operations[index];
    if (!expected || !operationMatches(operation, expected) || operation.stagePath !== makeStagePath(expectedStaging, operation.operationId)) {
      throw new Error(`Migration journal operation mapping is not owned by its transaction: ${operation.operationId}`);
    }
    if (operation.targetPrecondition !== 'absent') {
      throw new Error(`Migration journal target precondition is not recognized: ${operation.operationId}`);
    }
    if (!isPathWithin(sourceRoot, operation.source) || !isPathWithin(targetRoot, operation.target) || !isPathWithin(expectedStaging, operation.stagePath)) {
      throw new Error(`Migration journal contains an unsafe operation path: ${operation.operationId}`);
    }
    if (operation.kind === 'skill' && operation.skillShim) {
      const expectedMarker = join(operation.source, COMPAT_MARKER);
      const stagedMarker = operation.skillShimStagePath
        ? join(operation.skillShimStagePath, COMPAT_MARKER)
        : undefined;
      if (operation.skillShim.markerPath !== expectedMarker && operation.skillShim.markerPath !== stagedMarker) {
        throw new Error(`Migration journal contains an unsafe compatibility marker: ${operation.operationId}`);
      }
      if (operation.skillShimStagePath && !isPathWithin(expectedStaging, operation.skillShimStagePath)) {
        throw new Error(`Migration journal contains an unsafe compatibility staging path: ${operation.operationId}`);
      }
    }
    if (operation.generatedAgentBackupPath && !isPathWithin(journalDirectory(sourceRoot), operation.generatedAgentBackupPath)) {
      throw new Error(`Migration journal contains an unsafe agent backup path: ${operation.operationId}`);
    }
    if (operation.generatedAgentTemporaryPath && !isPathWithin(sourceRoot, operation.generatedAgentTemporaryPath)) {
      throw new Error(`Migration journal contains an unsafe agent temporary path: ${operation.operationId}`);
    }
    if (operation.stageOwnershipPath
      && operation.stageOwnershipPath !== join(expectedStaging, `${operation.operationId}.ownership`)) {
      throw new Error(`Migration journal contains an unsafe staging ownership path: ${operation.operationId}`);
    }
    if (operation.compatibilityPaths.some(path => !isPathWithin(sourceRoot, path))) {
      throw new Error(`Migration journal contains an unsafe compatibility path: ${operation.operationId}`);
    }
  }
  const configDirectory = dirname(journal.config.path);
  const registrationDirectory = opencodeConfigDir();
  const createdDirectories = [
    ...journal.createdDirectories.map(created => created.path),
    ...(journal.creatingDirectories ?? []).map(created => created.path),
  ];
  if (createdDirectories.some(path => (
    !isPathWithin(targetRoot, path)
    && !isPathWithin(configDirectory, path)
    && !isPathWithin(registrationDirectory, path)
  ))) {
    throw new Error(`Migration journal contains an unsafe created directory: ${journal.transactionId}`);
  }
  if (journal.registration) {
    for (const link of journal.registration.agentLinks) {
      if (!isPathWithin(opencodeConfigDir(), link.path)) {
        throw new Error(`Migration journal contains an unsafe agent link: ${link.path}`);
      }
      if (!isPathWithin(targetRoot, link.target)) {
        throw new Error(`Migration journal contains an unsafe agent link target: ${link.target}`);
      }
      const inventory = journal.registration.inventories.find(item => item.agentsDir === link.target);
      if (!inventory || agentRegistrationPath(inventory.repo) !== link.path) {
        throw new Error(`Migration journal contains an unexpected agent link: ${link.path}`);
      }
    }
  }
}

async function resumeOrRecover(
  journal: MigrationJournal,
  options: MigrationApplyOptions,
): Promise<MigrationApplyResult> {
  if (journal.status === 'committed') {
    const owner = await lockOwner(journal.sourceRoot);
    if (owner && owner !== journal.transactionId) throw new Error(`Migration source root is locked by transaction ${owner}`);
    await validateCommittedState(journal);
    let verification: VerifyResult[] = [];
    if (options.verify !== false) {
      if (!journal.registration) throw new Error(`Committed transaction has no registration record: ${journal.transactionId}`);
      verification = await verifyMigrationDiscovery(journal.registration.inventories, {
        skillSources: journal.registration.skillSources,
        agentLinks: journal.registration.agentLinks,
      });
      const failures = verification.filter(result => !result.ok);
      if (failures.length) throw new Error(`OpenCode discovery verification failed:\n${failures.map(result => `${result.command}: ${result.stderr.trim() || 'verification failed'}`).join('\n')}`);
    }
    await cleanCommittedSecrets(journal);
    if (owner === journal.transactionId) await releaseLock(journal.sourceRoot, journal.transactionId);
    return resultFromJournal(journal, options, verification);
  }

  if (journal.status === 'rollback-incomplete') {
    throw new Error(`Migration transaction ${journal.transactionId} is rollback-incomplete; refusing to guess or delete unknown paths`);
  }
  if (journal.status === 'rollback-complete' || journal.status === 'preflight-failed') {
    throw new Error(`Migration transaction ${journal.transactionId} is already ${journal.status} and cannot be resumed`);
  }
  if (journal.status === 'rollback-in-progress') {
    const owner = await lockOwner(journal.sourceRoot);
    if (owner && owner !== journal.transactionId) throw new Error(`Migration source root is locked by transaction ${owner}`);
    if (!owner) await acquireLock(journal.sourceRoot, journal.transactionId);
    const rollback = await rollbackTransaction(journal);
    const status = rollback.complete ? 'rollback-complete' : 'rollback-incomplete';
    throw new Error(
      `Migration transaction ${journal.transactionId} (journal ${journal.journalPath}) resumed rollback: ${status}`
      + (rollback.issues.length ? `\n${rollback.issues.join('\n')}` : ''),
    );
  }
  await validateInterruptedState(journal);
  if (options.dryRun) return resultFromJournal(journal, options, []);

  const owner = await lockOwner(journal.sourceRoot);
  if (owner && owner !== journal.transactionId) throw new Error(`Migration source root is locked by transaction ${owner}`);
  if (!owner) await acquireLock(journal.sourceRoot, journal.transactionId);
  const rollback = await rollbackTransaction(journal);
  const status = rollback.complete ? 'rollback-complete' : 'rollback-incomplete';
  throw new Error(
    `Migration transaction ${journal.transactionId} (journal ${journal.journalPath}) was interrupted and was not resumed: ${status}`
    + (rollback.issues.length ? `\n${rollback.issues.join('\n')}` : '')
    + '\nRun migration apply again after reviewing the transaction journal.',
  );
}

export async function applyMigration(options: MigrationApplyOptions): Promise<MigrationApplyResult> {
  const planPath = resolve(expandHome(options.planPath));
  const targetRoot = resolve(expandHome(options.targetRoot));
  const planText = await readFile(planPath, 'utf8');
  const planFingerprint = fingerprintText(planText);
  const plan = parsePlan(planText);
  const sourceRoot = resolve(expandHome(plan.generatedFrom.sourceRoot));
  if (sourceRoot === targetRoot) throw new Error('Migration source root and target root must be different');

  const operationsInput = buildOperations(plan, sourceRoot, targetRoot);
  if (!operationsInput.length) throw new Error('Migration plan has no CREATE_AND_MOVE operations');
  const configSnapshot = await readOpenCodeConfigSnapshot();
  const repositories = [...new Set(operationsInput.map(operation => operation.repoId))];
  const existingJournal = await matchingJournal(sourceRoot, planPath, planFingerprint, targetRoot, operationsInput);

  if (existingJournal) {
    ensureJournalIdentity(existingJournal, planPath, planFingerprint, sourceRoot, targetRoot, operationsInput);
    if (existingJournal.status === 'committed' || options.resume) return await resumeOrRecover(existingJournal, options);
    if (existingJournal.status === 'rollback-incomplete') {
      throw new Error(`Migration transaction ${existingJournal.transactionId} is rollback-incomplete; refusing to start another transaction`);
    }
    if (existingJournal.status !== 'rollback-complete' && existingJournal.status !== 'preflight-failed') {
      throw new Error(`Migration transaction ${existingJournal.transactionId} is already in progress; use --resume to recover it`);
    }
  }

  if (options.resume) {
    throw new Error(`No transaction journal matches this plan and roots; --resume refuses to guess filesystem state`);
  }

  const preflightResult = await preflight(operationsInput, sourceRoot, targetRoot, configSnapshot);
  if (options.dryRun) {
    return {
      dryRun: true,
      sourceRoot,
      targetRoot,
      repositories,
      moves: preflightResult.operations,
      resumedMoves: [],
      compatibilityPaths: [],
      verification: [],
      phase: 'preflight',
      status: 'dry-run',
      rollbackStatus: 'not-needed',
    };
  }

  const currentPlanFingerprint = fingerprintText(await readFile(planPath, 'utf8'));
  if (currentPlanFingerprint !== planFingerprint) {
    throw new Error(`Migration plan changed during preflight: ${planPath}`);
  }
  const transactionId = randomUUID();
  const journal = await createJournal(transactionId, planPath, planFingerprint, sourceRoot, targetRoot, preflightResult, configSnapshot);
  crashAfter('journal-created');
  let lockAcquired = false;
  try {
    // Persist the transaction identity before taking the lock so a crash in
    // this boundary leaves a journal that --resume can safely inspect.
    await acquireLock(sourceRoot, transactionId);
    lockAcquired = true;
    await assertFreshState(preflightResult.operations, configSnapshot);
    return await executeTransaction(journal, preflightResult, options);
  } catch (error) {
    if (!lockAcquired) {
      journal.status = 'preflight-failed';
      await cleanCommittedSecrets(journal).catch(() => undefined);
      throw error;
    }
    if (journal.status === 'committed') {
      const committedError = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration transaction ${transactionId} committed, but lock cleanup failed: ${committedError}`);
    }
    const failedPhase = journal.phase;
    let rollback: { complete: boolean; issues: string[] };
    try {
      rollback = await rollbackTransaction(journal);
    } catch (rollbackError) {
      rollback = {
        complete: false,
        issues: [rollbackError instanceof Error ? rollbackError.message : String(rollbackError)],
      };
    }
    const original = error instanceof Error ? error.message : String(error);
    const status = rollback.complete ? 'rollback-complete' : 'rollback-incomplete';
    throw new Error(
      `Migration transaction ${transactionId} (journal ${journal.journalPath}) failed during ${failedPhase}: ${original}\n${status}`
      + (rollback.issues.length ? `\n${rollback.issues.join('\n')}` : ''),
    );
  }
}
