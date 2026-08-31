#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { globSync, lstatSync, statSync } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

function usage(message) {
  if (message) console.error(`locate-resource: ${message}`);
  console.error('Usage: node locate-resource.mjs --kind <skill|agent> --name <name> [--config <file>]');
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage();
    if (argument === '--kind' || argument === '--name' || argument === '--config') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) usage(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      continue;
    }
    usage(`unknown option: ${argument}`);
  }

  if (!['skill', 'agent'].includes(values.kind)) usage('--kind must be skill or agent');
  if (!values.name?.trim()) usage('--name is required');
  return { kind: values.kind, name: values.name.trim(), config: values.config };
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function hasGlob(value) {
  return /[*?{}[\]]/.test(value);
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false;
        output += character;
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        output += '  ';
        index += 1;
        blockComment = false;
      } else {
        output += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }
    if (!inString && character === '/' && next === '/') {
      output += '  ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (!inString && character === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockComment = true;
      continue;
    }

    output += character;
    if (character === '\\' && inString && !escaped) {
      escaped = true;
      continue;
    }
    if (character === '"' && !escaped) inString = !inString;
    escaped = false;
  }

  return output.replace(/,\s*([}\]])/g, '$1');
}

async function readConfig(configPath) {
  try {
    await access(configPath, constants.R_OK);
  } catch {
    return {};
  }
  let text;
  try {
    text = await readFile(configPath, 'utf8');
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`cannot parse OpenCode config ${configPath}: ${error.message}`);
  }
}

function configuredPaths(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  if (value && typeof value === 'object' && Array.isArray(value.paths)) {
    return value.paths.filter(item => typeof item === 'string');
  }
  return [];
}

function configPath(explicit) {
  if (explicit) return resolve(expandHome(explicit));
  if (process.env.OPENCODE_CONFIG) return resolve(expandHome(process.env.OPENCODE_CONFIG));

  const configDir = resolve(expandHome(process.env.OPENCODE_CONFIG_DIR ?? '~/.config/opencode'));
  const jsonc = join(configDir, 'opencode.jsonc');
  const json = join(configDir, 'opencode.json');
  if (existsSync(jsonc) && existsSync(json)) {
    throw new Error(`both config files exist: ${jsonc} and ${json}; set OPENCODE_CONFIG`);
  }
  return existsSync(jsonc) || !existsSync(json) ? jsonc : json;
}

function existsSync(path) {
  try {
    return Boolean(lstatSync(path));
  } catch {
    return false;
  }
}

function resolveConfiguredPath(source, configFile) {
  const expanded = expandHome(source);
  return resolve(isAbsolute(expanded) ? expanded : join(dirname(configFile), expanded));
}

function sourceDirectories(sources, configFile) {
  const directories = [];
  for (const source of sources) {
    const pattern = resolveConfiguredPath(source, configFile);
    let matches;
    try {
      matches = hasGlob(pattern) ? globSync(pattern, { dot: true }) : [pattern];
    } catch (error) {
      throw new Error(`invalid configured path '${source}': ${error.message}`);
    }
    for (const match of matches) {
      try {
        if (statSync(match).isDirectory()) directories.push({ configured: source, path: match });
      } catch {
        // Missing sources are reported in the JSON result and do not abort other roots.
      }
    }
  }
  return directories;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

async function collectMarkdownFiles(root) {
  const files = [];
  const visited = new Set();

  async function walk(candidate) {
    let actual;
    try {
      actual = await realpath(candidate);
    } catch {
      return;
    }
    if (visited.has(actual)) return;
    visited.add(actual);

    let entries;
    try {
      entries = await readdir(actual, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const child = join(actual, entry.name);
      let childStat;
      try {
        childStat = await stat(child);
      } catch {
        continue;
      }
      if (childStat.isDirectory()) {
        await walk(child);
      } else if (childStat.isFile() && entry.name.endsWith('.md')) {
        files.push(await realpath(child));
      }
    }
  }

  await walk(root);
  return files;
}

async function frontmatterName(path) {
  const text = await readFile(path, 'utf8');
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find(item => /^name\s*:/.test(item));
  if (!line) return null;
  let value = line.replace(/^name\s*:\s*/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim() || null;
}

function gitValue(directory, args) {
  try {
    return execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    return null;
  }
}

function gitState(path) {
  const directory = dirname(path);
  const gitRoot = gitValue(directory, ['rev-parse', '--show-toplevel']);
  if (!gitRoot) return { managed: false, gitRoot: null, branch: null, dirty: null };
  const status = gitValue(directory, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return {
    managed: true,
    gitRoot: resolve(gitRoot),
    branch: gitValue(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    dirty: status !== null && status.length > 0,
  };
}

async function locate({ kind, name, config: explicitConfig }) {
  const configFile = configPath(explicitConfig);
  const data = await readConfig(configFile);
  const configDir = resolve(expandHome(process.env.OPENCODE_CONFIG_DIR ?? dirname(configFile)));
  const configured = kind === 'skill'
    ? configuredPaths(data.skills)
    : configuredPaths(data.agents);
  const roots = kind === 'skill'
    ? sourceDirectories(configured, configFile)
    : sourceDirectories([...configured, join(configDir, 'agents')], configFile);
  const candidates = [];

  for (const root of roots) {
    for (const path of await collectMarkdownFiles(root.path)) {
      if (kind === 'skill' && !path.endsWith(`${sep}SKILL.md`)) continue;
      if (await frontmatterName(path) !== name) continue;
      candidates.push({
        path,
        sourceRoot: await realpath(root.path),
        configuredSource: root.configured,
        git: gitState(path),
      });
    }
  }

  const unique = [...new Map(candidates.map(candidate => [candidate.path, candidate])).values()];
  if (unique.length !== 1) {
    const reason = unique.length === 0 ? 'resource not found' : 'resource is ambiguous';
    const error = new Error(`${reason}: ${kind} '${name}'`);
    error.result = {
      kind,
      name,
      config: configFile,
      searchedRoots: roots.map(root => resolve(root.path)),
      candidates: unique,
    };
    throw error;
  }

  return { kind, name, config: configFile, ...unique[0] };
}

try {
  const result = await locate(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error.result) console.error(JSON.stringify(error.result, null, 2));
  console.error(`locate-resource: ${error.message}`);
  process.exitCode = 1;
}
