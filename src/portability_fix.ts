import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { classifyMigrationPortability, type PortabilitySegment } from './portability.js';
import { resolveRegisteredResource } from './runtime.js';

export type PortabilityFixActionKind = 'AUTO-REPO-EXEC' | 'AUTO-DOC-OPENCODE-PATH' | 'MANUAL-FRONTMATTER' | 'MANUAL-MARKDOWN' | 'MANUAL-TEST' | 'MANUAL-RUNTIME-CODE';
export type PortabilityFixAction = { kind: PortabilityFixActionKind; lines: number[]; auto: boolean; detail: string; originalCommand?: string[]; replacementCommand?: string[]; mcpEntry?: string; runtimeRepoId?: string; runtimeResource?: string };
export type PortabilityFixFile = { repoId: string; path: string; actions: PortabilityFixAction[]; changed: boolean };
export type PortabilityFixResult = { schemaVersion: 1; dryRun: boolean; planPath: string; targetRoot: string; files: PortabilityFixFile[]; summary: { files: number; autoActions: number; manualActions: number; changedFiles: number } };
type RepoPlan = { id: string; action: string; skills?: string[]; agents?: string[]; libs?: string[] };
type MigrationPlan = { schemaVersion: number; generatedFrom?: { sourceRoot?: string }; repositories: RepoPlan[] };
type SourceMapping = { sourceBase: string; repoId: string; resourceBase: string };
type McpCommand = { entry: string; command: string[] };
type CommandBlock = { start: number; end: number; indent: string };

function expandHome(path: string): string { if (path === '~') return homedir(); if (path.startsWith('~/')) return join(homedir(), path.slice(2)); return path; }
function toPosix(path: string): string { return path.split(sep).join('/'); }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
function normalizeLibSpec(value: string): string { return value.replace(/\/\*\*$/, '').replace(/\/$/, ''); }

