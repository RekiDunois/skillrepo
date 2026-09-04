# Vendored OpenAPM v0.1 manifest schema

This directory vendors the normative OpenAPM v0.1 manifest JSON Schema used by
the `skillrepo` APM-manifest contract tests. It is a third-party normative
contract, not `skillrepo` source code.

- OpenAPM spec version: `v0.1`
- Schema `$id`: `https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json`
- Official source URL: `https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json`
- Corresponding path in `microsoft/apm`: `docs/public/specs/schemas/manifest-v0.1.schema.json`
- Vendoring date: 2026-09-05
- Vendored `manifest.schema.json` SHA-256:
  `7bdefbe443d3315d71add021c777d776c9cfd4942acb19750a799f46fa0d1344`
- License: MIT (see `LICENSE`, © Microsoft Corporation)

The docs-site file and the raw file on `main` of `microsoft/apm` were
byte-identical at vendoring time; `manifest.schema.json` is stored unmodified.

This file is a third-party normative contract: local modification is
forbidden. Do not reformat, relax, or "fix" it. Upgrading to a newer OpenAPM
contract must add or replace an explicitly versioned directory under
`vendor/openapm/` and update the contract tests in the same change; the
`skillrepo` test suite verifies the recorded SHA-256 and `$id`.
