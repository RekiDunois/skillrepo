import { access, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import YAML from 'yaml';

export type VerifyResult = { ok: boolean; command: string; stdout: string; stderr: string };

export function opencodeConfigDir(env = process.env): string {
  return resolve(env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode'));
}

export function opencodeConfigFile(env = process.env): string {
  if (env.OPENCODE_CONFIG) return resolve(env.OPENCODE_CONFIG);
  return join(opencodeConfigDir(env), 'opencode.jsonc');
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function readConfig(path: string): Promise<{ text: string; data: Record<string, unknown> }> {
  if (!(await exists(path))) return { text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', data: {} };
  const text = await readFile(path, 'utf8');
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  if (errors.length) throw new Error(`OpenCode config is not valid JSON/JSONC: ${path}`);
  return { text, data: data ?? {} };
}

async function updateSkills(configPath: string, updater: (skills: string[]) => string[]): Promise<void> {
  const { text, data } = await readConfig(configPath);
  const current = Array.isArray(data.skills) ? data.skills.filter((v): v is string => typeof v === 'string') : [];
  const next = updater(current);
  const edits = modify(text, ['skills'], next, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, applyEdits(text, edits), 'utf8');
}

function repoId(repoPath: string): string {
  const id = basename(repoPath).trim();
  if (!id || id === '.' || id === '..') throw new Error(`Cannot derive repo id from ${repoPath}`);
  return id.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function frontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  return (YAML.parse(text.slice(3, end)) ?? {}) as Record<string, unknown>;
}

async function validateAgents(agentsDir: string): Promise<string[]> {
  if (!(await exists(agentsDir))) return [];
  const entries = await readdir(agentsDir, { withFileTypes: true, recursive: true });
  const names = new Map<string, string>();
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const parent = (entry as typeof entry & { parentPath?: string }).parentPath ?? agentsDir;
    const path = join(parent, entry.name);
    const meta = frontmatter(await readFile(path, 'utf8'));
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    if (!name) { errors.push(`${path}: missing stable frontmatter name`); continue; }
    const previous = names.get(name);
    if (previous) errors.push(`${path}: duplicate agent name '${name}' (also ${previous})`);
    else names.set(name, path);
  }
  return errors;
}

export async function registerRepo(repoInput: string): Promise<{ repo: string; skillPath?: string; agentLink?: string }> {
  const repo = resolve(repoInput);
  const stat = await lstat(repo).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Repo path is not a directory: ${repo}`);

  const skills = join(repo, 'skills');
  const agents = join(repo, 'agents');
  if (!(await exists(skills)) && !(await exists(agents))) throw new Error(`Repo has neither skills/ nor agents/: ${repo}`);

  const agentErrors = await validateAgents(agents);
  if (agentErrors.length) throw new Error(`Agent validation failed:\n${agentErrors.join('\n')}`);

  let skillPath: string | undefined;
  if (await exists(skills)) {
    skillPath = skills;
    await updateSkills(opencodeConfigFile(), current => current.includes(skills) ? current : [...current, skills]);
  }

  let agentLink: string | undefined;
  if (await exists(agents)) {
    const targetDir = join(opencodeConfigDir(), 'agents');
    await mkdir(targetDir, { recursive: true });
    agentLink = join(targetDir, repoId(repo));
    if (await exists(agentLink)) {
      const st = await lstat(agentLink);
      if (!st.isSymbolicLink()) throw new Error(`Agent registration path exists and is not a symlink: ${agentLink}`);
      const currentTarget = resolve(dirname(agentLink), await readlink(agentLink));
      if (currentTarget !== agents) throw new Error(`Agent symlink collision: ${agentLink} -> ${currentTarget}`);
    } else {
      await symlink(agents, agentLink, 'dir');
    }
  }

  return { repo, skillPath, agentLink };
}

export async function unregisterRepo(repoInput: string): Promise<void> {
  const repo = resolve(repoInput);
  const skills = join(repo, 'skills');
  await updateSkills(opencodeConfigFile(), current => current.filter(path => resolve(path) !== skills));

  const link = join(opencodeConfigDir(), 'agents', repoId(repo));
  if (await exists(link)) {
    const st = await lstat(link);
    if (!st.isSymbolicLink()) throw new Error(`Refusing to remove non-symlink registration path: ${link}`);
    const target = resolve(dirname(link), await readlink(link));
    if (target !== join(repo, 'agents')) throw new Error(`Refusing to remove symlink owned by another target: ${link} -> ${target}`);
    await unlink(link);
  }
}

export async function runOpenCode(args: string[], env = process.env): Promise<VerifyResult> {
  return await new Promise(resolvePromise => {
    const child = spawn('opencode', args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => resolvePromise({ ok: false, command: `opencode ${args.join(' ')}`, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', code => resolvePromise({ ok: code === 0, command: `opencode ${args.join(' ')}`, stdout, stderr }));
  });
}

export async function verifyOpenCode(): Promise<VerifyResult[]> {
  return await Promise.all([
    runOpenCode(['--version']),
    runOpenCode(['agent', 'list']),
  ]);
}

export async function doctor(): Promise<{ ok: boolean; issues: string[]; verification: VerifyResult[] }> {
  const issues: string[] = [];
  const configPath = opencodeConfigFile();
  try {
    const { data } = await readConfig(configPath);
    const skills = Array.isArray(data.skills) ? data.skills.filter((v): v is string => typeof v === 'string') : [];
    for (const source of skills) if (!(await exists(resolve(source)))) issues.push(`Missing skill source: ${source}`);
  } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }

  const agentRoot = join(opencodeConfigDir(), 'agents');
  if (await exists(agentRoot)) {
    for (const entry of await readdir(agentRoot, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const link = join(agentRoot, entry.name);
      const target = resolve(agentRoot, await readlink(link));
      if (!(await exists(target))) issues.push(`Broken agent symlink: ${link} -> ${target}`);
    }
  }

  const verification = await verifyOpenCode();
  for (const result of verification) if (!result.ok) issues.push(`OpenCode verification failed: ${result.command}: ${result.stderr.trim() || 'non-zero exit'}`);
  return { ok: issues.length === 0, issues, verification };
}
