/**
 * Attached Groovy and XSLT files of a chat session. Specs reference them by file name
 * (a groovyScript step without code, or spec.resources) and the builder injects the content,
 * so the model never receives or writes the script bodies.
 */
const cds = require('@sap/cds')

const MAX_BYTES = 200 * 1024
const MAX_PER_SESSION = 20
const NAME = {
  groovy: /^[A-Za-z][A-Za-z0-9_]*\.groovy$/, // the base name is the spec's fileName
  xsl: /^[A-Za-z][A-Za-z0-9_.-]*\.xslt?$/
}

const db = (user, fn) => cds.tx({ user }, fn)
const Attachment = () => cds.entities('iflowpilot').Attachment
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

const kindOf = (fileName) => (/\.groovy$/i.test(fileName) ? 'groovy' : /\.xslt?$/i.test(fileName) ? 'xsl' : null)

/** Checks one { fileName, content } from the client; returns the row to store */
function check({ fileName, content }) {
  fileName = String(fileName || '').trim()
  const kind = kindOf(fileName)
  if (!kind) throw fail(400, 'INVALID_ATTACHMENT', `${fileName || 'Attachment'}: only .groovy and .xsl/.xslt files can be attached`)
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

/**
 * Stores files in a session; a file with the same name is replaced, except that files from
 * an existing iFlow (origin iflow/import) never replace an upload of the user.
 * @returns {Promise<string[]>} the file names stored
 */
async function save(user, sessionId, files, origin = 'upload') {
  const rows = files.map(check)
  const names = rows.map((r) => r.fileName)
  if (new Set(names).size !== names.length) throw fail(400, 'INVALID_ATTACHMENT', 'Two attachments have the same file name')
  const stored = []
  await db(user, async (tx) => {
    const existing = await tx.run(SELECT.from(Attachment()).columns('fileName', 'origin').where({ session_ID: sessionId }))
    const byName = Object.fromEntries(existing.map((e) => [e.fileName, e]))
    const added = names.filter((n) => !byName[n]).length
    if (existing.length + added > MAX_PER_SESSION) throw fail(400, 'TOO_MANY_ATTACHMENTS', `At most ${MAX_PER_SESSION} attached files per conversation`)
    for (const row of rows) {
      const old = byName[row.fileName]
      // the user's uploads and the scripts written in this conversation win over copies from an iFlow or an import
      if (old && origin !== 'upload' && (old.origin === 'upload' || (origin !== 'ai' && old.origin === 'ai'))) continue
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
  const steps = [...(spec?.steps || []), ...(spec?.exceptionSubprocess?.steps || [])]
  return [...steps.filter((s) => s?.type === 'groovyScript' && s.code == null && s.fileName).map((s) => `${s.fileName}.groovy`), ...(spec?.resources || [])]
}

module.exports = { save, list, contents, referencedBy, check, MAX_BYTES }
