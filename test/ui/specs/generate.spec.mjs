/**
 * Generate page (and the usage panel on Activity) against the faked backend: request template,
 * pre-send warnings, session defaults, attachments, import, proposal panel (approve, reject with
 * reason, package selection) and the token usage display.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const API = `http://localhost:${process.env.UI_TEST_PORT || 4011}/api`
const VIEW = 'integration.pilot.view.Generate'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-ui-'))
const GROOVY = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sf-entra', 'buildErrorNotification.groovy'), 'utf8')

// --- helpers ------------------------------------------------------------------------------------

// forceSelect: controls are re-rendered between tests; never use a cached reference
const control = (id) => browser.asControl({ forceSelect: true, selector: { id, viewName: VIEW } })
const text = (value, viewName = VIEW) => browser.asControl({ forceSelect: true, selector: { controlType: 'sap.m.Text', viewName, properties: { text: value } } })
/** A button by text; inDialog: only inside an open dialog (the page may have a button with the same text) */
const button = (text, inDialog = false) =>
  browser.asControl({
    forceSelect: true,
    selector: { controlType: 'sap.m.Button', properties: { text }, ...(inDialog ? { searchOpenDialogs: true, ancestor: { controlType: 'sap.m.Dialog' } } : { viewName: VIEW }) }
  })

/** The Generate view's chat model, read in the browser */
const chat = (property) =>
  browser.execute((viewName, p) => {
    const view = sap.ui.require('sap/ui/core/ElementRegistry').filter((e) => e.getViewName && e.getViewName() === viewName)[0]
    return JSON.parse(JSON.stringify(view.getModel('chat').getProperty(p) ?? null))
  }, VIEW, property)

const api = async (p) => (await fetch(API + p)).json()

async function newChat() {
  await browser.goTo({ sHash: '#/generate' })
  await (await browser.asControl({ selector: { id: 'sessionButton', viewName: VIEW } })).firePress()
  await browser.waitUntil(async () => (await chat('/messages')).length === 0 && !(await chat('/sessionId')))
}

async function type(text) {
  await (await control('input')).setValue(text)
}

async function pressSend() {
  await (await browser.asControl({ selector: { controlType: 'sap.m.Button', viewName: VIEW, properties: { icon: 'sap-icon://paper-plane' } } })).press()
}

/** Waits until the running turn is over and the answer is in the chat */
async function waitForAnswer(count = 1) {
  await browser.waitUntil(async () => !(await chat('/turn')) && (await chat('/messages')).filter((m) => m.kind !== 'user').length >= count, {
    timeout: 60000,
    timeoutMsg: 'no answer from the assistant'
  })
}

/** Texts of the warnings in the open "Check your request" dialog */
async function warningTexts() {
  const strips = await browser.allControls({ selector: { controlType: 'sap.m.MessageStrip', searchOpenDialogs: true, properties: { type: 'Warning' } } })
  return Promise.all(strips.map((s) => s.getText()))
}

async function setFile(acceptPart, file) {
  for (const input of await $$('input[type="file"]')) {
    if ((await input.getAttribute('accept'))?.includes(acceptPart)) {
      await input.setValue(file)
      return
    }
  }
  throw new Error(`no file input accepting ${acceptPart}`)
}

async function proposal(prompt) {
  await type(`${prompt} Create an iFlow on a timer, run once, in package PilotReference, no authentication.`)
  await pressSend()
  await waitForAnswer()
  await browser.waitUntil(async () => (await chat('/active'))?.status === 'PENDING', { timeoutMsg: 'no pending proposal' })
}

// --- tests ----------------------------------------------------------------------------------------

