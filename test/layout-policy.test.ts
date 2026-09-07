import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepo } from '../src/core.js';
import {
  fingerprintProjectedTree,
  fingerprintSkillTree,
  parseProjectionMarker,
  projectionMarkerHint,
  renderProjectionMarker,
  selectLayoutStrategy,
  stageProjection,
  validateManagedProjection,
} from '../src/layout.js';

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeSkillTree(root: string, skillName = 'alpha'): Promise<void> {
  await mkdir(join(root, skillName, 'scripts'), { recursive: true });
  await mkdir(join(root, skillName, 'references'), { recursive: true });
  await writeFile(
    join(root, skillName, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: layout policy test\n---\n`,
    'utf8',
  );
  await writeFile(join(root, skillName, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  await writeFile(join(root, skillName, 'references', 'notes.bin'), Buffer.from([0, 1, 2, 0xff, 0x00, 0x7f]));
}

test('layout strategy selection follows package composition', () => {
  assert.equal(selectLayoutStrategy({ hasSkills: true, hasApmOnlyPrimitives: false }), 'apm-root-skills');
  assert.equal(selectLayoutStrategy({ hasSkills: true, hasApmOnlyPrimitives: true }), 'apm-canonical-with-skill-projection');
  assert.equal(selectLayoutStrategy({ hasSkills: false, hasApmOnlyPrimitives: true }), 'apm-canonical');
  assert.throws(() => selectLayoutStrategy({ hasSkills: false, hasApmOnlyPrimitives: false }), /neither skills nor APM-only primitives/);
});

test('sha256-tree-v1 fingerprints are content-addressed and stable across runs', async () => {
  const root = await makeTempRoot('skillrepo-layout-fingerprint-');
  try {
    const treeA = join(root, 'tree-a');
    const treeB = join(root, 'tree-b');
    await writeSkillTree(treeA);
    await writeSkillTree(treeB);

    const first = await fingerprintSkillTree(treeA);
    const second = await fingerprintSkillTree(treeA);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, await fingerprintSkillTree(treeB));

    // Binary content is hashed by bytes, not text decoding.
    const mutated = join(root, 'tree-mutated');
    await writeSkillTree(mutated);
    await writeFile(join(mutated, 'alpha', 'references', 'notes.bin'), Buffer.from([0, 1, 2, 0xff, 0x00, 0x7e]));
    assert.notEqual(first, await fingerprintSkillTree(mutated));

    // Directory enumeration order does not influence the digest.
    const reordered = join(root, 'tree-reordered');
    await writeSkillTree(reordered, 'zeta');
    await mkdir(join(reordered, 'zeta', 'aaa'), { recursive: true });
    await writeFile(join(reordered, 'zeta', 'aaa', 'SKILL.md'), '---\nname: aaa\ndescription: aaa\n---\n');
    const reorderedDirect = join(root, 'tree-reordered-direct');
    await writeSkillTree(reorderedDirect, 'zeta');
    await mkdir(join(reorderedDirect, 'zeta', 'aaa'), { recursive: true });
    await writeFile(join(reorderedDirect, 'zeta', 'aaa', 'SKILL.md'), '---\nname: aaa\ndescription: aaa\n---\n');
    assert.equal(await fingerprintSkillTree(reordered), await fingerprintSkillTree(reorderedDirect));

    // Symlinks hash their link target text.
    const linked = join(root, 'tree-linked');
    await writeSkillTree(linked);
    await symlink(join(linked, 'alpha', 'scripts', 'run.sh'), join(linked, 'alpha', 'scripts', 'alias.sh'));
    const withLink = await fingerprintSkillTree(linked);
    await rm(join(linked, 'alpha', 'scripts', 'alias.sh'));
    await symlink(join(linked, 'alpha', 'scripts', 'other.sh'), join(linked, 'alpha', 'scripts', 'alias.sh'));
    assert.notEqual(withLink, await fingerprintSkillTree(linked));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('projection markers render deterministically and parse strictly', () => {
  const fingerprint = 'a'.repeat(64);
  const first = renderProjectionMarker(fingerprint);
  const second = renderProjectionMarker(fingerprint);
  assert.equal(first, second);
  const parsed = parseProjectionMarker(first);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.owner, 'skillrepo');
  assert.equal(parsed.kind, 'agent-skills-projection');
  assert.equal(parsed.source, '.apm/skills');
  assert.equal(parsed.target, 'skills');
  assert.equal(parsed.fingerprintAlgorithm, 'sha256-tree-v1');
  assert.equal(parsed.fingerprint, fingerprint);

  assert.throws(() => renderProjectionMarker('not-a-fingerprint'), /lowercase sha256/);
  assert.throws(() => parseProjectionMarker('not json'), /not valid JSON/);
  assert.throws(() => parseProjectionMarker('[]'), /JSON object/);
  assert.throws(() => parseProjectionMarker('{"schemaVersion":1}'), /missing field/);
  assert.throws(
    () => parseProjectionMarker(`${JSON.stringify({ ...parseProjectionMarker(first), extra: true }, null, 2)}\n`),
    /unknown field/,
  );
  assert.throws(
    () => parseProjectionMarker(`${JSON.stringify({ ...parseProjectionMarker(first), schemaVersion: 2 }, null, 2)}\n`),
    /Unsupported projection marker schemaVersion/,
  );
  assert.throws(
    () => parseProjectionMarker(`${JSON.stringify({ ...parseProjectionMarker(first), fingerprint: 'XYZ' }, null, 2)}\n`),
    /sha256 hex digest/,
  );
});

test('a mixed managed package with a valid projection is accepted as .apm authoritative', async () => {
  const root = await makeTempRoot('skillrepo-layout-managed-');
  try {
    const repo = join(root, 'package-repo');
    const canonical = join(repo, '.apm', 'skills');
    const agents = join(repo, '.apm', 'agents');
    await writeSkillTree(canonical);
    await mkdir(agents, { recursive: true });
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
    await writeFile(
      join(agents, 'worker.agent.md'),
      '---\ndescription: managed package\nmode: subagent\n---\n',
      'utf8',
    );

    const stage = join(root, 'stage');
    const fingerprint = await stageProjection(canonical, join(stage, 'projection'));
    await stageProjection(canonical, join(repo, 'skills'));
    // Regenerating is deterministic: same bytes for the marker and the tree.
    const markerBytes = await readFile(join(repo, 'skills', '.skillrepo-projection.json'), 'utf8');
    assert.equal(markerBytes, renderProjectionMarker(fingerprint));

    const inventory = await inspectRepo(repo);
    assert.equal(inventory.layout, 'apm');
    assert.equal(inventory.layoutStrategy, 'apm-canonical-with-skill-projection');
    assert.equal(inventory.skillsDir, canonical);
    assert.equal(inventory.projectedSkillsDir, join(repo, 'skills'));
    assert.equal(inventory.agentsDir, agents);
    const validation = await validateManagedProjection(repo);
    assert.equal(validation.ok, true);

    // The projected tree without the marker recomputes to the same fingerprint.
    assert.equal(await fingerprintProjectedTree(join(repo, 'skills')), fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale and diverged projections fail closed', async () => {
  const root = await makeTempRoot('skillrepo-layout-stale-');
  try {
    const buildPackage = async (): Promise<string> => {
      const repo = join(root, `package-${Math.random().toString(36).slice(2)}`);
      const canonical = join(repo, '.apm', 'skills');
      await writeSkillTree(canonical);
      await mkdir(join(repo, '.apm', 'agents'), { recursive: true });
      await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
      await stageProjection(canonical, join(repo, 'skills'));
      return repo;
    };

    // Canonical tree modified after generation -> stale.
    let repo = await buildPackage();
    await writeFile(join(repo, '.apm', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: changed\n---\n', 'utf8');
    let validation = await validateManagedProjection(repo);
    assert.equal(validation.ok, false);
    assert.deepEqual(validation.issues.map(issue => issue.code), ['stale-canonical-tree']);
    await assert.rejects(() => inspectRepo(repo), /Invalid managed skill projection/);

    // Projected content modified -> diverged.
    repo = await buildPackage();
    await writeFile(join(repo, 'skills', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho changed\n', 'utf8');
    validation = await validateManagedProjection(repo);
    assert.deepEqual(validation.issues.map(issue => issue.code), ['diverged-projection']);

    // Extra projected file -> diverged.
    repo = await buildPackage();
    await writeFile(join(repo, 'skills', 'alpha', 'extra.txt'), 'extra\n', 'utf8');
    validation = await validateManagedProjection(repo);
    assert.deepEqual(validation.issues.map(issue => issue.code), ['diverged-projection']);

    // Missing projected file -> diverged.
    repo = await buildPackage();
    await rm(join(repo, 'skills', 'alpha', 'references', 'notes.bin'));
    validation = await validateManagedProjection(repo);
    assert.deepEqual(validation.issues.map(issue => issue.code), ['diverged-projection']);

    // Changed symlink target in the projection -> diverged.
    repo = await buildPackage();
    await symlink('elsewhere.sh', join(repo, 'skills', 'alpha', 'scripts', 'alias.sh'));
    await writeFile(join(repo, '.apm', 'skills', 'alpha', 'scripts', 'elsewhere.sh'), 'echo hi\n', 'utf8');
    validation = await validateManagedProjection(repo);
    assert.equal(validation.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed or foreign projection markers fail closed', async () => {
  const root = await makeTempRoot('skillrepo-layout-marker-');
  try {
    const buildPackage = async (markerText: string): Promise<string> => {
      const repo = join(root, `package-${Math.random().toString(36).slice(2)}`);
      const canonical = join(repo, '.apm', 'skills');
      await writeSkillTree(canonical);
      await mkdir(join(repo, '.apm', 'agents'), { recursive: true });
      await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
      const fingerprint = await fingerprintSkillTree(canonical);
      await stageProjection(canonical, join(repo, 'skills'));
      await writeFile(join(repo, 'skills', '.skillrepo-projection.json'), markerText.replaceAll('__FINGERPRINT__', fingerprint), 'utf8');
      return repo;
    };

    const baseMarker = `${JSON.stringify({
      schemaVersion: 1,
      owner: 'skillrepo',
      kind: 'agent-skills-projection',
      source: '.apm/skills',
      target: 'skills',
      fingerprintAlgorithm: 'sha256-tree-v1',
      fingerprint: '__FINGERPRINT__',
    }, null, 2)}\n`;

    const cases: Array<[string, string, RegExp]> = [
      ['malformed', '{not json', /Invalid managed skill projection/],
      ['wrong owner', baseMarker.replace('"owner": "skillrepo"', '"owner": "someone-else"'), /owner must be skillrepo/],
      ['wrong kind', baseMarker.replace('agent-skills-projection', 'something-else'), /kind must be agent-skills-projection/],
      ['wrong source', baseMarker.replace('".apm/skills"', '".apm/other"'), /source must be \.apm\/skills/],
      ['wrong target', baseMarker.replace('"target": "skills"', '"target": "other"'), /target must be skills/],
      ['unsupported algorithm', baseMarker.replace('sha256-tree-v1', 'md5-tree-v0'), /unsupported projection fingerprint algorithm/],
      ['wrong fingerprint', baseMarker.replace('__FINGERPRINT__', 'b'.repeat(64)), /authoritative \.apm\/skills tree no longer matches/],
    ];

    for (const [label, markerText, expected] of cases) {
      const repo = await buildPackage(markerText);
      await assert.rejects(() => inspectRepo(repo), expected, `case ${label} should fail closed`);
      const validation = await validateManagedProjection(repo);
      assert.equal(validation.ok, false, `case ${label} should not validate`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dual skill sources without a projection marker are rejected', async () => {
  const root = await makeTempRoot('skillrepo-layout-dual-');
  try {
    const repo = join(root, 'package-repo');
    await writeSkillTree(join(repo, '.apm', 'skills'));
    await mkdir(join(repo, '.apm', 'agents'), { recursive: true });
    await writeFile(join(repo, 'apm.yml'), 'name: package-repo\n', 'utf8');
    await mkdir(join(repo, 'skills', 'legacy'), { recursive: true });
    await writeFile(join(repo, 'skills', 'legacy', 'SKILL.md'), '---\nname: legacy\ndescription: legacy\n---\n', 'utf8');

    await assert.rejects(
      () => inspectRepo(repo),
      /multiple supported layouts.*without a managed projection marker/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('split packages and primitives outside .apm are rejected', async () => {
  const root = await makeTempRoot('skillrepo-layout-split-');
  try {
    const withRootAgents = join(root, 'split-repo');
    await writeSkillTree(join(withRootAgents, 'skills'));
    await mkdir(join(withRootAgents, 'agents'), { recursive: true });
    await writeFile(join(withRootAgents, 'apm.yml'), 'name: split-repo\n', 'utf8');
    await assert.rejects(() => inspectRepo(withRootAgents), /Invalid split package/);

    const agentsOnly = join(root, 'agents-only-repo');
    await mkdir(join(agentsOnly, 'agents'), { recursive: true });
    await writeFile(join(agentsOnly, 'apm.yml'), 'name: agents-only-repo\n', 'utf8');
    await assert.rejects(() => inspectRepo(agentsOnly), /Invalid split package/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy and historical layouts stay inspectable', async () => {
  const root = await makeTempRoot('skillrepo-layout-legacy-');
  try {
    const legacy = join(root, 'legacy-repo');
    await writeSkillTree(join(legacy, 'skills'));
    await mkdir(join(legacy, 'agents'), { recursive: true });
    await writeFile(join(legacy, 'agents', 'worker.md'), '---\nname: worker\ndescription: legacy\nmode: subagent\n---\n', 'utf8');
    const legacyInventory = await inspectRepo(legacy);
    assert.equal(legacyInventory.layout, 'skillrepo');
    assert.equal(legacyInventory.layoutStrategy, 'legacy-root');
    assert.equal(legacyInventory.skillsDir, join(legacy, 'skills'));
    assert.equal(legacyInventory.agentsDir, join(legacy, 'agents'));
    assert.equal(legacyInventory.projectedSkillsDir, undefined);

    const historical = join(root, 'historical-repo');
    await writeSkillTree(join(historical, '.apm', 'skills'));
    await mkdir(join(historical, '.apm', 'agents'), { recursive: true });
    await writeFile(join(historical, '.apm', 'agents', 'worker.agent.md'), '---\ndescription: historical\nmode: subagent\n---\n', 'utf8');
    await writeFile(join(historical, 'apm.yml'), 'name: historical-repo\n', 'utf8');
    const historicalInventory = await inspectRepo(historical);
    assert.equal(historicalInventory.layout, 'apm');
    assert.equal(historicalInventory.layoutStrategy, 'apm-canonical');
    assert.equal(historicalInventory.skillsDir, join(historical, '.apm', 'skills'));
    assert.equal(historicalInventory.projectedSkillsDir, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the marker hint distinguishes managed, absent, and unrecognized markers', async () => {
  const root = await makeTempRoot('skillrepo-layout-hint-');
  try {
    const canonical = join(root, '.apm', 'skills');
    await writeSkillTree(canonical);

    assert.equal(await projectionMarkerHint(canonical), 'absent');

    await mkdir(join(root, 'managed'), { recursive: true });
    await stageProjection(canonical, join(root, 'managed'));
    assert.equal(await projectionMarkerHint(join(root, 'managed')), 'managed');

    const unrecognized = join(root, 'unrecognized');
    await mkdir(unrecognized, { recursive: true });
    await writeFile(join(unrecognized, '.skillrepo-projection.json'), '{ "schemaVersion": 1 }\n', 'utf8');
    assert.equal(await projectionMarkerHint(unrecognized), 'unrecognized');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
