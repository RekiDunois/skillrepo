import { spawn } from 'node:child_process';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOpenCodeSkills, inspectRepo, type DiscoveredOpenCodeSkill } from './core.js';
import { parseFrontmatter, stableSkillId } from './frontmatter.js';
import { analyzeSkillBoundary } from './apm_boundary.js';

// Strictly read-only APM migration-readiness audit (issue #40). The audit
// inventories the skills visible to the current OpenCode environment, resolves
// one trustworthy authoritative authoring source per skill through the #36
// authoring-source locator, and classifies packaging readiness as DIRECT,
// NEEDS_CHANGES, or BLOCKED. It never migrates, rewrites, registers,
// installs, or otherwise mutates user state.

export type ApmAuditClassification = 'DIRECT' | 'NEEDS_CHANGES' | 'BLOCKED';

export type ApmAuditFinding = {
  code: string;
  detail: string;
  path?: string;
  relatedPath?: string;
};

export type ApmAuditConsumerMatch = {
  path: string;
  origin?: string;
};

export type ApmAuditSkill = {
  skillId: string;
  classification: ApmAuditClassification;
  authoritativeSource: string | null;
  repoRoot: string | null;
  sourceRoot: string | null;
  layout: 'skillrepo' | 'apm' | 'unknown';
  alreadyPackaged: boolean;
  consumerMatches: ApmAuditConsumerMatch[];
  findings: ApmAuditFinding[];
  relatedSkills: string[];
};

export type ApmAuditResult = {
  schemaVersion: 1;
  summary: {
    skills: number;
    direct: number;
    needsChanges: number;
    blocked: number;
  };
  skills: ApmAuditSkill[];
};

const BLOCKING_FINDING_CODES: ReadonlySet<string> = new Set([
  'authoritative-source-not-found',
  'authoritative-source-ambiguous',
  'invalid-frontmatter',
  'skill-identity-mismatch',
  'skill-id-collision',
  'ambiguous-repo-layout',
  'unsupported-source-layout',
  'package-boundary-unknown',
]);

const NEEDS_CHANGE_FINDING_CODES: ReadonlySet<string> = new Set([
  'absolute-home-path',
  'local-runtime-environment',
  'absolute-symlink',
  'external-symlink',
  'shared-resource-boundary',
  'external-runtime-path',
]);

// One reducer owns classification: BLOCKED > NEEDS_CHANGES > DIRECT. DIRECT
// means only that skillrepo currently knows of no source-content or
// package-boundary change required before APM packaging; it is not a
// deployment or runtime compatibility guarantee.
export function classifySkill(findings: readonly ApmAuditFinding[]): ApmAuditClassification {
  if (findings.some(finding => BLOCKING_FINDING_CODES.has(finding.code))) return 'BLOCKED';
  if (findings.some(finding => NEEDS_CHANGE_FINDING_CODES.has(finding.code))) return 'NEEDS_CHANGES';
  return 'DIRECT';
}

type LocatorConsumerMatch = { path: string; origin?: string };

type LocatorOutcome =
  | {
    status: 'resolved';
    path: string;
    sourceRoot: string | null;
    repoRoot: string | null;
    layout: string;
    consumerMatches: LocatorConsumerMatch[];
  }
  | { status: 'not-found'; consumerMatches: LocatorConsumerMatch[] }
  | { status: 'ambiguous'; candidates: string[]; consumerMatches: LocatorConsumerMatch[] };

// The source-resolution side is a thin adapter over the #36 authoring-source
// contract: one locator invocation per distinct discovered skill. Root
// discovery, consumer/authoring classification, and ambiguity handling stay
// inside the locator; this module only maps its outcomes into audit findings.
function locatorScriptPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'skills',
    'skill-development-location',
    'scripts',
    'locate-resource.mjs',
  );
}

function normalizeConsumerMatches(value: unknown): LocatorConsumerMatch[] {
  if (!Array.isArray(value)) return [];
  const matches: LocatorConsumerMatch[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) continue;
    const match: LocatorConsumerMatch = { path: resolve(record.path) };
    if (typeof record.origin === 'string' && record.origin.trim()) match.origin = record.origin;
    matches.push(match);
  }
  return matches.sort((left, right) => left.path.localeCompare(right.path) || (left.origin ?? '').localeCompare(right.origin ?? ''));
}