describe('Generate page', () => {
  before(async () => {
    await browser.goTo({ sHash: '#/generate' })
  })

  it('fills the composer with the request template', async () => {
    await newChat()
    await (await button('Start from the request template')).press()
    const input = await chat('/input')
    expect(input).toMatch(/^Create an iFlow\.\nTrigger: </)
    for (const field of ['Steps', 'Receivers', 'Authentication', 'Package', 'Error handling']) expect(input).toContain(`${field}`)
  })

  it('warns before sending; Edit keeps the text, Send anyway sends', async () => {
    await newChat()
    const request = 'Create an iFlow that posts the order to https://example.org/orders'
    await type(request)
    await pressSend()
    const warnings = await warningTexts()
    expect(warnings).toHaveLength(3)
    expect(warnings.join('\n')).toMatch(/No target package[\s\S]*No trigger[\s\S]*No authentication info/)

    await (await button('Edit', true)).press()
    expect(await chat('/input')).toBe(request)
    expect(await chat('/messages')).toHaveLength(0)

    await pressSend()
    await (await button('Send anyway', true)).press()
    await waitForAnswer()
    const messages = await chat('/messages')
    expect(messages[0].kind).toBe('user')
    expect(messages[1].html).toContain('Fake answer to: Create an iFlow that posts')
  })

  it('session defaults silence the warnings and are stored on the session', async () => {
    await newChat()
    const panel = await control('defaultsPanel')
    await panel.setExpanded(true)
    await (await control('defaultPackage')).setValue('PilotReference')
    await (await control('defaultTimer')).setSelectedKey('once')
    await (await control('defaultAuth')).setValue('No authentication')
    await type('Create an iFlow that posts the order to https://example.org/orders')
    await pressSend()
    await waitForAnswer() // no warning dialog in between
    const session = await api(`/ChatSessions/${await chat('/sessionId')}`)
    expect(JSON.parse(session.defaults)).toEqual({ packageId: 'PilotReference', timer: 'once', authNote: 'No authentication' })
    await panel.setExpanded(false)
  })

  it('attaches a Groovy file, sends it with the message and removes it', async () => {
    await newChat()
    const file = path.join(TMP, 'mapUsers.groovy')
    fs.writeFileSync(file, GROOVY)
    await setFile('groovy', file)
    await browser.waitUntil(async () => (await chat('/files')).length === 1)
    expect(await chat('/files')).toEqual([expect.objectContaining({ fileName: 'mapUsers.groovy', pending: true })])
    const token = await browser.asControl({ selector: { controlType: 'sap.m.Token', viewName: VIEW } })
    expect(await token.getText()).toBe('mapUsers.groovy · sent with your next message')

    await type('Use the attached script.')
    await pressSend()
    await waitForAnswer()
    await browser.waitUntil(async () => (await chat('/files'))[0]?.pending === false, { timeoutMsg: 'attachment not stored' })
    const sessionId = await chat('/sessionId')
    expect(await api(`/Attachments?$filter=session_ID eq ${sessionId}`)).toEqual([expect.objectContaining({ fileName: 'mapUsers.groovy', lines: GROOVY.split('\n').length })])

    await $('.ipFiles .sapMTokenIcon').click()
    await browser.waitUntil(async () => (await chat('/files')).length === 0, { timeoutMsg: 'attachment not removed' })
    expect(await api(`/Attachments?$filter=session_ID eq ${sessionId}`)).toEqual([])
  })

  it('imports an iFlow zip as the draft spec', async () => {
    await newChat()
    const { build } = require(path.join(ROOT, 'srv', 'iflow-builder', 'builder.js'))
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sf-entra', 'spec.json'), 'utf8'))
    const attachments = Object.fromEntries(
      ['mapSfToEntra.groovy', 'buildErrorNotification.groovy'].map((f) => [f, fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sf-entra', f), 'utf8')])
    )
    const zip = path.join(TMP, 'sf-entra.zip')
    fs.writeFileSync(zip, Buffer.from((await build(spec, { attachments })).zipBase64, 'base64'))
    await setFile('zip', zip)
    await browser.waitUntil(async () => (await chat('/messages')).some((m) => m.html.includes('Imported')), { timeout: 30000, timeoutMsg: 'no import summary' })
    expect(await chat('/input')).toBe('Propose the imported iFlow as a new iFlow.')
    await browser.waitUntil(async () => (await chat('/files')).length === 2)
  })

  it('approves a proposal', async () => {
    await newChat()
    await proposal('UITEST_PROPOSE')
    expect((await chat('/active')).title).toBe('UI Test Flow')
    await (await button('Approve & create')).press()
    await (await button('Approve & create', true)).press()
    await browser.waitUntil(async () => (await chat('/active'))?.status === 'DONE', { timeout: 30000, timeoutMsg: 'proposal not executed' })
    expect((await chat('/active')).doneText).toMatch(/^Created UI_Test_/)
  })

  it('shows each script as checked, and asks before approving without the check', async () => {
    await newChat()
    await proposal('UITEST_PROPOSE')
    expect((await chat('/active')).scripts).toEqual([expect.objectContaining({ fileName: 'addLengthHeader.groovy', checkText: 'Syntax checked: no errors', checkState: 'Success' })])
    expect((await chat('/active')).groovyText).toBe('')

    await newChat()
    await proposal('UITEST_UNCHECKED')
    const active = await chat('/active')
    expect(active.scripts[0]).toMatchObject({ checkText: 'Not checked: fetch failed (ECONNREFUSED) at http://localhost:4010', checkState: 'Warning' })
    expect(active.groovyText).toMatch(/^1 Groovy script\(s\) were not syntax-checked/)
    const strip = await browser.asControl({ forceSelect: true, selector: { controlType: 'sap.m.MessageStrip', viewName: VIEW, properties: { text: active.groovyText } } })
    expect(await strip.getVisible()).toBe(true)
    expect(await strip.getType()).toBe('Warning')

    await (await button('Approve & create')).press()
    await (await button('Approve & create', true)).press()
    await (await button('Approve without the check', true)).press()
    await browser.waitUntil(async () => (await chat('/active'))?.status === 'DONE', { timeout: 30000, timeoutMsg: 'not executed' })
    const steps = (await chat('/active')).execSteps
    expect(steps[0]).toMatchObject({ label: 'Check Groovy scripts', status: 'warning' })
  })

  it('rejects a proposal with a reason', async () => {
    await newChat()
    await proposal('UITEST_PROPOSE')
    await (await button('Reject')).press()
    const reason = await browser.asControl({ selector: { controlType: 'sap.m.TextArea', searchOpenDialogs: true } })
    await reason.setValue('wrong receiver URL')
    await (await button('Reject', true)).press()
    await browser.waitUntil(async () => (await chat('/active'))?.status === 'REJECTED', { timeoutMsg: 'not rejected' })
    expect((await chat('/active')).rejectedText).toBe('Rejected: wrong receiver URL')
  })

  it('asks for a package when the proposed one does not exist', async () => {
    await newChat()
    await type('UITEST_NEWPKG Create an iFlow on a timer, run once, in package Ui.New.Package, no authentication.')
    await pressSend()
    await waitForAnswer()
    await browser.waitUntil(async () => (await chat('/active'))?.needsPackage === true, { timeoutMsg: 'no package question' })
    expect((await chat('/active')).packageHeading).toBe('Package "Ui.New.Package" does not exist on the tenant')
    expect(await (await button('Approve & create')).getEnabled()).toBe(false)

    await (await browser.asControl({ selector: { controlType: 'sap.m.RadioButton', viewName: VIEW, properties: { text: 'Create a new package' } } })).setSelected(true)
    await (await control('newPkgName')).setValue('UI New Package')
    await (await control('newPkgId')).setValue('Ui.New.Package')
    await (await button('Create on approval')).press()
    await browser.waitUntil(async () => (await chat('/active'))?.needsPackage === false, { timeoutMsg: 'package not set' })
    expect((await chat('/active')).packageSummary).toContain('UI New Package')
    expect(await (await button('Approve & create')).getEnabled()).toBe(true)
  })

  it('shows token usage per answer, per conversation and on the Activity page', async () => {
    await newChat()
    await proposal('UITEST_PROPOSE')
    const answer = (await chat('/messages')).find((m) => m.kind === 'assistant')
    expect(answer.usageText).toBe('3 model calls · 3.0k in / 300 out tokens · 0 s · 1 % of budget · fake/model')
    expect(await (await text('This conversation: 1 request · 3.3k tokens (3.0k in / 300 out) · 3 model calls')).getVisible()).toBe(true)

    await browser.goTo({ sHash: '#/activity' })
    const ACTIVITY = 'integration.pilot.view.Activity'
    await browser.waitUntil(async () => (await (await text('fake/model', ACTIVITY)).getText?.()) === 'fake/model', { timeoutMsg: 'no usage per model' })
    const usage = await api('/usage(days=30)')
    expect(usage.totals.requests).toBeGreaterThanOrEqual(1)
    const modelCalls = await browser.asControl({ forceSelect: true, selector: { controlType: 'sap.m.Title', viewName: ACTIVITY, properties: { text: String(usage.totals.modelCalls) } } })
    expect(await modelCalls.getVisible()).toBe(true)
  })
})
