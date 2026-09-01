import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";

const runtimeScript = fs.readFileSync(
  path.join(process.cwd(), "scripts", "opencode-runtime-test.mjs"),
  "utf8",
);
const migrationRuntimeScript = fs.readFileSync(
  path.join(process.cwd(), "scripts", "opencode-runtime-verify.mjs"),
  "utf8",
);

function functionBody(name: string, nextName: string): string {
  const start = runtimeScript.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\b`));
  const endOffset = runtimeScript.slice(start).search(new RegExp(`\\n(?:async\\s+)?function\\s+${nextName}\\b`));
  const end = endOffset < 0 ? -1 : start + endOffset;
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  assert.ok(end > start, `unexpected function order: ${name} must precede ${nextName}`);
  return runtimeScript.slice(start, end);
}

test("OpenCode runtime parity probe must load the registered skill inside the model session", () => {
  const mockProvider = functionBody("createMockProvider", "writeProjectConfig");
  const executeSession = functionBody("executeSkillSession", "runDiscoveryTest");

  assert.match(
    mockProvider,
    /name:\s*["']skill["']/,
    "the deterministic model must invoke OpenCode's built-in skill tool",
  );
  assert.match(
    mockProvider,
    /SKILL_NAME/,
    "the skill tool call must target the externally registered fixture skill",
  );
  assert.match(
    executeSession,
    /EXPECTED_RAW_SKILL_CONTENT_MARKER/,
    "the runtime session must verify that the completed skill-tool result contains the fixture's unique content marker",
  );
});

test("runtime verification uses serve instead of opening the default browser", () => {
  assert.match(runtimeScript, /\[context\.executable, 'serve',/);
  assert.doesNotMatch(runtimeScript, /\[context\.executable, 'web',/);
  assert.match(migrationRuntimeScript, /\[executable, 'serve',/);
  assert.doesNotMatch(migrationRuntimeScript, /\[executable, 'web',/);
});
