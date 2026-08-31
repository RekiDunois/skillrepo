import { createReadStream } from 'node:fs';
import { access, lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type AuditSeverity = 'blocker' | 'review';

export type AuditFinding = {
  severity: AuditSeverity;
  code: string;
  path: string;
  detail: string;
  suggestedIgnore?: string;
};

export type AuditIgnoreCandidate = {
  pattern: string;
  paths: string[];
};

export type RepoAudit = {
  repoId: string;
  repoPath: string;
  exists: boolean;
  gitignorePresent: boolean;
  stats: {
    files: number;
    directories: number;
    symlinks: number;
    bytes: number;
    prunedNoiseDirectories: number;
  };
  findings: AuditFinding[];
  ignoreCandidates: AuditIgnoreCandidate[];
  readyForInitialCommit: boolean;
};

export type MigrationAuditResult = {
  schemaVersion: 1;
  planPath: string;
  targetRoot: string;
  repositories: RepoAudit[];
  summary: {
    repositories: number;
    blockers: number;
    reviews: number;
    ignorePatterns: number;
  };
  readyForInitialCommit: boolean;
};

type MinimalRepoPlan = { id: string; action: string };
type MinimalMigrationPlan = { schemaVersion: number; repositories: MinimalRepoPlan[] };

type MutableRepoAudit = Omit<RepoAudit, 'ignoreCandidates' | 'readyForInitialCommit'> & {
  ignoreMap: Map<string, Set<string>>;
  existingIgnorePatterns: Set<string>;
};

const BLOCKER_BYTES = 100 * 1024 * 1024;
const REVIEW_BYTES = 10 * 1024 * 1024;
const STREAM_SCAN_OVERLAP = 8192;

const NOISE_DIRECTORIES = new Map<string, string>([
  ['node_modules', 'node_modules/'],
  ['.venv', '.venv/'],
  ['venv', 'venv/'],
  ['__pycache__', '__pycache__/'],
  ['.pytest_cache', '.pytest_cache/'],
  ['.mypy_cache', '.mypy_cache/'],
  ['.ruff_cache', '.ruff_cache/'],
  ['.tox', '.tox/'],
  ['.nox', '.nox/'],
  ['.ms-playwright', '.ms-playwright/'],
  ['chrome-profile', 'chrome-profile/'],
]);

const LOCAL_RUNTIME_ENV_DIRS = new Set(['.venv', 'venv']);

const TEXT_EXTENSIONS = new Set([
  '', '.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.fish', '.rb', '.go', '.rs',
  '.java', '.kt', '.kts', '.swift', '.html', '.htm', '.css', '.scss', '.xml', '.csv', '.sql', '.graphql', '.gql',
  '.properties', '.lock', '.gitignore', '.npmrc', '.pypirc', '.dockerignore',
]);

const HIGH_CONFIDENCE_SECRETS: Array<{ code: string; label: string; pattern: RegExp }> = [
  { code: 'private-key-content', label: 'private key material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { code: 'github-token-content', label: 'GitHub token-shaped literal', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { code: 'aws-access-key-content', label: 'AWS access-key-shaped literal', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { code: 'slack-token-content', label: 'Slack token-shaped literal', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: 'openai-key-content', label: 'API key-shaped sk- literal', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code: 'google-api-key-content', label: 'Google API key-shaped literal', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { code: 'credential-url-content', label: 'URL containing inline credentials', pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@/ },
  { code: 'bearer-token-content', label: 'Bearer token-shaped literal', pattern: /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~-]{20,}/i },
];

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function toPosix(path: string): string { return path.split(sep).join('/'); }
function repoRelative(repoRoot: string, path: string): string { return toPosix(relative(repoRoot, path)) || '.'; }
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function addFinding(audit: MutableRepoAudit, finding: AuditFinding): void {
  if (!audit.findings.some(item => item.code === finding.code && item.path === finding.path)) audit.findings.push(finding);
}

function addIgnore(audit: MutableRepoAudit, pattern: string, path: string): void {
  if (audit.existingIgnorePatterns.has(pattern)) return;
  const paths = audit.ignoreMap.get(pattern) ?? new Set<string>();
  paths.add(path);
  audit.ignoreMap.set(pattern, paths);
}

function parseExistingIgnore(text: string): Set<string> {
  return new Set(text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
}

function sensitivePathFinding(relPath: string): AuditFinding | null {
  const base = basename(relPath).toLowerCase();
  const ext = extname(base);
  const envSafe = new Set(['.env.example', '.env.sample', '.env.template']);
  if ((base === '.env' || base.startsWith('.env.')) && !envSafe.has(base)) return { severity: 'blocker', code: 'sensitive-env-path', path: relPath, detail: 'environment file may contain credentials or private configuration', suggestedIgnore: base === '.env' ? '.env' : '.env.*' };
  if (base === '.netrc' || ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].includes(base)) return { severity: 'blocker', code: 'sensitive-credential-path', path: relPath, detail: 'credential/private-key filename must be reviewed before Git initialization', suggestedIgnore: `/${relPath}` };
  if (/^(?:credentials?|service-account|service_account|tokens?|cookies?|storage-state|storage_state|auth-state|auth_state)(?:[._-].*)?\.json$/i.test(base) || /^secrets?(?:[._-].*)?$/i.test(base)) return { severity: 'blocker', code: 'sensitive-state-path', path: relPath, detail: 'credential/session/state filename may contain private material', suggestedIgnore: `/${relPath}` };
  if (ext === '.key' || ext === '.p12' || ext === '.pfx') return { severity: 'blocker', code: 'sensitive-key-path', path: relPath, detail: `${ext} files commonly contain private key material`, suggestedIgnore: `/${relPath}` };
  if (ext === '.pem' || base === '.npmrc' || base === '.pypirc') return { severity: 'review', code: 'credential-config-path', path: relPath, detail: 'file type may be safe or may contain credentials; inspect before first commit' };
  return null;
}

function noiseFilePattern(base: string): string | null {
  const lower = base.toLowerCase();
  if (base === '.DS_Store') return '.DS_Store';
  if (lower === 'thumbs.db') return 'Thumbs.db';
  if (/\.py[co]$/i.test(base)) return '*.py[cod]';
  if (/\.log$/i.test(base)) return '*.log';
  if (/\.(?:tmp|temp)$/i.test(base)) return '*.tmp';
  if (/\.(?:swp|swo)$/i.test(base)) return '*.swp';
  if (base === '.coverage') return '.coverage';
  if (lower === 'coverage.xml') return 'coverage.xml';
  if (/^(?:npm-debug|yarn-debug|yarn-error|pnpm-debug)\.log/i.test(base)) return '*-debug.log*';
  return null;
}

function shouldScanContent(path: string): boolean {
  const base = basename(path);
  return ['Dockerfile', 'Makefile', 'Justfile'].includes(base) || TEXT_EXTENSIONS.has(extname(base).toLowerCase());
}

function looksPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return value.includes('${') || value.includes('{{') || value.includes('<') || lower.includes('example') || lower.includes('placeholder') || lower.includes('changeme') || lower.includes('your_') || lower.includes('your-') || lower.includes('dummy') || lower.includes('redacted') || lower.includes('xxxxx') || lower.includes('*****') || /^test[-_]/i.test(value);
}

