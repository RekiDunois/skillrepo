import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const cliPath = resolve('dist/src/cli.js');
const templatePath = resolve('templates/opencode-migration.gitignore');

function runCli(args: string[], cwd: string, env = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, [cliPath, ...args], { cwd, env }, error => {
      if (!error) {
        resolvePromise({ code: 0, stdout: '', stderr: '' });
        return;
      }
      const result = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
      resolvePromise({
        code: typeof result.code === 'number' ? result.code : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? result.message,
      });
    });
    child.on('error', reject);
  });
}

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function assertInitLayout(repo: string, expectGit = false): Promise<void> {
  const expected = ['.gitignore', 'agents', 'skills'];
  if (expectGit) expected.unshift('.git');
  assert.deepEqual((await readdir(repo)).sort(), expected.sort());
  assert.equal(await readFile(join(repo, '.gitignore'), 'utf8'), await readFile(templatePath, 'utf8'));
  assert.equal(await readFile(join(repo, 'skills', '.gitkeep'), 'utf8'), '');
  assert.equal(await readFile(join(repo, 'agents', '.gitkeep'), 'utf8'), '');
  if (!expectGit) await assert.rejects(access(join(repo, '.git')));
}

test('init creates a skeleton for a missing, empty, current, and absolute directory', async () => {
  const root = await makeTempRoot('skillrepo-init-layout-');
  try {
    const missing = join(root, 'missing', 'repo');
    let result = await runCli(['init', '--layout', 'legacy', missing], root);
    assert.equal(result.code, 0, result.stderr);
    await assertInitLayout(missing);

    const empty = join(root, 'empty');
    await mkdir(empty);
    result = await runCli(['init', '--layout', 'legacy', empty], root);
    assert.equal(result.code, 0, result.stderr);
    await assertInitLayout(empty);

    const current = join(root, 'current');
    await mkdir(current);
    result = await runCli(['init', '--layout', 'legacy', '.'], current);
    assert.equal(result.code, 0, result.stderr);
    await assertInitLayout(current);

    const absolute = join(root, 'absolute');
    result = await runCli(['init', '--layout', 'legacy', absolute], root);
    assert.equal(result.code, 0, result.stderr);
    await assertInitLayout(absolute);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init defaults to the package authoring layout', async () => {
  const root = await makeTempRoot('skillrepo-init-package-');
  const repo = join(root, 'package-repo');
  try {
    const result = await runCli(['init', repo], root);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await readdir(repo)).sort(), ['.apm', '.gitignore', 'apm.yml'].sort());
    assert.deepEqual((await readdir(join(repo, '.apm'))).sort(), ['agents', 'skills'].sort());
    assert.equal(await readFile(join(repo, '.apm', 'skills', '.gitkeep'), 'utf8'), '');
    assert.equal(await readFile(join(repo, '.apm', 'agents', '.gitkeep'), 'utf8'), '');
    assert.equal(await readFile(join(repo, 'apm.yml'), 'utf8'), 'name: "package-repo"\nversion: 0.1.0\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init keeps YAML scalar-like repository names as strings', async () => {
  const root = await makeTempRoot('skillrepo-init-yaml-name-');
  try {
    for (const name of ['true', 'null', '123']) {
      const repo = join(root, name);
      const result = await runCli(['init', repo], root);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        await readFile(join(repo, 'apm.yml'), 'utf8'),
        `name: ${JSON.stringify(name)}\nversion: 0.1.0\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init accepts an explicit legacy layout', async () => {
  const root = await makeTempRoot('skillrepo-init-legacy-');
  const repo = join(root, 'legacy-repo');
  try {
    const result = await runCli(['init', '--layout', 'legacy', repo], root);
    assert.equal(result.code, 0, result.stderr);
    await assertInitLayout(repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init resolves its bundled template independently of the caller cwd', async () => {
  const root = await makeTempRoot('skillrepo-init-cwd-');
  const unrelated = join(root, 'unrelated');
  try {
    await mkdir(unrelated);
    const result = await runCli(['init', '--layout', 'legacy', './repo'], unrelated);
    assert.equal(result.code, 0, result.stderr);
    await assertInitLayout(join(unrelated, 'repo'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init rejects non-empty directories without changing their contents', async () => {
  const root = await makeTempRoot('skillrepo-init-nonempty-');
  const repo = join(root, 'repo');
  try {
    await mkdir(repo);
    await writeFile(join(repo, 'keep.txt'), 'keep me\n', 'utf8');
    const before = await readFile(join(repo, 'keep.txt'), 'utf8');
    const result = await runCli(['init', '--layout', 'legacy', repo], root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /empty|non-empty/i);
    assert.deepEqual(await readdir(repo), ['keep.txt']);
    assert.equal(await readFile(join(repo, 'keep.txt'), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init does not expose a force option', async () => {
  const root = await makeTempRoot('skillrepo-init-force-');
  const repo = join(root, 'repo');
  try {
    const result = await runCli(['init', '--force', repo], root);
    assert.notEqual(result.code, 0);
    await assert.rejects(lstat(repo));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init rejects files and every kind of symlink without creating partial output', async () => {
  const root = await makeTempRoot('skillrepo-init-reject-');
  try {
    const file = join(root, 'file');
    await writeFile(file, 'not a directory\n', 'utf8');
    let result = await runCli(['init', file], root);
    assert.notEqual(result.code, 0);
    assert.equal((await lstat(file)).isFile(), true);

    const directoryTarget = join(root, 'directory-target');
    const directoryLink = join(root, 'directory-link');
    await mkdir(directoryTarget);
    await symlink(directoryTarget, directoryLink, 'dir');
    result = await runCli(['init', directoryLink], root);
    assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(directoryTarget), []);

    const fileTarget = join(root, 'file-target');
    const fileLink = join(root, 'file-link');
    await writeFile(fileTarget, 'target\n', 'utf8');
    await symlink(fileTarget, fileLink, 'file');
    result = await runCli(['init', fileLink], root);
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(fileTarget, 'utf8'), 'target\n');

    const danglingLink = join(root, 'dangling-link');
    await symlink(join(root, 'does-not-exist'), danglingLink);
    result = await runCli(['init', danglingLink], root);
    assert.notEqual(result.code, 0);
    assert.equal((await lstat(danglingLink)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init does not initialize git, register the repo, or write OpenCode config', async () => {
  const root = await makeTempRoot('skillrepo-init-sideeffects-');
  const configDir = join(root, 'config');
  const repo = join(root, 'repo');
  try {
    await mkdir(configDir);
    const result = await runCli(['init', repo], root, { ...process.env, OPENCODE_CONFIG_DIR: configDir });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(join(repo, '.git')));
    assert.deepEqual(await readdir(configDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skills and agents survive git commit and clone', async () => {
  const root = await makeTempRoot('skillrepo-init-git-');
  const repo = join(root, 'repo');
  const clone = join(root, 'clone');
  try {
    let result = await runCli(['init', '--layout', 'legacy', repo], root);
    assert.equal(result.code, 0, result.stderr);
    await execFileAsync('git', ['init', '-q', repo]);
    await execFileAsync('git', ['-C', repo, 'add', '.']);
    await execFileAsync('git', ['-C', repo, '-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init skeleton']);
    await execFileAsync('git', ['clone', '-q', repo, clone]);
    await assertInitLayout(clone, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
