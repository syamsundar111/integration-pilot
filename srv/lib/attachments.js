/**
 * Files of a chat session: Groovy and XSLT files, and the mapping files of an imported or existing iFlow
 * (.mmap, .xsd, .wsdl), which only come from there. Specs reference them by file name and the builder
 * injects the content, so the model never receives or writes it.
 */
const cds = require('@sap/cds')
const { allSteps } = require('../iflow-builder/spec-steps')

const MAX_BYTES = 200 * 1024
const MAX_PER_SESSION = 20 // uploaded and written in the conversation
const MAX_FROM_IFLOW = 200 // files of an imported or existing iFlow come with it
const NAME = {
  groovy: /^[A-Za-z][A-Za-z0-9_]*\.groovy$/, // the base name is the spec's fileName
  xsl: /^[A-Za-z][A-Za-z0-9_.-]*\.xslt?$/,
  // as exported: the mapping files refer to each other by these names
  mmap: /^[^/\\]+\.mmap$/,
  xsd: /^[^/\\]+\.xsd$/i,
  wsdl: /^[^/\\]+\.wsdl$/i
}
const FROM_IFLOW_ONLY = ['mmap', 'xsd', 'wsdl']

const db = (user, fn) => cds.tx({ user }, fn)
const Attachment = () => cds.entities('iflowpilot').Attachment
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

const kindOf = (fileName) => (/\.groovy$/i.test(fileName) ? 'groovy' : /\.xslt?$/i.test(fileName) ? 'xsl' : /\.mmap$/i.test(fileName) ? 'mmap' : /\.xsd$/i.test(fileName) ? 'xsd' : /\.wsdl$/i.test(fileName) ? 'wsdl' : null)

/** Checks one { fileName, content } from the client; returns the row to store */
function checkFile({ fileName, content }, origin) {
  fileName = String(fileName || '').trim()
  const kind = kindOf(fileName)
  const fromIflow = origin === 'iflow' || origin === 'import'
  if (!kind || (FROM_IFLOW_ONLY.includes(kind) && !fromIflow)) throw fail(400, 'INVALID_ATTACHMENT', `${fileName || 'Attachment'}: only .groovy and .xsl/.xslt files can be attached`)
  if (!NAME[kind].test(fileName))
    throw fail(
      400,
      'INVALID_ATTACHMENT',
      kind === 'groovy'
        ? `${fileName}: name it like mapUsers.groovy (a letter, then letters, digits or underscore) — the name becomes the script's fileName`
        : `${fileName}: name it like transform.xsl (a letter, then letters, digits, dot, dash or underscore)`
    )
  if (typeof content !== 'string' || !content.trim()) throw fail(400, 'INVALID_ATTACHMENT', `${fileName}: the file is empty`)
  const size = Buffer.byteLength(content, 'utf8')
  if (size > MAX_BYTES) throw fail(400, 'INVALID_ATTACHMENT', `${fileName}: ${Math.ceil(size / 1024)} KB — at most ${MAX_BYTES / 1024} KB per file`)
  return { fileName, kind, content, size, lines: content.split('\n').length }
}

/** Checks a file of the client (an upload) */
const check = (file) => checkFile(file, 'upload')

/**
 * Stores files in a session; a file with the same name is replaced, except that files from
 * an existing iFlow (origin iflow/import) never replace an upload of the user.
 * @returns {Promise<string[]>} the file names stored
 */
/**
 * opts.replaceAi: file names of scripts written in the conversation (origin 'ai') that this save
 * replaces anyway, e.g. scripts of another iFlow with the same name as the iFlow's files
 */
async function save(user, sessionId, files, origin = 'upload', { replaceAi = [] } = {}) {
  const rows = files.map((f) => checkFile(f, origin))
  const names = rows.map((r) => r.fileName)
  if (new Set(names).size !== names.length) throw fail(400, 'INVALID_ATTACHMENT', 'Two attachments have the same file name')
  const stored = []
  await db(user, async (tx) => {
    const existing = await tx.run(SELECT.from(Attachment()).columns('fileName', 'origin').where({ session_ID: sessionId }))
    const byName = Object.fromEntries(existing.map((e) => [e.fileName, e]))
    const added = names.filter((n) => !byName[n]).length
    const fromIflow = origin === 'iflow' || origin === 'import'
    if (fromIflow && existing.length + added > MAX_FROM_IFLOW) throw fail(400, 'TOO_MANY_ATTACHMENTS', `At most ${MAX_FROM_IFLOW} files of an iFlow per conversation`)
    if (!fromIflow && existing.filter((e) => e.origin === 'upload' || e.origin === 'ai').length + added > MAX_PER_SESSION) throw fail(400, 'TOO_MANY_ATTACHMENTS', `At most ${MAX_PER_SESSION} attached files per conversation`)
    for (const row of rows) {
      const old = byName[row.fileName]
      // the user's uploads and the scripts written in this conversation win over copies from an iFlow or an import
      if (old && origin !== 'upload' && (old.origin === 'upload' || (origin !== 'ai' && old.origin === 'ai' && !replaceAi.includes(row.fileName)))) continue
      if (old) await tx.run(UPDATE(Attachment()).set({ ...row, origin }).where({ session_ID: sessionId, fileName: row.fileName }))
      else await tx.run(INSERT.into(Attachment()).entries({ ...row, origin, session_ID: sessionId }))
      stored.push(row.fileName)
    }
  })
  return stored
}

/** [{ fileName, kind, origin, size, lines }] of a session, without content */
function list(user, sessionId) {
  return db(user, (tx) => tx.run(SELECT.from(Attachment()).columns('fileName', 'kind', 'origin', 'size', 'lines').where({ session_ID: sessionId }).orderBy('fileName')))
}

/** { fileName: content } of a session */
async function contents(user, sessionId) {
  const rows = await db(user, (tx) => tx.run(SELECT.from(Attachment()).columns('fileName', 'content').where({ session_ID: sessionId })))
  return Object.fromEntries(rows.map((r) => [r.fileName, r.content]))
}

/** File names a spec takes from attachments: scripts without code and resources */
function referencedBy(spec) {
  const steps = allSteps(spec).map((x) => x.step) // main flow, routes and exception subprocess
  return [
    ...new Set([
      ...steps.filter((s) => s?.type === 'groovyScript' && s.code == null && s.fileName).map((s) => `${s.fileName}.groovy`),
      ...steps.flatMap((s) => (s?.type === 'xsltMapping' || s?.type === 'messageMapping' ? [s.file, ...(s.schemas || [])].filter(Boolean) : [])),
      ...(spec?.resources || [])
    ])
  ]
}

module.exports = { save, list, contents, referencedBy, check, MAX_BYTES }
