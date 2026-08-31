import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { auditMigrationRepos } from './audit.js';

export type PortabilityKind =
  | 'FRONTMATTER-RUNTIME'
  | 'MARKDOWN-BODY'
  | 'TEST'
  | 'RUNTIME-CODE';

export type PortabilitySegment = {
  kind: PortabilityKind;
  lines: number[];
};

export type PortabilityItem = {
  repoId: string;
  path: string;
  kind: PortabilityKind;
  lines: number[];
  segments: PortabilitySegment[];
};

export type MigrationPortabilityResult = {
  schemaVersion: 1;
  planPath: string;
  targetRoot: string;
  items: PortabilityItem[];
  summary: {
    files: number;
    frontmatterRuntime: number;
    markdownBody: number;
    test: number;
    runtimeCode: number;
  };
};

const HOME_PATH = /(?:\/Users\/[^/\s'"`]+\/|\/home\/[^/\s'"`]+\/|[A-Za-z]:\\Users\\[^\\\s'"`]+\\)/;

function isTestPath(path: string): boolean {
  const normalized = `/${path.replaceAll('\\', '/')}/`;
  const base = basename(path);
  return (
    /\/(?:tests?|__tests__)\//i.test(normalized)
    || /^(?:test(?:[_\-.]|$)|.*(?:[_\-.])test(?:[_\-.]|$))/i.test(base)
  );
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') return index;
  }
  return -1;
}

function classifySegments(path: string, lines: string[], hitIndexes: number[]): PortabilitySegment[] {
  if (isTestPath(path)) {
    return [{ kind: 'TEST', lines: hitIndexes.map(index => index + 1) }];
  }

  const ext = extname(path).toLowerCase();
  if (ext === '.md' || ext === '.mdx') {
    const end = frontmatterEnd(lines);
    const frontmatter = end >= 0 ? hitIndexes.filter(index => index <= end) : [];
    const body = hitIndexes.filter(index => end < 0 || index > end);
    const segments: PortabilitySegment[] = [];
    if (frontmatter.length) {
      segments.push({ kind: 'FRONTMATTER-RUNTIME', lines: frontmatter.map(index => index + 1) });
    }
    if (body.length) {
      segments.push({ kind: 'MARKDOWN-BODY', lines: body.map(index => index + 1) });
    }
    return segments;
  }

  return [{ kind: 'RUNTIME-CODE', lines: hitIndexes.map(index => index + 1) }];
}

function conservativeKind(segments: PortabilitySegment[]): PortabilityKind {
  if (segments.some(segment => segment.kind === 'FRONTMATTER-RUNTIME')) return 'FRONTMATTER-RUNTIME';
  return segments[0]!.kind;
}

function hasSegment(item: PortabilityItem, kind: PortabilityKind): boolean {
  return item.segments.some(segment => segment.kind === kind);
}

export async function classifyMigrationPortability(options: {
  planPath: string;
  targetRoot: string;
}): Promise<MigrationPortabilityResult> {
  const audit = await auditMigrationRepos(options);
  const items: PortabilityItem[] = [];

  for (const repo of audit.repositories) {
    const findings = repo.findings.filter(finding => finding.code === 'absolute-home-path');
    for (const finding of findings) {
      const file = join(repo.repoPath, finding.path);
      const text = await readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const hitIndexes = lines
        .map((line, index) => HOME_PATH.test(line) ? index : -1)
        .filter(index => index >= 0);

      if (!hitIndexes.length) {
        throw new Error(`Portability finding no longer matches file contents: ${file}`);
      }

      const segments = classifySegments(finding.path, lines, hitIndexes);
      items.push({
        repoId: repo.repoId,
        path: finding.path,
        kind: conservativeKind(segments),
        lines: hitIndexes.map(index => index + 1),
        segments,
      });
    }
  }

  items.sort((left, right) => left.repoId.localeCompare(right.repoId) || left.path.localeCompare(right.path));

  return {
    schemaVersion: 1,
    planPath: audit.planPath,
    targetRoot: audit.targetRoot,
    items,
    summary: {
      files: items.length,
      frontmatterRuntime: items.filter(item => hasSegment(item, 'FRONTMATTER-RUNTIME')).length,
      markdownBody: items.filter(item => hasSegment(item, 'MARKDOWN-BODY')).length,
      test: items.filter(item => hasSegment(item, 'TEST')).length,
      runtimeCode: items.filter(item => hasSegment(item, 'RUNTIME-CODE')).length,
    },
  };
}

export function renderMigrationPortability(result: MigrationPortabilityResult): string {
  const lines = [`Migration portability review: ${result.summary.files} file(s)`];
  let currentRepo = '';

  for (const item of result.items) {
    if (item.repoId !== currentRepo) {
      currentRepo = item.repoId;
      lines.push(`${currentRepo}:`);
    }
    if (item.segments.length === 1) {
      lines.push(`  [${item.segments[0]!.kind}] ${item.path}:${item.segments[0]!.lines.join(',')}`);
      continue;
    }
    lines.push(`  [MIXED] ${item.path}`);
    for (const segment of item.segments) {
      lines.push(`    [${segment.kind}] ${segment.lines.join(',')}`);
    }
  }

  lines.push(
    'Scopes: '
      + `${result.summary.frontmatterRuntime} file(s) with frontmatter-runtime, `
      + `${result.summary.markdownBody} with markdown-body, `
      + `${result.summary.test} test, `
      + `${result.summary.runtimeCode} runtime-code`,
  );
  lines.push('Read-only classification: no repository contents were changed.');
  return lines.join('\n');
}
