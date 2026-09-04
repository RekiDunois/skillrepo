import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { parse } from 'yaml';
import {
  OPENAPM_INITIAL_PACKAGE_VERSION,
  OPENAPM_MANIFEST_SCHEMA_ID,
  renderOpenApmManifest,
} from '../src/openapm.js';

const schemaUrl = new URL('../../vendor/openapm/v0.1/manifest.schema.json', import.meta.url);
const vendorReadmeUrl = new URL('../../vendor/openapm/v0.1/README.md', import.meta.url);

interface ManifestSchema {
  $schema: string;
  $id: string;
}

async function loadVendoredSchema(): Promise<ManifestSchema> {
  return JSON.parse(await readFile(schemaUrl, 'utf8')) as ManifestSchema;
}

async function loadVendoredSchemaHash(): Promise<string> {
  return createHash('sha256').update(await readFile(schemaUrl)).digest('hex');
}

// Extract the recorded SHA-256 from the vendored README instead of duplicating
// the value here, so the README stays the single provenance record.
async function loadRecordedSchemaHash(): Promise<string> {
  const readme = await readFile(vendorReadmeUrl, 'utf8');
  const match = readme.match(/manifest\.schema\.json` SHA-256:\s*`([0-9a-f]{64})`/);
  assert.ok(match, 'vendor/openapm/v0.1/README.md must record the manifest.schema.json SHA-256');
  return match[1];
}

async function makeValidator(): Promise<ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true });
  return ajv.compile(await loadVendoredSchema());
}

test('vendored OpenAPM schema keeps its official contract identity', async () => {
  const schema = await loadVendoredSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, OPENAPM_MANIFEST_SCHEMA_ID);
  assert.equal(await loadVendoredSchemaHash(), await loadRecordedSchemaHash());
});

test('default manifest from renderOpenApmManifest conforms to the vendored OpenAPM v0.1 schema', async () => {
  const manifest = parse(renderOpenApmManifest('package-repo')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest), ['$schema', 'name', 'version']);
  assert.equal(manifest.$schema, OPENAPM_MANIFEST_SCHEMA_ID);
  assert.equal(manifest.name, 'package-repo');
  assert.equal(manifest.version, OPENAPM_INITIAL_PACKAGE_VERSION);
  assert.equal(typeof manifest.version, 'string');
  const validate = await makeValidator();
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
});

test('the same validator rejects a manifest that violates the OpenAPM v0.1 schema', async () => {
  const validate = await makeValidator();
  const invalid = parse('name: example\nversion: "not-semver"\n');
  assert.equal(validate(invalid), false, 'the harness must reject manifests failing the official schema');
});

test('YAML-coercing repository basenames round-trip as strings and stay conforming', async () => {
  const validate = await makeValidator();
  for (const name of ['true', 'null', '123', 'name: value', '#hash', 'quote"name', '非ASCII名称']) {
    const manifest = parse(renderOpenApmManifest(name)) as Record<string, unknown>;
    assert.equal(manifest.name, name, `basename ${JSON.stringify(name)} must survive the YAML round-trip`);
    assert.equal(validate(manifest), true, `basename ${JSON.stringify(name)} must conform: ${JSON.stringify(validate.errors)}`);
  }
});

test('renderOpenApmManifest output is byte-stable for the default repository', async () => {
  const expected =
    '$schema: "https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json"\n' +
    'name: "package-repo"\n' +
    'version: "0.1.0"\n';
  assert.equal(renderOpenApmManifest('package-repo'), expected);
  assert.equal(renderOpenApmManifest('package-repo'), renderOpenApmManifest('package-repo'));
});

test('renderOpenApmManifest refuses an empty repository name', () => {
  assert.throws(() => renderOpenApmManifest(''), /non-empty/);
});
