#!/usr/bin/env node
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const EPHEMERAL_ROOT_NAMES = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'DevToolsActivePort',
]);

function usage() {
  console.log(`Usage:
  node scripts/experimental/migrate-browser-pdf-profile.mjs [--source <path>] [--target <path>] [--execute]

Defaults:
  --source ~/.config/opencode/skill/chrome-devtools/chrome-profile
  --target <SKILLREPO_DATA_HOME>/browser-pdf-tools/chrome-profile

  macOS SKILLREPO_DATA_HOME default:
    ~/Library/Application Support/opencode/skillrepo-data

Behavior:
  - dry-run by default
  - accepts a symlinked source root, but resolves it to the real profile directory before copying
  - refuses to overwrite an existing target
  - refuses execution when a live process appears to be using source/target profile
  - also checks Chrome SingletonLock when it contains a live PID
  - copies the profile without deleting or modifying the source
  - omits root runtime lock files: SingletonLock, SingletonSocket, SingletonCookie, DevToolsActivePort
  - verifies the copied tree: regular-file SHA-256/size and symlink targets
  - removes an incomplete target if copy/verification fails
`);
}

function parseArgs(argv) {
  let source;
  let target;
  let execute = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') {
      source = argv[++i];
      if (!source) throw new Error('--source requires a path');
    } else if (arg === '--target') {
      target = argv[++i];
      if (!target) throw new Error('--target requires a path');
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { source, target, execute, help: false };
}

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function defaultDataHome() {
  if (process.env.SKILLREPO_DATA_HOME) return expandHome(process.env.SKILLREPO_DATA_HOME);
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'opencode', 'skillrepo-data');
  }
  return join(expandHome(process.env.XDG_DATA_HOME || '~/.local/share'), 'opencode', 'skillrepo-data');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function processLinesUsing(paths) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (ps.error || ps.status !== 0) return { available: false, lines: [] };
  const normalized = [...new Set(paths.map(path => resolve(path)))];
  const lines = ps.stdout.split(/\r?\n/).filter(Boolean).filter(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return false;
    if (Number(match[1]) === process.pid) return false;
    const command = match[2];
    if (/chrome-devtools-mcp|chrome-mcp-wrapper/i.test(command) && !/migrate-browser-pdf-profile\.mjs/.test(command)) return true;
    const referencesProfile = normalized.some(path => command.includes(path));
    return referencesProfile && /--user-data-dir|Google Chrome|Chromium|chrome(?:-for-testing)?/i.test(command);
  });
  return { available: true, lines };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function singletonLockStatus(profile) {
  const lock = join(profile, 'SingletonLock');
  try {
    const info = await lstat(lock);
    let description = 'present';
    let candidatePid = null;
    if (info.isSymbolicLink()) {
      const target = await readlink(lock);
      description = `symlink -> ${target}`;
      const match = target.match(/(?:^|[-.])(\d+)$/);
      if (match) candidatePid = Number(match[1]);
    } else {
      const text = await readFile(lock, 'utf8').catch(() => '');
      description = info.isFile() ? `file${text ? ` -> ${text.trim().slice(0, 120)}` : ''}` : 'non-file';
      const match = text.match(/\b(\d{2,})\b/);
      if (match) candidatePid = Number(match[1]);
    }
    return {
      exists: true,
      description,
      pid: candidatePid,
      live: candidatePid ? pidAlive(candidatePid) : false,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, description: 'absent', pid: null, live: false };
    throw error;
  }
}

function shouldSkip(sourceRoot, entryPath) {
  const rel = relative(sourceRoot, entryPath);
  if (!rel || rel.includes(sep)) return false;
  return EPHEMERAL_ROOT_NAMES.has(rel);
}

async function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function inventory(root) {
  const records = new Map();
  const counters = { files: 0, dirs: 0, symlinks: 0, bytes: 0 };

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (shouldSkip(root, path)) continue;
      const rel = relative(root, path).split(sep).join('/');
      const info = await lstat(path);
      if (info.isDirectory()) {
        counters.dirs += 1;
        records.set(rel, { type: 'dir' });
        await walk(path);
      } else if (info.isFile()) {
        counters.files += 1;
        counters.bytes += info.size;
        records.set(rel, { type: 'file', size: info.size, sha256: await hashFile(path) });
      } else if (info.isSymbolicLink()) {
        counters.symlinks += 1;
        records.set(rel, { type: 'symlink', target: await readlink(path) });
      } else {
        throw new Error(`Unsupported profile entry type at ${path}`);
      }
    }
  }

  await walk(root);
  return { records, counters };
}

