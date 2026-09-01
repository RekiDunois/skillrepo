import { access, chmod, lstat, mkdir, readFile, readdir, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { parseFrontmatter } from './frontmatter.js';

export type VerifyResult = { ok: boolean; command: string; stdout: string; stderr: string };
export type RepoInventory = {
  repo: string;
  skillsDir?: string;
  agentsDir?: string;
  skillIds: string[];
  agentNames: string[];
};

type RegistrationState = { skillsRegistered: boolean; agentsRegistered: boolean };

export type OpenCodeConfigSnapshot = {
  path: string;
  existed: boolean;
  text: string;
  fingerprint: string;
  mode?: number;
  identity?: { dev: number; ino: number };
};

export type RegistrationPlan = {
  configPath: string;
  skillSources: string[];
  addedSkillSources: string[];
  agentLinks: Array<{ path: string; target: string }>;
};

const ABSENT_FINGERPRINT = 'absent';
const EMPTY_CONFIG_TEXT = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

export function opencodeConfigDir(env = process.env): string {
  return resolve(env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode'));
}

export function opencodeConfigFile(env = process.env): string {
  if (env.OPENCODE_CONFIG) return resolve(env.OPENCODE_CONFIG);

  const configDir = opencodeConfigDir(env);
  const jsonc = join(configDir, 'opencode.jsonc');
  const json = join(configDir, 'opencode.json');
  const hasJsonc = existsSync(jsonc);
  const hasJson = existsSync(json);

  if (hasJsonc && hasJson) {
    throw new Error(`Both ${jsonc} and ${json} exist. Set OPENCODE_CONFIG explicitly to choose one.`);
  }
  if (hasJsonc) return jsonc;
  if (hasJson) return json;
  return jsonc;
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

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function fingerprintText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function fileFingerprint(path: string): Promise<string> {
  const pathStat = await tryLstat(path);
  if (!pathStat) return ABSENT_FINGERPRINT;
  if (pathStat.isSymbolicLink()) throw new Error(`Refusing to replace symlinked OpenCode config: ${path}`);
  if (!pathStat.isFile()) throw new Error(`OpenCode config path is not a file: ${path}`);
  return fingerprintText(await readFile(path, 'utf8'));
}

function fileIdentity(pathStat: Awaited<ReturnType<typeof lstat>>): { dev: number; ino: number } {
  return { dev: Number(pathStat.dev), ino: Number(pathStat.ino) };
}

async function readConfig(path: string): Promise<{ text: string; data: Record<string, unknown> }> {
  if (!(await exists(path))) {
    return { text: EMPTY_CONFIG_TEXT, data: {} };
  }
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  if (errors.length) throw new Error(`OpenCode config is not valid JSON/JSONC: ${path}`);
  return { text, data: data ?? {} };
}

export async function readOpenCodeConfigSnapshot(configInput?: string): Promise<OpenCodeConfigSnapshot> {
  const path = resolve(configInput ?? opencodeConfigFile());
  const pathStat = await tryLstat(path);
  if (pathStat?.isSymbolicLink()) throw new Error(`Refusing to use symlinked OpenCode config: ${path}`);
  if (pathStat && !pathStat.isFile()) throw new Error(`OpenCode config path is not a file: ${path}`);

  const { text } = await readConfig(path);
  // Parse here as well as in readConfig so a caller gets one immutable snapshot
  // and cannot accidentally pair data from one config version with another.
  return {
    path,
    existed: Boolean(pathStat),
    text,
    fingerprint: pathStat ? fingerprintText(text) : ABSENT_FINGERPRINT,
    mode: pathStat?.mode,
    identity: pathStat ? fileIdentity(pathStat) : undefined,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isSkillUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function configuredSkillPaths(data: Record<string, unknown>): string[] {
  const value = data.skills;
  if (Array.isArray(value)) return stringArray(value).filter(path => !isSkillUrl(path));
  if (value && typeof value === 'object') {
    return stringArray((value as Record<string, unknown>).paths);
  }
  return [];
}

function configuredSkillUrls(data: Record<string, unknown>): string[] {
  const value = data.skills;
  if (Array.isArray(value)) return stringArray(value).filter(isSkillUrl);
  if (value && typeof value === 'object') {
    return stringArray((value as Record<string, unknown>).urls);
  }
  return [];
}

async function updateSkills(configPath: string, updater: (skills: string[]) => string[]): Promise<void> {
  const snapshot = await readOpenCodeConfigSnapshot(configPath);
  const { data } = await readConfig(configPath);
  const current = configuredSkillPaths(data);
  const legacyArray = Array.isArray(data.skills);
  const currentUrls = configuredSkillUrls(data);
  const next = updater(current);

  if (!legacyArray && current.length === next.length && current.every((value, index) => value === next[index])) return;
  if (!snapshot.existed && next.length === 0) return;

  const baseText = snapshot.existed ? snapshot.text : EMPTY_CONFIG_TEXT;
  const edits = modify(baseText, legacyArray ? ['skills'] : ['skills', 'paths'], legacyArray ? { paths: next, urls: currentUrls } : next, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  await writeOpenCodeConfigAtomically(snapshot, applyEdits(baseText, edits));
}

function configTextWithSkills(snapshot: OpenCodeConfigSnapshot, skills: string[]): string {
  const baseText = snapshot.existed ? snapshot.text : EMPTY_CONFIG_TEXT;
  const errors: ParseError[] = [];
  const parsed = parse(baseText, errors, { allowTrailingComma: true });
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenCode config is not valid JSON/JSONC: ${snapshot.path}`);
  }

  const data = parsed as Record<string, unknown>;
  const legacyArray = Array.isArray(data.skills);
  const currentUrls = configuredSkillUrls(data);
  const edits = modify(baseText, legacyArray ? ['skills'] : ['skills', 'paths'], legacyArray ? { paths: skills, urls: currentUrls } : skills, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const nextText = applyEdits(baseText, edits);
  const nextErrors: ParseError[] = [];
  parse(nextText, nextErrors, { allowTrailingComma: true });
  if (nextErrors.length) throw new Error(`Generated OpenCode config is not valid JSON/JSONC: ${snapshot.path}`);
  return nextText;
}

export function prospectiveOpenCodeConfig(
  snapshot: OpenCodeConfigSnapshot,
  skillSources: string[],
): { text: string; skills: string[]; addedSkillSources: string[] } {
  const baseText = snapshot.existed ? snapshot.text : EMPTY_CONFIG_TEXT;
  const errors: ParseError[] = [];
  const data = parse(baseText, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`OpenCode config is not valid JSON/JSONC: ${snapshot.path}`);
  }

  const current = configuredSkillPaths(data);
  const next = [...current];
  const addedSkillSources: string[] = [];
  for (const source of skillSources) {
    const resolved = resolveConfigSource(source, snapshot.path);
    if (!resolved) throw new Error(`Cannot register glob skill source transactionally: ${source}`);
    if (next.some(existing => resolveConfigSource(existing, snapshot.path) === resolved)) continue;
    next.push(source);
    addedSkillSources.push(source);
  }

  return {
    text: configTextWithSkills(snapshot, next),
    skills: next,
    addedSkillSources,
  };
}

async function assertConfigFingerprint(
  path: string,
  expected: string,
  expectedIdentity?: { dev: number; ino: number },
): Promise<void> {
  const pathStat = await tryLstat(path);
  const actual = await fileFingerprint(path);
  if (
    actual !== expected
    || (expectedIdentity && (!pathStat || pathStat.isSymbolicLink() || fileIdentity(pathStat).dev !== expectedIdentity.dev || fileIdentity(pathStat).ino !== expectedIdentity.ino))
  ) {
    throw new Error(`OpenCode config changed during migration: ${path}`);
  }
}

async function atomicReplaceConfig(
  snapshot: OpenCodeConfigSnapshot,
  text: string,
  expectedCurrentFingerprint?: string,
  expectedCurrentIdentity?: { dev: number; ino: number },
): Promise<string> {
  const expected = expectedCurrentFingerprint ?? snapshot.fingerprint;
  const identity = expectedCurrentIdentity ?? snapshot.identity;
  await assertConfigFingerprint(snapshot.path, expected, identity);
  await mkdir(dirname(snapshot.path), { recursive: true });

  const temporary = join(dirname(snapshot.path), `.${basename(snapshot.path)}.skillrepo-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: snapshot.mode ?? 0o600 });
    if (snapshot.mode !== undefined) await chmod(temporary, snapshot.mode & 0o7777);
    await assertConfigFingerprint(snapshot.path, expected, identity);
    await rename(temporary, snapshot.path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return fingerprintText(text);
}

export async function writeOpenCodeConfigAtomically(
  snapshot: OpenCodeConfigSnapshot,
  text: string,
): Promise<string> {
  if (snapshot.existed && fingerprintText(snapshot.text) === fingerprintText(text)) return snapshot.fingerprint;
  return await atomicReplaceConfig(snapshot, text);
}

export async function restoreOpenCodeConfig(
  snapshot: OpenCodeConfigSnapshot,
  expectedCurrentFingerprint: string,
  expectedCurrentIdentity?: { dev: number; ino: number },
): Promise<void> {
  if (!snapshot.existed) {
    await assertConfigFingerprint(snapshot.path, expectedCurrentFingerprint, expectedCurrentIdentity);
    if (expectedCurrentFingerprint !== ABSENT_FINGERPRINT) await unlink(snapshot.path);
    return;
  }

  await atomicReplaceConfig(snapshot, snapshot.text, expectedCurrentFingerprint, expectedCurrentIdentity);
}

function repoId(repoPath: string): string {
  const id = basename(repoPath).trim();
  if (!id || id === '.' || id === '..') throw new Error(`Cannot derive repo id from ${repoPath}`);
  return id.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function agentRegistrationPath(repoInput: string): string {
  return join(opencodeConfigDir(), 'agents', repoId(resolve(repoInput)));
}

function frontmatter(text: string): Record<string, unknown> {
  return parseFrontmatter(text).data;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function collectSkillIds(skillsDir: string, strictDuplicates: boolean): Promise<string[]> {
  if (!(await exists(skillsDir))) return [];
  const ids: string[] = [];
  const seen = new Map<string, string>();

  for (const path of await walkFiles(skillsDir)) {
    if (basename(path) !== 'SKILL.md') continue;
    const meta = frontmatter(await readFile(path, 'utf8'));
    if (Object.prototype.hasOwnProperty.call(meta, 'name') && typeof meta.name !== 'string') {
      throw new Error(`${path}: skill frontmatter name must be a string`);
    }
    const id = typeof meta.name === 'string' && meta.name.trim()
      ? meta.name.trim()
      : basename(dirname(path));
    const previous = seen.get(id);
    if (previous && strictDuplicates) {
      throw new Error(`Duplicate skill ID '${id}' in ${path} (also ${previous})`);
    }
    if (!previous) {
      seen.set(id, path);
      ids.push(id);
    }
  }
  return ids;
}

async function collectAgentNames(
  agentsDir: string,
  requireStableName: boolean,
): Promise<{ names: string[]; issues: string[] }> {
  if (!(await exists(agentsDir))) return { names: [], issues: [] };

  const names: string[] = [];
  const issues: string[] = [];
  const seen = new Map<string, string>();

  for (const path of await walkFiles(agentsDir)) {
    if (!path.endsWith('.md')) continue;
    const meta = frontmatter(await readFile(path, 'utf8'));
    if (Object.prototype.hasOwnProperty.call(meta, 'name') && typeof meta.name !== 'string') {
      throw new Error(`${path}: agent frontmatter name must be a string`);
    }
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    if (!name) {
      if (requireStableName) issues.push(`${path}: missing stable frontmatter name`);
      continue;
    }
    const previous = seen.get(name);
    if (previous) {
      issues.push(`${path}: duplicate agent name '${name}' (also ${previous})`);
      continue;
    }
    seen.set(name, path);
    names.push(name);
  }
  return { names, issues };
}

export async function inspectRepo(repoInput: string): Promise<RepoInventory> {
  const repo = resolve(repoInput);
  const repoStat = await tryLstat(repo);
  if (!repoStat?.isDirectory() || repoStat.isSymbolicLink()) throw new Error(`Repo path is not a real directory: ${repo}`);

  const skills = join(repo, 'skills');
  const agents = join(repo, 'agents');
  const skillsStat = await tryLstat(skills);
  const agentsStat = await tryLstat(agents);
  const hasSkills = Boolean(skillsStat);
  const hasAgents = Boolean(agentsStat);

  if (!hasSkills && !hasAgents) throw new Error(`Repo has neither skills/ nor agents/: ${repo}`);
  if (hasSkills && (!skillsStat!.isDirectory() || skillsStat!.isSymbolicLink())) throw new Error(`skills path is not a real directory: ${skills}`);
  if (hasAgents && (!agentsStat!.isDirectory() || agentsStat!.isSymbolicLink())) throw new Error(`agents path is not a real directory: ${agents}`);

  const skillIds = hasSkills ? await collectSkillIds(skills, true) : [];
  const agentResult = hasAgents
    ? await collectAgentNames(agents, true)
    : { names: [], issues: [] as string[] };

  if (agentResult.issues.length) {
    throw new Error(`Agent validation failed:\n${agentResult.issues.join('\n')}`);
  }

  return {
    repo,
    skillsDir: hasSkills ? skills : undefined,
    agentsDir: hasAgents ? agents : undefined,
    skillIds,
    agentNames: agentResult.names,
  };
}

function hasGlobSyntax(source: string): boolean {
  return /[*?[\]{}!]/.test(source);
}

function resolveConfigSource(source: string, configPath: string): string | null {
  if (hasGlobSyntax(source)) return null;
  const expanded = source === '~'
    ? homedir()
    : source.startsWith('~/')
      ? join(homedir(), source.slice(2))
      : source;
  return resolve(isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded));
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter(value => rightSet.has(value));
}

async function registrationState(inventory: RepoInventory): Promise<RegistrationState> {
  let skillsRegistered = !inventory.skillsDir;
  if (inventory.skillsDir) {
    const configPath = opencodeConfigFile();
    const { data } = await readConfig(configPath);
    skillsRegistered = configuredSkillPaths(data).some(source => {
      return resolveConfigSource(source, configPath) === inventory.skillsDir;
    });
  }

  let agentsRegistered = !inventory.agentsDir;
  if (inventory.agentsDir) {
    const link = join(opencodeConfigDir(), 'agents', repoId(inventory.repo));
    if (await lexists(link)) {
      const linkStat = await lstat(link);
      if (linkStat.isSymbolicLink()) {
        const target = resolve(dirname(link), await readlink(link));
        agentsRegistered = target === inventory.agentsDir;
      } else {
        agentsRegistered = false;
      }
    } else {
      agentsRegistered = false;
    }
  }

  return { skillsRegistered, agentsRegistered };
}

async function staticCollisionIssues(inventory: RepoInventory): Promise<string[]> {
  const issues: string[] = [];
  const configPath = opencodeConfigFile();

  if (inventory.skillsDir && inventory.skillIds.length) {
    const { data } = await readConfig(configPath);
    for (const source of configuredSkillPaths(data)) {
      const resolved = resolveConfigSource(source, configPath);
      if (!resolved || resolved === inventory.skillsDir || !(await directoryExists(resolved))) continue;
      const existingIds = await collectSkillIds(resolved, false);
      for (const id of intersect(inventory.skillIds, existingIds)) {
        issues.push(`Skill ID collision '${id}' with configured source ${source}`);
      }
    }
  }

  if (inventory.agentsDir) {
    const agentRoot = join(opencodeConfigDir(), 'agents');
    const candidateLink = join(agentRoot, repoId(inventory.repo));

    if (await lexists(candidateLink)) {
      const linkStat = await lstat(candidateLink);
      if (!linkStat.isSymbolicLink()) {
        issues.push(`Agent registration path exists and is not a symlink: ${candidateLink}`);
      } else {
        const target = resolve(dirname(candidateLink), await readlink(candidateLink));
        if (target !== inventory.agentsDir) {
          issues.push(`Agent symlink collision: ${candidateLink} -> ${target}`);
        }
      }
    }

    if (inventory.agentNames.length && await directoryExists(agentRoot)) {
      for (const entry of await readdir(agentRoot, { withFileTypes: true })) {
        const path = join(agentRoot, entry.name);
        let sourceDir: string | null = null;

        if (entry.isSymbolicLink()) {
          const target = resolve(agentRoot, await readlink(path));
          if (target === inventory.agentsDir || !(await directoryExists(target))) continue;
          sourceDir = target;
        } else if (entry.isDirectory()) {
          sourceDir = path;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const meta = frontmatter(await readFile(path, 'utf8'));
          const name = typeof meta.name === 'string' ? meta.name.trim() : '';
          if (name && inventory.agentNames.includes(name)) {
            issues.push(`Agent name collision '${name}' with ${path}`);
          }
        }

        if (sourceDir) {
          const existing = await collectAgentNames(sourceDir, false);
          for (const name of intersect(inventory.agentNames, existing.names)) {
            issues.push(`Agent name collision '${name}' with ${sourceDir}`);
          }
        }
      }
    }
  }

  return issues;
}

export async function prepareRegistration(
  inventories: RepoInventory[],
  snapshotInput?: OpenCodeConfigSnapshot,
): Promise<RegistrationPlan> {
  const snapshot = snapshotInput ?? await readOpenCodeConfigSnapshot();
  const skillOwners = new Map<string, string>();
  const agentOwners = new Map<string, string>();
  const duplicateIssues: string[] = [];

  for (const inventory of inventories) {
    for (const id of inventory.skillIds) {
      const previous = skillOwners.get(id);
      if (previous) duplicateIssues.push(`Duplicate skill ID '${id}' in ${inventory.repo} (also ${previous})`);
      else skillOwners.set(id, inventory.repo);
    }
    for (const name of inventory.agentNames) {
      const previous = agentOwners.get(name);
      if (previous) duplicateIssues.push(`Duplicate agent name '${name}' in ${inventory.repo} (also ${previous})`);
      else agentOwners.set(name, inventory.repo);
    }
  }

  if (duplicateIssues.length) throw new Error(`Registration batch validation failed:\n${duplicateIssues.join('\n')}`);

  const collisions: string[] = [];
  for (const inventory of inventories) collisions.push(...await staticCollisionIssues(inventory));
  if (collisions.length) throw new Error(`Registration blocked:\n${collisions.join('\n')}`);

  const skillSources = inventories
    .map(inventory => inventory.skillsDir)
    .filter((path): path is string => Boolean(path));
  const prospective = prospectiveOpenCodeConfig(snapshot, skillSources);
  const agentLinks = inventories
    .map(inventory => inventory.agentsDir
      ? { path: agentRegistrationPath(inventory.repo), target: inventory.agentsDir }
      : undefined)
    .filter((link): link is { path: string; target: string } => Boolean(link));

  return {
    configPath: snapshot.path,
    skillSources,
    addedSkillSources: prospective.addedSkillSources,
    agentLinks,
  };
}

function pathIsWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedRoot === resolvedCandidate || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

export async function assertNoConfiguredIdentifierCollisions(
  skillIds: string[],
  agentNames: string[],
  ignoredAgentPaths: string[] = [],
  ignoredSkillPaths: string[] = [],
): Promise<void> {
  const issues: string[] = [];
  const configPath = opencodeConfigFile();
  const { data } = await readConfig(configPath);
  const skillSet = new Set(skillIds);
  const configuredSkillOwners = new Map<string, string>();

  for (const source of stringArray(data.skills)) {
    const resolved = resolveConfigSource(source, configPath);
    if (!resolved || !(await directoryExists(resolved))) continue;
    for (const id of await collectSkillIds(resolved, true)) {
      const previous = configuredSkillOwners.get(id);
      if (previous && resolveConfigSource(previous, configPath) !== resolved) {
        issues.push(`Duplicate configured skill ID '${id}': ${previous} and ${source}`);
      } else {
        configuredSkillOwners.set(id, source);
      }
      if (skillSet.has(id) && !ignoredSkillPaths.some(path => resolve(path) === resolved)) {
        issues.push(`Skill ID collision '${id}' with configured source ${source}`);
      }
    }
  }

  const agentSet = new Set(agentNames);
  const agentRoot = join(opencodeConfigDir(), 'agents');
  if (agentSet.size && await directoryExists(agentRoot)) {
    for (const entry of await readdir(agentRoot, { withFileTypes: true })) {
      const path = join(agentRoot, entry.name);
      if (ignoredAgentPaths.some(root => pathIsWithin(root, path))) continue;

      let names: string[] = [];
      if (entry.isSymbolicLink()) {
        const target = resolve(agentRoot, await readlink(path));
        if (await directoryExists(target)) {
          const result = await collectAgentNames(target, false);
          issues.push(...result.issues);
          names = result.names;
        }
        else if (entry.name.endsWith('.md') && await exists(path)) {
          const meta = frontmatter(await readFile(path, 'utf8'));
          const name = typeof meta.name === 'string' ? meta.name.trim() : '';
          if (name) names = [name];
        }
      } else if (entry.isDirectory()) {
        const result = await collectAgentNames(path, false);
        issues.push(...result.issues);
        names = result.names;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const meta = frontmatter(await readFile(path, 'utf8'));
        const name = typeof meta.name === 'string' ? meta.name.trim() : '';
        if (name) names = [name];
      }

      for (const name of names) {
        if (agentSet.has(name)) issues.push(`Agent name collision '${name}' with ${path}`);
      }
    }
  }

  if (issues.length) throw new Error(`Registration blocked:\n${issues.join('\n')}`);
}

export async function registerRepo(
  repoInput: string,
): Promise<{ repo: string; skillPath?: string; agentLink?: string }> {
  const inventory = await inspectRepo(repoInput);
  const collisions = await staticCollisionIssues(inventory);
  if (collisions.length) throw new Error(`Registration blocked:\n${collisions.join('\n')}`);

  if (inventory.skillsDir) {
    const configPath = opencodeConfigFile();
    await updateSkills(
      configPath,
      current => current.some(source => resolveConfigSource(source, configPath) === inventory.skillsDir)
        ? current
        : [...current, inventory.skillsDir!],
    );
  }

  let agentLink: string | undefined;
  if (inventory.agentsDir) {
    const targetDir = join(opencodeConfigDir(), 'agents');
    await mkdir(targetDir, { recursive: true });
    agentLink = join(targetDir, repoId(inventory.repo));
    if (!(await lexists(agentLink))) {
      await symlink(inventory.agentsDir, agentLink, 'dir');
    }
  }

  return { repo: inventory.repo, skillPath: inventory.skillsDir, agentLink };
}

export async function unregisterRepo(repoInput: string): Promise<void> {
  const repo = resolve(repoInput);
  const skills = join(repo, 'skills');
  const configPath = opencodeConfigFile();

  await updateSkills(configPath, current => current.filter(source => {
    return resolveConfigSource(source, configPath) !== skills;
  }));

  const link = join(opencodeConfigDir(), 'agents', repoId(repo));
  if (await lexists(link)) {
    const linkStat = await lstat(link);
    if (!linkStat.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-symlink registration path: ${link}`);
    }
    const target = resolve(dirname(link), await readlink(link));
    if (target !== join(repo, 'agents')) {
      throw new Error(`Refusing to remove symlink owned by another target: ${link} -> ${target}`);
    }
    await unlink(link);
  }
}

let openCodeQueue: Promise<void> = Promise.resolve();

async function executeOpenCode(args: string[], env: NodeJS.ProcessEnv): Promise<VerifyResult> {
  return await new Promise(resolvePromise => {
    const child = spawn('opencode', args, {
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', error => resolvePromise({
      ok: false,
      command: `opencode ${args.join(' ')}`,
      stdout,
      stderr: `${stderr}${error.message}`,
    }));
    child.on('close', code => resolvePromise({
      ok: code === 0,
      command: `opencode ${args.join(' ')}`,
      stdout,
      stderr,
    }));
  });
}

export function runOpenCode(args: string[], env = process.env): Promise<VerifyResult> {
  const run = openCodeQueue.then(() => executeOpenCode(args, env));
  openCodeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function parseDiscoveredSkillIds(output: string): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;

  const ids = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) ids.add(name.trim());
  }
  return ids;
}

function containsIdentifier(output: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9._/-])${escaped}($|[^A-Za-z0-9._/-])`, 'm').test(output);
}

function expectIdentifiers(
  result: VerifyResult,
  ids: string[],
  shouldExist: boolean,
  kind: 'skill' | 'agent',
): VerifyResult {
  if (!result.ok) return result;
  const discovered = kind === 'skill' ? parseDiscoveredSkillIds(result.stdout) : undefined;
  if (kind === 'skill' && !discovered) {
    return {
      ...result,
      ok: false,
      stderr: `${result.stderr}${result.stderr ? '\n' : ''}OpenCode skill discovery output is not valid JSON`,
    };
  }
  const wrong = ids.filter(id => (discovered ? discovered.has(id) : containsIdentifier(result.stdout, id)) !== shouldExist);
  if (!wrong.length) return result;

  const expectation = shouldExist ? 'missing' : 'still visible';
  return {
    ...result,
    ok: false,
    stderr: `${result.stderr}${result.stderr ? '\n' : ''}Expected ${kind} IDs ${expectation}: ${wrong.join(', ')}`,
  };
}

async function runRepoProbes(inventory: RepoInventory): Promise<{
  skills?: VerifyResult;
  agents?: VerifyResult;
}> {
  const [skills, agents] = await Promise.all([
    inventory.skillIds.length ? runOpenCode(['debug', 'skill']) : Promise.resolve(undefined),
    inventory.agentNames.length ? runOpenCode(['agent', 'list']) : Promise.resolve(undefined),
  ]);
  return { skills, agents };
}

export async function assertNoRuntimeCollisions(inventory: RepoInventory): Promise<void> {
  const state = await registrationState(inventory);
  const skillIds = state.skillsRegistered ? [] : inventory.skillIds;
  const agentNames = state.agentsRegistered ? [] : inventory.agentNames;

  const [skillProbe, agentProbe] = await Promise.all([
    skillIds.length ? runOpenCode(['debug', 'skill']) : Promise.resolve(undefined),
    agentNames.length ? runOpenCode(['agent', 'list']) : Promise.resolve(undefined),
  ]);

  const failures = [skillProbe, agentProbe].filter(
    (result): result is VerifyResult => Boolean(result && !result.ok),
  );
  if (failures.length) {
    throw new Error(`OpenCode collision pre-check failed:\n${failures.map(
      result => `${result.command}: ${result.stderr.trim() || 'non-zero exit'}`,
    ).join('\n')}`);
  }

  const collisions: string[] = [];
  if (skillProbe) {
    const discovered = parseDiscoveredSkillIds(skillProbe.stdout);
    if (!discovered) throw new Error('OpenCode skill discovery output is not valid JSON');
    for (const id of skillIds) {
      if (discovered.has(id)) collisions.push(`Skill ID '${id}' is already visible in OpenCode`);
    }
  }
  if (agentProbe) {
    for (const name of agentNames) {
      if (containsIdentifier(agentProbe.stdout, name)) collisions.push(`Agent name '${name}' is already visible in OpenCode`);
    }
  }
  if (collisions.length) throw new Error(`Registration blocked:\n${collisions.join('\n')}`);
}

export async function verifyRepoRegistered(inventory: RepoInventory): Promise<VerifyResult[]> {
  const probes = await runRepoProbes(inventory);
  const results: VerifyResult[] = [];
  if (probes.skills) results.push(expectIdentifiers(probes.skills, inventory.skillIds, true, 'skill'));
  if (probes.agents) results.push(expectIdentifiers(probes.agents, inventory.agentNames, true, 'agent'));
  return results;
}

export async function verifyRepoUnregistered(inventory: RepoInventory): Promise<VerifyResult[]> {
  const probes = await runRepoProbes(inventory);
  const results: VerifyResult[] = [];
  if (probes.skills) results.push(expectIdentifiers(probes.skills, inventory.skillIds, false, 'skill'));
  if (probes.agents) results.push(expectIdentifiers(probes.agents, inventory.agentNames, false, 'agent'));
  return results;
}

export async function verifyOpenCode(): Promise<VerifyResult[]> {
  return await Promise.all([
    runOpenCode(['--version']),
    runOpenCode(['debug', 'skill']),
    runOpenCode(['agent', 'list']),
  ]);
}

export async function verifyMigrationDiscovery(
  inventories: RepoInventory[],
  registration: Pick<RegistrationPlan, 'skillSources' | 'agentLinks'>,
): Promise<VerifyResult[]> {
  const skillIds = [...new Set(inventories.flatMap(inventory => inventory.skillIds))];
  const agentNames = [...new Set(inventories.flatMap(inventory => inventory.agentNames))];
  const probes = await verifyOpenCode();
  const results = probes.map(result => {
    if (result.command === 'opencode debug skill') return expectIdentifiers(result, skillIds, true, 'skill');
    if (result.command === 'opencode agent list') return expectIdentifiers(result, agentNames, true, 'agent');
    return result;
  });

  const issues: string[] = [];
  try {
    const configPath = registrationSourceConfigPath();
    const { data } = await readConfig(configPath);
    const configuredSources = configuredSkillPaths(data);
    const configuredById = new Map<string, string>();

    for (const source of configuredSources) {
      const resolved = resolveConfigSource(source, configPath);
      if (!resolved || !(await directoryExists(resolved))) continue;
      for (const id of await collectSkillIds(resolved, false)) {
        const previous = configuredById.get(id);
        if (previous && previous !== source) issues.push(`Duplicate discovered skill ID '${id}': ${previous} and ${source}`);
        else configuredById.set(id, source);
      }
    }

    for (const source of registration.skillSources) {
      if (!(await directoryExists(source))) {
        issues.push(`Missing migrated skill source: ${source}`);
        continue;
      }
      if (!configuredSources.some(value => resolveConfigSource(value, configPath) === source)) {
        issues.push(`Migrated skill source is not configured: ${source}`);
      }
    }

    for (const inventory of inventories) {
      if (!inventory.skillsDir) continue;
      if (!registration.skillSources.includes(inventory.skillsDir)) {
        issues.push(`Migrated repository skill source is missing from registration plan: ${inventory.skillsDir}`);
      }
      const discovered = await collectSkillIds(inventory.skillsDir, false);
      const missing = inventory.skillIds.filter(id => !discovered.includes(id));
      if (missing.length) issues.push(`Migrated skill source does not contain expected IDs: ${missing.join(', ')}`);
    }

    for (const link of registration.agentLinks) {
      const linkStat = await tryLstat(link.path);
      if (!linkStat?.isSymbolicLink()) {
        issues.push(`Missing migrated agent registration link: ${link.path}`);
        continue;
      }
      const target = resolve(dirname(link.path), await readlink(link.path));
      if (target !== link.target) issues.push(`Migrated agent registration points elsewhere: ${link.path} -> ${target}`);
      if (!(await directoryExists(link.target))) issues.push(`Missing migrated agent source: ${link.target}`);
      const inventory = inventories.find(item => item.agentsDir === link.target);
      if (inventory) {
        const discovered = (await collectAgentNames(link.target, false)).names;
        const missing = inventory.agentNames.filter(name => !discovered.includes(name));
        if (missing.length) issues.push(`Migrated agent source does not contain expected names: ${missing.join(', ')}`);
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  results.push({
    ok: issues.length === 0,
    command: 'skillrepo migration targets',
    stdout: issues.length ? '' : 'all migrated targets are configured and readable',
    stderr: issues.join('\n'),
  });
  return results;
}

function registrationSourceConfigPath(): string {
  return opencodeConfigFile();
}

async function doctorStaticChecks(): Promise<{ issues: string[]; skillIds: string[]; registeredSources: number }> {
  const issues: string[] = [];
  const configuredSkillIds = new Set<string>();
  let registeredSources = 0;
  let configPath: string;

  try {
    configPath = opencodeConfigFile();
  } catch (error) {
    return {
      issues: [error instanceof Error ? error.message : String(error)],
      skillIds: [],
      registeredSources: 0,
    };
  }

  try {
    const { data } = await readConfig(configPath);
    const seenSkills = new Map<string, string>();

    for (const source of configuredSkillPaths(data)) {
      const resolved = resolveConfigSource(source, configPath);
      if (!resolved) continue;
      if (!(await directoryExists(resolved))) {
        issues.push(`Missing skill source: ${source}`);
        continue;
      }
      registeredSources += 1;

      for (const id of await collectSkillIds(resolved, false)) {
        configuredSkillIds.add(id);
        const previous = seenSkills.get(id);
        if (previous && previous !== source) issues.push(`Duplicate skill ID '${id}': ${previous} and ${source}`);
        else seenSkills.set(id, source);
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const agentRoot = join(opencodeConfigDir(), 'agents');
  if (await directoryExists(agentRoot)) {
    const seenAgents = new Map<string, string>();

    for (const entry of await readdir(agentRoot, { withFileTypes: true })) {
      const path = join(agentRoot, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(agentRoot, await readlink(path));
        if (!(await exists(target))) {
          issues.push(`Broken agent symlink: ${path} -> ${target}`);
          continue;
        }
        if (await directoryExists(target)) {
          registeredSources += 1;
          const result = await collectAgentNames(target, false);
          issues.push(...result.issues);
          for (const name of result.names) {
            const previous = seenAgents.get(name);
            if (previous && previous !== target) issues.push(`Duplicate agent name '${name}': ${previous} and ${target}`);
            else seenAgents.set(name, target);
          }
          continue;
        }
        if (!entry.name.endsWith('.md')) continue;
        const meta = frontmatter(await readFile(path, 'utf8'));
        const name = typeof meta.name === 'string' ? meta.name.trim() : '';
        if (!name) continue;
        const previous = seenAgents.get(name);
        if (previous && previous !== path) issues.push(`Duplicate agent name '${name}': ${previous} and ${path}`);
        else seenAgents.set(name, path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const meta = frontmatter(await readFile(path, 'utf8'));
        const name = typeof meta.name === 'string' ? meta.name.trim() : '';
        if (!name) continue;
        const previous = seenAgents.get(name);
        if (previous && previous !== path) issues.push(`Duplicate agent name '${name}': ${previous} and ${path}`);
        else seenAgents.set(name, path);
      }
    }
  }

  return { issues, skillIds: [...configuredSkillIds], registeredSources };
}

export async function doctor(): Promise<{ ok: boolean; issues: string[]; verification: VerifyResult[] }> {
  const staticChecks = await doctorStaticChecks();
  const issues = staticChecks.issues;
  if (staticChecks.registeredSources === 0) {
    issues.push('No registered skill or agent target source found');
  }
  const verification = await verifyOpenCode();
  for (const result of verification) {
    if (!result.ok) {
      issues.push(`OpenCode verification failed: ${result.command}: ${result.stderr.trim() || 'non-zero exit'}`);
    }
  }

  const skillProbe = verification.find(result => result.command === 'opencode debug skill');
  if (skillProbe?.ok && staticChecks.skillIds.length) {
    const discovered = parseDiscoveredSkillIds(skillProbe.stdout);
    if (!discovered) issues.push('OpenCode skill discovery output is not valid JSON');
    else {
      const missing = staticChecks.skillIds.filter(id => !discovered.has(id));
      if (missing.length) issues.push(`OpenCode discovery missing configured skill IDs: ${missing.join(', ')}`);
    }
  }
  return { ok: issues.length === 0, issues, verification };
}
