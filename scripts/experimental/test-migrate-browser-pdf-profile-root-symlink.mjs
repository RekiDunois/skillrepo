#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, symlink, lstat, readFile, readlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationScript = resolve(here, 'migrate-browser-pdf-profile.mjs');
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-profile-root-symlink-'));
  const realProfile = join(root, 'real-profile');
  const logicalProfile = join(root, 'logical-profile');
  const targetProfile = join(root, 'target-profile');

  try {
    await mkdir(join(realProfile, 'Default'), { recursive: true });
    await writeFile(join(realProfile, 'Default', 'Cookies'), 'cookie-state\n');
    await writeFile(join(realProfile, 'Local State'), '{"profile":"test"}\n');
    await symlink('Cookies', join(realProfile, 'Default', 'Cookies.link'));
    await symlink('host-999999', join(realProfile, 'SingletonLock'));
    await symlink(realProfile, logicalProfile, 'dir');

    const run = spawnSync(process.execPath, [
      migrationScript,
      '--source', logicalProfile,
      '--target', targetProfile,
      '--execute',
    ], { encoding: 'utf8' });

    if (run.status !== 0) {
      process.stderr.write(run.stdout || '');
      process.stderr.write(run.stderr || '');
      throw new Error(`migration command failed with status ${run.status}`);
    }

    const sourceStat = await lstat(logicalProfile);
    const targetStat = await lstat(targetProfile);
    const nestedLinkStat = await lstat(join(targetProfile, 'Default', 'Cookies.link'));

    assert(sourceStat.isSymbolicLink(), 'logical source root must remain a symlink');
    assert(targetStat.isDirectory(), 'target profile must be a real directory');
    assert(nestedLinkStat.isSymbolicLink(), 'nested profile symlink must remain a symlink');
    assert(await readlink(join(targetProfile, 'Default', 'Cookies.link')) === 'Cookies', 'nested symlink target changed');
    assert(await readFile(join(targetProfile, 'Default', 'Cookies'), 'utf8') === 'cookie-state\n', 'copied payload mismatch');
    assert(!(await exists(join(targetProfile, 'SingletonLock'))), 'root SingletonLock must be omitted');

    console.log('PASS: symlinked profile root resolves to a real target directory, source remains unchanged, payload verifies, nested symlinks are preserved, and root lock files are omitted.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
