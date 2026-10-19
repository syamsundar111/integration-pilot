/**
 * Client of the Groovy syntax check sidecar (srv/lib/groovy-check.js) against a fake sidecar,
 * and, when the jar is built and Java is installed, against the real one (groovy-check/).
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { checkScripts, required } = require('../srv/lib/groovy-check')

const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

describe('groovy-check client', () => {
  let server, url, lastRequest
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        lastRequest = { headers: req.headers, body: JSON.parse(body) }
        if (req.headers['x-check-token'] !== 'secret') return res.writeHead(401).end('{"error":"missing or wrong x-check-token"}')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results: lastRequest.body.scripts.map((s) => ({ fileName: s.fileName, errors: s.code.includes('oops') ? [{ line: 2, column: 3, message: 'Unexpected input' }] : [] })) }))
      })
    })
    await new Promise((r) => server.listen(0, r))
    url = `http://localhost:${server.address().port}`
  })
  afterAll(() => server.close())

  test('a dropped connection is retried once', async () => {
    const realFetch = global.fetch
    let calls = 0
    global.fetch = (...a) => (++calls === 1 ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })) : realFetch(...a))
    try {
      const result = await withEnv({ GROOVY_CHECK_URL: url, GROOVY_CHECK_TOKEN: 'secret' }, () => checkScripts([{ fileName: 'a.groovy', code: 'ok' }]))
      expect(result).toEqual({ checked: true, errors: [] })
      expect(calls).toBe(2)
    } finally {
      global.fetch = realFetch
    }
  })

  test('flattens the errors per file and sends the token', async () => {
    const result = await withEnv({ GROOVY_CHECK_URL: url, GROOVY_CHECK_TOKEN: 'secret' }, () =>
      checkScripts([{ fileName: 'a.groovy', code: 'ok' }, { fileName: 'b.groovy', code: 'x\noops' }])
    )
    expect(result).toEqual({ checked: true, errors: [{ fileName: 'b.groovy', line: 2, column: 3, message: 'Unexpected input' }] })
    expect(lastRequest.headers['x-check-token']).toBe('secret')
  })

  test('not configured, rejected or unreachable = not checked, with the reason', async () => {
    await withEnv({ GROOVY_CHECK_URL: '' }, async () => expect(await checkScripts([{ fileName: 'a.groovy', code: 'x' }])).toEqual({ checked: false, errors: [], reason: 'GROOVY_CHECK_URL is not set' }))
    await withEnv({ GROOVY_CHECK_URL: url, GROOVY_CHECK_TOKEN: 'wrong' }, async () =>
      expect(await checkScripts([{ fileName: 'a.groovy', code: 'x' }])).toMatchObject({ checked: false, reason: expect.stringMatching(/HTTP 401/) })
    )
    await withEnv({ GROOVY_CHECK_URL: 'http://localhost:1' }, async () =>
      expect(await checkScripts([{ fileName: 'a.groovy', code: 'x' }])).toMatchObject({ checked: false, reason: expect.stringMatching(/^fetch failed \(.+\)$/) }) // the network cause is named
    )
    expect(await checkScripts([])).toEqual({ checked: true, errors: [] })
    await withEnv({ GROOVY_CHECK_REQUIRED: 'true' }, () => expect(required()).toBe(true))
  })
})

// The real sidecar: only when it is built (mvn -f groovy-check/pom.xml package) and java is installed
const JAR = path.join(__dirname, '..', 'groovy-check', 'target', 'groovy-check.jar')
const haveJava = spawnSync('java', ['-version']).status === 0
const realSidecar = fs.existsSync(JAR) && haveJava ? describe : describe.skip

realSidecar('groovy-check sidecar (real Groovy parser)', () => {
  let proc
  const port = 4600 + Math.floor(Math.random() * 300)
  beforeAll(async () => {
    proc = spawn('java', ['-jar', JAR], { env: { ...process.env, PORT: String(port), CHECK_TOKEN: '' } })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://localhost:${port}/health`)).ok) return
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error('sidecar did not start')
  }, 20_000)
  afterAll(() => proc?.kill())

  test('the SF -> Directory scripts pass; a missing bracket is reported with line and column', async () => {
    const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'sf-entra', f), 'utf8')
    const result = await withEnv({ GROOVY_CHECK_URL: `http://localhost:${port}`, GROOVY_CHECK_TOKEN: '' }, () =>
      checkScripts([
        { fileName: 'mapSfToEntra.groovy', code: fixture('mapSfToEntra.groovy') },
        { fileName: 'buildErrorNotification.groovy', code: fixture('buildErrorNotification.groovy') },
        { fileName: 'broken.groovy', code: 'def Message processData(Message message) {\n  def x = [1, 2\n  return message\n}\n' }
      ])
    )
    // the parser stops at line 3; the line whose removal fixes the script is named
    expect(result).toEqual({
      checked: true,
      errors: [{ fileName: 'broken.groovy', line: 2, column: 1, message: "Unexpected input: 'return' (reported at line 3:3; the problem is probably at line 2: def x = [1, 2)" }]
    })
  })
})
