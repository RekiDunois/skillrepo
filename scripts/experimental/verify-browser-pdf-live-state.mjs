#!/usr/bin/env node
import { access, lstat, readFile, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROFILE_START = '# BEGIN skillrepo browser-pdf profile resolver';
const PROFILE_END = '# END skillrepo browser-pdf profile resolver';
const MAX_SYMLINK_DEPTH = 40;

function expandHome(path) {
  if (path === '~') return homedir();
  if (path?.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveFileTarget(inputPath) {
  const chain = [];
  const seen = new Set();
  let current = inputPath;
  for (let depth = 0; depth <= MAX_SYMLINK_DEPTH; depth += 1) {
    if (seen.has(current)) throw new Error(`symlink loop detected at ${current}`);
    seen.add(current);
    const stat = await lstat(current);
    if (!stat.isSymbolicLink()) {
      if (!stat.isFile()) throw new Error(`final target is not a regular file: ${current}`);
      return { target: current, chain };
    }
    if (depth === MAX_SYMLINK_DEPTH) throw new Error(`symlink depth exceeds ${MAX_SYMLINK_DEPTH}`);
    const raw = await readlink(current);
    const target = resolve(dirname(current), raw);
    chain.push({ path: current, raw, target });
    current = target;
  }
  throw new Error('failed to resolve wrapper');
}

function inferCoreWrapper(shimPath, shimText) {
  const sibling = resolve(dirname(shimPath), '..', 'browser-pdf-core', 'chrome-mcp-wrapper.sh');
  if (/browser-pdf-core/.test(shimText) || /CORE_DIR/.test(shimText)) return sibling;
  return shimPath;
}

function macDataHome() {
  return process.env.SKILLREPO_DATA_HOME || join(homedir(), 'Library', 'Application Support', 'opencode', 'skillrepo-data');
}

function nonMacDataHome() {
  const base = process.env.SKILLREPO_DATA_HOME || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return process.env.SKILLREPO_DATA_HOME ? base : join(base, 'opencode', 'skillrepo-data');
}

async function main() {
  const logical = resolve(expandHome(process.argv[2] || '~/.config/opencode/skill/chrome-devtools/chrome-mcp-wrapper.sh'));
  const resolved = await resolveFileTarget(logical);
  const shimPath = resolved.target;
  const shimText = await readFile(shimPath, 'utf8');
  const corePath = inferCoreWrapper(shimPath, shimText);
  const coreText = await readFile(corePath, 'utf8');

  const legacyProfile = resolve(dirname(shimPath), 'chrome-profile');
  const dataHome = process.platform === 'darwin' ? macDataHome() : nonMacDataHome();
  const externalProfile = join(dataHome, 'browser-pdf-tools', 'chrome-profile');

  const hasProfileMarkers = coreText.includes(PROFILE_START) && coreText.includes(PROFILE_END);
  const hasProfileVar = /CHROME_PROFILE_DIR/.test(coreText);
  const hasNewProfileRef = /skillrepo-data|browser-pdf-tools\/chrome-profile/.test(coreText);
  const hasLegacyFallbackRef = /chrome-devtools\/chrome-profile|\.\.\/chrome-devtools\/chrome-profile/.test(coreText);
  const hardcodedHome = coreText.includes(homedir()) || shimText.includes(homedir());
  const shimHasHardcodedOpenCodeCore = /CORE_DIR=["']?\/Users\/[^\n]*\.config\/opencode\/skill\/browser-pdf-core/.test(shimText)
    || /CORE_DIR=["']?[^\n]*\.config\/opencode\/skill\/browser-pdf-core/.test(shimText);

  const shCheckShim = spawnSync('/bin/sh', ['-n', shimPath], { encoding: 'utf8' });
  const shCheckCore = spawnSync('/bin/sh', ['-n', corePath], { encoding: 'utf8' });

  let predictedProfile;
  let predictedReason;
  if (process.env.CHROME_PROFILE_DIR) {
    predictedProfile = process.env.CHROME_PROFILE_DIR;
    predictedReason = 'explicit CHROME_PROFILE_DIR';
  } else if (await isDir(externalProfile)) {
    predictedProfile = externalProfile;
    predictedReason = 'external profile exists';
  } else if (await isDir(legacyProfile)) {
    predictedProfile = legacyProfile;
    predictedReason = 'legacy fallback exists';
  } else {
    predictedProfile = externalProfile;
    predictedReason = 'neither exists; wrapper would create external profile';
  }

  console.log(`WRAPPER: ${logical}`);
  for (const link of resolved.chain) console.log(`WRAPPER LINK: ${link.path} -> ${link.raw}`);
  console.log(`SHIM TARGET: ${shimPath}`);
  console.log(`CORE WRAPPER: ${corePath}`);
  console.log('');
  console.log(`PROFILE RESOLVER MARKERS: ${hasProfileMarkers ? 'PRESENT' : 'MISSING'}`);
  console.log(`CHROME_PROFILE_DIR LOGIC: ${hasProfileVar ? 'PRESENT' : 'MISSING'}`);
  console.log(`EXTERNAL PROFILE REFERENCE: ${hasNewProfileRef ? 'PRESENT' : 'MISSING'}`);
  console.log(`LEGACY FALLBACK REFERENCE: ${hasLegacyFallbackRef ? 'PRESENT' : 'MISSING'}`);
  console.log(`LEGACY PROFILE EXISTS: ${(await isDir(legacyProfile)) ? 'YES' : 'NO'} (${legacyProfile})`);
  console.log(`EXTERNAL PROFILE EXISTS: ${(await isDir(externalProfile)) ? 'YES' : 'NO'} (${externalProfile})`);
  console.log(`PREDICTED PROFILE: ${predictedProfile}`);
  console.log(`PREDICTED REASON: ${predictedReason}`);
  console.log('');
  console.log(`SHIM SHELL SYNTAX: ${shCheckShim.status === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`CORE SHELL SYNTAX: ${shCheckCore.status === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`HARDCODED HOME PATH PRESENT: ${hardcodedHome ? 'YES' : 'NO'}`);
  console.log(`HARDCODED OLD OPENCODE CORE_DIR: ${shimHasHardcodedOpenCodeCore ? 'YES' : 'NO'}`);
  console.log('');

  const resolverSurvived = hasProfileMarkers && hasProfileVar && hasNewProfileRef;
  const portabilityOkay = !shimHasHardcodedOpenCodeCore && shCheckShim.status === 0 && shCheckCore.status === 0;
  if (resolverSurvived && portabilityOkay) {
    console.log('VERDICT: PASS — profile migration resolver is still present, and the live wrapper chain is syntactically/portability-safe by these checks.');
  } else {
    console.log('VERDICT: REVIEW NEEDED');
    if (!resolverSurvived) console.log('  - The earlier profile migration resolver appears to have been removed or rewritten materially.');
    if (!portabilityOkay) console.log('  - The wrapper chain still has a portability/syntax problem.');
  }

  if (shCheckShim.status !== 0 && shCheckShim.stderr) console.log(`SHIM SYNTAX ERROR: ${shCheckShim.stderr.trim()}`);
  if (shCheckCore.status !== 0 && shCheckCore.stderr) console.log(`CORE SYNTAX ERROR: ${shCheckCore.stderr.trim()}`);
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
