/**
 * Files that must never be committed are ignored by git (review: a typo in .gitignore let
 * .env.local through).
 */
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ignored = (file) => spawnSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: ROOT }).status === 0

describe('.gitignore', () => {
  test.each(['.env', '.env.local', '.env.production', 'default-env.json', '.cdsrc-private.json', 'db.sqlite', 'db.sqlite.bak-202610221200', 'test/local/anything.zip'])(
    '%s is ignored',
    (file) => expect(ignored(file)).toBe(true)
  )

  test.each(['srv/agent/agent.js', 'docs/prompt-guide.md', 'test/fixtures/users-summary/spec.json'])('%s is not ignored', (file) => expect(ignored(file)).toBe(false))
})

describe('deployment', () => {
  const fs = require('fs')
  test.each(['mta.yaml', 'mta-sqlite.yaml'])('%s runs the backend as exactly one instance', (file) => {
    const mta = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const srv = mta.split(/\n {2}- name: /).find((m) => m.startsWith('integration-pilot-srv'))
    expect(srv).toMatch(/\n {6}instances: 1\n/)
  })
})

describe('Groovy check sidecar memory (review: 256M is below the Java buildpack reservations)', () => {
  const fs = require('fs')
  test.each(['mta.yaml', 'mta-sqlite.yaml'])('%s gives it 512M and sizes stacks, code cache and metaspace', (file) => {
    const mta = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const sidecar = mta.split(/\n {2}- name: /).find((m) => m.startsWith('integration-pilot-groovy-check'))
    expect(sidecar).toMatch(/\n {6}memory: 512M\n/)
    expect(sidecar).toMatch(/memory_calculator: \{ stack_threads: 40 \}/)
    expect(sidecar).toMatch(/JAVA_OPTS: '-XX:ReservedCodeCacheSize=64M -XX:MaxMetaspaceSize=96M -XX:MaxDirectMemorySize=10M'/)
  })
})
