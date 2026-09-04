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
const runtimeModule = fs.readFileSync(
  path.join(process.cwd(), "src", "runtime.ts"),
  "utf8",
);
const ciWorkflow = fs.readFileSync(
  path.join(process.cwd(), ".github", "workflows", "test.yml"),
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
    mockProvider,
    /hasSkillAdvertisement/,
    "the deterministic model must verify the skill advertisement",
  );
  assert.match(
    mockProvider,
    /修改 skill/,
    "the deterministic model request must contain the modification intent",
  );
  assert.match(
    executeSession,
    /EXPECTED_RAW_SKILL_CONTENT_MARKER/,
    "the runtime session must verify that the completed skill-tool result contains the fixture's unique content marker",
  );
  assert.match(
    executeSession,
    /skill-modification/,
    "the runtime request must name the skill-modification skill",
  );
});

test("OpenCode runtime fixture covers init and explicit registration", () => {
  const fixture = functionBody("createFixture", "listProbe");

  assert.match(fixture, /\[cli, 'init', repoRoot\]/);
  assert.match(fixture, /join\(repoRoot, '\.apm', 'skills', SKILL_NAME/);
  assert.match(fixture, /SKILL_NAMES/);
  assert.match(fixture, /\[cli, 'register', repoRoot\]/);
  assert.doesNotMatch(fixture, /migration.*apply/);
});

test("runtime verification uses serve instead of opening the default browser", () => {
  assert.match(runtimeScript, /\[context\.executable, 'serve',/);
  assert.doesNotMatch(runtimeScript, /\[context\.executable, 'web',/);
  assert.match(migrationRuntimeScript, /\[executable, 'serve',/);
  assert.doesNotMatch(migrationRuntimeScript, /\[executable, 'web',/);
});

test("primary OpenCode CI uses a pinned, self-consistent runtime baseline", () => {
  const install = ciWorkflow.match(/npm install -g opencode-ai@(\d+\.\d+\.\d+)/);
  assert.ok(install, "the primary runtime compatibility gate must pin an exact OpenCode version");
  const version = install[1];
  assert.match(
    ciWorkflow,
    new RegExp(`OPENCODE_EXPECTED_VERSION:\\s*${version.replaceAll('.', '\\.')}\\b`),
    "the runtime assertion must expect the exact version installed by CI",
  );
  assert.match(
    ciWorkflow,
    /OPENCODE_DISABLE_AUTOUPDATE:\s*true/,
    "the pinned runtime baseline must disable OpenCode auto-update",
  );
  assert.doesNotMatch(ciWorkflow, /opencode-ai@latest/);
});

test("primary CI retains migration packaged-CLI and Windows commit-readiness gates", () => {
  assert.match(
    ciWorkflow,
    /- name: Verify migration commit audit through packaged CLI[\s\S]*?skillrepo migration audit[\s\S]*?COMMIT-READY: YES/,
    "CI must exercise migration audit through the packaged CLI and assert commit readiness",
  );

  assert.match(
    ciWorkflow,
    /- name: Verify migration ignore through packaged CLI[\s\S]*?skillrepo migration ignore[\s\S]*?--execute/,
    "CI must retain the packaged-CLI migration ignore regression",
  );

  assert.match(
    ciWorkflow,
    /commit-readiness-windows:\s*[\s\S]*?runs-on:\s*windows-latest[\s\S]*?Run Windows commit-readiness tests/,
    "CI must retain Windows commit-readiness coverage",
  );
});

test("migration runtime verification captures debug skill discovery through a regular file", () => {
  assert.match(
    migrationRuntimeScript,
    /function isSkillDiscoveryCommand\(args\) \{\s*\n\s*return args\.length === 2 && args\[0\] === ["']debug["'] && args\[1\] === ["']skill["']/,
    "the verifier must select exactly the debug skill command for file-backed stdout",
  );
  assert.match(
    migrationRuntimeScript,
    /if \(isSkillDiscoveryCommand\(args\)\) \{\s*\n\s*return runCliWithFileStdout\(executable, args, env\)\s*\n\s*\}/,
    "runCli must delegate the skill discovery command to the file-backed transport",
  );
  assert.match(
    migrationRuntimeScript,
    /open\(stdoutFile, 'w', 0o600\)/,
    "discovery output may contain full skill metadata, so the capture file must be user-private",
  );
  assert.match(
    migrationRuntimeScript,
    /stdio:\s*\['ignore', handle\.fd, 'pipe'\]/,
    "the child stdout must be a regular-file descriptor with stderr kept on a pipe",
  );
  assert.match(
    migrationRuntimeScript,
    /await readFile\(stdoutFile, 'utf8'\)/,
    "the complete discovery document must be read from the capture file after child exit",
  );
  assert.match(
    migrationRuntimeScript,
    /await rm\(directory, \{ recursive: true, force: true \}\)/,
    "the private capture directory must be removed on every path",
  );
  assert.match(
    migrationRuntimeScript,
    /execFileAsync\(executable, args, \{ env, timeout: TIMEOUT_MS \}\)/,
    "commands other than skill discovery keep the existing execFile transport",
  );
});

test("migration runtime verification preserves the user global plugin directory", () => {
  assert.match(
    migrationRuntimeScript,
    /symlink\(originalPlugins,\s*join\(configDir, ['"]plugins['"]\)/,
  );
});

test("migration runtime verification preserves custom OPENCODE_CONFIG file semantics", () => {
  const start = migrationRuntimeScript.indexOf("async function verify(context)");
  const end = migrationRuntimeScript.indexOf("async function main()");
  assert.ok(start >= 0 && end > start);
  const body = migrationRuntimeScript.slice(start, end);

  assert.match(body, /env\.OPENCODE_CONFIG\s*=\s*injected\.path/);
});

test("migration runtime verification keeps config files and resource directories separate", () => {
  assert.doesNotMatch(
    migrationRuntimeScript,
    /join\(dirname\(originalPath\), ['"]plugins['"]\)/,
  );
  assert.doesNotMatch(
    migrationRuntimeScript,
    /join\(dirname\(originalPath\), ['"]agents['"]\)/,
  );
  assert.match(
    migrationRuntimeScript,
    /join\(originalResourceDir, ['"]plugins['"]\)/,
  );
  assert.match(migrationRuntimeScript, /OPENCODE_CONFIG_DIR/);
});

test("runtime verification resolves OpenCode env paths before switching helper cwd", () => {
  const start = runtimeModule.indexOf("export async function verifyOpenCodeRuntime");
  assert.ok(start >= 0);
  const body = runtimeModule.slice(start);

  assert.match(body, /OPENCODE_CONFIG\s*:\s*context\.configPath/);
  assert.match(body, /OPENCODE_CONFIG_DIR\s*:\s*opencodeConfigDir\(env\)/);
});
