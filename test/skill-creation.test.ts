import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { parseFrontmatter } from '../src/frontmatter.js';

const skillPath = join(process.cwd(), 'skills', 'skill-creation', 'SKILL.md');

test('skill-creation documents a layout-aware create-before-edit workflow', async () => {
  const text = await readFile(skillPath, 'utf8');
  const parsed = parseFrontmatter(text);

  assert.equal(parsed.data.name, 'skill-creation');
  assert.equal(typeof parsed.data.description, 'string');
  assert.match(String(parsed.data.description), /create|new/i);
  assert.equal(Object.hasOwn(parsed.data, 'trigger'), false);
  assert.equal(Object.hasOwn(parsed.data, 'when'), false);
  assert.match(text, /skillrepo init/);
  assert.match(text, /\.apm\/skills/);
  assert.match(text, /skills\//);
  assert.match(text, /ambiguous|歧义/i);
  assert.match(text, /already exists|已存在/i);
  assert.match(text, /repoRoot|repository root/i);
  assert.match(text, /sourceRoot|source root/i);
  assert.match(text, /skill-development-location/);
  assert.match(text, /--authoring/);
  assert.match(text, /selectionMode: "authoring"/);
  assert.match(text, /consumerMatches/);
  assert.match(text, /established deployment/);
  assert.match(text, /apm install/);
  assert.match(text, /discover or overwrite unknown consumer trees/);
  assert.doesNotMatch(text, /\/Users\/[^\s`]+/);
  assert.doesNotMatch(text, /(?:api[_-]?key|token|cookie|session[_-]?state)\s*:/i);
});
