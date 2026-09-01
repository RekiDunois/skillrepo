import { basename } from 'node:path';
import {
  auditMigrationRepos,
  type MigrationAuditResult,
  type RepoAudit,
} from './audit.js';

function localRuntimeIgnorePattern(path: string): string | null {
  const name = basename(path);
  if (name === '.venv') return '.venv/';
  if (name === 'venv') return 'venv/';
  return null;
}

function readinessRepo(repo: RepoAudit): RepoAudit {
  const findings = repo.findings.filter(finding => {
    if (finding.code !== 'local-runtime-environment') return true;
    const pattern = localRuntimeIgnorePattern(finding.path);
    if (!pattern) return true;
    const stillNeedsIgnore = repo.ignoreCandidates.some(candidate => candidate.pattern === pattern);
    return stillNeedsIgnore;
  });

  return {
    ...repo,
    findings,
    readyForInitialCommit: findings.length === 0 && repo.ignoreCandidates.length === 0,
  };
}

export async function auditMigrationCommitReadiness(options: {
  planPath: string;
  targetRoot: string;
  gitPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationAuditResult> {
  const raw = await auditMigrationRepos(options);
  const repositories = raw.repositories.map(readinessRepo);
  const blockers = repositories.reduce(
    (sum, repo) => sum + repo.findings.filter(finding => finding.severity === 'blocker').length,
    0,
  );
  const reviews = repositories.reduce(
    (sum, repo) => sum + repo.findings.filter(finding => finding.severity === 'review').length,
    0,
  );
  const ignorePatterns = repositories.reduce((sum, repo) => sum + repo.ignoreCandidates.length, 0);

  return {
    ...raw,
    repositories,
    summary: { repositories: repositories.length, blockers, reviews, ignorePatterns },
    readyForInitialCommit: repositories.every(repo => repo.readyForInitialCommit),
  };
}
