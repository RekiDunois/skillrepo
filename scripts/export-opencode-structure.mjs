#!/usr/bin/env node

import { lstat, mkdir, readlink, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PRUNED_DIRS = new Map([
  ['.git', 'version-control metadata'],
  ['.hg', 'version-control metadata'],
  ['.svn', 'version-control metadata'],
  ['node_modules', 'dependency tree'],
  ['__pycache__', 'Python bytecode cache'],
  ['.pytest_cache', 'test cache'],
  ['.mypy_cache', 'type-check cache'],
  ['.ruff_cache', 'lint cache'],
  ['.cache', 'cache directory'],
  ['local_cache', 'local model/data cache'],
  ['local-cache', 'local model/data cache'],
  ['.venv', 'virtual environment'],
  ['venv', 'virtual environment'],
  ['chrome-profile', 'browser runtime profile'],
  ['Cache', 'application/browser cache'],
  ['Code Cache', 'application/browser cache'],
  ['GPUCache', 'application/browser cache'],
  ['DawnCache', 'application/browser cache'],
  ['GrShaderCache', 'application/browser cache'],
  ['GraphiteDawnCache', 'application/browser cache'],
  ['ShaderCache', 'application/browser cache'],
  ['Crashpad', 'crash/runtime state'],
  ['BrowserMetrics', 'browser runtime state'],
  ['blob_storage', 'browser runtime state'],
  ['backup', 'backup directory'],
  ['backups', 'backup directory'],
  ['skill-bak', 'skill backup directory'],
]);

const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^credentials(?:\..+)?\.json$/i,
  /^client_secret.*\.json$/i,
  /^token(?:\..+)?\.json$/i,
  /service-account.*\.json$/i,
  /^rclone\.conf$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^(?:Cookies|Cookies-journal|Login Data|Login Data-journal|Web Data|Web Data-journal|Local State)$/i,
  /\.(?:sqlite|sqlite3|db)(?:-.+)?$/i,
];

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:\n  node scripts/export-opencode-structure.mjs [source] [--out <directory>]\n\nDefaults:\n  source: $OPENCODE_CONFIG_DIR or ~/.config/opencode\n  out:    <source>/.skillrepo-inventory`);
  process.exit(2);
}

function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function displayPath(path) {
  const home = resolve(homedir());
  const abs = resolve(path);
  if (abs === home) return '~';
  if (abs.startsWith(home + sep)) return `~/${relative(home, abs).split(sep).join('/')}`;
  return abs.split(sep).join('/');
}

function relPath(root, path) {
  const rel = relative(root, path);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

function isSensitiveCandidate(name) {
  if (/^\.env\.(?:example|sample)$/i.test(name)) return false;
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

function pruneReasonForDirectory(name) {
  const exact = PRUNED_DIRS.get(name);
  if (exact) return exact;
  if (/\.local-bak-/i.test(name)) return 'local backup directory';
  return undefined;
}

function parseArgs(argv) {
  let source;
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i];
      if (!out) usage('--out requires a directory');
      continue;
    }
    if (arg === '-h' || arg === '--help') usage();
    if (arg.startsWith('-')) usage(`Unknown option: ${arg}`);
    if (source) usage('Only one source directory may be supplied');
    source = arg;
  }
  return { source, out };
}

function treeLine(entry) {
  const marker = entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : 'f';
  let suffix = '';
  if (entry.type === 'file') suffix = `  ${entry.size} B`;
  if (entry.type === 'symlink') suffix = `  -> ${entry.target}${entry.targetScope === 'external' ? '  [external]' : ''}`;
  if (entry.pruned) suffix = `  [pruned: ${entry.prunedReason}]`;
  return `${marker} ${entry.path}${suffix}`;
}

async function main() {
  const { source: sourceArg, out: outArg } = parseArgs(process.argv.slice(2));
  const source = resolve(expandHome(sourceArg ?? process.env.OPENCODE_CONFIG_DIR ?? '~/.config/opencode'));
  const sourceStat = await lstat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) usage(`Source is not a directory: ${displayPath(source)}`);

  const out = resolve(expandHome(outArg ?? join(source, '.skillrepo-inventory')));
  if (!inside(source, out)) {
    console.warn(`note: output is outside source and will not be included automatically by a source-root sync: ${displayPath(out)}`);
  }
  await mkdir(out, { recursive: true });

  const entries = [];
  const symlinks = [];
  const externalSymlinks = [];
  const sensitiveCandidates = [];
  const prunedDirectories = [];
  let fileBytes = 0;

  async function walk(dir) {
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const path = join(dir, child.name);
      if (inside(out, path) && path !== out) continue;
      if (path === out) continue;

      const rel = relPath(source, path);
      const stat = await lstat(path);

      if (stat.isSymbolicLink()) {
        const rawTarget = await readlink(path);
        const resolvedTarget = resolve(dir, rawTarget);
        const targetScope = inside(source, resolvedTarget) ? 'internal' : 'external';
        const entry = {
          path: rel,
          type: 'symlink',
          target: isAbsolute(rawTarget) ? displayPath(rawTarget) : rawTarget.split(sep).join('/'),
          resolvedTarget: displayPath(resolvedTarget),
          targetScope,
        };
        entries.push(entry);
        symlinks.push(entry);
        if (targetScope === 'external') externalSymlinks.push(entry);
        continue;
      }

      if (stat.isDirectory()) {
        const pruneReason = pruneReasonForDirectory(child.name);
        const entry = {
          path: rel,
          type: 'directory',
          ...(pruneReason ? { pruned: true, prunedReason: pruneReason } : {}),
        };
        entries.push(entry);
        if (pruneReason) {
          prunedDirectories.push(entry);
          continue;
        }
        await walk(path);
        continue;
      }

      if (stat.isFile()) {
        const entry = {
          path: rel,
          type: 'file',
          size: stat.size,
          executable: (stat.mode & 0o111) !== 0,
        };
        entries.push(entry);
        fileBytes += stat.size;
        if (isSensitiveCandidate(basename(path))) sensitiveCandidates.push(rel);
        continue;
      }

      entries.push({ path: rel, type: 'other' });
    }
  }

  await walk(source);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: displayPath(source),
    output: displayPath(out),
    notes: [
      'File contents are not included.',
      'Symlinks are recorded but never followed.',
      'Known high-noise cache/dependency/VCS/browser-profile/backup directories are recorded as pruned directory entries without listing their children.',
      'Sensitive candidates are based on filenames only; this is not a secret scanner.',
    ],
    summary: {
      entries: entries.length,
      files: entries.filter((entry) => entry.type === 'file').length,
      directories: entries.filter((entry) => entry.type === 'directory').length,
      symlinks: symlinks.length,
      externalSymlinks: externalSymlinks.length,
      sensitivePathCandidates: sensitiveCandidates.length,
      prunedDirectories: prunedDirectories.length,
      listedFileBytes: fileBytes,
    },
    symlinks,
    sensitivePathCandidates: sensitiveCandidates,
    prunedDirectories,
    entries,
  };

  const jsonPath = join(out, 'structure.json');
  const treePath = join(out, 'structure.txt');
  const sensitivePath = join(out, 'sensitive-paths.txt');

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(treePath, `${entries.map(treeLine).join('\n')}\n`, 'utf8');
  await writeFile(
    sensitivePath,
    sensitiveCandidates.length
      ? `${sensitiveCandidates.join('\n')}\n`
      : '# No filename-based sensitive candidates found. This is not proof that file contents contain no secrets.\n',
    'utf8',
  );

  console.log(`Inventory written to ${displayPath(out)}`);
  console.log(`  ${report.summary.files} files, ${report.summary.directories} directories, ${report.summary.symlinks} symlinks`);
  if (externalSymlinks.length) {
    console.warn(`warning: ${externalSymlinks.length} external symlink(s) were recorded but their targets are outside the source tree`);
  }
  if (sensitiveCandidates.length) {
    console.warn(`warning: ${sensitiveCandidates.length} filename-based sensitive candidate(s); review sensitive-paths.txt before syncing`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
