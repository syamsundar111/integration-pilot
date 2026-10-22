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
  let mode = 'ok' // ok | slow | intermittent
  let checks = 0
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"UP","uptimeMs":5000,"checksRunning":0,"checksTotal":3}')
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        checks++
        if (mode === 'intermittent' && checks % 2 === 1) return req.socket.destroy() // every other connection drops
        lastRequest = { headers: req.headers, body: JSON.parse(body) }
        if (req.headers['x-check-token'] !== 'secret') return res.writeHead(401).end('{"error":"missing or wrong x-check-token"}')
        const answer = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results: lastRequest.body.scripts.map((s) => ({ fileName: s.fileName, errors: s.code.includes('oops') ? [{ line: 2, column: 3, message: 'Unexpected input' }] : [] })) }))
        }
        if (mode === 'slow') setTimeout(answer, 500)
        else answer()
      })
    })
    await new Promise((r) => server.listen(0, r))
    url = `http://localhost:${server.address().port}`
  })
  afterAll(() => server.close())
  afterEach(() => {
    mode = 'ok'
    checks = 0
  })

  test('sidecar down: not checked, with the URL and the network cause', async () => {
    const down = http.createServer()
    await new Promise((r) => down.listen(0, r))
    const port = down.address().port
    await new Promise((r) => down.close(r)) // nothing listens on this port any more
    const result = await withEnv({ GROOVY_CHECK_URL: `http://localhost:${port}` }, () => checkScripts([{ fileName: 'a.groovy', code: 'x' }]))
    expect(result).toEqual({ checked: false, errors: [], reason: `fetch failed (ECONNREFUSED) at http://localhost:${port}` })
  })

  test('sidecar slow: not checked after GROOVY_CHECK_TIMEOUT_MS, no retry', async () => {
    mode = 'slow'
    const result = await withEnv({ GROOVY_CHECK_URL: url, GROOVY_CHECK_TOKEN: 'secret', GROOVY_CHECK_TIMEOUT_MS: '100' }, () => checkScripts([{ fileName: 'a.groovy', code: 'x' }]))
    expect(result).toMatchObject({ checked: false, reason: expect.stringMatching(/timeout|aborted/i) })
    expect(checks).toBe(1)
  })

  test('sidecar failing intermittently: the retry gets the result', async () => {
    mode = 'intermittent'
    const result = await withEnv({ GROOVY_CHECK_URL: url, GROOVY_CHECK_TOKEN: 'secret' }, () => checkScripts([{ fileName: 'b.groovy', code: 'x\noops' }]))
    expect(result).toEqual({ checked: true, errors: [{ fileName: 'b.groovy', line: 2, column: 3, message: 'Unexpected input' }] })
    expect(checks).toBe(2)
  })

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
      expect(await checkScripts([{ fileName: 'a.groovy', code: 'x' }])).toMatchObject({ checked: false, reason: expect.stringMatching(/^fetch failed \(.+\) at http:\/\/localhost:1$/) }) // cause and URL
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

  test('the Users Summary scripts pass; a missing bracket is reported with line and column', async () => {
    const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'users-summary', f), 'utf8')
    const result = await withEnv({ GROOVY_CHECK_URL: `http://localhost:${port}`, GROOVY_CHECK_TOKEN: '' }, () =>
      checkScripts([
        { fileName: 'summarizeUsers.groovy', code: fixture('summarizeUsers.groovy') },
        { fileName: 'buildErrorMessage.groovy', code: fixture('buildErrorMessage.groovy') },
        { fileName: 'broken.groovy', code: 'def Message processData(Message message) {\n  def x = [1, 2\n  return message\n}\n' }
      ])
    )
    // the parser stops at line 3; the line whose removal fixes the script is named
    expect(result).toEqual({
      checked: true,
      errors: [{ fileName: 'broken.groovy', line: 2, column: 1, message: "Unexpected input: 'return' (reported at line 3:3; the problem is probably at line 2: def x = [1, 2)" }]
    })
  })

  test('an import of a class that does not exist on CPI is reported (Test 16: MessageLogFactory)', async () => {
    const code = [
      'import com.sap.gateway.ip.core.customdev.util.Message',
      'import com.sap.gateway.ip.core.customdev.util.MessageLogFactory',
      '',
      'def Message processData(Message message) {',
      '    MessageLogFactory.getMessageLog().addAttachmentAsString("Notification", "x", "text/plain")',
      '    return message',
      '}',
      ''
    ].join('\n')
    const fixed = code.replace('import com.sap.gateway.ip.core.customdev.util.MessageLogFactory\n', '').replace('MessageLogFactory.getMessageLog()', 'messageLogFactory.getMessageLog(message)')
    const result = await withEnv({ GROOVY_CHECK_URL: `http://localhost:${port}`, GROOVY_CHECK_TOKEN: '' }, () =>
      checkScripts([
        { fileName: 'addNotificationAttachment.groovy', code },
        { fileName: 'fixed.groovy', code: fixed }
      ])
    )
    expect(result).toEqual({
      checked: true,
      errors: [
        {
          fileName: 'addNotificationAttachment.groovy',
          line: 2,
          column: 1,
          message:
            'unable to resolve class com.sap.gateway.ip.core.customdev.util.MessageLogFactory (no such class on CPI: messageLogFactory is a binding variable, use messageLogFactory.getMessageLog(message) without an import)'
        }
      ]
    })
  })

  test('the OData example of the odata pattern passes the check', async () => {
    const code = fs.readFileSync(path.join(__dirname, 'fixtures', 'odata', 'filterProducts.groovy'), 'utf8')
    const result = await withEnv({ GROOVY_CHECK_URL: `http://localhost:${port}`, GROOVY_CHECK_TOKEN: '' }, () => checkScripts([{ fileName: 'filterProducts.groovy', code }]))
    expect(result).toEqual({ checked: true, errors: [] })
  })
})