function scanTextContent(audit: MutableRepoAudit, relPath: string, text: string): void {
  for (const detector of HIGH_CONFIDENCE_SECRETS) {
    detector.pattern.lastIndex = 0;
    if (detector.pattern.test(text)) addFinding(audit, { severity: 'blocker', code: detector.code, path: relPath, detail: detector.label });
  }
  const literal = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*["']?([^"'\s#,;]{12,})/gi;
  for (const match of text.matchAll(literal)) {
    const value = match[2] ?? '';
    if (!value || looksPlaceholder(value)) continue;
    addFinding(audit, { severity: 'review', code: 'credential-like-literal', path: relPath, detail: 'credential-like assignment contains a non-placeholder literal; value is intentionally not shown' });
    break;
  }
  if (/\/Users\/[^/\s'"`]+\/|\/home\/[^/\s'"`]+\/|[A-Za-z]:\\Users\\[^\\\s'"`]+\\/.test(text)) addFinding(audit, { severity: 'review', code: 'absolute-home-path', path: relPath, detail: 'contains an absolute user-home path; review for privacy and portability' });
}

async function scanTextFile(audit: MutableRepoAudit, relPath: string, path: string): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let carry = '';
  try {
    for await (const chunk of stream) {
      const text = `${carry}${chunk}`;
      if (text.includes('\u0000')) { stream.destroy(); return; }
      scanTextContent(audit, relPath, text);
      carry = text.slice(-STREAM_SCAN_OVERLAP);
    }
  } catch { /* path/type checks still apply if content is unreadable */ }
}

async function scanEntry(audit: MutableRepoAudit, repoRoot: string, path: string): Promise<void> {
  const entryStat = await lstat(path);
  const relPath = repoRelative(repoRoot, path);
  if (entryStat.isSymbolicLink()) {
    audit.stats.symlinks += 1;
    const rawTarget = await readlink(path);
    const resolvedTarget = resolve(join(path, '..'), rawTarget);
    try { await stat(path); } catch { addFinding(audit, { severity: 'review', code: 'broken-symlink', path: relPath, detail: 'symlink target does not currently resolve' }); return; }
    if (isAbsolute(rawTarget)) addFinding(audit, { severity: 'review', code: 'absolute-symlink', path: relPath, detail: 'absolute symlink is machine-specific and may expose a local path' });
    else if (!within(repoRoot, resolvedTarget)) addFinding(audit, { severity: 'review', code: 'external-symlink', path: relPath, detail: 'relative symlink resolves outside the repository' });
    return;
  }
  if (entryStat.isDirectory()) {
    audit.stats.directories += 1;
    const name = basename(path);
    if (name === '.git') {
      addFinding(audit, { severity: relPath === '.git' ? 'review' : 'blocker', code: relPath === '.git' ? 'git-already-initialized' : 'embedded-git', path: relPath, detail: relPath === '.git' ? 'repository already contains Git metadata' : 'nested Git metadata would create ambiguous provenance or an embedded-repository gitlink' });
      return;
    }
    const ignorePattern = NOISE_DIRECTORIES.get(name);
    if (ignorePattern) {
      audit.stats.prunedNoiseDirectories += 1;
      addIgnore(audit, ignorePattern, relPath);
      if (LOCAL_RUNTIME_ENV_DIRS.has(name)) addFinding(audit, { severity: 'review', code: 'local-runtime-environment', path: relPath, detail: 'local virtual environment should not be committed; ensure dependencies are reproducible without it' });
      return;
    }
    for (const entry of await readdir(path, { withFileTypes: true })) await scanEntry(audit, repoRoot, join(path, entry.name));
    return;
  }
  if (!entryStat.isFile()) return;
  audit.stats.files += 1;
  audit.stats.bytes += entryStat.size;
  const base = basename(path);
  const sensitive = sensitivePathFinding(relPath);
  if (sensitive) addFinding(audit, sensitive);
  const noisePattern = noiseFilePattern(base);
  if (noisePattern) addIgnore(audit, noisePattern, relPath);
  if (base === '.git' && relPath !== '.git') addFinding(audit, { severity: 'blocker', code: 'embedded-git', path: relPath, detail: 'nested .git file indicates embedded Git metadata or worktree linkage' });
  if (entryStat.size >= BLOCKER_BYTES) addFinding(audit, { severity: 'blocker', code: 'oversize-file', path: relPath, detail: `file is ${(entryStat.size / 1024 / 1024).toFixed(1)} MiB (GitHub hard limit risk)` });
  else if (entryStat.size >= REVIEW_BYTES) addFinding(audit, { severity: 'review', code: 'large-file', path: relPath, detail: `file is ${(entryStat.size / 1024 / 1024).toFixed(1)} MiB; confirm it belongs in source control` });
  if (shouldScanContent(path)) await scanTextFile(audit, relPath, path);
}

async function readPlan(planPath: string): Promise<MinimalMigrationPlan> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(planPath, 'utf8')); } catch (error) { throw new Error(`Migration plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!raw || typeof raw !== 'object') throw new Error('Migration plan must be a JSON object');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error(`Unsupported migration plan schemaVersion: ${String(value.schemaVersion)}`);
  if (!Array.isArray(value.repositories)) throw new Error('Migration plan repositories must be an array');
  const repositories = value.repositories.map((item, index): MinimalRepoPlan => {
    if (!item || typeof item !== 'object') throw new Error(`repositories[${index}] must be an object`);
    const repo = item as Record<string, unknown>;
    if (typeof repo.id !== 'string' || !repo.id.trim()) throw new Error(`repositories[${index}].id is missing`);
    if (typeof repo.action !== 'string' || !repo.action.trim()) throw new Error(`repositories[${index}].action is missing`);
    if (basename(repo.id) !== repo.id || repo.id === '.' || repo.id === '..' || !/^[A-Za-z0-9._-]+$/.test(repo.id)) throw new Error(`Unsafe repository id in migration plan: ${repo.id}`);
    return { id: repo.id, action: repo.action };
  });
  return { schemaVersion: 1, repositories };
}

async function auditRepo(repoId: string, targetRoot: string): Promise<RepoAudit> {
  const repoPath = resolve(targetRoot, repoId);
  const repoExists = await exists(repoPath);
  const mutable: MutableRepoAudit = { repoId, repoPath, exists: repoExists, gitignorePresent: false, stats: { files: 0, directories: 0, symlinks: 0, bytes: 0, prunedNoiseDirectories: 0 }, findings: [], ignoreMap: new Map(), existingIgnorePatterns: new Set() };
  if (!repoExists) addFinding(mutable, { severity: 'blocker', code: 'missing-repository', path: '.', detail: 'planned migrated repository does not exist at the target root' });
  else {
    const rootStat = await lstat(repoPath);
    if (!rootStat.isDirectory()) addFinding(mutable, { severity: 'blocker', code: 'repository-not-directory', path: '.', detail: 'planned repository path is not a directory' });
    else {
      const gitignore = join(repoPath, '.gitignore');
      if (await exists(gitignore)) { mutable.gitignorePresent = true; mutable.existingIgnorePatterns = parseExistingIgnore(await readFile(gitignore, 'utf8')); }
      for (const entry of await readdir(repoPath, { withFileTypes: true })) await scanEntry(mutable, repoPath, join(repoPath, entry.name));
    }
  }
  for (const finding of mutable.findings) if (finding.suggestedIgnore && !mutable.existingIgnorePatterns.has(finding.suggestedIgnore)) addIgnore(mutable, finding.suggestedIgnore, finding.path);
  const ignoreCandidates = [...mutable.ignoreMap.entries()].map(([pattern, paths]) => ({ pattern, paths: [...paths].sort() })).sort((left, right) => left.pattern.localeCompare(right.pattern));
  const findings = [...mutable.findings].sort((left, right) => left.severity !== right.severity ? (left.severity === 'blocker' ? -1 : 1) : left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { repoId, repoPath, exists: mutable.exists, gitignorePresent: mutable.gitignorePresent, stats: mutable.stats, findings, ignoreCandidates, readyForInitialCommit: findings.length === 0 && ignoreCandidates.length === 0 };
}

export async function auditMigrationRepos(options: { planPath: string; targetRoot: string }): Promise<MigrationAuditResult> {
  const planPath = resolve(expandHome(options.planPath));
  const targetRoot = resolve(expandHome(options.targetRoot));
  const plan = await readPlan(planPath);
  const repoIds = [...new Set(plan.repositories.filter(repo => repo.action === 'CREATE_AND_MOVE').map(repo => repo.id))];
  if (!repoIds.length) throw new Error('Migration plan has no CREATE_AND_MOVE repositories to audit');
  const repositories: RepoAudit[] = [];
  for (const repoId of repoIds) repositories.push(await auditRepo(repoId, targetRoot));
  const blockers = repositories.reduce((sum, repo) => sum + repo.findings.filter(finding => finding.severity === 'blocker').length, 0);
  const reviews = repositories.reduce((sum, repo) => sum + repo.findings.filter(finding => finding.severity === 'review').length, 0);
  const ignorePatterns = repositories.reduce((sum, repo) => sum + repo.ignoreCandidates.length, 0);
  return { schemaVersion: 1, planPath, targetRoot, repositories, summary: { repositories: repositories.length, blockers, reviews, ignorePatterns }, readyForInitialCommit: repositories.every(repo => repo.readyForInitialCommit) };
}

export function renderMigrationAudit(result: MigrationAuditResult): string {
  const lines: string[] = [`Migration commit-readiness audit: ${result.repositories.length} repo(s)`];
  for (const repo of result.repositories) {
    const blockers = repo.findings.filter(finding => finding.severity === 'blocker').length;
    const reviews = repo.findings.filter(finding => finding.severity === 'review').length;
    const status = repo.readyForInitialCommit ? 'READY' : blockers ? 'BLOCKED' : 'REVIEW';
    lines.push(`${repo.repoId}: ${status} (${blockers} blocker, ${reviews} review, ${repo.ignoreCandidates.length} ignore suggestion)`);
    for (const finding of repo.findings) lines.push(`  [${finding.severity === 'blocker' ? 'BLOCK' : 'REVIEW'}] ${finding.path} — ${finding.code}: ${finding.detail}`);
    for (const candidate of repo.ignoreCandidates) { const example = candidate.paths.slice(0, 3).join(', '); const more = candidate.paths.length > 3 ? ` (+${candidate.paths.length - 3} more)` : ''; lines.push(`  [IGNORE] ${candidate.pattern} — observed: ${example}${more}`); }
  }
  lines.push(`Summary: ${result.summary.blockers} blocker(s), ${result.summary.reviews} review item(s), ${result.summary.ignorePatterns} ignore suggestion(s)`);
  lines.push(`COMMIT-READY: ${result.readyForInitialCommit ? 'YES' : 'NO'}`);
  lines.push('Read-only audit: no .gitignore, Git metadata, or repository contents were changed.');
  return lines.join('\n');
}
