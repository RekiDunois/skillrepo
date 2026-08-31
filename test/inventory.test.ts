import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

test('inventory exporter records useful structure without following noisy dirs or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-inventory-'));
  const source = join(root, 'opencode');
  const external = join(root, 'external-agent-repo');

  try {
    await mkdir(join(source, 'skills', 'hello'), { recursive: true });
    await mkdir(join(source, '.git', 'objects'), { recursive: true });
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(source, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n', 'utf8');
    await writeFile(join(source, '.git', 'objects', 'large-object'), 'ignored', 'utf8');
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'ignored', 'utf8');
    await writeFile(join(source, '.env'), 'TOKEN=not-a-real-secret\n', 'utf8');
    await symlink(external, join(source, 'external-agents'), 'dir');

    await execFileAsync(process.execPath, [
      resolve(process.cwd(), 'scripts', 'export-opencode-structure.mjs'),
      source,
    ]);

    const report = JSON.parse(await readFile(join(source, '.skillrepo-inventory', 'structure.json'), 'utf8')) as {
      summary: { externalSymlinks: number; sensitivePathCandidates: number };
      entries: Array<{ path: string; type: string; pruned?: boolean; targetScope?: string }>;
      sensitivePathCandidates: string[];
    };

    assert.ok(report.entries.some((entry) => entry.path === 'skills/hello/SKILL.md' && entry.type === 'file'));
    assert.ok(report.entries.some((entry) => entry.path === '.git' && entry.pruned === true));
    assert.ok(report.entries.some((entry) => entry.path === 'node_modules' && entry.pruned === true));
    assert.equal(report.entries.some((entry) => entry.path === '.git/objects/large-object'), false);
    assert.equal(report.entries.some((entry) => entry.path === 'node_modules/pkg/index.js'), false);
    assert.ok(report.entries.some((entry) => entry.path === 'external-agents' && entry.targetScope === 'external'));
    assert.equal(report.summary.externalSymlinks, 1);
    assert.equal(report.summary.sensitivePathCandidates, 1);
    assert.deepEqual(report.sensitivePathCandidates, ['.env']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
