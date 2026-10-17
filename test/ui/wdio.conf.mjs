/**
 * wdi5 UI tests: the real app (CAP service + agent + builder + UI5 app) on port 4011 with the AI
 * model, the CPI tenant and the Groovy check faked (test/ui/fake-backend.cjs), driven in Chrome.
 *
 *   npm run test:ui                         headless
 *   HEADED=1 npm run test:ui                watch the browser
 *   CHROME_BIN=/path/to/chrome npm run test:ui   use a given Chrome (else WebdriverIO downloads one)
 *
 * The UI5 runtime is loaded from ui5.sap.com; behind a proxy, HTTPS_PROXY is passed to Chrome.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.UI_TEST_PORT || 4011)
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy

let server

export const config = {
  runner: 'local',
  specs: ['./specs/**/*.spec.mjs'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'chrome',
      ...(process.env.CHROME_VERSION && { browserVersion: process.env.CHROME_VERSION }),
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': {
        ...(process.env.CHROME_BIN && { binary: process.env.CHROME_BIN }),
        args: [
          ...(process.env.HEADED ? [] : ['--headless=new']),
          '--window-size=1500,1000',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1'] : [])
        ]
      }
    }
  ],
  logLevel: 'error',
  baseUrl: `http://localhost:${PORT}/index.html`,
  waitforTimeout: 20000,
  services: ['ui5'],
  wdi5: { waitForUI5Timeout: 30000, logLevel: 'error', screenshotPath: path.join(ROOT, 'test', 'ui', 'screenshots') },
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  reporters: ['spec'],

  /** Starts the app with the fakes on a fresh in-memory database */
  onPrepare() {
    return new Promise((resolve, reject) => {
      server = spawn(process.execPath, ['-r', './test/ui/fake-backend.cjs', 'node_modules/@sap/cds/bin/serve.js', 'all', '--in-memory'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), CDS_ENV: 'development', DEPLOY_POLL_INTERVAL_MS: '50', DEPLOY_POLL_TIMEOUT_MS: '500' }
      })
      const timer = setTimeout(() => reject(new Error('UI test server did not start within 60s')), 60000)
      server.stdout.on('data', (d) => {
        if (String(d).includes('server listening')) {
          clearTimeout(timer)
          resolve()
        }
      })
      server.stderr.on('data', (d) => process.stderr.write(`[ui-test server] ${d}`))
      server.on('exit', (code) => code && reject(new Error(`UI test server exited with ${code}`)))
    })
  },

  /** A screenshot of every failing test, in test/ui/screenshots (git-ignored) */
  async afterTest(test, _context, { passed }) {
    if (passed) return
    const dir = path.join(ROOT, 'test', 'ui', 'screenshots')
    await import('node:fs').then((fs) => fs.mkdirSync(dir, { recursive: true }))
    await browser.saveScreenshot(path.join(dir, `${test.title.replace(/[^\w]+/g, '-')}.png`))
  },

  onComplete() {
    server?.kill()
  }
}
