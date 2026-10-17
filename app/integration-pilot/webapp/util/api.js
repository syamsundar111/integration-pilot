sap.ui.define([], () => {
  'use strict'

  /**
   * REST client for the CAP service at /api (srv/api-service.cds).
   * Errors are thrown as ApiError with the backend's { code, message, hint }.
   * Writes send the approuter's CSRF token (production); locally there is none.
   */
  const BASE = 'api' // relative to index.html, so it works locally ("/") and behind the approuter

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.message) || `Request failed (${status})`)
      this.status = status
      this.code = body && body.code
      this.hint = body && body.hint
    }
  }

  let csrfToken = null
  let csrfFetched = false

  async function fetchCsrfToken() {
    csrfFetched = true
    try {
      const res = await fetch(`${BASE}/me`, { headers: { 'x-csrf-token': 'fetch', 'X-Requested-With': 'XMLHttpRequest' } })
      csrfToken = res.headers.get('x-csrf-token')
    } catch (e) {
      csrfToken = null
    }
  }

  const isWrite = (init) => !!init && !!init.method && init.method !== 'GET'

  async function send(path, init) {
    if (isWrite(init) && !csrfFetched) await fetchCsrfToken()
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    if (init && init.body) headers['Content-Type'] = 'application/json'
    if (isWrite(init) && csrfToken) headers['x-csrf-token'] = csrfToken
    return fetch(BASE + path, { ...init, headers })
  }

  async function request(path, init) {
    let res
    try {
      res = await send(path, init)
      // token expired with the session: fetch a new one and retry once
      if (res.status === 403 && (res.headers.get('x-csrf-token') || '').toLowerCase() === 'required') {
        await fetchCsrfToken()
        res = await send(path, init)
      }
    } catch (e) {
      throw new ApiError(0, { code: 'NETWORK', message: 'The server is not reachable.', hint: 'Check your connection; locally, check that the CAP server is running (npm run watch:hybrid).' })
    }
    if (res.status === 401) {
      // session expired behind the approuter: reload to sign in again
      setTimeout(() => window.location.reload(), 1500)
      throw new ApiError(401, { code: 'SESSION_EXPIRED', message: 'Your session has expired.', hint: 'Reloading to sign you in again…' })
    }
    if (res.status === 204) return null
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch (e) {
      body = text
    }
    if (!res.ok) throw new ApiError(res.status, (body && body.error) || { message: typeof body === 'string' && body ? body : res.statusText })
    return body
  }

  /** Downloads a binary response as a file; throws ApiError instead of saving an error page */
  async function download(path, fileName) {
    const res = await fetch(BASE + path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    if (!res.ok) {
      let err = { message: `Download failed (${res.status})` }
      try {
        err = (await res.json()).error || err
      } catch (e) {
        // not JSON
      }
      throw new ApiError(res.status, err)
    }
    const url = URL.createObjectURL(await res.blob())
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName })
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /** OData-style query string, e.g. q({ $orderby: 'createdAt desc', $top: 20 }) */
  function q(params) {
    const parts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    return parts.length ? `?${parts.join('&')}` : ''
  }

  return {
    ApiError,
    get: (path) => request(path),
    post: (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: (path) => request(path, { method: 'DELETE' }),
    download,
    q,
    seg: (id) => encodeURIComponent(id)
  }
})
