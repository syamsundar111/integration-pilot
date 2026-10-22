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
