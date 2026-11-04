// usage: node tools/push-scan.js — client-data scan of every unpushed commit (git rev-list --branches --not --remotes):
// its message, each added or modified file version, and every entry of changed zips, against the git-ignored
// test/local/forbidden-names.txt. Prints counts only; exit 1 on any hit or when the list is missing.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const R = path.join(__dirname, '..')
const JSZip = require(path.join(R, 'node_modules/jszip'))
const git = (...a) => execFileSync('git', ['-C', R, ...a], { maxBuffer: 1 << 28 })
const list = path.join(R, 'test/local/forbidden-names.txt')
const names = fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean) : []
if (!names.length) {
  console.log('STOP: test/local/forbidden-names.txt is missing or empty')
  process.exit(1)
}
const hitsIn = (text) => names.filter((n) => text.toLowerCase().includes(n)).length

;(async () => {
  const commits = git('rev-list', '--branches', '--not', '--remotes').toString().split('\n').filter(Boolean)
  let files = 0
  let zips = 0
  let entries = 0
  let hits = 0
  for (const c of commits) {
    hits += hitsIn(git('log', '-1', '--format=%B', c).toString())
    const changed = git('diff-tree', '--root', '--no-commit-id', '-r', '--diff-filter=AM', '--name-only', '-z', c).toString().split('\0').filter(Boolean)
    for (const f of changed) {
      const blob = git('show', `${c}:${f}`)
      files++
      hits += hitsIn(blob.toString('latin1'))
      if (!f.endsWith('.zip')) continue
      zips++
      const zip = await JSZip.loadAsync(blob)
      for (const e of Object.values(zip.files).filter((x) => !x.dir)) {
        entries++
        hits += hitsIn(e.name) + hitsIn(await e.async('string'))
      }
    }
  }
  console.log(`commits ${commits.length}, file versions ${files}, zips ${zips} with ${entries} entries, hits ${hits}`)
  process.exit(hits ? 1 : 0)
})().catch((e) => {
  console.error('STOP:', e.message)
  process.exit(1)
})
