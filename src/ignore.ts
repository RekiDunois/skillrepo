import { randomUUID } from 'node:crypto';
import { lstat, link, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
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
  '.coverage',
]);

function isSafeAutoIgnorePattern(pattern: string): boolean {
  if (SAFE_AUTO_IGNORE_PATTERNS.has(pattern)) return true;
  const lower = pattern.toLowerCase();
  if (lower === 'thumbs.db' || lower === 'coverage.xml') return true;
  if (/^\*\.(?:pyc|pyo|pyd|log|tmp|temp|swp|swo)$/.test(lower)) return true;
  return /^(?:npm-debug|yarn-debug|yarn-error|pnpm-debug)\.log$/.test(lower);
}

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

async function unlinkBestEffort(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      // A private staging path is never used as the final .gitignore. Failure to
      // clean it up must not cause skillrepo to delete or rewrite a published path.
    }
  }
}

async function publishNewGitignore(path: string, text: string): Promise<void> {
  const tempPath = join(dirname(path), `.skillrepo-gitignore-${process.pid}-${randomUUID()}.tmp`);
  const noFollow = constants.O_NOFOLLOW ?? 0;

  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o666);
    try {
      const created = await handle.stat();
      if (!created.isFile()) throw new Error(`Refusing to stage non-regular .gitignore content: ${tempPath}`);
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }

    // link() is the publish primitive because it fails with EEXIST instead of
    // replacing a .gitignore that appeared after the earlier existence check.
    try {
      await link(tempPath, path);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') {
        throw new Error(`Refusing to publish generated .gitignore because the path appeared concurrently: ${path}`);
      }
      throw error;
    }
  } finally {
    // Any create/write/sync/close/publish failure can leave only the private
    // staging name behind. The final .gitignore is never partially written.
    await unlinkBestEffort(tempPath);
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
    const repoStat = await lstat(repo.repoPath);
    if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
      throw new Error(`Migration ignore repository is not a real directory: ${repo.repoPath}`);
    }
    const candidates = repo.ignoreCandidates
      .filter(candidate => isSafeAutoIgnorePattern(candidate.pattern))
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
    const beforePublish = await lstat(repo.repoPath);
    if (!beforePublish.isDirectory() || beforePublish.isSymbolicLink()) {
      throw new Error(`Migration ignore repository changed to a symlink: ${repo.repoPath}`);
    }
    await publishNewGitignore(gitignorePath, text);

    try {
      const observedPaths = candidates.flatMap(candidate => candidate.paths);
      const ignored = await probeIgnoredPaths({ gitPath, env: { ...env } }, repo.repoPath, observedPaths);
      const missing = observedPaths.filter(path => !ignored.has(path));
      if (missing.length) {
        throw new Error(
          `Git verification did not ignore all observed paths: ${missing.join(', ')}`,
        );
      }
    } catch (error) {
      // Do not unlink a published pathname: pathname compare-and-delete is
      // inherently racy and could delete a concurrent user replacement.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; generated ${gitignorePath} was left in place for manual review because skillrepo never deletes a published .gitignore after verification starts`,
      );
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
  else lines.push('Only brand-new .gitignore files were atomically published and verified with Git. Verification failures leave the published generated file in place for manual review; skillrepo never deletes a published .gitignore.');
  return lines.join('\n');
}
