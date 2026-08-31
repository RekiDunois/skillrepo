import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

test('inventory exporter records useful structure, prunes runtime noise, and exports sanitized git provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-inventory-'));
  const source = join(root, 'opencode');
  const external = join(root, 'external-agent-repo');
  const vendorRepo = join(source, 'skills', 'vendor');

  try {
    await mkdir(join(source, 'skills', 'hello'), { recursive: true });
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(source, '.ms-playwright', 'chromium'), { recursive: true });
    await mkdir(vendorRepo, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(source, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\n---\n', 'utf8');
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'ignored', 'utf8');
    await writeFile(join(source, '.ms-playwright', 'chromium', 'browser-binary'), 'ignored', 'utf8');
    await writeFile(join(source, '.env'), 'TOKEN=not-a-real-secret\n', 'utf8');
    await writeFile(join(vendorRepo, 'README.md'), 'vendor\n', 'utf8');
    await symlink(external, join(source, 'external-agents'), 'dir');

    await execFileAsync('git', ['init', vendorRepo]);
    await execFileAsync('git', ['-C', vendorRepo, 'config', 'user.name', 'Skillrepo Test']);
    await execFileAsync('git', ['-C', vendorRepo, 'config', 'user.email', 'skillrepo@example.invalid']);
    await execFileAsync('git', ['-C', vendorRepo, 'add', 'README.md']);
    await execFileAsync('git', ['-C', vendorRepo, 'commit', '-m', 'initial']);
    await execFileAsync('git', ['-C', vendorRepo, 'remote', 'add', 'origin', 'https://user:secret@example.com/acme/vendor.git']);
    await appendFile(join(vendorRepo, 'README.md'), 'local change\n', 'utf8');

    await execFileAsync(process.execPath, [
      resolve(process.cwd(), 'scripts', 'export-opencode-structure.mjs'),
      source,
    ]);

    const report = JSON.parse(await readFile(join(source, '.skillrepo-inventory', 'structure.json'), 'utf8')) as {
      summary: {
        externalSymlinks: number;
        sensitivePathCandidates: number;
        gitRepositories: number;
        gitMetadataUnavailable: number;
      };
      entries: Array<{ path: string; type: string; pruned?: boolean; targetScope?: string }>;
      sensitivePathCandidates: string[];
      gitProvenance: Array<{
        path: string;
        available: boolean;
        dirty: boolean | null;
        remotes: Array<{ name: string; urls: string[] }>;
      }>;
    };

    assert.ok(report.entries.some((entry) => entry.path === 'skills/hello/SKILL.md' && entry.type === 'file'));
    assert.ok(report.entries.some((entry) => entry.path === 'skills/vendor/.git' && entry.pruned === true));
    assert.ok(report.entries.some((entry) => entry.path === 'node_modules' && entry.pruned === true));
    assert.ok(report.entries.some((entry) => entry.path === '.ms-playwright' && entry.pruned === true));
    assert.equal(report.entries.some((entry) => entry.path === 'node_modules/pkg/index.js'), false);
    assert.equal(report.entries.some((entry) => entry.path === '.ms-playwright/chromium/browser-binary'), false);
    assert.ok(report.entries.some((entry) => entry.path === 'external-agents' && entry.targetScope === 'external'));
    assert.equal(report.summary.externalSymlinks, 1);
    assert.equal(report.summary.sensitivePathCandidates, 1);
    assert.deepEqual(report.sensitivePathCandidates, ['.env']);
    assert.equal(report.summary.gitRepositories, 1);
    assert.equal(report.summary.gitMetadataUnavailable, 0);

    const provenance = report.gitProvenance.find((repo) => repo.path === 'skills/vendor');
    assert.ok(provenance);
    assert.equal(provenance.available, true);
    assert.equal(provenance.dirty, true);
    assert.deepEqual(provenance.remotes, [
      { name: 'origin', urls: ['https://example.com/acme/vendor.git'] },
    ]);

    const provenanceFile = JSON.parse(
      await readFile(join(source, '.skillrepo-inventory', 'git-provenance.json'), 'utf8'),
    ) as { repositories: typeof report.gitProvenance };
    assert.deepEqual(provenanceFile.repositories, report.gitProvenance);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
