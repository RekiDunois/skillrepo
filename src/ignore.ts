import { lstat, open } from 'node:fs/promises';
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
  '.ms-playwright/',
  'chrome-profile/',
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

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function existingPatterns(text: string): { patterns: Set<string>; hasNegation: boolean } {
  const rules = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  return {
    patterns: new Set(rules),
    hasNegation: rules.some(line => line.startsWith('!')),
  };
}

function appendPatterns(existing: string, patterns: string[]): string {
  if (!patterns.length) return existing;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  const spacer = prefix.length === 0 || prefix.endsWith('\n\n') ? '' : '\n';
  return `${prefix}${spacer}# skillrepo: generated runtime/cache ignores\n${patterns.join('\n')}\n`;
}

async function readGitignore(path: string): Promise<{ exists: boolean; text: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
  if (!info.isFile()) throw new Error(`Refusing to use non-regular .gitignore: ${path}`);

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Refusing to use non-regular .gitignore: ${path}`);
    return { exists: true, text: await handle.readFile({ encoding: 'utf8' }) };
  } finally {
    await handle.close();
  }
}

async function writeGitignore(path: string, text: string, existed: boolean): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = existed
    ? constants.O_WRONLY | constants.O_TRUNC | noFollow
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  const handle = await open(path, flags, 0o666);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Refusing to write non-regular .gitignore: ${path}`);
    await handle.writeFile(text, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
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
    const current = await readGitignore(gitignorePath);
    const present = existingPatterns(current.text);

    // Negation makes effective ignore semantics order-dependent. Do not append any
    // generated rules, because doing so could override an explicit user exception.
    if (present.hasNegation) continue;

    const patterns = repo.ignoreCandidates
      .map(candidate => candidate.pattern)
      .filter(pattern => SAFE_AUTO_IGNORE_PATTERNS.has(pattern) && !present.patterns.has(pattern))
      .sort();

    if (!patterns.length) continue;
    repositories.push({ repoId: repo.repoId, repoPath: repo.repoPath, gitignorePath, patterns });
    if (!dryRun) await writeGitignore(gitignorePath, appendPatterns(current.text, patterns), current.exists);
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