function structuredLocatorError(stderr: string): Record<string, unknown> | undefined {
  const marker = '\nlocate-resource: ';
  const index = stderr.indexOf(marker);
  if (index <= 0) return undefined;
  try {
    const parsed = JSON.parse(stderr.slice(0, index)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function locatorFailureMessage(stderr: string): string {
  const marker = 'locate-resource: ';
  const index = stderr.lastIndexOf(marker);
  if (index < 0) return stderr.trim();
  return stderr.slice(index + marker.length).trim();
}

async function runLocatorProcess(skillId: string, projectRoot: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [locatorScriptPath(), '--kind', 'skill', '--name', skillId, '--project-root', projectRoot, '--authoring'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

async function invokeAuthoringLocator(skillId: string, projectRoot: string, env: NodeJS.ProcessEnv): Promise<LocatorOutcome> {
  const result = await runLocatorProcess(skillId, projectRoot, env);

  if (result.code === 0) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`Authoritative source locator returned unparseable output for skill '${skillId}'`);
    }
    if (!parsed || parsed.selectionMode !== 'authoring' || typeof parsed.path !== 'string') {
      throw new Error(`Authoritative source locator returned an unexpected result for skill '${skillId}'`);
    }
    return {
      status: 'resolved',
      path: resolve(parsed.path),
      sourceRoot: typeof parsed.sourceRoot === 'string' ? resolve(parsed.sourceRoot) : null,
      repoRoot: typeof parsed.repoRoot === 'string' ? resolve(parsed.repoRoot) : null,
      layout: typeof parsed.layout === 'string' ? parsed.layout : 'unknown',
      consumerMatches: normalizeConsumerMatches(parsed.consumerMatches),
    };
  }

  const message = locatorFailureMessage(result.stderr);
  const structured = structuredLocatorError(result.stderr);
  if (message.includes('authoritative source not found')) {
    return { status: 'not-found', consumerMatches: normalizeConsumerMatches(structured?.consumerMatches) };
  }
  if (message.includes('resource is ambiguous')) {
    const candidates = Array.isArray(structured?.candidates)
      ? (structured.candidates as Array<Record<string, unknown>>)
        .map(candidate => typeof candidate?.path === 'string' ? resolve(candidate.path) : null)
        .filter((candidate): candidate is string => Boolean(candidate))
        .sort((left, right) => left.localeCompare(right))
      : [];
    return { status: 'ambiguous', candidates, consumerMatches: normalizeConsumerMatches(structured?.consumerMatches) };
  }
  if (message.includes('resource not found')) {
    return { status: 'not-found', consumerMatches: [] };
  }
  throw new Error(`Authoritative source locator failed for skill '${skillId}': ${message || 'unknown failure'}`);
}

type RepoContext =
  | {
    status: 'established';
    layout: 'skillrepo' | 'apm';
    repoRoot: string;
    sourceRoot: string;
    alreadyPackaged: boolean;
  }
  | { status: 'blocked'; finding: ApmAuditFinding };

// Inspection failures that restate a defect the audit already recorded for
// this skill are suppressed so one root cause is reported once.
function suppressesContextFinding(finding: ApmAuditFinding, alreadyRecorded: ReadonlySet<string>): boolean {
  if (finding.code === 'skill-id-collision' && alreadyRecorded.has('skill-id-collision')) return true;
  if ((finding.code === 'invalid-frontmatter' || finding.code === 'unsupported-source-layout')
    && alreadyRecorded.has('invalid-frontmatter')) return true;
  return false;
}

async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// Repository/layout semantics come from inspectRepo(); the audit never infers
// layout from path strings on its own. Inspection failures that name a concrete
// content defect are mapped onto the matching audit finding so the existing
// fail-closed behavior is preserved without a second taxonomy.
async function resolveRepoContext(outcome: Extract<LocatorOutcome, { status: 'resolved' }>): Promise<RepoContext> {
  const layout = outcome.layout === 'skillrepo' || outcome.layout === 'apm' ? outcome.layout : 'unknown';
  if (layout === 'unknown' || !outcome.repoRoot) {
    return {
      status: 'blocked',
      finding: {
        code: 'unsupported-source-layout',
        detail: 'no supported package/repository boundary could be established for the authoritative source',
        path: outcome.path,
      },
    };
  }

  let inventory;
  try {
    inventory = await inspectRepo(outcome.repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duplicate = message.match(/Duplicate skill ID '([^']+)'/);
    if (/multiple supported layouts|requires a regular apm\.yml/.test(message)) {
      return {
        status: 'blocked',
        finding: {
          code: 'ambiguous-repo-layout',
          detail: `repository inspection rejected the layout: ${message}`,
          path: outcome.repoRoot,
        },
      };
    }
    if (duplicate) {
      return {
        status: 'blocked',
        finding: {
          code: 'skill-id-collision',
          detail: `repository inspection rejected the source directory: ${message}`,
          path: outcome.repoRoot,
        },
      };
    }
    const namedFrontmatter = message.match(/^([^:]+): skill frontmatter name must be a string$/);
    if (namedFrontmatter) {
      return {
        status: 'blocked',
        finding: {
          code: 'invalid-frontmatter',
          detail: message,
          path: resolve(namedFrontmatter[1]!),
        },
      };
    }
    return {
      status: 'blocked',
      finding: {
        code: 'unsupported-source-layout',
        detail: `repository inspection could not establish a supported package boundary: ${message}`,
        path: outcome.repoRoot,
      },
    };
  }

  if (!inventory.skillsDir || !outcome.sourceRoot) {
    return {
      status: 'blocked',
      finding: {
        code: 'unsupported-source-layout',
        detail: 'the inspected repository does not expose a skill source directory',
        path: outcome.repoRoot,
      },
    };
  }

  const skillsDir = resolve(inventory.skillsDir);
  const sourceRoot = resolve(outcome.sourceRoot);
  const realSkillsDir = await realpathSafe(skillsDir);
  const realSourceRoot = await realpathSafe(sourceRoot);
  if (!isWithin(skillsDir, sourceRoot) && !isWithin(realSkillsDir, realSourceRoot)) {
    return {
      status: 'blocked',
      finding: {
        code: 'unsupported-source-layout',
        detail: 'authoritative source is outside the inspected repository skill source directory',
        path: outcome.path,
      },
    };
  }

  return {
    status: 'established',
    layout: inventory.layout,
    repoRoot: resolve(inventory.repo),
    sourceRoot: skillsDir,
    alreadyPackaged: inventory.layout === 'apm',
  };
}

// Stable-identity collision scan over the resolved repository source
// directory, using the same single-file identity helper as registration.
async function findStableIdCollision(sourceRoot: string, skillId: string, ownSource: string): Promise<string | null> {
  const own = resolve(ownSource);
  const walk = async (dir: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await walk(path));
      else if (entry.isFile() && basename(path) === 'SKILL.md') found.push(path);
    }
    return found;
  };

  const candidates = (await walk(sourceRoot)).sort((left, right) => left.localeCompare(right));
  for (const path of candidates) {
    if (resolve(path) === own) continue;
    try {
      const document = parseFrontmatter(await readFile(path, 'utf8'));
      if (stableSkillId(document.data, path) === skillId) return path;
    } catch {
      // Files with invalid frontmatter are separate skills with their own
      // audit outcomes; they cannot contribute a stable identity here.
    }
  }
  return null;
}

