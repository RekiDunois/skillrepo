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
