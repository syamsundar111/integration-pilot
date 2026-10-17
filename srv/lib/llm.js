/**
 * LLM adapter — the single swap point for the model provider.
 *
 * Today: an OpenAI-compatible /chat/completions endpoint behind the BTP destination
 * NVIDIA_LLM (the destination supplies the Authorization header). Model name from
 * env LLM_MODEL, optional fallback LLM_FALLBACK_MODEL. To move to SAP Generative AI Hub, re-implement `send()` and keep
 * the `chat()` contract: OpenAI-style request in, OpenAI-style response out.
 *
 * Reasoning models (e.g. moonshotai/kimi-k2.6) may return their chain of thought in
 * `reasoning_content`/`reasoning` or inside <think> tags; it is always stripped, so
 * callers only see the final content and tool_calls.
 */
const cds = require('@sap/cds')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')

const LOG = cds.log('llm')

const DESTINATION = 'NVIDIA_LLM'
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120_000) // reasoning models can think for a while; large specs need more
const MAX_RETRIES = 3 // for 429, 5xx and garbled output
const MAX_TIMEOUT_RETRIES = 1
const BASE_DELAY_MS = Number(process.env.LLM_RETRY_BASE_MS || 2_000)

const env = (name, fallback) => process.env[name] || fallback
const model = () => process.env.LLM_MODEL

// --- client-side rate limit (free tier: ~40 requests/min) --------------------------

const sentAt = []

/** Waits until a request fits into the per-minute budget (LLM_MAX_RPM, default 35) */
async function throttle() {
  const limit = Number(env('LLM_MAX_RPM', 35))
  for (;;) {
    const now = Date.now()
    while (sentAt.length && now - sentAt[0] >= 60_000) sentAt.shift()
    if (sentAt.length < limit) return void sentAt.push(now)
    const waitMs = 60_000 - (now - sentAt[0]) + 50
    LOG.info(`Rate budget of ${limit} requests/min used up, waiting ${Math.ceil(waitMs / 1000)}s`)
    await sleep(waitMs)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- errors --------------------------------------------------------------------------

function llmError(status, code, message, hint) {
  const err = new Error(message)
  Object.assign(err, { status, code, hint })
  Object.defineProperty(err, 'isLlmError', { value: true })
  err.$sanitize = false
  return err
}

const RATE_LIMIT_MESSAGE =
  'The AI model is rate-limited right now (the NVIDIA free tier allows about 40 requests per minute). Please wait a minute and try again.'

function normalizeError(e, modelName = model()) {
  if (e.isLlmError) return e
  const status = e.response?.status
  const data = e.response?.data
  const detail = (typeof data === 'string' ? data : data?.error?.message || data?.detail || data?.message || data?.title) || e.message
  if (!status) {
    if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message))
      return llmError(504, 'LLM_TIMEOUT', `The AI model did not answer within ${TIMEOUT_MS / 1000}s.`, 'Retry; reasoning models can be slow under load.')
    return llmError(502, 'LLM_UNREACHABLE', String(detail),
      `Check destination ${DESTINATION} (URL e.g. https://integrate.api.nvidia.com/v1, header URL.headers.Authorization = Bearer <key>). Locally run with --profile hybrid.`)
  }
  if (status === 429) return llmError(429, 'LLM_RATE_LIMITED', RATE_LIMIT_MESSAGE, 'Wait about a minute before sending the next message.')
  if (status === 401 || status === 403)
    return llmError(502, 'LLM_UNAUTHORIZED', String(detail), `The model API rejected the key in destination ${DESTINATION} (property URL.headers.Authorization).`)
  if (status === 404)
    return llmError(502, 'LLM_NOT_FOUND', String(detail), `Model '${modelName}' is not available for this API key. Check LLM_MODEL / LLM_FALLBACK_MODEL and that the destination URL ends with /v1.`)
  if (status === 410)
    return llmError(502, 'LLM_MODEL_RETIRED', String(detail), 'The provider retired this model. Set LLM_MODEL / LLM_FALLBACK_MODEL to a current model (GET https://integrate.api.nvidia.com/v1/models lists them).')
  if (status === 400 || status === 422) return llmError(502, 'LLM_BAD_REQUEST', String(detail))
  return llmError(502, 'LLM_ERROR', String(detail), 'The model service reported an error; retry in a moment.')
}

