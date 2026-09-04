// OpenAPM v0.1 producer contract for the `apm.yml` manifests written by
// `skillrepo init`. The contract is pinned to the vendored normative schema in
// `vendor/openapm/v0.1/` so that generated manifests cannot drift with the APM
// working draft. Bumping the OpenAPM contract version is an explicit change to
// this constant plus the vendored schema and the contract tests; never point it
// at `latest`.

export const OPENAPM_MANIFEST_SCHEMA_ID = 'https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json';

// Initial package version for new `skillrepo init` repositories. This is the
// skillrepo package-version contract, not an OpenAPM spec version.
export const OPENAPM_INITIAL_PACKAGE_VERSION = '0.1.0';

// Render the minimal conforming OpenAPM v0.1 manifest: exactly the `$schema`,
// `name`, and `version` fields, each written as a YAML 1.2 double-quoted
// string. A JSON string literal is a safe subset of a YAML 1.2 double-quoted
// scalar, so `JSON.stringify` provides the escaping. Output ends with a single
// newline and is byte-stable for a given input.
export function renderOpenApmManifest(name: string): string {
  if (name === '') throw new Error('OpenAPM manifest name must be a non-empty string');
  return [
    `$schema: ${JSON.stringify(OPENAPM_MANIFEST_SCHEMA_ID)}`,
    `name: ${JSON.stringify(name)}`,
    `version: ${JSON.stringify(OPENAPM_INITIAL_PACKAGE_VERSION)}`,
  ].join('\n') + '\n';
}
