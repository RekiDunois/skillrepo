#!/usr/bin/env node
import { chmod, copyFile, lstat, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const START_MARKER = '# BEGIN skillrepo browser-pdf profile resolver';
const END_MARKER = '# END skillrepo browser-pdf profile resolver';
const MAX_SYMLINK_DEPTH = 40;

function usage() {
  console.log(`Usage:
  node scripts/experimental/migrate-browser-pdf-wrapper.mjs [--wrapper <path>] [--execute]

Defaults:
  --wrapper ~/.config/opencode/skill/chrome-devtools/chrome-mcp-wrapper.sh

Behavior:
  - dry-run by default
  - follows wrapper symlinks without replacing the symlink itself
  - refuses broken/looping symlinks and non-file final targets
  - creates a timestamped sibling backup of the real wrapper target before writing
  - injects a CHROME_PROFILE_DIR resolver with this priority:
      1. explicit CHROME_PROFILE_DIR
      2. external skillrepo data profile, if present
      3. legacy wrapper-adjacent chrome-profile, if present
      4. create/use the external profile directory
  - rewrites recognized legacy chrome-profile references to CHROME_PROFILE_DIR
  - does NOT move or delete the existing profile
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
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function resolveWrapperTarget(wrapperPath) {
  const chain = [];
  const seen = new Set();
  let current = wrapperPath;

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

    if (depth === MAX_SYMLINK_DEPTH) {
      throw new Error(`Wrapper symlink chain exceeds ${MAX_SYMLINK_DEPTH} links`);
    }

    const rawTarget = await readlink(current);
    const target = resolve(dirname(current), rawTarget);
    chain.push({ path: current, rawTarget, target });
    current = target;
  }

  throw new Error('Wrapper symlink resolution failed');
}

function resolverBlock() {
  return `${START_MARKER}
# Keep runtime browser state outside the skill source tree while preserving
# compatibility with the existing profile until it is migrated separately.
if [ -n "\${CHROME_PROFILE_DIR:-}" ]; then
  mkdir -p -- "\${CHROME_PROFILE_DIR}"
else
  _skillrepo_wrapper_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
  case "$(uname -s 2>/dev/null || printf unknown)" in
    Darwin)
      _skillrepo_data_home="\${SKILLREPO_DATA_HOME:-\${HOME}/Library/Application Support/opencode/skillrepo-data}"
      ;;
    *)
      _skillrepo_data_home="\${SKILLREPO_DATA_HOME:-\${XDG_DATA_HOME:-\${HOME}/.local/share}/opencode/skillrepo-data}"
      ;;
  esac
  _skillrepo_new_profile="\${_skillrepo_data_home}/browser-pdf-tools/chrome-profile"
  _skillrepo_legacy_profile="\${_skillrepo_wrapper_dir}/chrome-profile"

  if [ -d "\${_skillrepo_new_profile}" ]; then
    CHROME_PROFILE_DIR="\${_skillrepo_new_profile}"
  elif [ -d "\${_skillrepo_legacy_profile}" ]; then
    CHROME_PROFILE_DIR="\${_skillrepo_legacy_profile}"
  else
    mkdir -p -- "\${_skillrepo_new_profile}"
    CHROME_PROFILE_DIR="\${_skillrepo_new_profile}"
  fi
  export CHROME_PROFILE_DIR
  unset _skillrepo_wrapper_dir _skillrepo_data_home _skillrepo_new_profile _skillrepo_legacy_profile
fi
${END_MARKER}`;
}

function findInsertionOffset(text) {
  if (text.startsWith('#!')) {
    const newline = text.indexOf('\n');
    return newline === -1 ? text.length : newline + 1;
  }
  return 0;
}

function rewriteLegacyReferences(text, logicalWrapperPath, targetWrapperPath) {
  const logicalWrapperDir = dirname(logicalWrapperPath);
  const targetWrapperDir = dirname(targetWrapperPath);
  const home = homedir();
  const candidates = [
    `${logicalWrapperDir}/chrome-profile`,
    `${targetWrapperDir}/chrome-profile`,
    `${home}/.config/opencode/skill/chrome-devtools/chrome-profile`,
    '~/.config/opencode/skill/chrome-devtools/chrome-profile',
    '${HOME}/.config/opencode/skill/chrome-devtools/chrome-profile',
    '$HOME/.config/opencode/skill/chrome-devtools/chrome-profile',
    '${SCRIPT_DIR}/chrome-profile',
    '$SCRIPT_DIR/chrome-profile',
  ];
  let output = text;
  let replacements = 0;
  for (const candidate of [...new Set(candidates)]) {
    if (!candidate) continue;
    const parts = output.split(candidate);
    if (parts.length > 1) {
      replacements += parts.length - 1;
      output = parts.join('${CHROME_PROFILE_DIR}');
    }
  }
  return { text: output, replacements };
}

function migratedText(text, logicalWrapperPath, targetWrapperPath) {
  if (text.includes(START_MARKER) || text.includes(END_MARKER)) {
    if (text.includes(START_MARKER) && text.includes(END_MARKER)) return { alreadyMigrated: true, text, replacements: 0 };
    throw new Error('Wrapper contains only one migration marker; refusing to modify a partial migration');
  }
  const rewritten = rewriteLegacyReferences(text, logicalWrapperPath, targetWrapperPath);
  if (rewritten.replacements === 0) {
    const lines = text.split(/\r?\n/).filter(line => line.includes('chrome-profile'));
    const detail = lines.length ? `\nObserved chrome-profile lines:\n${lines.map(line => `  ${line}`).join('\n')}` : '';
    throw new Error(`No recognized legacy chrome-profile reference was found; refusing a blind rewrite.${detail}`);
  }
  const offset = findInsertionOffset(rewritten.text);
  const block = `${resolverBlock()}\n`;
  return {
    alreadyMigrated: false,
    text: `${rewritten.text.slice(0, offset)}${block}${rewritten.text.slice(offset)}`,
    replacements: rewritten.replacements,
  };
}

function backupPath(wrapperPath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${wrapperPath}.skillrepo-backup-${stamp}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const logicalWrapperPath = resolve(expandHome(args.wrapper ?? '~/.config/opencode/skill/chrome-devtools/chrome-mcp-wrapper.sh'));
  const resolved = await resolveWrapperTarget(logicalWrapperPath);
  const targetWrapperPath = resolved.targetPath;
  const stat = resolved.targetStat;

  const original = await readFile(targetWrapperPath, 'utf8');
  if (original.includes('\u0000')) throw new Error(`Wrapper appears to be binary: ${targetWrapperPath}`);
  const result = migratedText(original, logicalWrapperPath, targetWrapperPath);
  if (result.alreadyMigrated) {
    console.log(`ALREADY-MIGRATED: ${targetWrapperPath}`);
    if (resolved.chain.length) console.log(`WRAPPER LINK PRESERVED: ${logicalWrapperPath}`);
    return;
  }

  console.log(`WRAPPER: ${logicalWrapperPath}`);
  if (resolved.chain.length) {
    for (const link of resolved.chain) console.log(`WRAPPER LINK: ${link.path} -> ${link.rawTarget}`);
    console.log(`WRAPPER TARGET: ${targetWrapperPath}`);
  }
  console.log(`LEGACY REFERENCES TO REWRITE: ${result.replacements}`);
  console.log(`MODE: ${args.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('PROFILE DATA: unchanged');
  if (!args.execute) {
    console.log('\nNo files were changed. Re-run with --execute to apply.');
    return;
  }

  const backup = backupPath(targetWrapperPath);
  await copyFile(targetWrapperPath, backup, constants.COPYFILE_EXCL);
  await chmod(backup, stat.mode & 0o7777);

  const temporary = `${targetWrapperPath}.skillrepo-tmp-${process.pid}`;
  try {
    await writeFile(temporary, result.text, { encoding: 'utf8', mode: stat.mode & 0o7777, flag: 'wx' });
    await chmod(temporary, stat.mode & 0o7777);
    const check = await readFile(temporary, 'utf8');
    if (!check.includes(START_MARKER) || !check.includes(END_MARKER)) throw new Error('Temporary wrapper verification failed');
    // rename is atomic on the same filesystem. The OpenCode compatibility symlink
    // remains untouched because only the resolved target path is replaced.
    await rename(temporary, targetWrapperPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  console.log(`BACKUP: ${backup}`);
  if (resolved.chain.length) console.log(`SYMLINK PRESERVED: ${logicalWrapperPath}`);
  console.log('UPDATED: wrapper target now supports external profile resolution while retaining legacy fallback.');
  console.log('\nNext test: run the same browser/PDF workflow you normally use.');
  console.log('Expected on this first pass: if the external profile does not exist and the legacy profile does, the legacy profile is still selected.');
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