function compareFindings(left: ApmAuditFinding, right: ApmAuditFinding): number {
  return left.code.localeCompare(right.code)
    || (left.path ?? '').localeCompare(right.path ?? '')
    || (left.relatedPath ?? '').localeCompare(right.relatedPath ?? '')
    || left.detail.localeCompare(right.detail);
}

async function auditSkill(
  discovered: DiscoveredOpenCodeSkill,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  resourceOwners: Map<string, Set<string>>,
  skillResources: Map<string, string[]>,
): Promise<ApmAuditSkill> {
  const findings: ApmAuditFinding[] = [];
  let authoritativeSource: string | null = null;
  let sourceRoot: string | null = null;
  let repoRoot: string | null = null;
  let layout: 'skillrepo' | 'apm' | 'unknown' = 'unknown';
  let alreadyPackaged = false;
  let consumerMatches: ApmAuditConsumerMatch[] = [];

  const outcome = await invokeAuthoringLocator(discovered.id, projectRoot, env);
  consumerMatches = outcome.consumerMatches;

  if (outcome.status === 'not-found') {
    findings.push({
      code: 'authoritative-source-not-found',
      detail: `no authoritative authoring source was found for skill '${discovered.id}'`,
      ...(discovered.location ? { path: discovered.location } : {}),
    });
  } else if (outcome.status === 'ambiguous') {
    findings.push({
      code: 'authoritative-source-ambiguous',
      detail: `${outcome.candidates.length} authoritative sources match skill '${discovered.id}'`,
      ...(outcome.candidates.length ? { path: outcome.candidates[0] } : {}),
      ...(outcome.candidates.length > 1 ? { relatedPath: outcome.candidates[1] } : {}),
    });
  } else {
    authoritativeSource = outcome.path;
    sourceRoot = outcome.sourceRoot;

    let stableId: string | null = null;
    let invalidFrontmatter = false;
    try {
      const document = parseFrontmatter(await readFile(authoritativeSource, 'utf8'));
      stableId = stableSkillId(document.data, authoritativeSource);
    } catch (error) {
      invalidFrontmatter = true;
      findings.push({
        code: 'invalid-frontmatter',
        detail: error instanceof Error ? error.message : String(error),
        path: authoritativeSource,
      });
    }
    if (stableId !== null && stableId !== discovered.id) {
      findings.push({
        code: 'skill-identity-mismatch',
        detail: `OpenCode exposes skill '${discovered.id}' but the authoritative source identity is '${stableId}'`,
        path: authoritativeSource,
      });
    }

    // The collision scan only needs the resolved source directory, so it runs
    // ahead of repository inspection and reports precise path evidence.
    let collisionRecorded = false;
    if (stableId !== null && outcome.sourceRoot) {
      const collision = await findStableIdCollision(outcome.sourceRoot, stableId, authoritativeSource);
      if (collision) {
        collisionRecorded = true;
        findings.push({
          code: 'skill-id-collision',
          detail: `stable skill identity '${stableId}' is also exposed by ${collision}`,
          path: authoritativeSource,
          relatedPath: collision,
        });
      }
    }

    const context = await resolveRepoContext(outcome);
    if (context.status === 'blocked') {
      const recorded = new Set(findings.map(finding => finding.code));
      if (!suppressesContextFinding(context.finding, recorded)) findings.push(context.finding);
    } else {
      layout = context.layout;
      repoRoot = context.repoRoot;
      sourceRoot = context.sourceRoot;
      alreadyPackaged = context.alreadyPackaged;

      const boundary = await analyzeSkillBoundary({
        skillDir: dirname(authoritativeSource),
        repoRoot: context.repoRoot,
        env,
      });
      findings.push(...boundary.findings);
      if (boundary.sharedResources.length) skillResources.set(discovered.id, boundary.sharedResources);
      for (const resource of boundary.sharedResources) {
        const owners = resourceOwners.get(resource) ?? new Set<string>();
        owners.add(discovered.id);
        resourceOwners.set(resource, owners);
      }
    }
  }

  findings.sort(compareFindings);
  return {
    skillId: discovered.id,
    classification: classifySkill(findings),
    authoritativeSource,
    repoRoot,
    sourceRoot,
    layout,
    alreadyPackaged,
    consumerMatches,
    findings,
    relatedSkills: [],
  };
}

