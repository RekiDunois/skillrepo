import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Git process terminated by signal ${signal}: ${command} ${args.join(' ')}`));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
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

  const gitDir = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-oracle-'));
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
    for (const relPath of unique) {
      const result = await runProcess(
        runtime.gitPath,
        ['check-ignore', '--no-index', '--quiet', '--', relPath],
        { cwd: repoRoot, env },
      );
      if (result.code === 0) {
        ignored.add(relPath);
        continue;
      }
      if (result.code === 1) continue;
      throw new Error(
        `Git check-ignore failed for ${relPath}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
      );
    }
    return ignored;
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}
