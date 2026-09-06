import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { containsSensitiveCredentialText, detectTextAuditFindings } from './audit.js';

// Focused package-boundary evidence analysis for one authoritative skill
// directory (issue #40). The module only reports relationships supported by
// concrete filesystem/source/path evidence: symlink targets, explicit absolute
// and `~`-relative path literals, explicit `./` and `../` references, and
// concrete environment-variable paths. It never infers dependencies from
// Markdown prose and never writes to the filesystem.

export type BoundaryRelation = 'inside-skill' | 'inside-repo' | 'outside-repo';

export type BoundaryEvidence = {
  fromFile: string;
  line: number;
  literal: string;
  resolvedPath: string;
  relation: BoundaryRelation;
};

export type BoundaryFinding = {
  code: string;
  detail: string;
  path?: string;
  relatedPath?: string;
};

export type BoundaryAnalysis = {
  evidence: BoundaryEvidence[];
  findings: BoundaryFinding[];
  // Canonical identities of shared in-repository resources referenced from
  // outside the individual skill directory. Consumers use these to populate
  // grouping evidence such as relatedSkills.
  sharedResources: string[];
};

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const HOME_PATH_LITERAL = /\/(?:Users|home)\/[^/]+(?:\/|$)|[A-Za-z]:[\\/]Users[\\/][^\\/]+(?:[\\/]|$)/i;

const ABSOLUTE_PATH_LITERAL = /(?<![\w.\-:/])\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*/g;
const WINDOWS_PATH_LITERAL = /(?<![\w.\-:/])[A-Za-z]:[\\/][A-Za-z0-9._@+-]+(?:[\\/][A-Za-z0-9._@+-]+)*/g;
const HOME_TILDE_LITERAL = /(?<![\w.~])~\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*/g;
const ENV_PATH_LITERAL = /(?<![\w.])\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?:\/[A-Za-z0-9._@+-]+)+/g;
const RELATIVE_PATH_LITERAL = /(?<![\w.\/])\.{1,2}(?:\/\.{1,2})*\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*/g;

const HOME_DETAIL = 'contains an absolute user-home path; review for privacy and portability';
const ABSOLUTE_SYMLINK_DETAIL = 'absolute symlink is machine-specific and may expose a local path';
const EXTERNAL_SYMLINK_DETAIL = 'relative symlink resolves outside the repository';
const LOCAL_RUNTIME_ENV_DETAIL = 'local virtual environment should not be committed; ensure dependencies are reproducible without it';

// Findings are user-visible while evidence stays internal, so a literal that
// matches credential-shaped or placeholder-shaped content is never echoed into
// detail or relatedPath text. Evidence and shared-resource grouping keep the
// original value; classification codes are unaffected.
const REDACTED_LITERAL_DETAIL = 'path reference text is withheld because it matches credential-shaped or placeholder-shaped content';

// '${HOME}/bin' and '${VAR}/tool' carry a structural variable prefix that is
// an identifier, not secret content; credential detection examines the path
// segments behind it.
function sensitiveCheckText(literal: string): string {
  return literal.replace(/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, '');
}

function redactIfSensitive(text: string): string | null {
  return containsSensitiveCredentialText(text) ? REDACTED_LITERAL_DETAIL : null;
}

const LOCAL_RUNTIME_ENV_DIRS = new Set(['.venv', 'venv']);

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function classifyRelation(resolved: string, skillDir: string, repoRoot: string): BoundaryRelation {
  if (isWithin(skillDir, resolved)) return 'inside-skill';
  if (isWithin(repoRoot, resolved)) return 'inside-repo';
  return 'outside-repo';
}

async function canonicalResourceKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function realDirectoryEntries(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map(entry => entry.name).sort((left, right) => left.localeCompare(right));
}

class BoundaryCollector {
  evidence: BoundaryEvidence[] = [];
  findings: BoundaryFinding[] = [];
  sharedResources = new Set<string>();

  addFinding(finding: BoundaryFinding): void {
    this.findings.push(finding);
  }

  hasFinding(code: string, path: string): boolean {
    return this.findings.some(finding => finding.code === code && finding.path === path);
  }

  addEvidence(evidence: BoundaryEvidence): void {
    this.evidence.push(evidence);
  }

  async addSharedResource(resolved: string): Promise<void> {
    this.sharedResources.add(await canonicalResourceKey(resolved));
  }
}

function resolveAbsolutePathLiteral(literal: string): string {
  return resolve(literal);
}

