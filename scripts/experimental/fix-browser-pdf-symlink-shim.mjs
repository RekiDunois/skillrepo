#!/usr/bin/env node
import { chmod, copyFile, lstat, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const START_MARKER = '# BEGIN skillrepo symlink-safe browser-pdf-core path';
const END_MARKER = '# END skillrepo symlink-safe browser-pdf-core path';
const MAX_SYMLINK_DEPTH = 40;

function usage() {
  console.log(`Usage:
  node scripts/experimental/fix-browser-pdf-symlink-shim.mjs [--wrapper <path>] [--execute]

Defaults:
  --wrapper ~/.config/opencode/skill/chrome-devtools/chrome-mcp-wrapper.sh

Behavior:
  - dry-run by default
  - resolves the OpenCode wrapper symlink to the real chrome-devtools forwarding shim
  - replaces exactly one hard-coded CORE_DIR=.../browser-pdf-core assignment
  - resolves the shim's own symlink before locating sibling browser-pdf-core
  - preserves the OpenCode symlink, implementation wrapper, Chrome profile, and existing exec arguments
  - creates a timestamped backup of the shim before writing
`);
}

function parseArgs(argv) {
  let wrapper;
  let execute = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--wrapper') {
      const value = argv[++i];
      if (!value) throw new Error('--wrapper requires a path');
      wrapper = value;
    } else if (arg === '--execute') execute = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { wrapper, execute, help: false };
}

