import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { auditMigrationRepos } from './audit.js';
import { probeIgnoredPaths } from './git_ignore.js';

export type IgnoreRepoPlan = {
  repoId: string;
  repoPath: string;
  gitignorePath: string;
  patterns: string[];
};

export type ManualIgnoreRepoPlan = IgnoreRepoPlan & {
  reason: string;
};

export type MigrationIgnoreResult = {
  dryRun: boolean;
  repositories: IgnoreRepoPlan[];
  manualRepositories: ManualIgnoreRepoPlan[];
  patterns: number;
};

type CreatedFileProof = {
  dev: number;
  ino: number;
  text: string;
};

const SAFE_AUTO_IGNORE_PATTERNS = new Set([
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '.nox/',
  '.ms-playwright/',
  'chrome-profile/',
  '.DS_Store',
  '[Tt][Hh][Uu][Mm][Bb][Ss].[Dd][Bb]',
  '*.[Pp][Yy][CcOoDd]',
  '*.[Ll][Oo][Gg]',
  '*.[Tt][Mm][Pp]',
  '*.[Tt][Ee][Mm][Pp]',
  '*.[Ss][Ww][Pp]',
  '*.[Ss][Ww][Oo]',
  '.coverage',
  '[Cc][Oo][Vv][Ee][Rr][Aa][Gg][Ee].[Xx][Mm][Ll]',
  '*[Dd][Ee][Bb][Uu][Gg].[Ll][Oo][Gg]*',
  '[Yy][Aa][Rr][Nn]-[Ee][Rr][Rr][Oo][Rr].[Ll][Oo][Gg]*',
]);

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function comparePatterns(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function gitignoreExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function newGitignoreText(patterns: string[]): string {
  return `# skillrepo: generated runtime/cache ignores\n${patterns.join('\n')}\n`;
}

async function writeNewGitignore(path: string, text: string): Promise<CreatedFileProof> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o666);
  try {
    const created = await handle.stat();
    if (!created.isFile()) throw new Error(`Refusing to write non-regular .gitignore: ${path}`);
    await handle.writeFile(text, { encoding: 'utf8' });
    return { dev: created.dev, ino: created.ino, text };
  } finally {
    await handle.close();
  }
}

async function rollbackCreatedGitignore(path: string, proof: CreatedFileProof): Promise<boolean> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== proof.dev || before.ino !== proof.ino) return false;
    if (await readFile(path, 'utf8') !== proof.text) return false;
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== proof.dev || after.ino !== proof.ino) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    return false;
  }
}

export async function applyMigrationIgnores(options: {
  planPath: string;
  targetRoot: string;
  dryRun?: boolean;
  gitPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationIgnoreResult> {
  const dryRun = options.dryRun ?? true;
  const gitPath = options.gitPath ?? 'git';
  const env = options.env ?? process.env;

  // auditMigrationRepos performs the mandatory Git preflight before reading the plan or scanning repositories.
  const audit = await auditMigrationRepos({
    planPath: options.planPath,
    targetRoot: options.targetRoot,
    gitPath,
    env,
  });
  const repositories: IgnoreRepoPlan[] = [];
  const manualRepositories: ManualIgnoreRepoPlan[] = [];

  for (const repo of audit.repositories) {
    if (!repo.exists) continue;
    const gitignorePath = join(repo.repoPath, '.gitignore');
    const candidates = repo.ignoreCandidates
      .filter(candidate => SAFE_AUTO_IGNORE_PATTERNS.has(candidate.pattern))
      .sort((left, right) => comparePatterns(left.pattern, right.pattern));
    const patterns = candidates.map(candidate => candidate.pattern);
    if (!patterns.length) continue;

    if (await gitignoreExists(gitignorePath)) {
      manualRepositories.push({
        repoId: repo.repoId,
        repoPath: repo.repoPath,
        gitignorePath,
        patterns,
        reason: 'existing .gitignore is user-authored; skillrepo will not rewrite or interpret its rule ordering',
      });
      continue;
    }

    const plan = { repoId: repo.repoId, repoPath: repo.repoPath, gitignorePath, patterns };
    repositories.push(plan);
    if (dryRun) continue;

    const text = newGitignoreText(patterns);
    const proof = await writeNewGitignore(gitignorePath, text);
    try {
      const observedPaths = candidates.flatMap(candidate => candidate.paths);
      const ignored = await probeIgnoredPaths({ gitPath, env: { ...env } }, repo.repoPath, observedPaths);
      const missing = observedPaths.filter(path => !ignored.has(path));
      if (missing.length) {
        throw new Error(
          `Created ${gitignorePath}, but Git verification did not ignore all observed paths: ${missing.join(', ')}`,
        );
      }
    } catch (error) {
      const rolledBack = await rollbackCreatedGitignore(gitignorePath, proof);
      if (!rolledBack) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; rollback was skipped because ${gitignorePath} no longer matched the file/content created by this invocation`,
        );
      }
      throw error;
    }
  }

  return {
    dryRun,
    repositories,
    manualRepositories,
    patterns: repositories.reduce((sum, repo) => sum + repo.patterns.length, 0),
  };
}

export function renderMigrationIgnore(result: MigrationIgnoreResult): string {
  const lines = [
    `Migration ignore ${result.dryRun ? 'dry-run' : 'applied'}: ${result.patterns} pattern(s) across ${result.repositories.length} repo(s); ${result.manualRepositories.length} repo(s) require manual review`,
  ];
  for (const repo of result.repositories) lines.push(`${repo.repoId}: ${repo.patterns.join(', ')}`);
  for (const repo of result.manualRepositories) {
    lines.push(`[MANUAL] ${repo.repoId}: ${repo.patterns.join(', ')} — ${repo.reason}`);
  }
  if (result.dryRun) lines.push('No .gitignore files were changed. Existing .gitignore files are never auto-rewritten.');
  else lines.push('Only brand-new .gitignore files were created and verified with Git. Failed verification rolls back an unchanged skillrepo-created file; existing .gitignore files and Git metadata were not changed.');
  return lines.join('\n');
}