function resolveTildePathLiteral(literal: string): string {
  return literal === '~' ? homedir() : join(homedir(), literal.slice(2));
}

function resolveEnvPathLiteral(literal: string, fromDir: string): { resolved: string } | { variable: string } {
  const match = literal.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/[A-Za-z0-9._@+-]+.*)$/);
  if (!match) return { variable: literal };
  const [, name, rest] = match;
  if (name === 'HOME') return { resolved: join(homedir(), rest!) };
  return { variable: name! };
}

async function analyzeTextFile(collector: BoundaryCollector, file: string, skillDir: string, repoRoot: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile()) return;
  if (info.size > MAX_SCAN_BYTES) return;

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return;
  }
  if (text.includes('\u0000')) return;

  // APM-relevance mapping: only portability/boundary codes affect APM
  // readiness. Publication/privacy codes stay the responsibility of the
  // migration commit-readiness audit and are deliberately not surfaced here.
  for (const finding of detectTextAuditFindings(file, text)) {
    if (finding.code === 'absolute-home-path') {
      if (!collector.hasFinding('absolute-home-path', file)) {
        collector.addFinding({ code: finding.code, detail: finding.detail, path: file });
      }
    }
  }

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const literals = collectLiterals(line);
    for (const { literal, kind } of literals) {
      if (kind === 'absolute') {
        const resolved = resolveAbsolutePathLiteral(literal);
        if (HOME_PATH_LITERAL.test(literal)) {
          // The shared absolute-home-path code already covers home literals;
          // recording external-runtime-path for the same reference would
          // duplicate the taxonomy.
          collector.addEvidence({
            fromFile: file,
            line: lineNumber,
            literal,
            resolvedPath: resolved,
            relation: classifyRelation(resolved, skillDir, repoRoot),
          });
          continue;
        }
        await recordResolvable(collector, file, lineNumber, literal, resolved, skillDir, repoRoot);
        continue;
      }
      if (kind === 'tilde') {
        await recordResolvable(collector, file, lineNumber, literal, resolveTildePathLiteral(literal), skillDir, repoRoot);
        continue;
      }
      if (kind === 'env') {
        const outcome = resolveEnvPathLiteral(literal, dirname(file));
        if ('resolved' in outcome) {
          await recordResolvable(collector, file, lineNumber, literal, outcome.resolved, skillDir, repoRoot);
        } else {
          const redacted = redactIfSensitive(sensitiveCheckText(literal));
          collector.addFinding({
            code: 'package-boundary-unknown',
            detail: redacted
              ? `${redacted}; the package boundary cannot be established without guessing`
              : `path reference '${literal}' depends on the '${outcome.variable}' environment variable; the package boundary cannot be established without guessing`,
            path: file,
          });
        }
        continue;
      }
      // relative './' or '../' reference
      await recordResolvable(collector, file, lineNumber, literal, resolve(dirname(file), literal), skillDir, repoRoot);
    }
  }
}

async function recordResolvable(
  collector: BoundaryCollector,
  fromFile: string,
  line: number,
  literal: string,
  resolved: string,
  skillDir: string,
  repoRoot: string,
): Promise<void> {
  const relation = classifyRelation(resolved, skillDir, repoRoot);
  collector.addEvidence({ fromFile, line, literal, resolvedPath: resolved, relation });
  if (relation === 'inside-skill') return;
  if (relation === 'inside-repo') {
    const canonical = await canonicalResourceKey(resolved);
    collector.addFinding({
      code: 'shared-resource-boundary',
      detail: 'references a shared repository resource outside the individual skill directory; the current repository grouping must be preserved',
      path: fromFile,
      ...(!redactIfSensitive(canonical) ? { relatedPath: canonical } : {}),
    });
    await collector.addSharedResource(resolved);
    return;
  }
  const redacted = redactIfSensitive(sensitiveCheckText(literal)) ?? redactIfSensitive(resolved);
  collector.addFinding({
    code: 'external-runtime-path',
    detail: redacted
      ? `${redacted}; it resolves outside the repository boundary`
      : `path reference '${literal}' resolves outside the repository boundary`,
    path: fromFile,
    ...(!redacted ? { relatedPath: resolve(resolved) } : {}),
  });
}

type LiteralKind = 'absolute' | 'tilde' | 'env' | 'relative';

type LineLiteral = { literal: string; kind: LiteralKind; start: number; end: number };

