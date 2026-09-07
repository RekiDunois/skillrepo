// Shared repository-layout policy for APM packages (issue #42).
//
// This module is intentionally independent of `core.ts` so callers on both
// sides of the inventory/registration boundary can classify package layouts,
// fingerprint skill trees, and validate managed Agent Skills projections
// without importing registration logic or creating a dependency cycle.
//
// The single authoritative skill source per package is:
//   - skills-only APM package      -> <repo>/skills
//   - mixed APM package            -> <repo>/.apm/skills (root skills/ is a
//     generated, fingerprint-verified managed projection)
//   - agent-only APM package       -> none
//   - legacy repository (no apm.yml) -> <repo>/skills under the existing
//     legacy-root behavior.

import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export type PackageLayoutStrategy =
  | 'legacy-root'
  | 'apm-root-skills'
  | 'apm-canonical'
  | 'apm-canonical-with-skill-projection';

export type PackageComposition = {
  hasSkills: boolean;
  hasApmOnlyPrimitives: boolean;
};

export const APM_DIRECTORY = '.apm';
export const SKILLS_DIRECTORY = 'skills';
export const AGENTS_DIRECTORY = 'agents';
export const APM_MANIFEST_FILE = 'apm.yml';

export const PROJECTION_MARKER_NAME = '.skillrepo-projection.json';
export const PROJECTION_MARKER_SOURCE = '.apm/skills';
export const PROJECTION_MARKER_TARGET = 'skills';
export const PROJECTION_MARKER_SCHEMA_VERSION = 1;
export const PROJECTION_MARKER_OWNER = 'skillrepo';
export const PROJECTION_MARKER_KIND = 'agent-skills-projection';
export const PROJECTION_FINGERPRINT_ALGORITHM = 'sha256-tree-v1';

export type ProjectionMarker = {
  schemaVersion: number;
  owner: string;
  kind: string;
  source: string;
  target: string;
  fingerprintAlgorithm: string;
  fingerprint: string;
};

export type ProjectionValidationIssue = { code: string; detail: string };

export type ProjectionValidationResult = {
  ok: boolean;
  issues: ProjectionValidationIssue[];
};

// Selects the required target strategy for a newly generated or migrated APM
// package from its primitive composition. A package with neither skills nor
// APM-only primitives has no layout and is rejected.
export function selectLayoutStrategy(composition: PackageComposition): PackageLayoutStrategy {
  if (composition.hasSkills && composition.hasApmOnlyPrimitives) return 'apm-canonical-with-skill-projection';
  if (composition.hasSkills) return 'apm-root-skills';
  if (composition.hasApmOnlyPrimitives) return 'apm-canonical';
  throw new Error('Package composition has neither skills nor APM-only primitives');
}

// The authoritative skill directory of a newly generated package, relative to
// the repository root. Agent-only packages have no skill directory.
export function relativeSkillDirectory(strategy: PackageLayoutStrategy): string | undefined {
  if (strategy === 'apm-canonical-with-skill-projection') return join(APM_DIRECTORY, SKILLS_DIRECTORY);
  if (strategy === 'apm-root-skills') return SKILLS_DIRECTORY;
  return undefined;
}

// Normalizes an APM agent entrypoint markdown file name migrated from the
// OpenCode layout (`name.md`) to the canonical APM target (`name.agent.md`).
// Non-markdown support files keep their names; files already using the
// canonical `.agent.md` suffix are preserved verbatim.
export function agentEntryPointFileName(fileName: string): string {
  if (fileName.endsWith('.agent.md')) return fileName;
  if (fileName.endsWith('.md')) return `${fileName.slice(0, -'.md'.length)}.agent.md`;
  return fileName;
}

// Stable agent identity derived from a canonical entrypoint file name. This is
// the same identity the runtime derives from an installed `.agent.md` path.
export function agentNameFromEntryPointFileName(fileName: string): string {
  if (fileName.endsWith('.agent.md')) return fileName.slice(0, -'.agent.md'.length);
  if (fileName.endsWith('.md')) return fileName.slice(0, -'.md'.length);
  return '';
}

// ---------------------------------------------------------------------------
// Structural layout state and classification
// ---------------------------------------------------------------------------

export type LayoutStructureState = {
  hasApmManifest: boolean;
  hasRootSkills: boolean;
  hasRootAgents: boolean;
  hasApmSkills: boolean;
  hasApmAgents: boolean;
  hasProjectionMarker: boolean;
};

export type LayoutDecision =
  | { strategy: 'legacy-root' | 'apm-root-skills' | 'apm-canonical' | 'apm-canonical-with-skill-projection'; layout: 'skillrepo' | 'apm' }
  | { strategy: 'invalid'; layout?: undefined; reason: string };

