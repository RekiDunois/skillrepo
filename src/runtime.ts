import { access, lstat, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type ParseError } from 'jsonc-parser';
import { opencodeConfigDir, opencodeConfigFile } from './core.js';

export type RuntimeVerificationPhase = 'canary-runtime-verification' | 'final-runtime-verification';

export type RuntimeSkillExpectation = {
  id: string;
  source: string;
  target: string;
  marker: string;
};

export type RuntimeVerificationContext = {
  phase: RuntimeVerificationPhase;
  transactionId: string;
  projectDir: string;
  configPath: string;
  configFingerprint: string;
  skillSources: string[];
  agentLinks: Array<{ path: string; target: string }>;
  expectedSkillIds: string[];
  expectedAgentNames: string[];
  skills: RuntimeSkillExpectation[];
};

export type RuntimeVerificationResult = {
  ok: boolean;
  phase: RuntimeVerificationPhase;
  checks: Array<{ ok: boolean; command: string; stdout: string; stderr: string }>;
  diagnostics: Record<string, unknown>;
};

export type RuntimeVerifier = (context: RuntimeVerificationContext) => Promise<RuntimeVerificationResult>;

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

async function repoRootsFromSource(source: string): Promise<string[]> {
  const parent = dirname(source);
  if (basename(parent) !== '.apm') return [parent];
  const packageRoot = dirname(parent);
  return await exists(join(packageRoot, 'apm.yml')) ? [packageRoot] : [parent];
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

async function walkSymlinkPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await walkSymlinkPaths(path));
    else if (entry.isSymbolicLink()) paths.push(path);
  }
  return paths;
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
  const skills = data?.skills;
  if (Array.isArray(skills)) return stringArray(skills);
  if (skills && typeof skills === 'object') return stringArray((skills as Record<string, unknown>).paths);
  return [];
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
        for (const root of await repoRootsFromSource(target)) {
          if (repoIdFromPath(root) === repoId) candidates.add(root);
        }
      }
    }
  } catch {
    // No agent registration for this repo.
  }

  const agentRoot = join(opencodeConfigDir(env), 'agents');
  if (await directoryExists(agentRoot)) {
    for (const path of await walkSymlinkPaths(agentRoot)) {
      let target: string;
      try {
        target = resolve(dirname(path), await readlink(path));
      } catch {
        continue;
      }
      if (!(await exists(target))) continue;
      for (const root of await repoRootsFromSource(dirname(target))) {
        if (repoIdFromPath(root) === repoId) candidates.add(root);
      }
    }
  }

  const configPath = opencodeConfigFile(env);
  for (const source of await readOpenCodeSkills(env)) {
    const skillsDir = resolveConfigSource(source, configPath);
    if (!skillsDir || basename(skillsDir) !== 'skills' || !(await directoryExists(skillsDir))) continue;
    for (const root of await repoRootsFromSource(skillsDir)) {
      if (repoIdFromPath(root) === repoId) candidates.add(root);
    }
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

  let realRepo: string;
  let realTarget: string;
  try {
    [realRepo, realTarget] = await Promise.all([realpath(repo), realpath(target)]);
  } catch {
    throw new Error(`Registered repo resource does not exist: ${repoId}/${resource}`);
  }
  if (!within(realRepo, realTarget)) throw new Error(`Resource path escapes registered repo: ${resourceInput}`);

  let targetStat;
  try {
    targetStat = await stat(realTarget);
  } catch {
    throw new Error(`Registered repo resource does not exist: ${repoId}/${resource}`);
  }
  if (!targetStat.isFile()) throw new Error(`Registered repo resource is not a file: ${repoId}/${resource}`);
  return realTarget;
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

export async function installedSkillrepoSupportsExec(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return await new Promise<boolean>(resolvePromise => {
    let stderr = '';
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const child = spawn('skillrepo', ['exec'], {
      shell: false,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', data => stderr += data);
    child.once('error', () => finish(false));
    child.once('close', () => finish(stderr.includes('skillrepo exec <repo-id> <repo-relative-resource>')));
  });
}

/**
 * Run the external verifier in a child process so OpenCode's worker lifecycle
 * cannot interfere with the migration process or its rollback handlers.
 */
export async function verifyOpenCodeRuntime(
  context: RuntimeVerificationContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeVerificationResult> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'skillrepo-runtime-verification-'));
  const inputPath = join(temporaryRoot, 'request.json');
  const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/opencode-runtime-verify.mjs');
  try {
    await writeFile(inputPath, `${JSON.stringify(context)}\n`, { encoding: 'utf8', mode: 0o600 });
    const childEnv = {
      ...env,
      OPENCODE_CONFIG: context.configPath,
      OPENCODE_CONFIG_DIR: opencodeConfigDir(env),
    };
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [helperPath, inputPath], {
        cwd: context.projectDir,
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => stdout += data);
      child.stderr.on('data', data => stderr += data);
      child.once('error', reject);
      child.once('close', code => resolvePromise({ code, stdout, stderr }));
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return {
        ok: false,
        phase: context.phase,
        checks: [{ ok: false, command: 'opencode runtime verifier', stdout: result.stdout, stderr: result.stderr }],
        diagnostics: { verifierError: 'runtime verifier returned invalid JSON', verifierStderr: result.stderr },
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        phase: context.phase,
        checks: [{ ok: false, command: 'opencode runtime verifier', stdout: result.stdout, stderr: result.stderr }],
        diagnostics: { verifierError: 'runtime verifier returned a non-object result', verifierStderr: result.stderr },
      };
    }
    const value = parsed as Partial<RuntimeVerificationResult>;
    if (value.phase !== context.phase || typeof value.ok !== 'boolean' || !Array.isArray(value.checks)) {
      return {
        ok: false,
        phase: context.phase,
        checks: [{ ok: false, command: 'opencode runtime verifier', stdout: result.stdout, stderr: result.stderr }],
        diagnostics: { verifierError: 'runtime verifier returned an invalid result shape', verifierStderr: result.stderr },
      };
    }
    return {
      ok: value.ok,
      phase: context.phase,
      checks: value.checks as RuntimeVerificationResult['checks'],
      diagnostics: value.diagnostics && typeof value.diagnostics === 'object' && !Array.isArray(value.diagnostics)
        ? value.diagnostics as Record<string, unknown>
        : { verifierStderr: result.stderr },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
