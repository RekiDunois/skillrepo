import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { preflightGit, probeIgnoredPaths } from '../src/git_ignore.js';

async function locateGit(): Promise<string> {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ }
    }
  }
  throw new Error('Git executable not found on test PATH');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test('Git oracle uses target filesystem case behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-case-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, '.gitignore'), 'Thumbs.db\n', 'utf8');
    await writeFile(join(repo, 'thumbs.db'), 'runtime noise\n', 'utf8');

    let caseInsensitive = true;
    try { await access(join(repo, 'Thumbs.db')); } catch { caseInsensitive = false; }

    const runtime = await preflightGit(await locateGit());
    const ignored = await probeIgnoredPaths(runtime, repo, ['thumbs.db']);
    assert.equal(
      ignored.has('thumbs.db'),
      caseInsensitive,
      'Git ignore result must follow the target filesystem rather than the temporary metadata filesystem',
    );
    await assert.rejects(access(join(repo, '.git')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Git oracle batches all candidate paths into one check-ignore process', async t => {
  if (process.platform === 'win32') { t.skip('shell wrapper fixture is POSIX-only'); return; }
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-ignore-batch-'));
  try {
    const repo = join(root, 'repo');
    const wrapper = join(root, 'git');
    const calls = join(root, 'check-ignore-calls.log');
    const realGit = await locateGit();
    await mkdir(repo);
    await writeFile(join(repo, '.gitignore'), '*.log\n', 'utf8');
    for (const name of ['one.log', 'two.log', 'three.log']) await writeFile(join(repo, name), 'noise\n', 'utf8');
    await writeFile(wrapper, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "git version 2.0.0"; exit 0; fi',
      `if [ "$1" = "init" ]; then exec ${shellQuote(realGit)} "$@"; fi`,
      `printf '%s\\n' "$*" >> ${shellQuote(calls)}`,
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'), 'utf8');
    await chmod(wrapper, 0o755);

    const runtime = await preflightGit(wrapper);
    const ignored = await probeIgnoredPaths(runtime, repo, ['one.log', 'two.log', 'three.log']);
    assert.deepEqual([...ignored].sort(), ['one.log', 'three.log', 'two.log']);
    const invocations = (await readFile(calls, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    assert.equal(invocations.length, 1);
    assert.match(invocations[0]!, /check-ignore/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
