import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('README documents agent linking as conditional when agents/ is absent', () => {
  const readme = readFileSync('README.md', 'utf8');
  if (!existsSync('agents')) {
    assert.doesNotMatch(
      readme,
      /links its `agents\/` directory/,
      'document agent linking as conditional when agents/ is absent',
    );
  }
});
