import type { MigrationStatus, SkillMapping } from './migration.js';
import { join } from 'node:path';

export type HandoffGitState = {
  managed: boolean;
  gitRoot?: string;
  branch?: string;
  dirty?: boolean;
};

export type SkillModificationHandoffInput = {
  status?: MigrationStatus | 'dry-run';
  verified: boolean;
  sourceRoot: string;
  targetRoot: string;
  configPath: string;
  transactionId: string;
  journalPath: string;
  repositories: string[];
  skillMappings: SkillMapping[];
  git: Record<string, HandoffGitState>;
};

function code(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  const tick = String.fromCharCode(96);
  return `${tick}${escaped}${tick}`;
}

function gitText(state: HandoffGitState | undefined): string {
  if (!state?.managed) return 'not a Git repository (migration does not initialize Git)';
  const details = [state.gitRoot ? `root=${code(state.gitRoot)}` : 'root=unknown'];
  if (state.branch) details.push(`branch=${code(state.branch)}`);
  if (state.dirty !== undefined) details.push(`dirty=${state.dirty}`);
  return `managed (${details.join(', ')})`;
}

function assertCommitted(input: SkillModificationHandoffInput): void {
  if (input.status !== 'committed') {
    throw new Error('Skill modification handoff requires a committed migration');
  }
  if (!input.skillMappings.length) {
    throw new Error('Skill modification handoff requires at least one skill mapping');
  }
}

export function renderSkillModificationHandoff(input: SkillModificationHandoffInput): string {
  assertCommitted(input);
  const status = input.verified ? 'committed-and-verified' : 'unverified';
  const warning = input.verified
    ? ''
    : '\n> WARNING: OpenCode discovery/runtime verification was not run. Treat this handoff as unverified.\n';
  const mappingSections = input.skillMappings.map(mapping => {
    const repoRoot = join(input.targetRoot, mapping.repoId);
    return [
      `### ${code(mapping.skillId)}`,
      `- skill_id: ${code(mapping.skillId)}`,
      `- skill_file: ${code(mapping.targetFile)}`,
      `- source_file: ${code(mapping.sourceFile)}`,
      `- repo_id: ${code(mapping.repoId)}`,
      `- repo_root: ${code(repoRoot)}`,
      `- git_state: ${gitText(input.git[mapping.repoId])}`,
      `- operation_id: ${code(mapping.operationId ?? 'unknown')}`,
    ].join('\n');
  }).join('\n\n');

  return [
    'SKILL_MODIFICATION_HANDOFF_BEGIN',
    '# Skill Modification Task',
    '',
    `- handoff_status: ${code(status)}`,
    `- config_path: ${code(input.configPath)}`,
    `- transaction_id: ${code(input.transactionId)}`,
    `- journal_path: ${code(input.journalPath)}`,
    `- source_root: ${code(input.sourceRoot)}`,
    `- target_root: ${code(input.targetRoot)}`,
    `- repository_count: ${input.repositories.length}`,
    warning.trimEnd(),
    '## Skill Mappings',
    '',
    mappingSections,
    '',
    '## Before Editing',
    '',
    '1. Run the locator from `skill-development-location` using the exact skill ID.',
    '2. Confirm the locator returns exactly one real `SKILL.md`, its `sourceRoot`, `config`, and `git.gitRoot`.',
    '3. Stop on a missing or ambiguous result; do not choose by directory name, order, or modification time.',
    '4. Run `git status --short --branch`, `git diff`, and `git log --oneline -10` in the locator Git root.',
    '5. Do not edit compatibility shells, symlinks, caches, or generated mirrors.',
    '',
    '## After Editing',
    '',
    '1. Re-run the locator and confirm the exact target file is still authoritative.',
    '2. Parse frontmatter and keep the stable `name` and OpenCode-supported fields valid.',
    '3. Run the target repository focused tests, then the required full test suite.',
    '4. Run `skillrepo doctor` or the repository equivalent.',
    '5. Run `opencode debug skill`, parse its JSON list, and check the skill ID in that list.',
    '6. Run the real `skill()` runtime test when the change affects model-visible behavior.',
    '',
    'SKILL_MODIFICATION_HANDOFF_END',
    '',
  ].filter((line, index, lines) => !(line === '' && lines[index - 1] === '' && lines[index + 1] === '')).join('\n');
}