// Collects path-like literals from one line. Overlapping matches collapse to
// the earliest, longest token so that '${VAR}/bin' is classified once as an
// environment reference instead of also leaking '/bin' as an absolute path.
function collectLiterals(line: string): LineLiteral[] {
  const raw: LineLiteral[] = [];
  const push = (literal: string, kind: LiteralKind, start: number): void => {
    if (literal) raw.push({ literal, kind, start, end: start + literal.length });
  };

  for (const match of line.matchAll(WINDOWS_PATH_LITERAL)) push(match[0], 'absolute', match.index ?? 0);
  for (const match of line.matchAll(ABSOLUTE_PATH_LITERAL)) push(match[0], 'absolute', match.index ?? 0);
  for (const match of line.matchAll(HOME_TILDE_LITERAL)) push(match[0], 'tilde', match.index ?? 0);
  for (const match of line.matchAll(ENV_PATH_LITERAL)) push(match[0], 'env', match.index ?? 0);
  for (const match of line.matchAll(RELATIVE_PATH_LITERAL)) push(match[0], 'relative', match.index ?? 0);

  raw.sort((left, right) => left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || left.kind.localeCompare(right.kind));
  const literals: LineLiteral[] = [];
  let claimedEnd = -1;
  for (const candidate of raw) {
    if (candidate.start < claimedEnd) continue;
    literals.push(candidate);
    claimedEnd = candidate.end;
  }
  return literals;
}

async function analyzeSymlink(collector: BoundaryCollector, path: string, skillDir: string, repoRoot: string): Promise<void> {
  const rawTarget = await readlink(path);
  const resolved = resolve(dirname(path), rawTarget);
  const relation = classifyRelation(resolved, skillDir, repoRoot);
  collector.addEvidence({ fromFile: path, line: 0, literal: rawTarget, resolvedPath: resolved, relation });

  if (isAbsolute(rawTarget)) {
    collector.addFinding({ code: 'absolute-symlink', detail: ABSOLUTE_SYMLINK_DETAIL, path });
  } else if (!isWithin(repoRoot, resolved)) {
    collector.addFinding({ code: 'external-symlink', detail: EXTERNAL_SYMLINK_DETAIL, path });
  }

  if (relation === 'inside-repo') {
    const canonical = await canonicalResourceKey(resolved);
    collector.addFinding({
      code: 'shared-resource-boundary',
      detail: 'symlink target is a shared repository resource outside the individual skill directory; the current repository grouping must be preserved',
      path,
      ...(!redactIfSensitive(canonical) ? { relatedPath: canonical } : {}),
    });
    await collector.addSharedResource(resolved);
  }
}

async function analyzeDirectory(collector: BoundaryCollector, dir: string, skillDir: string, repoRoot: string): Promise<void> {
  for (const name of await realDirectoryEntries(dir)) {
    const path = join(dir, name);
    const entryStat = await lstat(path);
    if (entryStat.isSymbolicLink()) {
      await analyzeSymlink(collector, path, skillDir, repoRoot);
      continue;
    }
    if (entryStat.isDirectory()) {
      if (LOCAL_RUNTIME_ENV_DIRS.has(name)) {
        collector.addFinding({ code: 'local-runtime-environment', detail: LOCAL_RUNTIME_ENV_DETAIL, path });
        continue;
      }
      await analyzeDirectory(collector, path, skillDir, repoRoot);
      continue;
    }
    if (entryStat.isFile()) {
      await analyzeTextFile(collector, path, skillDir, repoRoot);
    }
  }
}

// Analysis is evidence-only: callers decide the classification. `stat` probes
// are avoided on regular files; symlink targets are classified lexically so a
// broken target still yields deterministic evidence.
export async function analyzeSkillBoundary(options: {
  skillDir: string;
  repoRoot: string;
}): Promise<BoundaryAnalysis> {
  const skillDir = resolve(options.skillDir);
  const repoRoot = resolve(options.repoRoot);
  const collector = new BoundaryCollector();
  await analyzeDirectory(collector, skillDir, skillDir, repoRoot);

  collector.evidence.sort((left, right) =>
    left.fromFile.localeCompare(right.fromFile)
    || left.line - right.line
    || left.literal.localeCompare(right.literal)
    || left.relation.localeCompare(right.relation));
  collector.findings.sort((left, right) =>
    left.code.localeCompare(right.code)
    || (left.path ?? '').localeCompare(right.path ?? '')
    || (left.relatedPath ?? '').localeCompare(right.relatedPath ?? '')
    || left.detail.localeCompare(right.detail));

  return {
    evidence: collector.evidence,
    findings: collector.findings,
    sharedResources: [...collector.sharedResources].sort((left, right) => left.localeCompare(right)),
  };
}
