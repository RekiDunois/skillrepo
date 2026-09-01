import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { parseFrontmatter } from '../src/frontmatter.js';

const skillPath = join(process.cwd(), 'skills', 'skill-modification', 'SKILL.md');

test('skill-modification has an OpenCode-compatible frontmatter contract', async () => {
  const text = await readFile(skillPath, 'utf8');
  const parsed = parseFrontmatter(text);

  assert.equal(parsed.data.name, 'skill-modification');
  assert.equal(typeof parsed.data.description, 'string');
  assert.match(String(parsed.data.description), /modify|edit|update/i);
  assert.match(String(parsed.data.description), /迁移|migration/i);
  assert.equal(Object.hasOwn(parsed.data, 'trigger'), false);
  assert.equal(Object.hasOwn(parsed.data, 'when'), false);
  assert.match(text, /skill-development-location/);
  assert.match(text, /ambiguous|歧义/i);
  assert.match(text, /compatibility|兼容壳|symlink/i);
  assert.doesNotMatch(text, /\/Users\/[^\s`]+/);
  assert.doesNotMatch(text, /(?:api[_-]?key|token|cookie|session[_-]?state)\s*:/i);
});