// Pure classification of a repository's structural layout state. Fingerprint
// validation of a detected projection marker is asynchronous and therefore
// owned by the caller: when this classifier returns
// `apm-canonical-with-skill-projection` the caller must still run
// `validateManagedProjection()` and fail closed on any issue.
export function decideLayoutStructure(state: LayoutStructureState): LayoutDecision {
  const manifestClause = 'a regular apm.yml manifest';
  if (!state.hasApmManifest) {
    if (state.hasApmSkills || state.hasApmAgents) {
      return {
        strategy: 'invalid',
        reason: `Package layout requires ${manifestClause} for .apm source directories`,
      };
    }
    if (!state.hasRootSkills && !state.hasRootAgents) {
      return {
        strategy: 'invalid',
        reason: 'Repo has neither skills/ nor agents/ (or .apm/skills nor .apm/agents)',
      };
    }
    return { strategy: 'legacy-root', layout: 'skillrepo' };
  }

  const rootPresent = state.hasRootSkills || state.hasRootAgents;
  const apmPresent = state.hasApmSkills || state.hasApmAgents;
  if (rootPresent && apmPresent) {
    // The only supported dual-tree package is the mixed canonical package with
    // its root Agent Skills projection. Every other dual combination has two
    // independent skill or agent sources and stays ambiguous.
    const canonicalProjection =
      state.hasApmSkills && state.hasRootSkills && !state.hasRootAgents;
    if (!canonicalProjection) {
      return {
        strategy: 'invalid',
        reason: 'Repo has multiple supported layouts: conflicting root and .apm source directories',
      };
    }
    if (!state.hasProjectionMarker) {
      return {
        strategy: 'invalid',
        reason: 'Repo has multiple supported layouts: root skills and .apm/skills coexist without a managed projection marker',
      };
    }
    return { strategy: 'apm-canonical-with-skill-projection', layout: 'apm' };
  }

  if (state.hasApmSkills) return { strategy: 'apm-canonical', layout: 'apm' };
  if (state.hasApmAgents) return { strategy: 'apm-canonical', layout: 'apm' };

  if (state.hasRootSkills) {
    // Skill-only APM package. Root agents alongside root skills would create a
    // second non-canonical primitive source inside an APM package.
    if (state.hasRootAgents) {
      return {
        strategy: 'invalid',
        reason: 'Invalid split package: root skills and root agents must be canonicalized under .apm in an APM package',
      };
    }
    return { strategy: 'apm-root-skills', layout: 'apm' };
  }

  if (state.hasRootAgents) {
    return {
      strategy: 'invalid',
      reason: 'Invalid split package: agent primitives must live in .apm/agents in an APM package',
    };
  }

  return {
    strategy: 'invalid',
    reason: 'Repo has neither skills/ nor agents/ (or .apm/skills nor .apm/agents)',
  };
}

// ---------------------------------------------------------------------------
// sha256-tree-v1 fingerprinting
// ---------------------------------------------------------------------------

type TreeEntry = {
  relativePath: string;
  type: 'file' | 'symlink' | 'directory' | 'other';
  bytes?: Buffer;
  linkTarget?: string;
};

async function collectTreeEntries(
  root: string,
  options: { excludeTopLevel?: ReadonlySet<string> } = {},
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const names = (await readdir(directory, { withFileTypes: true }))
      .map(entry => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      if (relativeDirectory === '' && options.excludeTopLevel?.has(name)) continue;
      const path = join(directory, name);
      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) {
        entries.push({ relativePath, type: 'symlink', linkTarget: await readlink(path) });
      } else if (entryStat.isDirectory()) {
        entries.push({ relativePath, type: 'directory' });
        await walk(path, relativePath);
      } else if (entryStat.isFile()) {
        entries.push({ relativePath, type: 'file', bytes: await readFile(path) });
      } else {
        entries.push({ relativePath, type: 'other' });
      }
    }
  }

  await walk(root, '');
  entries.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return entries;
}

function hashTreeEntries(entries: TreeEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update('entry\0', 'utf8');
    hash.update(`${entry.relativePath}\0${entry.type}\0`, 'utf8');
    if (entry.type === 'file') hash.update(entry.bytes!);
    else if (entry.type === 'symlink') hash.update(entry.linkTarget ?? '', 'utf8');
  }
  return hash.digest('hex');
}

