process.env.LLM_MODEL = 'test/model'
process.env.LLM_RETRY_BASE_MS = '1'

jest.mock('@sap-cloud-sdk/http-client', () => ({ executeHttpRequest: jest.fn() }))
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const llm = require('../srv/lib/llm')

const ok = (message, extra = {}) => ({ data: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }], usage: { total_tokens: 1 }, ...extra } })
const httpError = (status, headers = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers, data: { error: { message: `status ${status}` } } } })

beforeEach(() => {
  executeHttpRequest.mockReset()
  // CAP loads .env (which may set LLM_FALLBACK_MODEL); tests opt in to the fallback explicitly
  delete process.env.LLM_FALLBACK_MODEL
})

describe('reasoning is ignored', () => {
  test.each([
    ['<think>plan…</think>Final answer', 'Final answer'],
    ['reasoning without opening tag</think>\n\nFinal', 'Final'],
    ['Answer<think>truncated reasoning', 'Answer'],
    ['<think>only thinking</think>', ''],
    ['plain', 'plain']
  ])('stripThinking(%j)', (input, expected) => expect(llm.stripThinking(input)).toBe(expected))

  test('drops reasoning_content/reasoning and keeps tool_calls', async () => {
    executeHttpRequest.mockResolvedValue(
      ok({ content: '', reasoning_content: 'secret thoughts', reasoning: 'more', tool_calls: [{ id: 'listPackages:0', type: 'function', function: { name: 'listPackages', arguments: '{}' } }] })
    )
    const msg = (await llm.chat({ messages: [] })).choices[0].message
    expect(msg).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'listPackages:0', type: 'function', function: { name: 'listPackages', arguments: '{}' } }] })
  })

  test('adds ids to tool calls that have none', async () => {
    executeHttpRequest.mockResolvedValue(ok({ content: null, tool_calls: [{ function: { name: 'x', arguments: '{}' } }] }))
    const [tc] = (await llm.chat({ messages: [] })).choices[0].message.tool_calls
    expect(tc).toMatchObject({ id: expect.stringMatching(/^call_/), type: 'function' })
  })
})

describe('request', () => {
  test('uses the destination, model from LLM_MODEL and tools', async () => {
    executeHttpRequest.mockResolvedValue(ok({ content: 'hi' }))
    await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 't' } }] })
    const [dest, req] = executeHttpRequest.mock.calls[0]
    expect(dest).toEqual({ destinationName: 'NVIDIA_LLM' })
    expect(req).toMatchObject({ method: 'POST', url: '/chat/completions', data: { model: 'test/model', tool_choice: 'auto', tools: [{ function: { name: 't' } }] } })
  })

  test('fails clearly without LLM_MODEL', async () => {
    const saved = process.env.LLM_MODEL
    delete process.env.LLM_MODEL
    await expect(llm.chat({ messages: [] })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' })
    process.env.LLM_MODEL = saved
  })
})

describe('retries', () => {
  test('retries 429 and 5xx, then succeeds', async () => {
    executeHttpRequest.mockRejectedValueOnce(httpError(429)).mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(ok({ content: 'done' }))
    const res = await llm.chat({ messages: [] })
    expect(res.choices[0].message.content).toBe('done')
    expect(executeHttpRequest).toHaveBeenCalledTimes(3)
  })

  test('gives up after 3 retries on 429 with a clear rate-limit message', async () => {
    executeHttpRequest.mockRejectedValue(httpError(429, { 'retry-after': '0' }))
    await expect(llm.chat({ messages: [] })).rejects.toMatchObject({ status: 429, code: 'LLM_RATE_LIMITED', message: expect.stringContaining('about 40 requests per minute') })
    expect(executeHttpRequest).toHaveBeenCalledTimes(4)
  })

  test('retries garbled output (leaked template tokens)', async () => {
    executeHttpRequest.mockResolvedValueOnce(ok({ content: '<|close|>. the iflow.1.' })).mockResolvedValueOnce(ok({ content: 'clean' }))
    expect((await llm.chat({ messages: [] })).choices[0].message.content).toBe('clean')
  })

  test('does not retry 401', async () => {
    executeHttpRequest.mockRejectedValue(httpError(401))
    await expect(llm.chat({ messages: [] })).rejects.toMatchObject({ code: 'LLM_UNAUTHORIZED' })
    expect(executeHttpRequest).toHaveBeenCalledTimes(1)
  })
})