const retryable = (status) => status === 429 || (status >= 500 && status <= 599)
const isTimeout = (e) => !e.response && (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || ''))

// Leaked chat-template tokens (e.g. "<|close|>") mean the provider produced garbage; retry
const GARBLED = /<\|[a-z_]{2,30}\|>/i

/** Retry-After header (seconds or HTTP date), if any */
function retryAfterMs(headers = {}) {
  const v = headers['retry-after']
  if (!v) return null
  const secs = Number(v)
  if (!Number.isNaN(secs)) return secs * 1000
  const date = Date.parse(v)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

// --- reasoning stripping ---------------------------------------------------------------

/** Removes <think>…</think> blocks (also a dangling closing or opening tag) */
function stripThinking(content) {
  if (typeof content !== 'string') return content
  let out = content
  const close = out.lastIndexOf('</think>')
  if (close >= 0) out = out.slice(close + '</think>'.length) // reasoning before the closing tag
  const open = out.indexOf('<think>')
  if (open >= 0) out = out.slice(0, open) // truncated reasoning without closing tag
  return out.trim()
}

function cleanMessage(message = {}) {
  // eslint-disable-next-line no-unused-vars
  const { reasoning_content, reasoning, reasoning_details, ...rest } = message
  rest.content = stripThinking(rest.content) || null
  if (Array.isArray(rest.tool_calls)) {
    rest.tool_calls = rest.tool_calls.map((tc, i) => ({ ...tc, id: tc.id || `call_${Date.now()}_${i}`, type: tc.type || 'function' }))
    if (!rest.tool_calls.length) delete rest.tool_calls
  }
  return rest
}

// --- usage ---------------------------------------------------------------------------------

/**
 * Token usage in a provider-neutral shape. This is the only place that knows the provider's
 * field names (OpenAI-style prompt_tokens / completion_tokens here); null when not reported.
 * @returns {{ inputTokens: number|null, outputTokens: number|null, totalTokens: number|null, durationMs: number }}
 */
function normalizeUsage(raw = {}, durationMs) {
  const num = (v) => (Number.isFinite(v) ? v : null)
  const inputTokens = num(raw.prompt_tokens)
  const outputTokens = num(raw.completion_tokens)
  const totalTokens = num(raw.total_tokens) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null)
  return { inputTokens, outputTokens, totalTokens, durationMs }
}

// --- transport -------------------------------------------------------------------------