function expandHome(path) {
  if (path === '~') return homedir();
  if (path?.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function resolveFileTarget(inputPath) {
  const chain = [];
  const seen = new Set();
  let current = inputPath;
  for (let depth = 0; depth <= MAX_SYMLINK_DEPTH; depth += 1) {
    if (seen.has(current)) throw new Error(`Wrapper symlink loop detected at: ${current}`);
    seen.add(current);
    const stat = await lstat(current).catch(error => {
      throw new Error(`Cannot read wrapper path ${current}: ${error.message}`);
    });
    if (!stat.isSymbolicLink()) {
      if (!stat.isFile()) throw new Error(`Wrapper target is not a regular file: ${current}`);
      return { targetPath: current, targetStat: stat, chain };
    }
    if (depth === MAX_SYMLINK_DEPTH) throw new Error(`Wrapper symlink chain exceeds ${MAX_SYMLINK_DEPTH} links`);
    const rawTarget = await readlink(current);
    const target = resolve(dirname(current), rawTarget);
    chain.push({ path: current, rawTarget, target });
    current = target;
  }
  throw new Error('Wrapper symlink resolution failed');
}

function symlinkSafeCoreDirBlock() {
  return `${START_MARKER}
_skillrepo_shim_source="$0"
_skillrepo_shim_hops=0
while [ -L "$_skillrepo_shim_source" ]; do
  _skillrepo_shim_hops=$((_skillrepo_shim_hops + 1))
  if [ "$_skillrepo_shim_hops" -gt 40 ]; then
    printf '%s\\n' 'chrome-devtools wrapper symlink chain is too deep' >&2
    exit 126
  fi
  _skillrepo_shim_dir="$(CDPATH= cd -P -- "$(dirname -- "$_skillrepo_shim_source")" && pwd)" || exit 126
  _skillrepo_shim_target="$(readlink "$_skillrepo_shim_source")" || exit 126
  case "$_skillrepo_shim_target" in
    /*) _skillrepo_shim_source="$_skillrepo_shim_target" ;;
    *) _skillrepo_shim_source="$_skillrepo_shim_dir/$_skillrepo_shim_target" ;;
  esac
done
_skillrepo_shim_dir="$(CDPATH= cd -P -- "$(dirname -- "$_skillrepo_shim_source")" && pwd)" || exit 126
CORE_DIR="$(CDPATH= cd -P -- "$_skillrepo_shim_dir/../browser-pdf-core" && pwd)" || exit 126
unset _skillrepo_shim_source _skillrepo_shim_hops _skillrepo_shim_target _skillrepo_shim_dir
${END_MARKER}`;
}

function patchShim(text) {
  if (text.includes(START_MARKER) || text.includes(END_MARKER)) {
    if (text.includes(START_MARKER) && text.includes(END_MARKER)) return { alreadyPatched: true, text, originalCoreDir: null };
    throw new Error('Shim contains only one symlink-safe marker; refusing to modify a partial patch');
  }

  if (!/\$CORE_DIR\/chrome-mcp-wrapper\.sh/.test(text)) {
    throw new Error('Resolved wrapper does not look like the chrome-devtools forwarding shim; CORE_DIR/chrome-mcp-wrapper.sh exec was not found');
  }

  const lines = text.split(/(?<=\n)/);
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    const bare = lines[i].replace(/\r?\n$/, '');
    const match = bare.match(/^\s*CORE_DIR\s*=\s*(["']?)([^"'\r\n]*browser-pdf-core\/?)(?:\1)\s*$/);
    if (match) matches.push({ index: i, value: match[2] });
  }
  if (matches.length !== 1) {
    const candidates = text.split(/\r?\n/).filter(line => /CORE_DIR|browser-pdf-core|chrome-mcp-wrapper/.test(line));
    const detail = candidates.length ? `\nObserved shim lines:\n${candidates.map(line => `  ${line}`).join('\n')}` : '';
    throw new Error(`Expected exactly one CORE_DIR assignment ending in browser-pdf-core, found ${matches.length}.${detail}`);
  }

  const { index, value } = matches[0];
  const newline = lines[index].endsWith('\r\n') ? '\r\n' : '\n';
  lines[index] = `${symlinkSafeCoreDirBlock().replaceAll('\n', newline)}${newline}`;
  return { alreadyPatched: false, text: lines.join(''), originalCoreDir: value };
}

function backupPath(path) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${path}.skillrepo-backup-${stamp}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const logicalWrapper = resolve(expandHome(args.wrapper ?? '~/.config/opencode/skill/chrome-devtools/chrome-mcp-wrapper.sh'));
  const resolved = await resolveFileTarget(logicalWrapper);
  if (resolved.chain.length === 0) {
    throw new Error(`Wrapper is not a symlink; this fix is only for the OpenCode symlink invocation case: ${logicalWrapper}`);
  }

  const original = await readFile(resolved.targetPath, 'utf8');
  if (original.includes('\u0000')) throw new Error(`Shim appears to be binary: ${resolved.targetPath}`);
  const patched = patchShim(original);

  console.log(`WRAPPER: ${logicalWrapper}`);
  for (const link of resolved.chain) console.log(`WRAPPER LINK: ${link.path} -> ${link.rawTarget}`);
  console.log(`SHIM TARGET: ${resolved.targetPath}`);
  if (patched.alreadyPatched) {
    console.log('ALREADY-PATCHED: shim already resolves sibling browser-pdf-core from its real path.');
    return;
  }
  console.log(`OLD CORE_DIR: ${patched.originalCoreDir}`);
  console.log('NEW CORE_DIR: <real shim dir>/../browser-pdf-core');
  console.log(`MODE: ${args.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('IMPLEMENTATION WRAPPER: unchanged');
  console.log('PROFILE DATA: unchanged');
  console.log('OPENCODE SYMLINK: preserved');
  if (!args.execute) {
    console.log('\nNo files were changed. Re-run with --execute to apply.');
    return;
  }

  const backup = backupPath(resolved.targetPath);
  await copyFile(resolved.targetPath, backup, constants.COPYFILE_EXCL);
  await chmod(backup, resolved.targetStat.mode & 0o7777);

  const temporary = `${resolved.targetPath}.skillrepo-tmp-${process.pid}`;
  try {
    await writeFile(temporary, patched.text, { encoding: 'utf8', mode: resolved.targetStat.mode & 0o7777, flag: 'wx' });
    await chmod(temporary, resolved.targetStat.mode & 0o7777);
    const check = await readFile(temporary, 'utf8');
    if (!check.includes(START_MARKER) || !check.includes(END_MARKER)) throw new Error('Temporary shim verification failed');
    await rename(temporary, resolved.targetPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  console.log(`BACKUP: ${backup}`);
  console.log(`UPDATED SHIM: ${resolved.targetPath}`);
  console.log(`OPENCODE LINK PRESERVED: ${logicalWrapper}`);
  console.log('\nNext test: invoke the OpenCode symlink path with the same --output-mode=compact call that previously closed the connection.');
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
