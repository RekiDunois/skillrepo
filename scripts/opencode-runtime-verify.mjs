import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'jsonc-parser'

const execFileAsync = promisify(execFile)
const MOCK_PROVIDER = 'mock'
const MOCK_MODEL = 'mock-model'
const TIMEOUT_MS = 30_000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function commandForPty(command) {
  return process.platform === 'darwin'
    ? ['-q', '/dev/null', ...command]
    : ['-qefc', command.map(shellQuote).join(' '), '/dev/null']
}

function redact(value) {
  if (typeof value === 'string') {
    return value
      .replace(/(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*[^\s,;}]+/gi, '$1:[REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      key.toLowerCase().includes('key') || key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('password')
        ? '[REDACTED]'
        : redact(child),
    ]))
  }
  return value
}

function safeResult(result) {
  return redact(result)
}

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = text }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(redact(body))}`)
  return body
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address.port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function startRuntime(executable, projectDir, port, env, web = false) {
  const command = web
    ? [executable, 'serve', '--hostname', '127.0.0.1', '--port', String(port)]
    : [executable, projectDir, '--hostname', '127.0.0.1', '--port', String(port)]
  const child = spawn('script', commandForPty(command), {
    cwd: projectDir,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  return {
    child,
    output: () => redact(output),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM') } catch {}
      }
      await Promise.race([
        new Promise(resolve => child.once('close', resolve)),
        sleep(2_000),
      ])
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
    },
  }
}

async function waitForHealth(baseUrl, runtime) {
  const deadline = Date.now() + TIMEOUT_MS
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`OpenCode exited before becoming healthy: ${runtime.output()}`)
    }
    try {
      const health = await requestJson(baseUrl, '/global/health')
      if (health?.healthy === true) return health
      lastError = `unexpected health response: ${JSON.stringify(redact(health))}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for OpenCode runtime (${lastError})`)
}

async function createMockProvider(skills) {
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unexpected mock route' } }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const serialized = JSON.stringify(body)
    const userText = (body.messages || [])
      .filter(message => message?.role === 'user')
      .map(message => typeof message.content === 'string' ? message.content : '')
      .join('\n')
    const skill = skills.find(candidate => userText.includes(candidate.id)) || skills[0]
    const hasMarker = serialized.includes(skill.marker)
    const first = requests.length === 0
    requests.push({ first, hasMarker })
    const toolCall = {
      id: 'call_skillrepo_runtime_probe',
      type: 'function',
      function: { name: 'skill', arguments: JSON.stringify({ name: skill.id }) },
    }
    if (!first && !hasMarker) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'skill tool result did not contain the expected marker' } }))
      return
    }
    const payload = first
      ? { id: 'skillrepo-runtime-tool', object: 'chat.completion', created: 1, model: MOCK_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] }
      : { id: 'skillrepo-runtime-final', object: 'chat.completion', created: 1, model: MOCK_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'SKILL_LOAD_OK' }, finish_reason: 'stop' }] }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' })
      if (first) {
        response.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: MOCK_MODEL, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`)
      } else {
        response.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: MOCK_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'SKILL_LOAD_OK' }, finish_reason: null }] })}\n\n`)
      }
      response.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: MOCK_MODEL, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    reset() { requests.length = 0 },
    async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}

function findToolParts(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(findToolParts)
  return [value, ...Object.values(value).flatMap(findToolParts)]
}

async function executeSkill(runtimeUrl, projectDir, skill, mock) {
  mock.reset()
  const query = `?directory=${encodeURIComponent(projectDir)}`
  const session = await requestJson(runtimeUrl, `/session${query}`, {
    method: 'POST',
    body: JSON.stringify({ title: `skillrepo ${skill.id} runtime verification`, model: { providerID: MOCK_PROVIDER, id: MOCK_MODEL } }),
  })
  const result = await requestJson(runtimeUrl, `/session/${encodeURIComponent(session.id)}/message${query}`, {
    method: 'POST',
    body: JSON.stringify({ model: { providerID: MOCK_PROVIDER, modelID: MOCK_MODEL }, parts: [{ type: 'text', text: `Run skill ${skill.id} now.` }] }),
  })
  const messages = await requestJson(runtimeUrl, `/session/${encodeURIComponent(session.id)}/message${query}`)
  const parts = findToolParts(messages)
  const completed = parts.find(part => part.type === 'tool' && part.tool === 'skill' && part.state?.status === 'completed')
  if (!completed) throw new Error(`OpenCode did not complete skill(${skill.id}): ${JSON.stringify(redact({ result, messages }))}`)
  if (!JSON.stringify(completed).includes(skill.marker)) throw new Error(`skill(${skill.id}) returned content from an unexpected source`)
  if (!JSON.stringify(result).includes('SKILL_LOAD_OK')) throw new Error(`OpenCode model session did not complete skill(${skill.id})`)
  if (mock.requests.length !== 2 || !mock.requests[0].first || !mock.requests[1].hasMarker) {
    throw new Error(`mock provider protocol was not completed deterministically: ${JSON.stringify(mock.requests)}`)
  }
  return { sessionId: session.id, completed: true, mockRequests: mock.requests.length }
}

async function configPathFromEnv(env) {
  if (env.OPENCODE_CONFIG) return env.OPENCODE_CONFIG
  const dir = env.OPENCODE_CONFIG_DIR || join(env.HOME || tmpdir(), '.config', 'opencode')
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    try { await stat(join(dir, name)); return join(dir, name) } catch {}
  }
  return join(dir, 'opencode.jsonc')
}

async function makeInjectedConfig(context, root, baseEnv, mockBaseUrl) {
  const originalPath = await configPathFromEnv(baseEnv)
  let original = '{}\n'
  try { original = await readFile(originalPath, 'utf8') } catch {}
  const errors = []
  const parsed = parse(original, errors)
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`cannot parse OpenCode config: ${originalPath}`)
  const config = { ...parsed }
  const providers = config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider) ? config.provider : {}
  config.provider = {
    ...providers,
    [MOCK_PROVIDER]: {
      npm: '@ai-sdk/openai-compatible',
      name: 'skillrepo deterministic runtime verifier',
      options: { baseURL: `${mockBaseUrl}/v1`, apiKey: 'skillrepo-runtime-test-only' },
      models: { [MOCK_MODEL]: { name: 'skillrepo deterministic runtime model' } },
    },
  }
  const configDir = join(root, 'config')
  await mkdir(configDir, { recursive: true })
  const path = join(configDir, basename(originalPath))
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  const originalAgents = join(dirname(originalPath), 'agents')
  try { await stat(originalAgents); await symlink(originalAgents, join(configDir, 'agents'), 'dir') } catch {}
  return { path, configDir, originalPath, config }
}

async function runCli(executable, args, env) {
  try {
    const result = await execFileAsync(executable, args, { env, timeout: TIMEOUT_MS })
    return { ok: true, command: `${executable} ${args.join(' ')}`, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { ok: false, command: `${executable} ${args.join(' ')}`, stdout: error.stdout || '', stderr: error.stderr || error.message }
  }
}

async function verify(context) {
  const executable = process.env.OPENCODE_BIN || 'opencode'
  const root = await mkdtemp(join(tmpdir(), 'skillrepo-runtime-helper-'))
  const mock = await createMockProvider(context.skills)
  let runtime
  let webRuntime
  let injected
  const report = {
    phase: context.phase,
    transactionId: context.transactionId,
    executable,
    projectDir: context.projectDir,
    configPath: context.configPath,
    configFingerprint: context.configFingerprint,
    skillSources: context.skillSources,
    expectedSkillIds: context.expectedSkillIds,
    expectedAgentNames: context.expectedAgentNames,
    skillMappings: context.skills.map(skill => ({ id: skill.id, source: skill.source, target: skill.target })),
  }
  try {
    try {
      const located = await execFileAsync('which', [executable], { env: process.env, timeout: TIMEOUT_MS })
      report.executablePath = (located.stdout || '').trim() || executable
    } catch {
      report.executablePath = executable
    }
    const version = await execFileAsync(executable, ['--version'], { env: process.env, timeout: TIMEOUT_MS })
    report.opencodeVersion = (version.stdout || version.stderr || '').trim()
    injected = await makeInjectedConfig(context, root, process.env, mock.baseUrl)
    report.activeConfigPaths = [context.configPath, injected.path]
    report.plugins = Array.isArray(injected.config.plugin) ? injected.config.plugin.map(value => typeof value === 'string' ? value : '[configured]') : []
    const env = { ...process.env, OPENCODE_CONFIG_DIR: injected.configDir }
    delete env.OPENCODE_CONFIG
    report.cliDiscovery = await runCli(executable, ['debug', 'skill'], env)
    report.cliAgents = await runCli(executable, ['agent', 'list'], env)
    report.agentInventory = context.expectedAgentNames.map(name => ({ name, present: report.cliAgents.stdout.includes(name) }))
    if (context.expectedAgentNames.some(name => !report.cliAgents.stdout.includes(name))) {
      throw new Error('OpenCode agent inventory is missing a migrated agent')
    }
    const webPort = await reservePort()
    webRuntime = startRuntime(executable, context.projectDir, webPort, env, true)
    const webUrl = `http://127.0.0.1:${webPort}`
    await waitForHealth(webUrl, webRuntime)
    const port = await reservePort()
    runtime = startRuntime(executable, context.projectDir, port, env)
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForHealth(baseUrl, runtime)
    const state = await requestJson(baseUrl, `/skill?directory=${encodeURIComponent(context.projectDir)}`)
    report.tuiSkillState = state
    if (!Array.isArray(state)) throw new Error('TUI /skill returned a non-array response')
    for (const id of context.expectedSkillIds) {
      if (!state.some(item => item?.name === id)) throw new Error(`TUI /skill did not return ${id}`)
    }
    for (const skill of context.skills) {
      const discovered = state.find(item => item?.name === skill.id)
      if (!discovered) throw new Error(`TUI /skill did not return ${skill.id}`)
      if (typeof discovered.location !== 'string' || !discovered.location.includes(dirname(skill.target))) {
        throw new Error(`TUI /skill resolved ${skill.id} outside its migrated target`)
      }
    }
    const executions = [{ runtime: 'serve', ...(await executeSkill(webUrl, context.projectDir, context.skills[0], mock)) }]
    for (const skill of context.skills) executions.push(await executeSkill(baseUrl, context.projectDir, skill, mock))
    report.toolExecution = executions
    return { ok: true, phase: context.phase, checks: [{ ok: true, command: 'OpenCode full TUI runtime skill()', stdout: 'SKILL_LOAD_OK', stderr: '' }], diagnostics: safeResult(report) }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    report.runtimeOutput = runtime?.output() || 'not started'
    return { ok: false, phase: context.phase, checks: [{ ok: false, command: 'OpenCode full TUI runtime skill()', stdout: '', stderr: `${report.error}\n${report.runtimeOutput}` }], diagnostics: safeResult(report) }
  } finally {
    await runtime?.stop()
    await webRuntime?.stop()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) throw new Error('runtime verifier input path is required')
  const context = JSON.parse(await readFile(inputPath, 'utf8'))
  const result = await verify(context)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, phase: 'unknown', checks: [], diagnostics: { verifierError: redact(error instanceof Error ? error.message : String(error)) } })}\n`)
  process.exitCode = 1
})
