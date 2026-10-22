/**
 * Package Name vs ID, as in CPI: the Name may contain underscores and spaces, the Technical Name
 * (ID) only letters, digits and dots. CPI strips the rest: Name "test_1" -> ID "test1".
 * The same logic runs in the browser (app/integration-pilot/webapp/util/promptLint.js).
 */

const PACKAGE_ID = /^[A-Za-z0-9.]+$/

/** What was removed, for "(CPI does not allow … in IDs)" */
function removedKinds(value) {
  const underscores = value.includes('_')
  const spaces = /\s/.test(value)
  const other = /[^A-Za-z0-9._\s]/.test(value)
  const kinds = [underscores && 'underscores', spaces && 'spaces', other && 'special characters'].filter(Boolean)
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : kinds[0]
}

/**
 * @param {string} value - what the user called the package: an ID or a Name
 * @returns {{ id: string, name: string|null, note: string|null }} id: the CPI ID (keeps the user's
 *   capitalisation; '' if nothing is left); name/note only when the value was a Name
 */
function toPackageId(value) {
  const v = String(value ?? '').trim()
  if (!v || PACKAGE_ID.test(v)) return { id: v, name: null, note: null }
  const id = v.replace(/[^A-Za-z0-9.]/g, '')
  return { id, name: v, note: id ? `Package ID will be ${id} (CPI does not allow ${removedKinds(v)} in IDs).` : null }
}

module.exports = { PACKAGE_ID, toPackageId }
