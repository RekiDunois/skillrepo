#!/usr/bin/env node
import { chmod, copyFile, lstat, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const START_MARKER = '# BEGIN skillrepo browser-pdf profile resolver';
const END_MARKER = '# END skillrepo browser-pdf profile resolver';
const MAX_SYMLINK_DEPTH = 40;

function usage() {
  console.log(`Usage:
  node scripts/experimental/migrate-browser-pdf-wrapper.mjs [--wrapper <path>] [--implementation-wrapper <path>] [--legacy-profile <path>] [--execute]

Defaults:
  --wrapper ~/.config/opencode/skill/chrome-devtools/chrome-mcp-wrapper.sh

Behavior:
  - dry-run by default
  - follows the OpenCode wrapper symlink without replacing it
  - recognizes the chrome-devtools forwarding shim and follows it to the sibling browser-pdf-core implementation
  - --implementation-wrapper can override implementation discovery
  - --legacy-profile can override legacy profile discovery
  - creates a timestamped sibling backup of the real implementation wrapper before writing
  - injects a CHROME_PROFILE_DIR resolver with this priority:
      1. explicit CHROME_PROFILE_DIR
      2. external skillrepo data profile, if present
      3. existing legacy chrome-devtools profile, if present
      4. create/use the external profile directory
  - rewrites recognized legacy chrome-profile references in the implementation wrapper to CHROME_PROFILE_DIR
  - does NOT move or delete the existing profile
`);
}

function parseArgs(argv) {
  let wrapper;
  let implementationWrapper;
  let legacyProfile;
  let execute = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--wrapper') {
      const value = argv[++i];
      if (!value) throw new Error('--wrapper requires a path');
      wrapper = value;
    } else if (arg === '--implementation-wrapper') {
      const value = argv[++i];
      if (!value) throw new Error('--implementation-wrapper requires a path');
      implementationWrapper = value;
    } else if (arg === '--legacy-profile') {
      const value = argv[++i];
      if (!value) throw new Error('--legacy-profile requires a path');
      legacyProfile = value;
    } else if (arg === '--execute') execute = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { wrapper, implementationWrapper, legacyProfile, execute, help: false };
}

