import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { auditMigrationRepos } from './audit.js';

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
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
    const current = await exists(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
    const present = existingPatterns(current);
    const patterns = repo.ignoreCandidates
      .map(candidate => candidate.pattern)
      .filter(pattern => SAFE_AUTO_IGNORE_PATTERNS.has(pattern) && !present.has(pattern))
      .sort();

    if (!patterns.length) continue;
    repositories.push({ repoId: repo.repoId, repoPath: repo.repoPath, gitignorePath, patterns });
    if (!dryRun) await writeFile(gitignorePath, appendPatterns(current, patterns), 'utf8');
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
