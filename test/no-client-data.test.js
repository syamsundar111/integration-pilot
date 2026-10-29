/**
 * The repository contains no client data. The names to look for are themselves client data, so
 * they live in the git-ignored test/local/forbidden-names.txt; without that file that check is skipped.
 * The reference exports are ZIPs (compressed, so a plain text search cannot see into them): their
 * text files are unpacked and checked for forbidden names and, always, for real-looking e-mail
 * addresses, hosts and IP addresses.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const JSZip = require('jszip')

const ROOT = path.join(__dirname, '..')
const LIST = path.join(__dirname, 'local', 'forbidden-names.txt')
const REF_DIR = path.join(ROOT, 'srv/iflow-builder/reference')
const run = fs.existsSync(LIST) ? describe : describe.skip

const forbiddenNames = () =>
  fs
    .readFileSync(LIST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

/** Every text file in every reference ZIP: [{ where: 'Ref_X.zip:path', text }] (binary files skipped) */
let unpacked
async function referenceTexts() {
  if (unpacked) return unpacked
  unpacked = []
  for (const zipName of fs.readdirSync(REF_DIR).filter((f) => f.endsWith('.zip')).sort()) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(REF_DIR, zipName)))
    for (const entry of Object.values(zip.files).filter((e) => !e.dir)) {
      const bytes = await entry.async('uint8array')
      if (bytes.includes(0)) continue // binary
      unpacked.push({ where: `${zipName}:${entry.name}`, text: Buffer.from(bytes).toString('utf8') })
    }
  }
  return unpacked
}

// Allowed in the reference exports: example domains, the dummy SAP host, SAP and XML namespace hosts
const ALLOWED_HOST = /^(?:[\w-]+\.)*example\.(?:com|org|net)$|^s4dummy$|^(?:[\w-]+\.)*(?:sap\.com|w3\.org|omg\.org|xmlsoap\.org)$|^$/i
const EMAIL = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g
const URL_HOST = /\b(?:https?|ftps?|sftp|smtps?):\/\/([^/\s:<>"'&?#]*)/gi
const HOST_PORT = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}):\d{2,5}\b/gi // sftp.example.com:22, without a scheme
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g

/** Real-looking e-mail addresses, hosts and IPs in one text: ['e-mail x@y.com', ...] */
function realLooking(text) {
  const found = []
  for (const [m, domain] of text.matchAll(EMAIL)) if (!ALLOWED_HOST.test(domain)) found.push(`e-mail ${m}`)
  for (const re of [URL_HOST, HOST_PORT]) for (const [m, host] of text.matchAll(re)) if (!ALLOWED_HOST.test(host)) found.push(`host ${m}`)
  for (const [m] of text.matchAll(IP)) found.push(`IP ${m}`)
  return [...new Set(found)]
}

run('no client data in the repository', () => {
  test('no tracked or committable file contains a forbidden name', () => {
    const names = forbiddenNames()
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

  test('no file inside a reference ZIP contains a forbidden name', async () => {
    const names = forbiddenNames()
    const found = []
    for (const { where, text } of await referenceTexts()) {
      const content = text.toLowerCase()
      for (const n of names) {
        const i = content.indexOf(n.toLowerCase())
        if (i >= 0) found.push(`${where}:${content.slice(0, i).split('\n').length}: ${n}`)
      }
    }
    expect(found).toEqual([])
  })
})

describe('reference exports contain dummy data only', () => {
  test('the ZIPs are unpacked: every reference has its .iflw, the mapping its .mmap', async () => {
    const files = (await referenceTexts()).map((f) => f.where)
    for (const zipName of fs.readdirSync(REF_DIR).filter((f) => f.endsWith('.zip')))
      expect(files.some((w) => w.startsWith(`${zipName}:`) && /\.(iflw|mmap)$/.test(w))).toBe(true)
  })

  test('no e-mail address, host or IP address outside example.com, s4dummy and SAP/XML namespaces', async () => {
    const found = (await referenceTexts()).flatMap(({ where, text }) => realLooking(text).map((f) => `${where}: ${f}`))
    expect(found).toEqual([])
  })

  test('the check finds real-looking data (so an empty result means something)', () => {
    expect(realLooking('to=ops@client-corp.de host=https://erp.client-corp.de/sap sftp=files.client.io:22 ip=10.1.2.3')).toEqual([
      'e-mail ops@client-corp.de',
      'host https://erp.client-corp.de',
      'host files.client.io:22',
      'IP 10.1.2.3'
    ])
    expect(
      realLooking('noreply@example.com https://odata.example.com/x http://s4dummy:8000/y sftp.example.com:22 http://www.w3.org/2001 https://help.sap.com/z http:///com.sap.ifl.model/Ifl.xsd dir://mmap/x')
    ).toEqual([])
  })
})
