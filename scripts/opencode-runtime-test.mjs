import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const SKILL_NAME = 'skill-modification'
const SKILL_NAMES = [SKILL_NAME, 'skill-creation']
const EXPECTED_RAW_SKILL_CONTENT_MARKER = 'SKILLREPO_SKILL_MODIFICATION_RUNTIME_MARKER_2026'
const EXPECTED_SKILL_DESCRIPTION_FRAGMENT = 'Resolve the authoritative source path before editing'
const SUCCESS_MARKER = 'SKILL_LOAD_OK'
const DEFAULT_TIMEOUT_MS = 30_000

class RuntimeFailure extends Error {
  constructor(label, cause, diagnostics) {
    super(`${label}: ${cause instanceof Error ? cause.message : String(cause)}\n${diagnostics}`)
    this.name = 'RuntimeFailure'
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function commandForPty(command) {
  if (process.platform === 'darwin') {
    return ['-q', '/dev/null', ...command]
  }
  return ['-qefc', command.map(shellQuote).join(' '), '/dev/null']
}

async function listeningPids(port) {
  try {
    const result = await execFileAsync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN', '-n', '-P'])
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

async function signalListeningProcesses(port, signal) {
  for (const pid of await listeningPids(port)) {
    if (pid === process.pid) continue
    try {
      process.kill(pid, signal)
    } catch {
      // The server may have exited between lsof and kill.
    }
  }
}

function startProcess(command, options) {
  const child = spawn('script', commandForPty(command), {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output += String(chunk)
  })

  return {
    child,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform === 'win32') child.kill('SIGTERM')
          else if (child.pid) process.kill(-child.pid, 'SIGTERM')
        } catch {
          // The PTY wrapper may have exited while the worker was shutting down.
        }
      }
      await signalListeningProcesses(options.port, 'SIGTERM')
      await Promise.race([
        new Promise((resolvePromise) => child.once('close', resolvePromise)),
        sleep(2_000),
      ])
      await signalListeningProcesses(options.port, 'SIGKILL')
    },
  }
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  return port
}

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`)
  }
  return body
}

async function waitForHealth(baseUrl, processInfo) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) {
      throw new Error(`process exited before becoming healthy: ${processInfo.output()}`)
    }
    try {
      const health = await requestJson(baseUrl, '/global/health')
      if (health?.healthy === true) return health
      lastError = `unexpected health response: ${JSON.stringify(health)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${baseUrl} (${lastError})`)
}

async function createMockProvider() {
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
      return
    }

    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `unexpected mock route ${request.method} ${request.url}` } }))
      return
    }

    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const serialized = JSON.stringify(body)
    const hasProbeMarker = serialized.includes(EXPECTED_RAW_SKILL_CONTENT_MARKER)
    const hasSkillAdvertisement = serialized.includes(EXPECTED_SKILL_DESCRIPTION_FRAGMENT)
    const hasModificationIntent = serialized.includes('修改 skill')
    const firstRequest = requests.length === 0
    requests.push({ body, hasProbeMarker, hasSkillAdvertisement, hasModificationIntent, firstRequest })

    if (firstRequest && (!hasSkillAdvertisement || !hasModificationIntent)) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'mock expected the skill modification advertisement and user intent' } }))
      return
    }

    if (!firstRequest && !hasProbeMarker) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'mock expected the skill tool result marker' } }))
      return
    }

    const toolCall = {
      id: 'call_skillrepo_probe',
      type: 'function',
      function: {
        name: 'skill',
        arguments: JSON.stringify({ name: SKILL_NAME }),
      },
    }
    if (firstRequest) requests[0].toolCall = toolCall
    const payload = !firstRequest
      ? {
          id: 'chatcmpl-skillrepo-final',
          object: 'chat.completion',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: SUCCESS_MARKER }, finish_reason: 'stop' }],
        }
      : {
          id: 'chatcmpl-skillrepo-tool',
          object: 'chat.completion',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
        }

    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' })
      if (hasProbeMarker) {
        response.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: SUCCESS_MARKER }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      } else {
        response.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    reset() {
      requests.length = 0
    },
    async close() {
      await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
    },
  }
}

async function writeProjectConfig(root, mockBaseUrl) {
  const configDir = join(root, 'opencode-config')
  await writeFile(
    join(configDir, 'opencode.jsonc'),
    `${JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        mock: {
          npm: '@ai-sdk/openai-compatible',
          name: 'skillrepo deterministic mock',
          options: { baseURL: `${mockBaseUrl}/v1`, apiKey: 'skillrepo-test-only' },
          models: { 'mock-model': { name: 'skillrepo mock model' } },
        },
      },
    }, null, 2)}
