/**
 * The repository contains no client data. The names to look for are themselves client data, so
 * they live in the git-ignored test/local/forbidden-names.txt; without that file the check is skipped.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const LIST = path.join(__dirname, 'local', 'forbidden-names.txt')
const run = fs.existsSync(LIST) ? describe : describe.skip

run('no client data in the repository', () => {
  test('no tracked or committable file contains a forbidden name', () => {
    const names = fs
      .readFileSync(LIST, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    // tracked files, plus untracked files that are not ignored (they would be committed next)
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT })
      .toString()
      .split('\0')
      .filter((f) => f && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile())
    const found = []
    for (const f of files) {
      const content = fs.readFileSync(path.join(ROOT, f), 'latin1').toLowerCase()
      for (const n of names) {
        const i = content.indexOf(n.toLowerCase())
        if (i >= 0) found.push(`${f}:${content.slice(0, i).split('\n').length}: ${n}`)
      }
    }
    expect(found).toEqual([])
  })
})
