import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';

const creationPath = join(process.cwd(), 'skills', 'skill-creation', 'SKILL.md');
const modificationPath = join(process.cwd(), 'skills', 'skill-modification', 'SKILL.md');

async function assertPublicationAuditContract(path: string): Promise<void> {
  const text = await readFile(path, 'utf8');

  assert.match(text, /pre-commit|before (?:a |the )?(?:formal )?commit|before committing/i);
  assert.match(text, /publication.*privacy|privacy.*publication/i);
  assert.match(text, /corpus/i);
  assert.match(text, /benchmark/i);
  assert.match(text, /(?:person|name).*email|email.*(?:person|name)|real people/i);
  assert.match(text, /address/i);
  assert.match(text, /URL|link/i);
  assert.match(text, /(?:institution|university|laboratory|lab|company)/i);
  assert.match(text, /(?:key|tag|identifier)/i);
  assert.match(text, /publication venue|venue/i);
  assert.match(text, /(?:internal|private).*(?:development|debug|workflow)|(?:development|debug|workflow).*(?:internal|private)/i);
  assert.match(text, /(?:delete|remove|generalize|generic|placeholder)/i);
  assert.match(text, /current (?:functional )?contract|final (?:functional )?contract/i);
  assert.match(text, /(?:history|historical|migration|evolution)/i);
}

test('skill-creation requires a full publication/privacy audit before a formal commit', async () => {
  await assertPublicationAuditContract(creationPath);
});

test('skill-modification requires a full publication/privacy audit before a formal commit', async () => {
  await assertPublicationAuditContract(modificationPath);
});