`,
    'utf8',
  )
}

async function removeFixture(root) {
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await sleep(200)
    }
  }
  throw lastError
}

async function createFixture(root, mockBaseUrl) {
  const configDir = join(root, 'opencode-config')
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  const repoRoot = join(root, 'init-runtime-repo')
  const skillPath = join(repoRoot, '.apm', 'skills', SKILL_NAME, 'SKILL.md')

  await mkdir(configDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  const skillSource = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/skill-modification/SKILL.md')
  const skillContent = await readFile(skillSource, 'utf8')
  assert.match(skillContent, new RegExp(EXPECTED_RAW_SKILL_CONTENT_MARKER))
  await writeProjectConfig(root, mockBaseUrl)

  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    TERM: 'xterm-256color',
  }
  delete env.OPENCODE_CONFIG

  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/src/cli.js')
  await execFileAsync(process.execPath, [cli, 'init', repoRoot], { env })
  for (const skillName of SKILL_NAMES) {
    const source = resolve(dirname(fileURLToPath(import.meta.url)), `../skills/${skillName}/SKILL.md`)
    await mkdir(join(repoRoot, '.apm', 'skills', skillName), { recursive: true })
    await writeFile(join(repoRoot, '.apm', 'skills', skillName, 'SKILL.md'), await readFile(source, 'utf8'), 'utf8')
  }
  await execFileAsync(process.execPath, [cli, 'register', repoRoot], { env })
  await access(skillPath)

  const debug = await execFileAsync(process.env.OPENCODE_BIN ?? 'opencode', ['debug', 'skill'], {
    cwd: projectDir,
    env,
  })
  const discovered = JSON.parse(debug.stdout)
  assert.ok(Array.isArray(discovered))
  for (const skillName of SKILL_NAMES) {
    assert.ok(discovered.some((skill) => skill?.name === skillName), `opencode debug skill did not discover ${skillName}`)
  }

  const config = await readFile(join(configDir, 'opencode.jsonc'), 'utf8')
  assert.match(config, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  return { configDir, env, projectDir, repoRoot, skillPath }
}

async function listProbe(baseUrl, projectDir) {
  const skills = await requestJson(baseUrl, `/skill?directory=${encodeURIComponent(projectDir)}`)
  assert.ok(Array.isArray(skills))
  return {
    count: skills.length,
    probe: skills.find((skill) => skill.name === SKILL_NAME),
  }
}

function processDiagnostics(processInfo) {
  return processInfo ? processInfo.output().slice(-12_000) : 'not started'
}

function makeDiagnostics(context, details = {}) {
  return JSON.stringify({
    opencodeVersion: context.version,
    executable: context.executable,
    projectDir: context.fixture?.projectDir,
    configDir: context.fixture?.configDir,
    configFile: context.fixture ? join(context.fixture.configDir, 'opencode.jsonc') : undefined,
    registeredRepo: context.fixture?.repoRoot,
    effectiveSkillSource: context.fixture?.skillPath,
    tuiOutput: processDiagnostics(context.tui),
    webOutput: processDiagnostics(context.web),
    ...details,
  }, null, 2)
}

function findToolParts(value) {
  const parts = []
  if (!value || typeof value !== 'object') return parts
  if (Array.isArray(value)) {
    for (const item of value) parts.push(...findToolParts(item))
    return parts
  }
  if (value.type === 'tool') parts.push(value)
  for (const child of Object.values(value)) parts.push(...findToolParts(child))
  return parts
}

async function executeSkillSession(context, runtime, baseUrl) {
  try {
    context.mock.reset()
    const query = `?directory=${encodeURIComponent(context.fixture.projectDir)}`
    const session = await requestJson(baseUrl, `/session${query}`, {
      method: 'POST',
      body: JSON.stringify({ title: `skillrepo ${runtime} runtime probe`, model: { providerID: 'mock', id: 'mock-model' } }),
    })
    assert.match(session.id, /^ses/)
    const result = await requestJson(baseUrl, `/session/${encodeURIComponent(session.id)}/message${query}`, {
      method: 'POST',
      body: JSON.stringify({
        model: { providerID: 'mock', modelID: 'mock-model' },
        parts: [{ type: 'text', text: '修改 skill，请先加载 skill-modification。' }],
      }),
    })
    const messages = await requestJson(baseUrl, `/session/${encodeURIComponent(session.id)}/message${query}`)
    context.lastRuntimePayloads ??= {}
    context.lastRuntimePayloads[runtime] = { result, messages }

    const toolParts = findToolParts(messages)
    const completed = toolParts.find((part) => part.tool === 'skill' && part.state?.status === 'completed')
    assert.ok(completed, `OpenCode did not complete the skill tool: ${JSON.stringify({ toolParts, result })}`)
    assert.match(JSON.stringify(completed), new RegExp(EXPECTED_RAW_SKILL_CONTENT_MARKER))
    assert.match(JSON.stringify(result), new RegExp(SUCCESS_MARKER))
    assert.equal(context.mock.requests.length, 2, `mock observed unexpected model request count: ${context.mock.requests.length}`)
    assert.equal(context.mock.requests[0].firstRequest, true)
    assert.equal(context.mock.requests[0].hasSkillAdvertisement, true)
    assert.equal(context.mock.requests[0].hasModificationIntent, true)
    assert.equal(context.mock.requests[0].toolCall.function.name, 'skill')
    assert.deepEqual(
      JSON.parse(context.mock.requests[0].toolCall.function.arguments),
      { name: SKILL_NAME },
    )
    assert.equal(context.mock.requests[1].hasProbeMarker, true)

    return { session, result, messages, toolParts, mockRequests: context.mock.requests.map((request) => ({ ...request })) }
  } catch (error) {
    throw new Error(`${runtime} runtime: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runDiscoveryTest(context) {
  try {
    const [tuiSkills, webSkills] = await Promise.all([
      listProbe(context.tuiBaseUrl, context.fixture.projectDir).then((result) => {
        context.lastTuiSkills = result
        return result
      }),
      listProbe(context.webBaseUrl, context.fixture.projectDir).then((result) => {
        context.lastWebSkills = result
        return result
      }),
    ])
    assert.ok(tuiSkills.probe, 'TUI /skill did not return the registered probe')
    assert.ok(webSkills.probe, 'Web /skill did not return the registered probe')
    assert.equal(tuiSkills.probe.location, webSkills.probe.location, 'TUI and Web resolved different skill locations')
    assert.ok(
      tuiSkills.probe.location.includes(`${context.fixture.repoRoot}/.apm/skills/${SKILL_NAME}`),
      `probe resolved outside migrated repo: ${tuiSkills.probe.location}`,
    )
    return { tui: tuiSkills, web: webSkills }
  } catch (error) {
    throw new RuntimeFailure(
      'Test 1 (TUI/Web /skill discovery parity)',
      error,
      makeDiagnostics(context, { tuiSkillResult: context.lastTuiSkills, webSkillResult: context.lastWebSkills }),
    )
  }
}

