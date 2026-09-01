import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type GitIgnoreRuntime = {
  gitPath: string;
  env: NodeJS.ProcessEnv;
};

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const hasInput = options.input !== undefined;
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: options.env,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', data => stdout += data);
    child.stderr?.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Git process terminated by signal ${signal}: ${command} ${args.join(' ')}`));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    if (hasInput && child.stdin) {
      child.stdin.on('error', error => {
        if (errnoCode(error) !== 'EPIPE') reject(error);
      });
      child.stdin.end(options.input);
    }
  });
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function flipAsciiCase(name: string): string | null {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code >= 65 && code <= 90) return `${name.slice(0, index)}${name[index]!.toLowerCase()}${name.slice(index + 1)}`;
    if (code >= 97 && code <= 122) return `${name.slice(0, index)}${name[index]!.toUpperCase()}${name.slice(index + 1)}`;
  }
  return null;
}

async function deriveTargetIgnoreCase(repoRoot: string, relPaths: string[]): Promise<boolean> {
  const rootStat = await lstat(repoRoot);
  for (const relPath of relPaths) {
    const segments = relPath.replaceAll('\\', '/').split('/').filter(Boolean);
    let parent = repoRoot;
    for (const segment of segments) {
      const current = join(parent, segment);
      let currentStat;
      try { currentStat = await lstat(current); } catch { break; }
      if (currentStat.dev !== rootStat.dev) break;

      const alternate = flipAsciiCase(segment);
      if (alternate && alternate !== segment) {
        const entries = await readdir(parent);
        if (entries.includes(alternate)) return false;
        try {
          await lstat(join(parent, alternate));
          return true;
        } catch (error) {
          if (errnoCode(error) === 'ENOENT') return false;
          throw error;
        }
      }
      parent = current;
    }
  }
  throw new Error(`Git ignore oracle could not derive target filesystem case behavior for ${repoRoot}`);
}

async function createOracleGitDir(repoRoot: string): Promise<string> {
  const parent = dirname(repoRoot);
  try {
    const [repoStat, parentStat] = await Promise.all([lstat(repoRoot), lstat(parent)]);
    if (repoStat.dev === parentStat.dev) {
      try { return await mkdtemp(join(parent, '.skillrepo-ignore-oracle-')); } catch { /* fall back below */ }
    }
  } catch { /* fall back below */ }
  return await mkdtemp(join(tmpdir(), 'skillrepo-ignore-oracle-'));
}

function withoutInheritedRepositoryContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  delete clean.GIT_COMMON_DIR;
  return clean;
}

async function hasOwnGitMetadata(repoRoot: string): Promise<boolean> {
  try {
    await lstat(join(repoRoot, '.git'));
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function probeInitializedRepository(
  runtime: GitIgnoreRuntime,
  repoRoot: string,
  unique: string[],
): Promise<Set<string> | null> {
  if (!await hasOwnGitMetadata(repoRoot)) return null;

  const env = withoutInheritedRepositoryContext(runtime.env);
  const context = await runProcess(
    runtime.gitPath,
    ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'],
    { cwd: repoRoot, env },
  );
  if (context.code !== 0 || context.stdout.trim() !== 'true') {
    const detail = context.stderr.trim() || context.stdout.trim() || `exit ${context.code}`;
    throw new Error(`Existing Git metadata is not a usable worktree for ignore evaluation: ${repoRoot} (${detail})`);
  }

  const result = await runProcess(
    runtime.gitPath,
    ['-C', repoRoot, 'check-ignore', '--no-index', '--stdin', '-z'],
    { cwd: repoRoot, env, input: `${unique.join('\0')}\0` },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`Git check-ignore failed in initialized repository: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }

  const ignored = new Set<string>();
  for (const relPath of result.stdout.split('\0')) if (relPath) ignored.add(relPath);
  return ignored;
}

export async function preflightGit(
  gitPathInput = 'git',
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitIgnoreRuntime> {
  const gitPath = gitPathInput.trim();
  if (!gitPath) throw new Error('Git is required for migration commit-readiness; selected Git executable path is empty');

  let result: ProcessResult;
  try {
    result = await runProcess(gitPath, ['--version'], { env });
  } catch (error) {
    throw new Error(`Git is required for migration commit-readiness but is unavailable: ${gitPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (result.code !== 0 || !/^git version\s+/i.test(result.stdout.trim())) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`Selected Git executable is not usable: ${gitPath} (${detail})`);
  }
  return { gitPath, env: { ...env } };
}

export async function probeIgnoredPaths(
  runtime: GitIgnoreRuntime,
  repoRootInput: string,
  relPaths: string[],
): Promise<Set<string>> {
  const repoRoot = resolve(repoRootInput);
  const unique = [...new Set(relPaths)].sort();
  const ignored = new Set<string>();
  if (!unique.length) return ignored;

  // If the target already has its own Git metadata, effective ignore semantics
  // must come from that real repository context so .git/info/exclude and
  // repository-local ignore configuration are honored.
  const initialized = await probeInitializedRepository(runtime, repoRoot, unique);
  if (initialized) return initialized;

  // For an uninitialized target, a normal future `git init` derives
  // core.ignoreCase from the target filesystem. Derive it from existing target
  // paths explicitly so a mount point or fallback metadata directory on another
  // filesystem cannot change ignore semantics.
  const ignoreCase = await deriveTargetIgnoreCase(repoRoot, unique);
  const gitDir = await createOracleGitDir(repoRoot);
  try {
    const init = await runProcess(runtime.gitPath, ['init', '--bare', '--quiet', gitDir], { env: runtime.env });
    if (init.code !== 0) {
      throw new Error(`Git ignore oracle initialization failed: ${init.stderr.trim() || init.stdout.trim() || `exit ${init.code}`}`);
    }

    const env = {
      ...runtime.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: repoRoot,
    };
    const result = await runProcess(
      runtime.gitPath,
      ['-c', `core.ignoreCase=${ignoreCase ? 'true' : 'false'}`, 'check-ignore', '--no-index', '--stdin', '-z'],
      { cwd: repoRoot, env, input: `${unique.join('\0')}\0` },
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`Git check-ignore failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
    }
    for (const relPath of result.stdout.split('\0')) if (relPath) ignored.add(relPath);
    return ignored;
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}
