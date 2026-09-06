import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSkillBoundary } from '../src/apm_boundary.js';

test('APM boundary findings never echo credential-shaped path literals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-audit-secret-redaction-'));
  try {
    const repoRoot = join(root, 'repo');
    const skillDir = join(repoRoot, 'skills', 'audit-secret-redaction');
    await mkdir(skillDir, { recursive: true });

    const secret = `sk-${'a'.repeat(32)}`;
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: audit-secret-redaction\ndescription: synthetic\n---\nRun /tmp/${secret}/tool when available.\n`,
      'utf8',
    );

    const analysis = await analyzeSkillBoundary({ skillDir, repoRoot });
    assert.ok(
      analysis.findings.some(finding => finding.code === 'external-runtime-path'),
      'fixture must exercise the external-runtime-path finding',
    );

    const serialized = JSON.stringify(analysis.findings);
    assert.equal(
      serialized.includes(secret),
      false,
      'machine-readable APM findings must not echo credential-shaped values from source text',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('APM boundary findings never echo credential-shaped segments from env path literals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-audit-secret-redaction-'));
  try {
    const repoRoot = join(root, 'repo');
    const skillDir = join(repoRoot, 'skills', 'audit-secret-env');
    await mkdir(skillDir, { recursive: true });

    const secret = `sk-${'b'.repeat(32)}`;
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: audit-secret-env\ndescription: synthetic\n---\nUse \${DEPLOY_ROOT}/${secret}/tool when configured.\n`,
      'utf8',
    );

    const analysis = await analyzeSkillBoundary({ skillDir, repoRoot });
    assert.ok(
      analysis.findings.some(finding => finding.code === 'package-boundary-unknown'),
      'fixture must exercise the package-boundary-unknown finding',
    );
    const serialized = JSON.stringify(analysis.findings);
    assert.equal(
      serialized.includes(secret),
      false,
      'package-boundary-unknown details must not echo credential-shaped path segments',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared-resource findings omit relatedPath for credential-shaped resource paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-audit-secret-redaction-'));
  try {
    const repoRoot = join(root, 'repo');
    const skillDir = join(repoRoot, 'skills', 'audit-secret-shared');
    const secret = `sk-${'c'.repeat(32)}`;
    const sharedDir = join(repoRoot, 'shared', secret);
    await mkdir(skillDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, 'run.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: audit-secret-shared\ndescription: synthetic\n---\nRun ../../shared/${secret}/run.sh from the repository root.\n`,
      'utf8',
    );

    const analysis = await analyzeSkillBoundary({ skillDir, repoRoot });
    const finding = analysis.findings.find(
      candidate => candidate.code === 'shared-resource-boundary' && (candidate.path ?? '').endsWith('SKILL.md'),
    );
    assert.ok(finding, 'fixture must exercise the shared-resource-boundary finding');
    assert.equal(
      finding.relatedPath,
      undefined,
      'shared-resource-boundary must not expose a credential-shaped relatedPath',
    );
    assert.ok(
      analysis.sharedResources.length === 1,
      'internal grouping evidence keeps the original resource identity',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('benign path literals keep their detail and relatedPath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-audit-secret-redaction-'));
  try {
    const repoRoot = join(root, 'repo');
    const skillDir = join(repoRoot, 'skills', 'audit-benign-paths');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: audit-benign-paths\ndescription: synthetic\n---\n'
        + 'Run /opt/apm-audit-fixture-tool/bin/runner once, then extend ${HOME}/.local/bin.\n',
      'utf8',
    );

    const analysis = await analyzeSkillBoundary({ skillDir, repoRoot });
    const details = analysis.findings
      .filter(finding => finding.code === 'external-runtime-path')
      .map(finding => finding.detail);
    assert.equal(
      details.some(detail => detail.includes('/opt/apm-audit-fixture-tool/bin/runner')),
      true,
      'ordinary external path references must keep their literal for review',
    );
    assert.equal(
      details.some(detail => detail.includes('${HOME}/.local/bin')),
      true,
      'structural environment-variable references must keep their literal',
    );
    assert.equal(
      analysis.findings.some(finding => finding.code === 'external-runtime-path' && finding.relatedPath),
      true,
      'benign external references must keep their relatedPath',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