function expandHome(path) {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function resolveFileTarget(inputPath, label) {
  const chain = [];
  const seen = new Set();
  let current = inputPath;

  for (let depth = 0; depth <= MAX_SYMLINK_DEPTH; depth += 1) {
    if (seen.has(current)) throw new Error(`${label} symlink loop detected at: ${current}`);
    seen.add(current);

    const stat = await lstat(current).catch(error => {
      throw new Error(`Cannot read ${label} path ${current}: ${error.message}`);
    });

    if (!stat.isSymbolicLink()) {
      if (!stat.isFile()) throw new Error(`${label} target is not a regular file: ${current}`);
      return { targetPath: current, targetStat: stat, chain };
    }

    if (depth === MAX_SYMLINK_DEPTH) throw new Error(`${label} symlink chain exceeds ${MAX_SYMLINK_DEPTH} links`);
    const rawTarget = await readlink(current);
    const target = resolve(dirname(current), rawTarget);
    chain.push({ path: current, rawTarget, target });
    current = target;
  }

  throw new Error(`${label} symlink resolution failed`);
}

async function tryDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverImplementationWrapper(logicalWrapperPath, resolvedWrapper, explicitPath) {
  if (explicitPath) {
    const logicalPath = resolve(expandHome(explicitPath));
    const resolved = await resolveFileTarget(logicalPath, 'implementation wrapper');
    return { logicalPath, ...resolved, discoveredFromShim: false };
  }

  const currentText = await readFile(resolvedWrapper.targetPath, 'utf8');
  const looksLikeForwarder = /exec\s+["']?\$\{?CORE_DIR\}?\/chrome-mcp-wrapper\.sh/.test(currentText)
    || currentText.includes('$CORE_DIR/chrome-mcp-wrapper.sh');

  if (!looksLikeForwarder) {
    return {
      logicalPath: logicalWrapperPath,
      targetPath: resolvedWrapper.targetPath,
      targetStat: resolvedWrapper.targetStat,
      chain: resolvedWrapper.chain,
      discoveredFromShim: false,
    };
  }

  const siblingCandidate = resolve(dirname(resolvedWrapper.targetPath), '..', 'browser-pdf-core', 'chrome-mcp-wrapper.sh');
  try {
    const siblingResolved = await resolveFileTarget(siblingCandidate, 'implementation wrapper');
    return { logicalPath: siblingCandidate, ...siblingResolved, discoveredFromShim: true };
  } catch (error) {
    throw new Error(
      `Detected chrome-devtools forwarding shim at ${resolvedWrapper.targetPath}, but could not resolve sibling browser-pdf-core wrapper ${siblingCandidate}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function discoverLegacyProfile(logicalWrapperPath, resolvedWrapper, explicitPath) {
  if (explicitPath) {
    const path = resolve(expandHome(explicitPath));
    if (!(await tryDirectory(path))) throw new Error(`Legacy profile is not an existing directory: ${path}`);
    return { path, source: 'explicit' };
  }

  const candidates = [
    resolve(dirname(resolvedWrapper.targetPath), 'chrome-profile'),
    resolve(dirname(logicalWrapperPath), 'chrome-profile'),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await tryDirectory(candidate)) return { path: candidate, source: 'discovered' };
  }

  throw new Error(
    `Could not discover the existing legacy Chrome profile. Re-run with --legacy-profile <path>; expected near ${resolvedWrapper.targetPath}`,
  );
}

function runtimeRelativeLegacyExpression(implementationPath, legacyProfilePath) {
  const rel = relative(dirname(implementationPath), legacyProfilePath);
  if (!rel || rel === '.') throw new Error('Legacy profile path unexpectedly resolves to the implementation wrapper directory');
  if (rel.split(sep).includes('')) throw new Error(`Cannot represent legacy profile path relative to implementation wrapper: ${legacyProfilePath}`);
  return rel.split(sep).join('/');
}

function resolverBlock(legacyRelativePath) {
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
  _skillrepo_legacy_profile="\${_skillrepo_wrapper_dir}/${legacyRelativePath}"

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

function rewriteLegacyReferences(text, logicalWrapperPath, shimTargetPath, implementationPath, legacyProfilePath) {
  const home = homedir();
  const candidates = [
    legacyProfilePath,
    `${dirname(logicalWrapperPath)}/chrome-profile`,
    `${dirname(shimTargetPath)}/chrome-profile`,
    `${dirname(implementationPath)}/chrome-profile`,
    `${home}/.config/opencode/skill/chrome-devtools/chrome-profile`,
    '~/.config/opencode/skill/chrome-devtools/chrome-profile',
    '${HOME}/.config/opencode/skill/chrome-devtools/chrome-profile',
    '$HOME/.config/opencode/skill/chrome-devtools/chrome-profile',
    '${SCRIPT_DIR}/../chrome-devtools/chrome-profile',
    '$SCRIPT_DIR/../chrome-devtools/chrome-profile',
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

function migratedText(text, context) {
  if (text.includes(START_MARKER) || text.includes(END_MARKER)) {
    if (text.includes(START_MARKER) && text.includes(END_MARKER)) return { alreadyMigrated: true, text, replacements: 0 };
    throw new Error('Implementation wrapper contains only one migration marker; refusing to modify a partial migration');
  }
  const rewritten = rewriteLegacyReferences(
    text,
    context.logicalWrapperPath,
    context.shimTargetPath,
    context.implementationPath,
    context.legacyProfilePath,
  );
  if (rewritten.replacements === 0) {
    const lines = text.split(/\r?\n/).filter(line => /chrome|profile|user-data|data-dir/i.test(line));
    const detail = lines.length ? `\nObserved implementation lines:\n${lines.slice(0, 30).map(line => `  ${line}`).join('\n')}` : '';
    throw new Error(`No recognized legacy chrome-profile reference was found in the implementation wrapper; refusing a blind rewrite.${detail}`);
  }
  const offset = findInsertionOffset(rewritten.text);
  const block = `${resolverBlock(context.legacyRelativePath)}\n`;
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
  const resolvedWrapper = await resolveFileTarget(logicalWrapperPath, 'wrapper');
  const implementation = await discoverImplementationWrapper(logicalWrapperPath, resolvedWrapper, args.implementationWrapper);
  const legacyProfile = await discoverLegacyProfile(logicalWrapperPath, resolvedWrapper, args.legacyProfile);
  const legacyRelativePath = runtimeRelativeLegacyExpression(implementation.targetPath, legacyProfile.path);

  const original = await readFile(implementation.targetPath, 'utf8');
  if (original.includes('\u0000')) throw new Error(`Implementation wrapper appears to be binary: ${implementation.targetPath}`);
  const result = migratedText(original, {
    logicalWrapperPath,
    shimTargetPath: resolvedWrapper.targetPath,
    implementationPath: implementation.targetPath,
    legacyProfilePath: legacyProfile.path,
    legacyRelativePath,
  });

  if (result.alreadyMigrated) {
    console.log(`ALREADY-MIGRATED: ${implementation.targetPath}`);
    console.log(`LEGACY PROFILE: ${legacyProfile.path}`);
    return;
  }

  console.log(`WRAPPER: ${logicalWrapperPath}`);
  for (const link of resolvedWrapper.chain) console.log(`WRAPPER LINK: ${link.path} -> ${link.rawTarget}`);
  console.log(`WRAPPER TARGET: ${resolvedWrapper.targetPath}`);
  if (implementation.discoveredFromShim) console.log('FORWARDING SHIM: detected chrome-devtools -> browser-pdf-core');
  console.log(`IMPLEMENTATION WRAPPER: ${implementation.targetPath}`);
  console.log(`LEGACY PROFILE: ${legacyProfile.path} (${legacyProfile.source})`);
  console.log(`LEGACY PROFILE RUNTIME RELATIVE PATH: ${legacyRelativePath}`);
  console.log(`LEGACY REFERENCES TO REWRITE: ${result.replacements}`);
  console.log(`MODE: ${args.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('PROFILE DATA: unchanged');
  if (!args.execute) {
    console.log('\nNo files were changed. Re-run with --execute to apply.');
    return;
  }

  const stat = implementation.targetStat;
  const backup = backupPath(implementation.targetPath);
  await copyFile(implementation.targetPath, backup, constants.COPYFILE_EXCL);
  await chmod(backup, stat.mode & 0o7777);

  const temporary = `${implementation.targetPath}.skillrepo-tmp-${process.pid}`;
  try {
    await writeFile(temporary, result.text, { encoding: 'utf8', mode: stat.mode & 0o7777, flag: 'wx' });
    await chmod(temporary, stat.mode & 0o7777);
    const check = await readFile(temporary, 'utf8');
    if (!check.includes(START_MARKER) || !check.includes(END_MARKER)) throw new Error('Temporary implementation wrapper verification failed');
    await rename(temporary, implementation.targetPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  console.log(`BACKUP: ${backup}`);
  console.log(`SHIM PRESERVED: ${resolvedWrapper.targetPath}`);
  console.log(`OPENCODE LINK PRESERVED: ${logicalWrapperPath}`);
  console.log('UPDATED: browser-pdf-core implementation now supports external profile resolution while retaining legacy fallback.');
  console.log('\nNext test: run the same browser/PDF workflow you normally use.');
  console.log('Expected on this first pass: because the external profile does not exist yet, the existing legacy chrome-devtools profile is still selected.');
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