export async function auditApmReadiness(options: {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ApmAuditResult> {
  const env = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const discovered = await discoverOpenCodeSkills(env);

  const resourceOwners = new Map<string, Set<string>>();
  const skillResources = new Map<string, string[]>();
  const skills: ApmAuditSkill[] = [];
  for (const entry of discovered) {
    skills.push(await auditSkill(entry, projectRoot, env, resourceOwners, skillResources));
  }

  for (const skill of skills) {
    const related = new Set<string>();
    for (const resource of skillResources.get(skill.skillId) ?? []) {
      for (const owner of resourceOwners.get(resource) ?? []) {
        if (owner !== skill.skillId) related.add(owner);
      }
    }
    skill.relatedSkills = [...related].sort((left, right) => left.localeCompare(right));
  }

  skills.sort((left, right) => left.skillId.localeCompare(right.skillId));

  return {
    schemaVersion: 1,
    summary: {
      skills: skills.length,
      direct: skills.filter(skill => skill.classification === 'DIRECT').length,
      needsChanges: skills.filter(skill => skill.classification === 'NEEDS_CHANGES').length,
      blocked: skills.filter(skill => skill.classification === 'BLOCKED').length,
    },
    skills,
  };
}

const READ_ONLY_NOTE = 'Read-only audit: no source files, OpenCode config, .gitignore, apm.yml, registration state, migration journals, or Git metadata were changed.';

export function renderApmAudit(result: ApmAuditResult): string {
  const lines: string[] = [
    'APM AUDIT',
    '',
    `DIRECT: ${result.summary.direct}`,
    `NEEDS_CHANGES: ${result.summary.needsChanges}`,
    `BLOCKED: ${result.summary.blocked}`,
  ];

  for (const classification of ['DIRECT', 'NEEDS_CHANGES', 'BLOCKED'] as const) {
    const group = result.skills.filter(skill => skill.classification === classification);
    if (!group.length) continue;
    lines.push('', `${classification} (${group.length} ${group.length === 1 ? 'skill' : 'skills'})`);
    for (const skill of group) {
      lines.push(`  ${skill.skillId}`);
      lines.push(`    source: ${skill.authoritativeSource ?? '(none)'}`);
      lines.push(`    layout: ${skill.layout}`);
      lines.push(`    repo root: ${skill.repoRoot ?? '(none)'}`);
      if (skill.alreadyPackaged) lines.push('    already packaged: yes');
      if (skill.findings.length) lines.push('    findings:');
      for (const finding of skill.findings) {
        const location = finding.path ?? '-';
        const related = finding.relatedPath ? ` -> ${finding.relatedPath}` : '';
        lines.push(`      ${finding.code} ${location}${related} — ${finding.detail}`);
      }
      for (const match of skill.consumerMatches) {
        lines.push(`    consumer match: ${match.path}${match.origin ? ` (${match.origin})` : ''}`);
      }
      if (skill.relatedSkills.length) lines.push(`    related skills: ${skill.relatedSkills.join(', ')}`);
    }
  }

  lines.push(READ_ONLY_NOTE);
  return lines.join('\n');
}