function send(body, signal) {
  return executeHttpRequest(
    { destinationName: DESTINATION },
    { method: 'POST', url: '/chat/completions', data: body, timeout: TIMEOUT_MS, signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
    { fetchCsrfToken: false }
  )
}

// Errors where another model would not help (same key, same destination, missing config)
const NO_FALLBACK = new Set(['LLM_NOT_CONFIGURED', 'LLM_UNAUTHORIZED', 'LLM_UNREACHABLE', 'CANCELLED'])

/** Thrown when the caller aborted the request (e.g. the user cancelled the chat turn) */
const cancelled = () => Object.assign(new Error('Cancelled'), { code: 'CANCELLED', status: 499, isLlmError: true })

/**
 * One model, with retries for 429/5xx/garbled output (3x) and timeouts (1x) unless retries=false.
 * @returns {Promise<object>} response with cleaned messages
 */
async function callModel(body, { retries = true, signal } = {}) {
  let timeouts = 0
  for (let attempt = 0; ; attempt++) {
    await throttle()
    if (signal?.aborted) throw cancelled()
    const started = Date.now()
    try {
      const res = await send(body, signal)
      const data = res.data
      const u = data.usage || {}
      LOG.info(`${body.model}: ${Date.now() - started}ms, tokens prompt=${u.prompt_tokens ?? '?'} completion=${u.completion_tokens ?? '?'} total=${u.total_tokens ?? '?'}`)
      data.usage = normalizeUsage(u, Date.now() - started)
      if (!Array.isArray(data.choices) || !data.choices.length) throw llmError(502, 'LLM_EMPTY', 'The AI model returned no answer.')
      const raw = data.choices[0].message?.content
      if (typeof raw === 'string' && GARBLED.test(raw)) throw Object.assign(new Error('garbled model output'), { garbled: true })
      data.choices = data.choices.map((c) => ({ ...c, message: cleanMessage(c.message) }))
      data.model = body.model
      return data
    } catch (e) {
      if (signal?.aborted) throw cancelled() // never retry or fall back after a cancel
      const status = e.response?.status
      const transient = (retryable(status) || e.garbled) && attempt < MAX_RETRIES
      if (retries && !e.isLlmError && (transient || (isTimeout(e) && timeouts++ < MAX_TIMEOUT_RETRIES))) {
        const delay = (status && retryAfterMs(e.response.headers)) ?? BASE_DELAY_MS * 2 ** attempt + Math.random() * 500
        const why = e.garbled ? 'garbled output' : isTimeout(e) ? 'timeout' : `HTTP ${status}`
        LOG.warn(`${body.model}: ${why}, retry ${attempt + 1} in ${Math.round(delay / 1000)}s`)
        await sleep(Math.min(delay, 30_000))
        continue
      }
      const err = e.garbled
        ? llmError(502, 'LLM_GARBLED', 'The AI model returned an unreadable answer.', 'Retry in a moment; the free model endpoint is sometimes unstable.')
        : normalizeError(e, body.model)
      LOG.error(`${body.model}: chat failed: ${err.code} ${err.message}`)
      throw err
    }
  }
}

/**
 * OpenAI-compatible chat completion. If the primary model (LLM_MODEL) still fails after
 * all retries, the same request is sent once to LLM_FALLBACK_MODEL (if set).
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, temperature?: number, maxTokens?: number, signal?: AbortSignal }} req
 * @returns {Promise<object>} response with choices[0].message cleaned (no reasoning);
 *   `model` is the model that answered, `fallbackUsed` tells whether it was the fallback,
 *   `usage` = { inputTokens, outputTokens, totalTokens, durationMs } (provider-neutral)
 */
async function chat({ messages, tools, toolChoice, temperature = 0.3, maxTokens, signal } = {}) {
  if (!model()) throw llmError(500, 'LLM_NOT_CONFIGURED', 'LLM_MODEL is not set.', 'Set LLM_MODEL (e.g. in .env for local runs, or as an app environment variable).')
  const body = {
    model: model(),
    messages,
    temperature,
    max_tokens: maxTokens || Number(env('LLM_MAX_TOKENS', 8192)),
    ...(tools?.length && { tools, tool_choice: toolChoice || 'auto' })
  }

  try {
    return { ...(await callModel(body, { signal })), fallbackUsed: false }
  } catch (e) {
    const fallback = process.env.LLM_FALLBACK_MODEL
    if (!fallback || fallback === body.model || NO_FALLBACK.has(e.code)) throw e
    LOG.warn(`${body.model} failed (${e.code}); retrying once with fallback model ${fallback}`)
    return { ...(await callModel({ ...body, model: fallback }, { retries: false, signal })), fallbackUsed: true }
  }
}

/** Sends a tiny prompt to verify destination, key and model; never throws. */
async function health() {
  const started = Date.now()
  try {
    // generous max_tokens: reasoning models spend tokens before answering
    const res = await chat({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], temperature: 0, maxTokens: 1024 })
    return { ok: true, model: res.model, fallbackUsed: res.fallbackUsed, latencyMs: Date.now() - started, reply: (res.choices[0].message.content || '').slice(0, 100), error: null }
  } catch (e) {
    const { code, message, hint } = normalizeError(e)
    return { ok: false, model: model() || null, fallbackUsed: false, latencyMs: null, reply: null, error: { code, message, hint } }
  }
}

module.exports = { chat, health, stripThinking, cleanMessage, normalizeUsage, RATE_LIMIT_MESSAGE }
