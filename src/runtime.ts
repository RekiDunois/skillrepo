import { access, lstat, readFile, readlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { opencodeConfigDir, opencodeConfigFile } from './core.js';

function validateRepoId(id: string): string {
  const value = id.trim();
  if (!value || value === '.' || value === '..' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid repo id: ${id}`);
  }
  return value;
}

function repoIdFromPath(path: string): string {
  return basename(path).trim().replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function readOpenCodeSkills(env: NodeJS.ProcessEnv): Promise<string[]> {
  const configPath = opencodeConfigFile(env);
  if (!(await exists(configPath))) return [];
  const text = await readFile(configPath, 'utf8');
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (errors.length) throw new Error(`OpenCode config is not valid JSON/JSONC: ${configPath}`);
  return stringArray(data?.skills);
}

function resolveConfigSource(source: string, configPath: string): string | null {
  if (/[*?[\]{}!]/.test(source)) return null;
  const expanded = source === '~'
    ? homedir()
    : source.startsWith('~/')
      ? join(homedir(), source.slice(2))
      : source;
  return resolve(isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded));
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function resolveRegisteredRepo(
  repoIdInput: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const repoId = validateRepoId(repoIdInput);
  const candidates = new Set<string>();

  const agentLink = join(opencodeConfigDir(env), 'agents', repoId);
  try {
    const linkStat = await lstat(agentLink);
    if (linkStat.isSymbolicLink()) {
      const target = resolve(dirname(agentLink), await readlink(agentLink));
      if (await directoryExists(target)) {
        const root = dirname(target);
        if (repoIdFromPath(root) === repoId) candidates.add(root);
      }
    }
  } catch {
    // No agent registration for this repo.
  }

  const configPath = opencodeConfigFile(env);
  for (const source of await readOpenCodeSkills(env)) {
    const skillsDir = resolveConfigSource(source, configPath);
    if (!skillsDir || basename(skillsDir) !== 'skills' || !(await directoryExists(skillsDir))) continue;
    const root = dirname(skillsDir);
    if (repoIdFromPath(root) === repoId) candidates.add(root);
  }

  if (candidates.size === 0) {
    throw new Error(`Registered repo not found: ${repoId}`);
  }
  if (candidates.size > 1) {
    throw new Error(`Registered repo id is ambiguous: ${repoId}`);
  }
  return [...candidates][0]!;
}

export async function resolveRegisteredResource(
  repoId: string,
  resourceInput: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const resource = resourceInput.trim();
  if (!resource || isAbsolute(resource)) throw new Error(`Resource path must be repo-relative: ${resourceInput}`);

  const repo = await resolveRegisteredRepo(repoId, env);
  const target = resolve(repo, resource);
  if (!within(repo, target)) throw new Error(`Resource path escapes registered repo: ${resourceInput}`);

  let targetStat;
  try {
    targetStat = await stat(target);
  } catch {
    throw new Error(`Registered repo resource does not exist: ${repoId}/${resource}`);
  }
  if (!targetStat.isFile()) throw new Error(`Registered repo resource is not a file: ${repoId}/${resource}`);
  return target;
}

export async function execRegisteredResource(options: {
  repoId: string;
  resource: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = options.env ?? process.env;
  const target = await resolveRegisteredResource(options.repoId, options.resource, env);

  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(target, options.args ?? [], {
      shell: false,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Registered resource terminated by signal ${signal}: ${options.repoId}/${options.resource}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}
