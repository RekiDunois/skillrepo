import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { parseFrontmatter } from '../src/frontmatter.js';

const skillPath = join(process.cwd(), 'skills', 'skill-development-location', 'SKILL.md');

test('skill-development-location documents the authoring source contract', async () => {
  const text = await readFile(skillPath, 'utf8');
  const parsed = parseFrontmatter(text);

  assert.equal(parsed.data.name, 'skill-development-location');
  assert.equal(typeof parsed.data.description, 'string');
  assert.match(String(parsed.data.description), /Locate|location/i);
  assert.equal(Object.hasOwn(parsed.data, 'trigger'), false);
  assert.equal(Object.hasOwn(parsed.data, 'when'), false);
  assert.match(text, /locate-resource\.mjs/);
  assert.match(text, /--authoring/);
  assert.match(text, /<git-root>\/skills/);
  assert.match(text, /\.apm\/skills/);
  assert.match(text, /selectionMode: "authoring"/);
  assert.match(text, /consumerMatches/);
  assert.match(text, /only editable source/);
  assert.match(text, /must not be edited directly/);
  assert.match(text, /authoritative source not found/);
  assert.match(text, /directory order, timestamp, or Git-state heuristics/);
  assert.match(text, /resource is ambiguous/);
  assert.match(text, /not equivalent to source authority/);
  assert.doesNotMatch(text, /\/Users\/[^\s`]+/);
  assert.doesNotMatch(text, /(?:api[_-]?key|token|cookie|session[_-]?state)\s*:/i);
});

test('skill-development-location keeps legacy codex roots out of default discovery', async () => {
  const text = await readFile(skillPath, 'utf8');

  assert.match(text, /\.codex\/skills/);
  assert.match(
    text,
    /(?:\.codex\/skills[^\n.]*not[^\n.]*default discovery|default discovery[^\n.]*not[^\n.]*\.codex\/skills)/i,
    'the model-facing contract must say that legacy .codex/skills roots are diagnostics in authoring mode only, not default discovery sources',
  );
  assert.doesNotMatch(
    text,
    /Default locator mode[^.]*including[^.]*legacy `\.codex\/skills`/i,
    'default discovery must not claim it can select legacy .codex/skills copies',
  );
});