async function runExecutionTest(context) {
  const results = {}
  try {
    results.web = await executeSkillSession(context, 'serve', context.webBaseUrl)
    results.tui = await executeSkillSession(context, 'TUI', context.tuiBaseUrl)
    return results
  } catch (error) {
    throw new RuntimeFailure(
      'Test 2 (real skill() execution)',
      error,
      makeDiagnostics(context, { runtimeResults: results, runtimePayloads: context.lastRuntimePayloads, mockRequests: context.mock.requests }),
    )
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-opencode-runtime-'))
  const context = { root, executable: process.env.OPENCODE_BIN ?? 'opencode' }
  try {
    const versionResult = await execFileAsync(context.executable, ['--version'])
    context.version = versionResult.stdout.trim() || versionResult.stderr.trim()
    if (process.env.OPENCODE_EXPECTED_VERSION) {
      assert.equal(context.version, process.env.OPENCODE_EXPECTED_VERSION, 'OpenCode version is not the pinned test version')
    }

    context.mock = await createMockProvider()
    context.fixture = await createFixture(root, context.mock.baseUrl)
    const tuiPort = await reservePort()
    const webPort = await reservePort()
    context.tuiBaseUrl = `http://127.0.0.1:${tuiPort}`
    context.webBaseUrl = `http://127.0.0.1:${webPort}`
    context.web = startProcess(
      [context.executable, 'serve', '--pure', '--hostname', '127.0.0.1', '--port', String(webPort)],
      { cwd: context.fixture.projectDir, env: context.fixture.env, port: webPort },
    )
    // Both runtimes may install a configured custom provider on first use.
    // Start them serially so that the isolated provider cache cannot race.
    await waitForHealth(context.webBaseUrl, context.web)
    context.tui = startProcess(
      [context.executable, context.fixture.projectDir, '--pure', '--hostname', '127.0.0.1', '--port', String(tuiPort)],
      { cwd: context.fixture.projectDir, env: context.fixture.env, port: tuiPort },
    )
    await waitForHealth(context.tuiBaseUrl, context.tui)

    console.log('Test 1: TUI/serve /skill discovery parity')
    const discovery = await runDiscoveryTest(context)
    context.lastTuiSkills = discovery.tui
    context.lastWebSkills = discovery.web
    console.log(`  PASS (TUI ${discovery.tui.count} skills, serve ${discovery.web.count} skills)`)

    console.log('Test 2: real skill() execution in serve and standalone full TUI')
    const execution = await runExecutionTest(context)
    console.log(`  PASS (serve ${execution.web.session.id}, TUI ${execution.tui.session.id})`)
  } finally {
    await context.tui?.stop()
    await context.web?.stop()
    await context.mock?.close()
    await sleep(1_000)
    await removeFixture(root)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
