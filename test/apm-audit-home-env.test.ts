import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { auditApmReadiness } from '../src/apm_audit.js';

const OPENCODE_STUB = `
if (process.argv[2] === 'debug' && process.argv[3] === 'skill') {
  process.stdout.write(JSON.stringify([{
    name: 'audit-env-home',
    location: process.env.OPENCODE_STUB_SOURCE,
  }]) + '\\n');
  process.exit(0);
}
if (process.argv[2] === '--version') {
  process.stdout.write('opencode test stub 0.0.0\\n');
  process.exit(0);
}
process.exit(0);
`;

test('boundary references resolve against the audit environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-audit-home-env-'));
  try {
    const syntheticHome = join(root, 'synthetic-home');
    const configuredToolRoot = join(root, 'configured-tools');
    const configDir = join(root, 'opencode');
    const binDir = join(root, 'bin');
    const repo = join(root, 'source-repo');
    const skillsDir = join(repo, 'skills');
    const source = join(skillsDir, 'audit-env-home', 'SKILL.md');

    await mkdir(syntheticHome, { recursive: true });
    await mkdir(configuredToolRoot, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(dirname(source), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);

    await writeFile(
      source,
      '---\nname: audit-env-home\ndescription: synthetic\n---\nRun ~/tools/runner and ${TOOL_ROOT}/runner for this task.\n',
      'utf8',
    );
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      `${JSON.stringify({ skills: { paths: [skillsDir] } }, null, 2)}\n`,
      'utf8',
    );

    const stubPath = join(binDir, 'opencode-test-stub.mjs');
    await writeFile(stubPath, OPENCODE_STUB, 'utf8');
    const launcherPath = join(binDir, 'opencode');
    await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`, 'utf8');
    await chmod(launcherPath, 0o755);

    const { OPENCODE_CONFIG: _ignored, ...restEnv } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...restEnv,
      HOME: syntheticHome,
      USERPROFILE: syntheticHome,
      TOOL_ROOT: configuredToolRoot,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_STUB_SOURCE: source,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    };

    const result = await auditApmReadiness({ projectRoot: root, env });
    const skill = result.skills.find(entry => entry.skillId === 'audit-env-home');
    assert.ok(skill);
    assert.equal(skill.classification, 'NEEDS_CHANGES');
    assert.equal(skill.findings.some(entry => entry.code === 'package-boundary-unknown'), false);

    const relatedPaths = skill.findings
      .filter(entry => entry.code === 'external-runtime-path')
      .map(entry => entry.relatedPath)
      .filter((value): value is string => typeof value === 'string')
      .sort();
    assert.deepEqual(relatedPaths, [
      resolve(configuredToolRoot, 'runner'),
      resolve(syntheticHome, 'tools', 'runner'),
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
