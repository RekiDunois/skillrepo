import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSkillModificationHandoff, type SkillModificationHandoffInput } from '../src/skill_modification_template.js';

const input: SkillModificationHandoffInput = {
  status: 'committed',
  verified: true,
  sourceRoot: '/source root',
  targetRoot: '/target root',
  configPath: '/config/opencode.jsonc',
  transactionId: 'tx-123',
  journalPath: '/source root/.skillrepo-migrations/tx-123.json',
  repositories: ['repo-a'],
  skillMappings: [
    {
      operationId: 'op-0001',
      repoId: 'repo-a',
      skillId: 'root-skill',
      sourceFile: '/source root/skill/root-skill/SKILL.md',
      targetFile: '/target root/repo-a/skills/root-skill/SKILL.md',
    },
    {
      operationId: 'op-0001',
      repoId: 'repo-a',
      skillId: 'nested-skill',
      sourceFile: '/source root/skill/root-skill/nested/SKILL.md',
      targetFile: '/target root/repo-a/skills/root-skill/nested/SKILL.md',
    },
  ],
  git: {
    'repo-a': { managed: true, gitRoot: '/target root/repo-a', branch: 'main', dirty: false },
  },
};

test('handoff renders every root and nested skill from file mappings', () => {
  const rendered = renderSkillModificationHandoff(input);

  assert.match(rendered, /SKILL_MODIFICATION_HANDOFF_BEGIN/);
  assert.match(rendered, /committed-and-verified/);
  assert.match(rendered, /skill_file:/);
  assert.match(rendered, /repo_id:/);
  assert.match(rendered, /config_path:/);
  assert.match(rendered, /root-skill/);
  assert.match(rendered, /nested-skill/);
  assert.match(rendered, /\/source root\/skill\/root-skill\/nested\/SKILL\.md/);
  assert.match(rendered, /\/target root\/repo-a\/skills\/root-skill\/nested\/SKILL\.md/);
  assert.match(rendered, /Do not edit compatibility shells, symlinks, caches, or generated mirrors/);
});

test('handoff rejects non-committed states and missing file mappings', () => {
  assert.throws(
    () => renderSkillModificationHandoff({ ...input, status: 'dry-run' }),
    /committed migration/,
  );
  assert.throws(
    () => renderSkillModificationHandoff({ ...input, skillMappings: [] }),
    /skill mapping/,
  );
});

test('handoff marks committed no-verify output as unverified', () => {
  const rendered = renderSkillModificationHandoff({ ...input, verified: false });

  assert.match(rendered, /unverified/);
  assert.match(rendered, /OpenCode discovery\/runtime verification was not run/);
  assert.doesNotMatch(rendered, /committed-and-verified/);
});
