import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { auditMigrationRepos } from './audit.js';
import { fingerprintText } from './core.js';

export type IgnoreRepoPlan = {
  repoId: string;
  repoPath: string;
  gitignorePath: string;
  patterns: string[];
};

export type MigrationIgnoreResult = {
  dryRun: boolean;
  repositories: IgnoreRepoPlan[];
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
  '.cache/',
  '.ms-playwright/',
  'chrome-profile/',
  'playwright-report/',
  'test-results/',
  'htmlcov/',
  'coverage/',
  '.DS_Store',
  'Thumbs.db',
  '*.py[cod]',
  '*.log',
  '*.tmp',
  '*.swp',
  '.coverage',
  'coverage.xml',
  '*-debug.log*',
]);

type GitignoreSnapshot = {
  existed: boolean;
  text: string;
  fingerprint: string;
  identity?: { dev: number; ino: number };
  mode?: number;
};

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

async function readGitignoreSnapshot(repoPath: string, gitignorePath: string): Promise<GitignoreSnapshot> {
  try {
    const repoStat = await lstat(repoPath);
    if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) {
      throw new Error(`Migration ignore repository is not a real directory: ${repoPath}`);
    }
    let gitignoreStat;
    try {
      gitignoreStat = await lstat(gitignorePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return { existed: false, text: '', fingerprint: 'absent' };
    }
    if (gitignoreStat.isSymbolicLink()) throw new Error(`Refusing to write symlinked .gitignore: ${gitignorePath}`);
    if (!gitignoreStat.isFile()) throw new Error(`Migration ignore path is not a regular file: ${gitignorePath}`);
    const text = await readFile(gitignorePath, 'utf8');
    return {
      existed: true,
      text,
      fingerprint: fingerprintText(text),
      identity: { dev: Number(gitignoreStat.dev), ino: Number(gitignoreStat.ino) },
      mode: gitignoreStat.mode & 0o7777,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { existed: false, text: '', fingerprint: 'absent' };
    }
    throw error;
  }
}

async function assertGitignoreSnapshotCurrent(
  repoPath: string,
  gitignorePath: string,
  snapshot: GitignoreSnapshot,
): Promise<void> {
  const current = await readGitignoreSnapshot(repoPath, gitignorePath);
  if (
    current.existed !== snapshot.existed
    || current.fingerprint !== snapshot.fingerprint
    || (snapshot.identity && (!current.identity || current.identity.dev !== snapshot.identity.dev || current.identity.ino !== snapshot.identity.ino))
  ) {
    throw new Error(`.gitignore changed during migration ignore application: ${gitignorePath}`);
  }
}

async function writeGitignoreAtomically(
  repoPath: string,
  gitignorePath: string,
  snapshot: GitignoreSnapshot,
  text: string,
): Promise<void> {
  await assertGitignoreSnapshotCurrent(repoPath, gitignorePath, snapshot);
  const temporary = join(dirname(gitignorePath), `.${basename(gitignorePath)}.skillrepo-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: snapshot.mode ?? 0o644, flag: 'wx' });
    if (snapshot.mode !== undefined) await chmod(temporary, snapshot.mode);
    await assertGitignoreSnapshotCurrent(repoPath, gitignorePath, snapshot);
    await rename(temporary, gitignorePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function existingPatterns(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')),
  );
}

function appendPatterns(existing: string, patterns: string[]): string {
  if (!patterns.length) return existing;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  const spacer = prefix.length === 0 || prefix.endsWith('\n\n') ? '' : '\n';
  return `${prefix}${spacer}# skillrepo: generated runtime/cache ignores\n${patterns.join('\n')}\n`;
}

export async function applyMigrationIgnores(options: {
  planPath: string;
  targetRoot: string;
  dryRun?: boolean;
}): Promise<MigrationIgnoreResult> {
  const dryRun = options.dryRun ?? true;
  const audit = await auditMigrationRepos({ planPath: options.planPath, targetRoot: options.targetRoot });
  const repositories: IgnoreRepoPlan[] = [];

  for (const repo of audit.repositories) {
    if (!repo.exists) continue;
    const gitignorePath = join(repo.repoPath, '.gitignore');
    const snapshot = await readGitignoreSnapshot(repo.repoPath, gitignorePath);
    const current = snapshot.text;
    const present = existingPatterns(current);
    const patterns = repo.ignoreCandidates
      .map(candidate => candidate.pattern)
      .filter(pattern => SAFE_AUTO_IGNORE_PATTERNS.has(pattern) && !present.has(pattern))
      .sort();

    if (!patterns.length) continue;
    repositories.push({ repoId: repo.repoId, repoPath: repo.repoPath, gitignorePath, patterns });
    if (!dryRun) await writeGitignoreAtomically(repo.repoPath, gitignorePath, snapshot, appendPatterns(current, patterns));
  }

  return {
    dryRun,
    repositories,
    patterns: repositories.reduce((sum, repo) => sum + repo.patterns.length, 0),
  };
}

export function renderMigrationIgnore(result: MigrationIgnoreResult): string {
  const lines = [
    `Migration ignore ${result.dryRun ? 'dry-run' : 'applied'}: ${result.patterns} pattern(s) across ${result.repositories.length} repo(s)`,
  ];
  for (const repo of result.repositories) {
    lines.push(`${repo.repoId}: ${repo.patterns.join(', ')}`);
  }
  if (result.dryRun) lines.push('No .gitignore files were changed. Re-run with --execute only after reviewing this output.');
  else lines.push('Only .gitignore files were changed. Git was not initialized and no commit was created.');
  return lines.join('\n');
}
