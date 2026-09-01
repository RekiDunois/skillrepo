import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";

const runtimeScript = fs.readFileSync(
  path.join(process.cwd(), "scripts", "opencode-runtime-test.mjs"),
  "utf8",
);

function functionBody(name: string, nextName: string): string {
  const start = runtimeScript.indexOf(`function ${name}`);
  const end = runtimeScript.indexOf(`\nfunction ${nextName}`, start);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  return runtimeScript.slice(start, end);
}

test("OpenCode runtime parity probe must load the registered skill inside the model session", () => {
  const mockProvider = functionBody("createMockProvider", "writeProjectConfig");
  const executeSession = functionBody("executeSkillSession", "runDiscoveryTest");

  assert.match(
    mockProvider,
    /name:\s*["']skill["']/,
    "the deterministic model must invoke OpenCode's built-in skill tool before requesting the shell tool",
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
