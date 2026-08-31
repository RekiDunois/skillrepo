import { access, lstat, mkdir, readFile, readdir, readlink, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import YAML from 'yaml';

export type VerifyResult = { ok: boolean; command: string; stdout: string; stderr: string };
export type RepoInventory = {
  repo: string;
  skillsDir?: string;
  agentsDir?: string;
  skillIds: string[];
  agentNames: string[];
};

type RegistrationState = { skillsRegistered: boolean; agentsRegistered: boolean };

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

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readConfig(path: string): Promise<{ text: string; data: Record<string, unknown> }> {
  if (!(await exists(path))) {
    return { text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', data: {} };
  }
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  if (errors.length) throw new Error(`OpenCode config is not valid JSON/JSONC: ${path}`);
  return { text, data: data ?? {} };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function updateSkills(configPath: string, updater: (skills: string[]) => string[]): Promise<void> {
  const existed = await exists(configPath);
  const { text, data } = await readConfig(configPath);
  const current = stringArray(data.skills);
  const next = updater(current);

  if (current.length === next.length && current.every((value, index) => value === next[index])) return;
  if (!existed && next.length === 0) return;

  const edits = modify(text, ['skills'], next, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, applyEdits(text, edits), 'utf8');
}

function repoId(repoPath: string): string {
  const id = basename(repoPath).trim();
  if (!id || id === '.' || id === '..') throw new Error(`Cannot derive repo id from ${repoPath}`);
  return id.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  return (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
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
  if (!(await directoryExists(repo))) throw new Error(`Repo path is not a directory: ${repo}`);

  const skills = join(repo, 'skills');
  const agents = join(repo, 'agents');
  const hasSkills = await exists(skills);
  const hasAgents = await exists(agents);

  if (!hasSkills && !hasAgents) throw new Error(`Repo has neither skills/ nor agents/: ${repo}`);
  if (hasSkills && !(await directoryExists(skills))) throw new Error(`skills path is not a directory: ${skills}`);
  if (hasAgents && !(await directoryExists(agents))) throw new Error(`agents path is not a directory: ${agents}`);

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
    skillsRegistered = stringArray(data.skills).some(source => {
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
    for (const source of stringArray(data.skills)) {
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
  const wrong = ids.filter(id => containsIdentifier(result.stdout, id) !== shouldExist);
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
    for (const id of skillIds) {
      if (containsIdentifier(skillProbe.stdout, id)) collisions.push(`Skill ID '${id}' is already visible in OpenCode`);
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

async function doctorStaticIssues(): Promise<string[]> {
  const issues: string[] = [];
  let configPath: string;

  try {
    configPath = opencodeConfigFile();
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  try {
    const { data } = await readConfig(configPath);
    const seenSkills = new Map<string, string>();

    for (const source of stringArray(data.skills)) {
      const resolved = resolveConfigSource(source, configPath);
      if (!resolved) continue;
      if (!(await directoryExists(resolved))) {
        issues.push(`Missing skill source: ${source}`);
        continue;
      }

      for (const id of await collectSkillIds(resolved, false)) {
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
        if (!(await directoryExists(target))) {
          issues.push(`Broken agent symlink: ${path} -> ${target}`);
          continue;
        }
        const result = await collectAgentNames(target, true);
        issues.push(...result.issues);
        for (const name of result.names) {
          const previous = seenAgents.get(name);
          if (previous && previous !== target) issues.push(`Duplicate agent name '${name}': ${previous} and ${target}`);
          else seenAgents.set(name, target);
        }
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

  return issues;
}

export async function doctor(): Promise<{ ok: boolean; issues: string[]; verification: VerifyResult[] }> {
  const issues = await doctorStaticIssues();
  const verification = await verifyOpenCode();
  for (const result of verification) {
    if (!result.ok) {
      issues.push(`OpenCode verification failed: ${result.command}: ${result.stderr.trim() || 'non-zero exit'}`);
    }
  }
  return { ok: issues.length === 0, issues, verification };
}