describe('fallback model', () => {
  afterEach(() => delete process.env.LLM_FALLBACK_MODEL)

  test('after the primary fails all retries, the same request goes once to LLM_FALLBACK_MODEL', async () => {
    process.env.LLM_FALLBACK_MODEL = 'test/fallback'
    executeHttpRequest
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce(ok({ content: 'from fallback' }))
    const res = await llm.chat({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 't' } }] })
    expect(res).toMatchObject({ model: 'test/fallback', fallbackUsed: true })
    expect(res.choices[0].message.content).toBe('from fallback')
    const calls = executeHttpRequest.mock.calls.map(([, req]) => req.data)
    expect(calls.map((d) => d.model)).toEqual(['test/model', 'test/model', 'test/model', 'test/model', 'test/fallback'])
    expect(calls[4]).toEqual({ ...calls[0], model: 'test/fallback' }) // same request
  })

  test('the fallback is tried only once; its error is returned', async () => {
    process.env.LLM_FALLBACK_MODEL = 'test/fallback'
    executeHttpRequest.mockRejectedValue(httpError(429, { 'retry-after': '0' }))
    await expect(llm.chat({ messages: [] })).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' })
    expect(executeHttpRequest).toHaveBeenCalledTimes(5) // 4 primary + 1 fallback
  })

  test('no fallback for errors another model cannot fix (e.g. rejected key)', async () => {
    process.env.LLM_FALLBACK_MODEL = 'test/fallback'
    executeHttpRequest.mockRejectedValue(httpError(401))
    await expect(llm.chat({ messages: [] })).rejects.toMatchObject({ code: 'LLM_UNAUTHORIZED' })
    expect(executeHttpRequest).toHaveBeenCalledTimes(1)
  })

  test('primary success reports fallbackUsed: false', async () => {
    process.env.LLM_FALLBACK_MODEL = 'test/fallback'
    executeHttpRequest.mockResolvedValue(ok({ content: 'hi' }))
    expect(await llm.chat({ messages: [] })).toMatchObject({ model: 'test/model', fallbackUsed: false })
  })
})

describe('cancellation', () => {
  afterEach(() => delete process.env.LLM_FALLBACK_MODEL)

  test('an aborted call ends as CANCELLED without retries or fallback', async () => {
    process.env.LLM_FALLBACK_MODEL = 'test/fallback'
    const controller = new AbortController()
    executeHttpRequest.mockImplementation((_d, req) => {
      expect(req.signal).toBe(controller.signal)
      controller.abort()
      return Promise.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
    })
    await expect(llm.chat({ messages: [], signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(executeHttpRequest).toHaveBeenCalledTimes(1)
  })
})

describe('health', () => {
  test('ok with latency', async () => {
    executeHttpRequest.mockResolvedValue(ok({ content: '<think>hmm</think>OK' }))
    expect(await llm.health()).toMatchObject({ ok: true, model: 'test/model', reply: 'OK', latencyMs: expect.any(Number), error: null })
  })

  test('never throws', async () => {
    executeHttpRequest.mockRejectedValue(httpError(404))
    expect(await llm.health()).toMatchObject({ ok: false, error: { code: 'LLM_NOT_FOUND' } })
  })
})

describe('usage', () => {
  test('is returned in a provider-neutral shape', async () => {
    executeHttpRequest.mockResolvedValue(ok({ content: 'x' }, { usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } }))
    const res = await llm.chat({ messages: [] })
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500, durationMs: expect.any(Number) })
  })

  test('missing numbers stay null; a missing total is the sum', () => {
    expect(llm.normalizeUsage({}, 5)).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 5 })
    expect(llm.normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 }, 1)).toMatchObject({ totalTokens: 12 })
  })
})