describe('streaming lint (Test 3: CPI script check "High: parsing the message body without streaming")', () => {
  const { lint, checkSpecScripts } = require('../srv/lib/groovy-check')
  const advice = 'parses the whole message body as a String (CPI script check: High, no streaming); use new JsonSlurper().parse(message.getBody(java.io.Reader.class)) instead'

  test('parseText of the body is reported, directly or through a variable; streamed parsing and properties are not', () => {
    expect(lint('import groovy.json.JsonSlurper\ndef j = new JsonSlurper().parseText(message.getBody(String))')).toEqual([{ line: 2, message: advice }])
    expect(lint("def body = message.getBody(String) ?: ''\ndef j = new JsonSlurper().parseText(body)")).toEqual([{ line: 2, message: advice }])
    expect(lint('def x = new XmlSlurper().parseText(message.getBody(java.lang.String.class))')[0].message).toMatch(/use new XmlSlurper\(\)\.parse\(message\.getBody\(java\.io\.Reader\.class\)\)/)
    expect(lint('def j = new JsonSlurper().parse(message.getBody(java.io.Reader.class))')).toEqual([])
    expect(lint("def j = new JsonSlurper().parseText(message.getProperty('UsersJson'))")).toEqual([])
    expect(lint(fs.readFileSync(path.join(__dirname, 'fixtures', 'odata', 'filterProducts.groovy'), 'utf8'))).toEqual([])
  })

  test('the proposal check keeps the script ok and adds the warning', async () => {
    const spec = { steps: [{ type: 'groovyScript', name: 'Parse', fileName: 'parse' }] }
    const code = 'def j = new groovy.json.JsonSlurper().parseText(message.getBody(String))'
    const r = await checkSpecScripts(spec, { 'parse.groovy': code }, { check: async () => ({ checked: true, errors: [] }) })
    expect(r.files['parse.groovy']).toMatchObject({ status: 'ok', warnings: [`1: ${advice}`] })
  })
})