function compareInventories(sourceInventory, targetInventory) {
  const problems = [];
  const source = sourceInventory.records;
  const target = targetInventory.records;
  for (const [path, expected] of source) {
    const actual = target.get(path);
    if (!actual) {
      problems.push(`missing target entry: ${path}`);
      continue;
    }
    if (expected.type !== actual.type) {
      problems.push(`type mismatch ${path}: source=${expected.type} target=${actual.type}`);
      continue;
    }
    if (expected.type === 'file') {
      if (expected.size !== actual.size) problems.push(`size mismatch ${path}: source=${expected.size} target=${actual.size}`);
      if (expected.sha256 !== actual.sha256) problems.push(`sha256 mismatch: ${path}`);
    } else if (expected.type === 'symlink' && expected.target !== actual.target) {
      problems.push(`symlink target mismatch ${path}: source=${expected.target} target=${actual.target}`);
    }
  }
  for (const path of target.keys()) {
    if (!source.has(path)) problems.push(`unexpected target entry: ${path}`);
  }
  return problems;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const requestedSource = resolve(expandHome(args.source || '~/.config/opencode/skill/chrome-devtools/chrome-profile'));
  const source = await realpath(requestedSource).catch(error => {
    throw new Error(`Source profile is not readable: ${requestedSource}: ${error.message}`);
  });
  const target = resolve(expandHome(args.target || join(defaultDataHome(), 'browser-pdf-tools', 'chrome-profile')));

  const sourceInfo = await stat(source).catch(error => {
    throw new Error(`Resolved source profile is not readable: ${source}: ${error.message}`);
  });
  if (!sourceInfo.isDirectory()) throw new Error(`Resolved source profile is not a directory: ${source}`);
  if (source === target) throw new Error('Source and target profile paths are identical');
  if (isPathInside(target, source)) throw new Error(`Target must not be inside source: ${target}`);
  if (isPathInside(source, target)) throw new Error(`Source must not be inside target: ${source}`);
  if (await exists(target)) throw new Error(`Target already exists; refusing to overwrite: ${target}`);

  const processes = processLinesUsing([requestedSource, source, target]);
  const lock = await singletonLockStatus(source);

  console.log(`SOURCE: ${requestedSource}`);
  if (source !== requestedSource) console.log(`SOURCE TARGET: ${source}`);
  console.log(`TARGET: ${target}`);
  console.log(`MODE: ${args.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('SOURCE WILL BE DELETED: NO');
  console.log(`ROOT EPHEMERAL FILES OMITTED: ${[...EPHEMERAL_ROOT_NAMES].join(', ')}`);
  console.log(`PROCESS CHECK: ${processes.available ? (processes.lines.length ? `BUSY (${processes.lines.length} matching process${processes.lines.length === 1 ? '' : 'es'})` : 'CLEAR') : 'UNAVAILABLE'}`);
  for (const line of processes.lines.slice(0, 10)) console.log(`  ${line.trim()}`);
  console.log(`SINGLETON LOCK: ${lock.description}${lock.pid ? `; pid=${lock.pid}; live=${lock.live ? 'YES' : 'NO'}` : ''}`);

  if (!args.execute) {
    console.log('\nNo files were changed. Before --execute, stop the dedicated Chrome/MCP process that uses this profile.');
    return;
  }

  if (!processes.available) throw new Error('Cannot verify profile process usage because ps failed; refusing execute');
  if (processes.lines.length) throw new Error('A live process command references the source/target profile; stop Chrome/MCP and retry');
  if (lock.live) throw new Error(`Source SingletonLock refers to live PID ${lock.pid}; stop the browser using this profile and retry`);

  console.log('\nBuilding source inventory and SHA-256 manifest...');
  const sourceInventory = await inventory(source);
  console.log(`SOURCE INVENTORY: ${sourceInventory.counters.files} files, ${sourceInventory.counters.dirs} dirs, ${sourceInventory.counters.symlinks} symlinks, ${formatBytes(sourceInventory.counters.bytes)}`);

  await mkdir(dirname(target), { recursive: true });
  let targetCreated = false;
  try {
    console.log('Copying profile...');
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: path => !shouldSkip(source, path),
    });
    targetCreated = true;

    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory()) throw new Error(`Copied target is not a directory: ${target}`);
    await chmod(target, sourceInfo.mode & 0o7777).catch(() => {});

    console.log('Verifying copied profile...');
    const targetInventory = await inventory(target);
    console.log(`TARGET INVENTORY: ${targetInventory.counters.files} files, ${targetInventory.counters.dirs} dirs, ${targetInventory.counters.symlinks} symlinks, ${formatBytes(targetInventory.counters.bytes)}`);
    const problems = compareInventories(sourceInventory, targetInventory);
    if (problems.length) {
      const preview = problems.slice(0, 20).map(item => `  - ${item}`).join('\n');
      throw new Error(`Copied profile verification failed with ${problems.length} difference(s):\n${preview}`);
    }

    console.log('\nCOPY VERIFIED: PASS');
    console.log(`SOURCE PROFILE: preserved unchanged (${requestedSource})`);
    console.log(`EXTERNAL PROFILE READY: ${target}`);
    console.log('\nNext: run verify-browser-pdf-live-state.mjs. It should predict the external profile, then run the same skill_mcp/browser/PDF smoke tests.');
  } catch (error) {
    if (targetCreated || await exists(target)) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      console.error(`INCOMPLETE TARGET REMOVED: ${target}`);
    }
    throw error;
  }
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