// Stable content fingerprint of a skill tree using sha256-tree-v1: entries are
// enumerated recursively, identified by normalized POSIX-style relative paths
// in code-unit lexical order, and hashed as path + type + file bytes (or
// symlink target text). Timestamps, inode numbers, permissions, absolute
// paths, and staging paths never influence the result.
export async function fingerprintSkillTree(root: string): Promise<string> {
  return hashTreeEntries(await collectTreeEntries(root));
}

// Fingerprint of a projected root skills tree. Only the projection marker
// itself is excluded; every other entry must match the authoritative tree.
export async function fingerprintProjectedTree(projectedRoot: string): Promise<string> {
  return hashTreeEntries(await collectTreeEntries(projectedRoot, {
    excludeTopLevel: new Set([PROJECTION_MARKER_NAME]),
  }));
}

// ---------------------------------------------------------------------------
// Projection marker rendering, parsing, and validation
// ---------------------------------------------------------------------------

// Deterministic marker bytes: fixed key order, two-space indentation, and a
// single trailing newline. Regenerating the marker for the same tree always
// produces byte-identical output.
export function renderProjectionMarker(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`Projection fingerprint must be a lowercase sha256 hex digest: ${fingerprint}`);
  }
  const marker: ProjectionMarker = {
    schemaVersion: PROJECTION_MARKER_SCHEMA_VERSION,
    owner: PROJECTION_MARKER_OWNER,
    kind: PROJECTION_MARKER_KIND,
    source: PROJECTION_MARKER_SOURCE,
    target: PROJECTION_MARKER_TARGET,
    fingerprintAlgorithm: PROJECTION_FINGERPRINT_ALGORITHM,
    fingerprint,
  };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

