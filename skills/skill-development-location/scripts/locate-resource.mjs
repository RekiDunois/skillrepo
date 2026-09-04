#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { globSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

function usage(message) {
  if (message) console.error(`locate-resource: ${message}`);
  console.error('Usage: node locate-resource.mjs --kind <skill|agent> --name <name> [--config <file>] [--project-root <path>] [--authoring]');
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage();
    if (argument === '--authoring') {
      values.authoring = true;
      continue;
    }
    if (argument === '--kind' || argument === '--name' || argument === '--config' || argument === '--project-root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) usage(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      continue;
    }
    usage(`unknown option: ${argument}`);
  }

  if (!['skill', 'agent'].includes(values.kind)) usage('--kind must be skill or agent');
  if (!values.name?.trim()) usage('--name is required');
  return {
    kind: values.kind,
    name: values.name.trim(),
    config: values.config,
    projectRoot: values['project-root'],
    authoring: Boolean(values.authoring),
  };
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

function resolveConfiguredPath(source, projectRoot) {
  const expanded = expandHome(source);
  return resolve(isAbsolute(expanded) ? expanded : join(projectRoot, expanded));
}

function sourceDirectories(sources, projectRoot, origin, role) {
  const directories = [];
  for (const configuredSource of sources) {
    const source = typeof configuredSource === 'string' ? configuredSource : configuredSource.path;
    const recursive = typeof configuredSource === 'string' || configuredSource.recursive !== false;
    const pattern = resolveConfiguredPath(source, projectRoot);
    let matches;
    try {
      matches = hasGlob(pattern) ? globSync(pattern, { dot: true }) : [pattern];
    } catch (error) {
      throw new Error(`invalid configured path '${source}': ${error.message}`);
    }
    for (const match of matches) {
      try {
        if (statSync(match).isDirectory()) {
          directories.push({
            configured: source,
            path: match,
            recursive,
            origin: configuredSource.origin ?? origin,
            role: configuredSource.role ?? role,
          });
        }
      } catch {
        // Missing sources are reported in the JSON result and do not abort other roots.
      }
    }
  }
  return directories;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

async function collectMarkdownFiles(root, recursive = true) {
  const files = [];
  const visited = new Set();

  async function walk(logicalCandidate) {
    let actual;
    try {
      actual = await realpath(logicalCandidate);
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
      const logicalChild = join(logicalCandidate, entry.name);
      let childStat;
      try {
        childStat = await stat(child);
      } catch {
        continue;
      }
      if (childStat.isDirectory() && recursive) {
        await walk(logicalChild);
      } else if (childStat.isFile() && entry.name.endsWith('.md')) {
        files.push({ path: await realpath(child), logicalPath: logicalChild });
      }
    }
  }

  await walk(root);
  return files;
}

function standardSources(kind, configDir, projectRoots) {
  const projectSources = projectRoots.flatMap(projectRoot => kind === 'skill'
    ? [
      { path: join(projectRoot, '.opencode', 'skills'), origin: 'opencode-native', role: 'authoring' },
      { path: join(projectRoot, '.opencode', 'skill'), origin: 'opencode-native', role: 'authoring' },
      { path: join(projectRoot, '.claude', 'skills'), origin: 'claude-skills', role: 'consumer' },
      { path: join(projectRoot, '.agents', 'skills'), origin: 'agents-skills', role: 'consumer' },
    ]
    : [
      { path: join(projectRoot, '.opencode', 'agents'), origin: 'opencode-native', role: 'authoring' },
      { path: join(projectRoot, '.opencode', 'agent'), origin: 'opencode-native', role: 'authoring' },
      { path: join(projectRoot, '.opencode', 'modes'), recursive: false, origin: 'opencode-native', role: 'authoring' },
      { path: join(projectRoot, '.opencode', 'mode'), recursive: false, origin: 'opencode-native', role: 'authoring' },
    ]);

  if (kind === 'skill') {
    return [
      ...projectSources,
      { path: join(configDir, 'skills'), origin: 'opencode-native', role: 'authoring' },
      { path: join(configDir, 'skill'), origin: 'opencode-native', role: 'authoring' },
      { path: join(homedir(), '.claude', 'skills'), origin: 'claude-skills', role: 'consumer' },
      { path: join(homedir(), '.agents', 'skills'), origin: 'agents-skills', role: 'consumer' },
    ];
  }
  return [
    ...projectSources,
    { path: join(configDir, 'agents'), origin: 'opencode-native', role: 'authoring' },
    { path: join(configDir, 'agent'), origin: 'opencode-native', role: 'authoring' },
    { path: join(configDir, 'modes'), recursive: false, origin: 'opencode-native', role: 'authoring' },
    { path: join(configDir, 'mode'), recursive: false, origin: 'opencode-native', role: 'authoring' },
  ];
}

function repositoryAuthoringSources(kind, projectRoot) {
  const gitRoot = gitValue(projectRoot, ['rev-parse', '--show-toplevel']);
  if (!gitRoot) return [];
  const sourceDirectory = kind === 'skill' ? 'skills' : 'agents';
  const repoRoot = resolve(gitRoot);
  return [
    { path: join(repoRoot, '.apm', sourceDirectory), origin: 'project-repository', role: 'authoring' },
    { path: join(repoRoot, sourceDirectory), origin: 'project-repository', role: 'authoring' },
  ];
}

function consumerDiagnosticSources(kind, projectRoots) {
  if (kind !== 'skill') return [];
  return [
    ...projectRoots.map(projectRoot => ({ path: join(projectRoot, '.codex', 'skills'), origin: 'codex-legacy', role: 'consumer' })),
    { path: join(homedir(), '.codex', 'skills'), origin: 'codex-legacy', role: 'consumer' },
  ];
}

async function projectDirectories(projectRoot) {
  const current = await realpath(projectRoot).catch(() => resolve(projectRoot));
  const gitRoot = gitValue(current, ['rev-parse', '--show-toplevel']);
  const boundary = gitRoot ? resolve(gitRoot) : current;
  const directories = [];
  let directory = current;

  while (true) {
    directories.push(directory);
    if (directory === boundary) break;
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(boundary + sep)) {
      directories.push(boundary);
      break;
    }
    directory = parent;
  }
  return directories;
}