async function readPlan(planPath: string): Promise<MigrationPlan> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(planPath, 'utf8')); } catch (error) { throw new Error(`Migration plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!raw || typeof raw !== 'object') throw new Error('Migration plan must be a JSON object');
  const plan = raw as MigrationPlan;
  if (plan.schemaVersion !== 1) throw new Error(`Unsupported migration plan schemaVersion: ${String(plan.schemaVersion)}`);
  if (!Array.isArray(plan.repositories)) throw new Error('Migration plan repositories must be an array');
  if (typeof plan.generatedFrom?.sourceRoot !== 'string' || !plan.generatedFrom.sourceRoot.trim()) throw new Error('Migration plan generatedFrom.sourceRoot is required for portability fixes');
  return plan;
}

function buildMappings(plan: MigrationPlan, sourceRoot: string): SourceMapping[] {
  const mappings: SourceMapping[] = [];
  for (const repo of plan.repositories) {
    if (repo.action !== 'CREATE_AND_MOVE') continue;
    for (const skill of repo.skills ?? []) mappings.push({ sourceBase: resolve(sourceRoot, 'skill', skill), repoId: repo.id, resourceBase: toPosix(join('skills', skill)) });
    for (const agent of repo.agents ?? []) mappings.push({ sourceBase: resolve(sourceRoot, 'agents', agent), repoId: repo.id, resourceBase: toPosix(join('agents', agent)) });
    for (const rawLib of repo.libs ?? []) { const lib = normalizeLibSpec(rawLib); mappings.push({ sourceBase: resolve(sourceRoot, lib), repoId: repo.id, resourceBase: toPosix(lib) }); }
  }
  return mappings.sort((left, right) => right.sourceBase.length - left.sourceBase.length);
}

function mapSourcePath(path: string, mappings: SourceMapping[]): { repoId: string; resource: string } | null {
  const absolute = resolve(path);
  for (const mapping of mappings) {
    if (!within(mapping.sourceBase, absolute)) continue;
    const suffix = relative(mapping.sourceBase, absolute);
    return { repoId: mapping.repoId, resource: suffix ? toPosix(join(mapping.resourceBase, suffix)) : mapping.resourceBase };
  }
  return null;
}

function mcpCommands(text: string): McpCommand[] {
  const meta = parseFrontmatter(text).data;
  const mcp = meta.mcp;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return [];
  const commands: McpCommand[] = [];
  for (const [entry, value] of Object.entries(mcp as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const command = (value as Record<string, unknown>).command;
    if (Array.isArray(command) && command.every(item => typeof item === 'string')) commands.push({ entry, command: command as string[] });
  }
  return commands;
}

function frontmatterLineLimit(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return -1;
  for (let index = 1; index < lines.length; index += 1) if (lines[index]!.trim() === '---') return index + 1;
  return -1;
}
function indentation(line: string): number { return line.match(/^\s*/)?.[0].length ?? 0; }
function yamlKey(line: string): { indent: number; key: string } | null {
  const match = line.match(/^(\s*)(?:(['"])(.*?)\2|([^:#][^:]*?))\s*:/);
  if (!match) return null;
  const key = (match[3] ?? match[4] ?? '').trim();
  return key ? { indent: match[1]!.length, key } : null;
}

function findMcpCommandBlock(text: string, entry: string): CommandBlock | null {
  const lines = text.split('\n');
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (lines[0]?.trim() !== '---' || close < 0) return null;
  let mcpIndex = -1, mcpIndent = -1;
  for (let i = 1; i < close; i += 1) { const key = yamlKey(lines[i]!); if (key?.key === 'mcp') { mcpIndex = i; mcpIndent = key.indent; break; } }
  if (mcpIndex < 0) return null;
  let mcpEnd = close;
  for (let i = mcpIndex + 1; i < close; i += 1) if (lines[i]!.trim() && indentation(lines[i]!) <= mcpIndent) { mcpEnd = i; break; }
  let entryIndex = -1, entryIndent = -1;
  for (let i = mcpIndex + 1; i < mcpEnd; i += 1) { const key = yamlKey(lines[i]!); if (key?.key === entry && key.indent > mcpIndent) { entryIndex = i; entryIndent = key.indent; break; } }
  if (entryIndex < 0) return null;
  let entryEnd = mcpEnd;
  for (let i = entryIndex + 1; i < mcpEnd; i += 1) if (lines[i]!.trim() && indentation(lines[i]!) <= entryIndent) { entryEnd = i; break; }
  for (let i = entryIndex + 1; i < entryEnd; i += 1) {
    const key = yamlKey(lines[i]!);
    if (key?.key !== 'command' || key.indent <= entryIndent) continue;
    let end = i + 1;
    while (end < entryEnd) { if (lines[end]!.trim() === '') { end += 1; continue; } if (indentation(lines[end]!) <= key.indent) break; end += 1; }
    return { start: i, end, indent: lines[i]!.match(/^\s*/)?.[0] ?? '' };
  }
  return null;
}

function commandHitLines(text: string, entry: string, executable: string, segmentLines: number[]): number[] {
  const block = findMcpCommandBlock(text, entry); if (!block) return [];
  const lines = text.split('\n'); const allowed = new Set(segmentLines); const hits: number[] = [];
  for (let i = block.start; i < block.end; i += 1) if (allowed.has(i + 1) && lines[i]!.includes(executable)) hits.push(i + 1);
  return hits;
}
function rewriteCommandBlock(text: string, entry: string, replacementCommand: string[]): string {
  const block = findMcpCommandBlock(text, entry); if (!block) throw new Error(`Expected MCP command block for entry ${entry}`);
  const lines = text.split('\n'); lines.splice(block.start, block.end - block.start, `${block.indent}command: ${JSON.stringify(replacementCommand)}`); return lines.join('\n');
}
function rewriteMarkdownBodySourceRoot(text: string, sourceRoot: string, alias: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/); if (!match) return text.replaceAll(sourceRoot, alias); const prefix = match[0]; return `${prefix}${text.slice(prefix.length).replaceAll(sourceRoot, alias)}`;
}
function isRuntimeEnvironmentResource(resource: string): boolean { const normalized = `/${resource.replaceAll('\\', '/')}/`; return normalized.includes('/.venv/') || normalized.includes('/venv/'); }

function planFrontmatterActions(text: string, segment: PortabilitySegment, sourceRoot: string, mappings: SourceMapping[]): PortabilityFixAction[] {
  const actions: PortabilityFixAction[] = []; const covered = new Set<number>(); const limit = frontmatterLineLimit(text);
  for (const item of mcpCommands(text)) {
    const executable = item.command[0]; if (!executable || !isAbsolute(executable) || !within(sourceRoot, resolve(executable))) continue;
    const hitLines = commandHitLines(text, item.entry, executable, segment.lines).filter(line => line <= limit); if (!hitLines.length) continue; for (const line of hitLines) covered.add(line);
    const mapped = mapSourcePath(executable, mappings);
    if (!mapped) { actions.push({ kind: 'MANUAL-FRONTMATTER', lines: hitLines, auto: false, detail: 'MCP executable points to an OpenCode path not owned by an active migrated repo' }); continue; }
    if (isRuntimeEnvironmentResource(mapped.resource)) { actions.push({ kind: 'MANUAL-FRONTMATTER', lines: hitLines, auto: false, detail: 'MCP executable lives inside a local virtual environment and needs reproducible dependency setup' }); continue; }
    const replacementCommand = ['skillrepo', 'exec', mapped.repoId, mapped.resource, ...item.command.slice(1)];
    actions.push({ kind: 'AUTO-REPO-EXEC', lines: hitLines, auto: true, detail: `resolve registered repo resource ${mapped.repoId}/${mapped.resource}`, originalCommand: item.command, replacementCommand, mcpEntry: item.entry, runtimeRepoId: mapped.repoId, runtimeResource: mapped.resource });
  }
  const remaining = segment.lines.filter(line => !covered.has(line)); if (remaining.length) actions.push({ kind: 'MANUAL-FRONTMATTER', lines: remaining, auto: false, detail: 'frontmatter home path is not a directly rewritable MCP executable' });
  return actions;
}

function planSegmentActions(text: string, segment: PortabilitySegment, sourceRoot: string, sourceAlias: string | null, mappings: SourceMapping[]): PortabilityFixAction[] {
  if (segment.kind === 'FRONTMATTER-RUNTIME') return planFrontmatterActions(text, segment, sourceRoot, mappings);
  if (segment.kind === 'MARKDOWN-BODY') {
    const lines = text.split(/\r?\n/); const allUnderSourceRoot = segment.lines.every(line => lines[line - 1]?.includes(sourceRoot));
    if (sourceAlias && allUnderSourceRoot) return [{ kind: 'AUTO-DOC-OPENCODE-PATH', lines: segment.lines, auto: true, detail: `replace legacy OpenCode source root with ${sourceAlias}` }];
    return [{ kind: 'MANUAL-MARKDOWN', lines: segment.lines, auto: false, detail: 'Markdown home path is outside the standard migrated OpenCode source root' }];
  }
  if (segment.kind === 'TEST') return [{ kind: 'MANUAL-TEST', lines: segment.lines, auto: false, detail: 'test fixture semantics must be preserved before replacing an absolute path' }];
  return [{ kind: 'MANUAL-RUNTIME-CODE', lines: segment.lines, auto: false, detail: 'runtime code needs language-aware path resolution rather than text replacement' }];
}

async function validateRuntimeActions(actions: PortabilityFixAction[], env: NodeJS.ProcessEnv): Promise<void> {
  for (const action of actions) {
    if (action.kind !== 'AUTO-REPO-EXEC') continue;
    try { await resolveRegisteredResource(action.runtimeRepoId!, action.runtimeResource!, env); }
    catch { action.kind = 'MANUAL-FRONTMATTER'; action.auto = false; action.detail = `mapped repo resource ${action.runtimeRepoId}/${action.runtimeResource} is not currently resolvable from OpenCode registration`; }
  }
}

export async function applyMigrationPortabilityFixes(options: { planPath: string; targetRoot: string; dryRun?: boolean; env?: NodeJS.ProcessEnv }): Promise<PortabilityFixResult> {
  const planPath = resolve(expandHome(options.planPath)); const targetRoot = resolve(expandHome(options.targetRoot)); const plan = await readPlan(planPath); const sourceRoot = resolve(expandHome(plan.generatedFrom!.sourceRoot!));
  const defaultOpenCodeRoot = resolve(join(homedir(), '.config', 'opencode')); const sourceAlias = sourceRoot === defaultOpenCodeRoot ? '~/.config/opencode' : null; const mappings = buildMappings(plan, sourceRoot); const portability = await classifyMigrationPortability({ planPath, targetRoot }); const dryRun = options.dryRun ?? true; const env = options.env ?? process.env; const files: PortabilityFixFile[] = [];
  for (const item of portability.items) {
    const file = join(targetRoot, item.repoId, item.path); const original = await readFile(file, 'utf8'); const actions = item.segments.flatMap(segment => planSegmentActions(original, segment, sourceRoot, sourceAlias, mappings)); await validateRuntimeActions(actions, env);
    let next = original; for (const action of actions) { if (!action.auto) continue; if (action.kind === 'AUTO-REPO-EXEC') next = rewriteCommandBlock(next, action.mcpEntry!, action.replacementCommand!); else if (action.kind === 'AUTO-DOC-OPENCODE-PATH') next = rewriteMarkdownBodySourceRoot(next, sourceRoot, sourceAlias!); }
    const changed = next !== original; if (!dryRun && changed) await writeFile(file, next, 'utf8'); files.push({ repoId: item.repoId, path: item.path, actions, changed });
  }
  const autoActions = files.reduce((sum, file) => sum + file.actions.filter(action => action.auto).length, 0); const manualActions = files.reduce((sum, file) => sum + file.actions.filter(action => !action.auto).length, 0); const changedFiles = files.filter(file => file.changed).length;
  return { schemaVersion: 1, dryRun, planPath, targetRoot, files, summary: { files: files.length, autoActions, manualActions, changedFiles } };
}

export function renderMigrationPortabilityFix(result: PortabilityFixResult): string {
  const mode = result.dryRun ? 'dry-run' : 'applied'; const lines = [`Migration portability fix ${mode}: ${result.summary.autoActions} auto action(s), ${result.summary.manualActions} manual action(s), ${result.summary.changedFiles} changed file(s)`]; let currentRepo = '';
  for (const file of result.files) { if (file.repoId !== currentRepo) { currentRepo = file.repoId; lines.push(`${currentRepo}:`); } for (const action of file.actions) lines.push(`  [${action.auto ? 'AUTO' : 'MANUAL'}] ${file.path}:${action.lines.join(',')} — ${action.kind}: ${action.detail}`); }
  lines.push(result.dryRun ? 'Dry-run only: no repository contents were changed. Re-run with --execute after reviewing auto actions.' : 'Only planned AUTO portability edits were applied; MANUAL items were left unchanged.'); return lines.join('\n');
}