// Strict marker parsing: unknown keys, missing keys, wrong types, unsupported
// schema versions, and malformed fingerprints are all rejected.
export function parseProjectionMarker(text: string): ProjectionMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Projection marker is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Projection marker must be a JSON object');
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = new Set([
    'schemaVersion',
    'owner',
    'kind',
    'source',
    'target',
    'fingerprintAlgorithm',
    'fingerprint',
  ]);
  const actualKeys = new Set(Object.keys(value));
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) throw new Error(`Projection marker has an unknown field: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) throw new Error(`Projection marker is missing field: ${key}`);
  }
  if (value.schemaVersion !== PROJECTION_MARKER_SCHEMA_VERSION) {
    throw new Error(`Unsupported projection marker schemaVersion: ${String(value.schemaVersion)}`);
  }
  for (const key of ['owner', 'kind', 'source', 'target', 'fingerprintAlgorithm'] as const) {
    if (typeof value[key] !== 'string') throw new Error(`Projection marker field must be a string: ${key}`);
  }
  if (value.fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(String(value.fingerprint))) {
    throw new Error('Projection marker fingerprint must be a lowercase sha256 hex digest');
  }
  return value as unknown as ProjectionMarker;
}

function projectionIssue(code: string, detail: string): ProjectionValidationResult {
  return { ok: false, issues: [{ code, detail }] };
}

// Validates the managed projection of a mixed APM package, fail-closed:
// the marker must exist, parse, declare the expected ownership and paths, and
// both the authoritative `.apm/skills` tree and the projected root `skills`
// tree must recompute to the marker fingerprint.
export async function validateManagedProjection(repoRoot: string): Promise<ProjectionValidationResult> {
  const repo = resolve(repoRoot);
  const sourceDir = join(repo, APM_DIRECTORY, SKILLS_DIRECTORY);
  const projectedDir = join(repo, SKILLS_DIRECTORY);
  const markerPath = join(projectedDir, PROJECTION_MARKER_NAME);

  const sourceStat = await lstat(sourceDir).catch(() => undefined);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    return projectionIssue('missing-canonical-source', `authoritative skill source is not a real directory: ${sourceDir}`);
  }
  const projectedStat = await lstat(projectedDir).catch(() => undefined);
  if (!projectedStat?.isDirectory() || projectedStat.isSymbolicLink()) {
    return projectionIssue('missing-projection', `projected skills directory is not a real directory: ${projectedDir}`);
  }
  const markerStat = await lstat(markerPath).catch(() => undefined);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    return projectionIssue('missing-marker', `projection marker is not a regular file: ${markerPath}`);
  }

  let marker: ProjectionMarker;
  try {
    marker = parseProjectionMarker(await readFile(markerPath, 'utf8'));
  } catch (error) {
    return projectionIssue('invalid-marker', error instanceof Error ? error.message : String(error));
  }
  if (marker.owner !== PROJECTION_MARKER_OWNER) {
    return projectionIssue('invalid-marker', `projection marker owner must be ${PROJECTION_MARKER_OWNER}: ${marker.owner}`);
  }
  if (marker.kind !== PROJECTION_MARKER_KIND) {
    return projectionIssue('invalid-marker', `projection marker kind must be ${PROJECTION_MARKER_KIND}: ${marker.kind}`);
  }
  if (marker.source !== PROJECTION_MARKER_SOURCE) {
    return projectionIssue('invalid-marker', `projection marker source must be ${PROJECTION_MARKER_SOURCE}: ${marker.source}`);
  }
  if (marker.target !== PROJECTION_MARKER_TARGET) {
    return projectionIssue('invalid-marker', `projection marker target must be ${PROJECTION_MARKER_TARGET}: ${marker.target}`);
  }
  if (marker.fingerprintAlgorithm !== PROJECTION_FINGERPRINT_ALGORITHM) {
    return projectionIssue('invalid-marker', `unsupported projection fingerprint algorithm: ${marker.fingerprintAlgorithm}`);
  }

  const canonicalFingerprint = await fingerprintSkillTree(sourceDir);
  if (canonicalFingerprint !== marker.fingerprint) {
    return projectionIssue('stale-canonical-tree', `authoritative .apm/skills tree no longer matches the projection fingerprint`);
  }
  const projectedFingerprint = await fingerprintProjectedTree(projectedDir);
  if (projectedFingerprint !== marker.fingerprint) {
    return projectionIssue('diverged-projection', `projected root skills tree no longer matches the projection fingerprint`);
  }
  return { ok: true, issues: [] };
}

// Materializes a staged projection: copies the canonical skill tree into the
// (already created) transaction-owned staging directory and writes the marker.
// Returns the fingerprint embedded in the marker. The staged tree is byte- and
// link-faithful, so validating the published projection recomputes the same
// fingerprint as the authoritative tree.
export async function stageProjection(sourceDir: string, stageDir: string): Promise<string> {
  const fingerprint = await fingerprintSkillTree(sourceDir);

  async function copyTree(source: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    const names = (await readdir(source, { withFileTypes: true }))
      .map(entry => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      const sourcePath = join(source, name);
      const targetPath = join(target, name);
      const entryStat = await lstat(sourcePath);
      if (entryStat.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), targetPath);
      } else if (entryStat.isDirectory()) {
        await copyTree(sourcePath, targetPath);
      } else if (entryStat.isFile()) {
        await copyFile(sourcePath, targetPath);
      } else {
        throw new Error(`Unsupported skill tree entry cannot be projected: ${sourcePath}`);
      }
    }
  }

  await rm(stageDir, { recursive: true, force: true });
  await copyTree(sourceDir, stageDir);
  await writeFile(join(stageDir, PROJECTION_MARKER_NAME), renderProjectionMarker(fingerprint), {
    encoding: 'utf8',
    flag: 'wx',
  });

  const stagedFingerprint = await fingerprintProjectedTree(stageDir);
  if (stagedFingerprint !== fingerprint) {
    throw new Error(`Staged projection does not match its canonical tree fingerprint: ${stageDir}`);
  }
  return fingerprint;
}

// Best-effort classification hint for authoring-source discovery. This is NOT
// a validity oracle: `inspectRepo()` (via validateManagedProjection) remains
// the authoritative validator. "unrecognized" means a marker exists but cannot
// be trusted, so callers must keep the fail-closed ambiguity instead of
// hiding the root tree.
export type ProjectionMarkerHint = 'absent' | 'managed' | 'unrecognized';

export async function projectionMarkerHint(projectedDir: string): Promise<ProjectionMarkerHint> {
  const markerPath = join(projectedDir, PROJECTION_MARKER_NAME);
  const markerStat = await lstat(markerPath).catch(() => undefined);
  if (!markerStat) return 'absent';
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) return 'unrecognized';
  let marker: ProjectionMarker;
  try {
    marker = parseProjectionMarker(await readFile(markerPath, 'utf8'));
  } catch {
    return 'unrecognized';
  }
  const wellFormed =
    marker.owner === PROJECTION_MARKER_OWNER
    && marker.kind === PROJECTION_MARKER_KIND
    && marker.source === PROJECTION_MARKER_SOURCE
    && marker.target === PROJECTION_MARKER_TARGET
    && marker.fingerprintAlgorithm === PROJECTION_FINGERPRINT_ALGORITHM
    && /^[0-9a-f]{64}$/.test(marker.fingerprint);
  return wellFormed ? 'managed' : 'unrecognized';
}

// Convenience for callers that only need the marker path of a repository root.
export function projectionMarkerPath(repoRoot: string): string {
  return join(resolve(repoRoot), SKILLS_DIRECTORY, PROJECTION_MARKER_NAME);
}