function pathResourceId(kind, sourceRoot, logicalPath) {
  const value = relative(sourceRoot, logicalPath).split(sep).join('/');
  if (kind === 'skill') {
    if (value === 'SKILL.md') return basename(sourceRoot);
    if (!value.endsWith('/SKILL.md')) return null;
    return value.slice(0, -'/SKILL.md'.length);
  }
  if (!value.endsWith('.md')) return null;
  return value.slice(0, -'.md'.length);
}

function resourceIds(kind, sourceRoot, logicalPath, metadataName) {
  if (kind === 'skill' && !metadataName) return [];
  const pathId = pathResourceId(kind, sourceRoot, logicalPath);
  if (!pathId) return [];
  const v1Id = metadataName ?? (kind === 'skill'
    ? basename(dirname(logicalPath))
    : pathId);
  return [...new Set([v1Id, pathId])];
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

function pathWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function realDirectory(path) {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function provenanceRank(root) {
  if (root.role !== 'authoring') return 0;
  if (root.origin === 'configured') return 3;
  if (root.origin === 'project-repository') return 2;
  return 1;
}

function upsertCandidate(bucket, candidate, rank) {
  const existing = bucket.get(candidate.path);
  if (!existing || rank > existing.rank) bucket.set(candidate.path, { candidate, rank });
}

function classifyCandidate(candidate, authoringRoots, consumerRoots, discoveryRoot) {
  const locations = [candidate.path, candidate.sourceRoot];
  const authoringHit = authoringRoots
    .slice()
    .sort((first, second) => provenanceRank(second) - provenanceRank(first))
    .find(root => {
      const real = realDirectory(root.path) ?? resolve(root.path);
      return locations.some(location => pathWithin(real, location));
    });
  if (authoringHit) return { role: 'authoring', origin: authoringHit.origin, rank: provenanceRank(authoringHit) };
  const consumerHit = consumerRoots.find(root => {
    const real = realDirectory(root.path) ?? resolve(root.path);
    return locations.some(location => pathWithin(real, location));
  });
  if (consumerHit) return { role: 'consumer', origin: consumerHit.origin, rank: 0 };
  return { role: 'authoring', origin: discoveryRoot.origin, rank: provenanceRank(discoveryRoot) };
}

function hasPackageManifest(repoRoot) {
  try {
    const manifestStat = lstatSync(join(repoRoot, 'apm.yml'));
    return manifestStat.isFile() && !manifestStat.isSymbolicLink();
  } catch {
    return false;
  }
}

function canonicalSourceRoot(kind, configuredSourceRoot, filePath) {
  const sourceDirectory = kind === 'skill' ? 'skills' : 'agents';
  const gitRoot = gitValue(dirname(filePath), ['rev-parse', '--show-toplevel']);

  if (gitRoot) {
    const repoRoot = resolve(gitRoot);
    if (hasPackageManifest(repoRoot)) {
      const packageSourceRoot = realDirectory(join(repoRoot, '.apm', sourceDirectory));
      if (packageSourceRoot && pathWithin(packageSourceRoot, filePath)) return packageSourceRoot;
    }

    const legacySourceRoot = realDirectory(join(repoRoot, sourceDirectory));
    if (legacySourceRoot && pathWithin(legacySourceRoot, filePath)) return legacySourceRoot;
  }

  if (pathWithin(configuredSourceRoot, filePath)) return configuredSourceRoot;
  return configuredSourceRoot;
}

function layoutMetadata(kind, sourceRoot, git) {
  const realSourceRoot = resolve(sourceRoot);
  const parent = dirname(realSourceRoot);
  const packageRoot = dirname(parent);
  const manifest = join(packageRoot, 'apm.yml');
  let hasPackageManifest = false;
  try {
    const manifestStat = lstatSync(manifest);
    hasPackageManifest = manifestStat.isFile() && !manifestStat.isSymbolicLink();
  } catch {
    // A source root can be a regular OpenCode directory without a package manifest.
  }

  const sourceDirectory = kind === 'skill' ? 'skills' : 'agents';
  if (basename(realSourceRoot) === sourceDirectory && basename(parent) === '.apm' && hasPackageManifest) {
    return {
      repoRoot: git.gitRoot ?? packageRoot,
      layout: 'apm',
    };
  }
  if (basename(realSourceRoot) === sourceDirectory) {
    return {
      repoRoot: git.gitRoot ?? parent,
      layout: 'skillrepo',
    };
  }
  return {
    repoRoot: git.gitRoot ?? dirname(realSourceRoot),
    layout: 'unknown',
  };
}

async function locate({ kind, name, config: explicitConfig, projectRoot: explicitProjectRoot, authoring }) {
  const configFile = configPath(explicitConfig);
  const data = await readConfig(configFile);
  const configDir = resolve(expandHome(process.env.OPENCODE_CONFIG_DIR ?? '~/.config/opencode'));
  const projectRoot = resolve(expandHome(explicitProjectRoot ?? process.cwd()));
  const projectRoots = await projectDirectories(projectRoot);
  const configured = kind === 'skill'
    ? configuredPaths(data.skills)
    : configuredPaths(data.agents);
  const configuredRoots = sourceDirectories(configured, projectRoot, 'configured', 'authoring');
  const standardRoots = sourceDirectories(standardSources(kind, configDir, projectRoots), projectRoot);
  const repositoryRoots = authoring
    ? sourceDirectories(repositoryAuthoringSources(kind, projectRoot), projectRoot)
    : [];
  const consumerDiagnosticRoots = authoring
    ? sourceDirectories(consumerDiagnosticSources(kind, projectRoots), projectRoot)
    : [];
  const roots = [...standardRoots, ...configuredRoots, ...repositoryRoots, ...consumerDiagnosticRoots];
  const authoringRoots = authoring
    ? [...configuredRoots, ...repositoryRoots, ...standardRoots.filter(root => root.role === 'authoring')]
    : [];
  const consumerRoots = authoring
    ? [...standardRoots.filter(root => root.role === 'consumer'), ...consumerDiagnosticRoots]
    : [];
  const primary = new Map();
  const alias = new Map();
  const consumers = new Map();

  for (const root of roots) {
    for (const file of await collectMarkdownFiles(root.path, root.recursive)) {
      const metadataName = await frontmatterName(file.path);
      const identifiers = resourceIds(kind, root.path, file.logicalPath, metadataName);
      if (!identifiers.includes(name)) continue;
      const configuredSourceRoot = await realpath(root.path);
      const sourceRoot = canonicalSourceRoot(kind, configuredSourceRoot, file.path);
      const sourceRelativePath = relative(sourceRoot, file.path).split(sep).join('/');
      const candidate = {
        path: file.path,
        id: identifiers[0],
        identifiers,
        sourceRelativePath,
        sourceRoot,
        configuredSource: root.configured,
        frontmatterName: metadataName,
      };

      if (authoring) {
        const classification = classifyCandidate(candidate, authoringRoots, consumerRoots, root);
        if (classification.role === 'consumer') {
          const diagnostic = {
            path: candidate.path,
            id: candidate.id,
            origin: classification.origin,
            layout: 'unknown',
            repoRoot: null,
          };
          if (!consumers.has(diagnostic.path)) consumers.set(diagnostic.path, diagnostic);
          continue;
        }
        candidate.git = gitState(candidate.path);
        const layout = layoutMetadata(kind, candidate.sourceRoot, candidate.git);
        candidate.repoRoot = layout.repoRoot;
        candidate.layout = layout.layout;
        upsertCandidate(identifiers[0] === name ? primary : alias, candidate, classification.rank);
        continue;
      }

      candidate.git = gitState(candidate.path);
      const layout = layoutMetadata(kind, candidate.sourceRoot, candidate.git);
      candidate.repoRoot = layout.repoRoot;
      candidate.layout = layout.layout;
      upsertCandidate(identifiers[0] === name ? primary : alias, candidate, provenanceRank(root));
    }
  }

  const pool = primary.size ? primary : alias;
  const unique = [...pool.values()].map(entry => entry.candidate);
  const consumerMatches = [...consumers.values()];

  if (authoring) {
    if (unique.length === 1) {
      return { kind, name, config: configFile, ...unique[0], selectionMode: 'authoring', consumerMatches };
    }
    const reason = unique.length === 0
      ? (consumerMatches.length ? 'authoritative source not found' : 'resource not found')
      : 'resource is ambiguous';
    const error = new Error(`${reason}: ${kind} '${name}'`);
    error.result = {
      kind,
      name,
      config: configFile,
      selectionMode: 'authoring',
      searchedRoots: roots.map(root => resolve(root.path)),
      candidates: unique,
      consumerMatches,
    };
    throw error;
  }

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
