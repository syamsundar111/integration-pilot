const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const { DOMParser } = require('@xmldom/xmldom')

const REF_DIR = path.join(__dirname, '..', 'srv', 'iflow-builder', 'reference')
const readRef = (name) => fs.readFileSync(path.join(REF_DIR, name))

const GROOVY = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    message.setHeader('X-Test', 'yes')
    return message
}
`

/** Minimal valid spec; override parts per test */
const baseSpec = (overrides = {}) => ({
  id: 'Test_Flow',
  name: 'Test Flow',
  packageId: 'PilotReference',
  trigger: { type: 'httpsSender', address: '/test/flow' },
  steps: [],
  end: { type: 'none' },
  ...overrides
})

/** Spec equivalent to Reference_AllSteps.zip (same values as the CPI export) */
async function allStepsSpec() {
  const zip = await JSZip.loadAsync(readRef('Reference_AllSteps.zip'))
  const code = await zip.file('src/main/resources/script/script1.groovy').async('string')
  return {
    id: 'Reference_AllSteps',
    name: 'Reference_AllSteps',
    packageId: 'PilotReference',
    trigger: { type: 'httpsSender', address: '/pilot/reference' },
    steps: [
      {
        type: 'contentModifier',
        headers: [{ name: 'Source', type: 'constant', value: 'Pilot' }],
        properties: [{ name: 'OrderId', type: 'expression', value: '${header.Source}' }],
        body: '{"hello":"world"}'
      },
      { type: 'groovyScript', fileName: 'script1', code },
      { type: 'jsonToXml' },
      { type: 'xmlToJson' },
      { type: 'requestReplyHttp', system: 'Receiver1', url: '{{TargetURL}}', method: 'POST', authType: 'None' }
    ],
    end: { type: 'httpReceiver', url: '{{FinalURL}}', method: 'POST', authType: 'None' },
    parameters: { TargetURL: 'https://httpbin.org/post', FinalURL: 'https://httpbin.org/post' }
  }
}

async function unzip(base64OrBuffer) {
  const zip = await JSZip.loadAsync(Buffer.isBuffer(base64OrBuffer) ? base64OrBuffer : Buffer.from(base64OrBuffer, 'base64'))
  const files = {}
  for (const [name, entry] of Object.entries(zip.files)) files[name] = entry.dir ? null : await entry.async('string')
  return files
}

function parseXml(xml) {
  const errors = []
  const doc = new DOMParser({ onError: (level, msg) => level !== 'warning' && errors.push(msg) }).parseFromString(xml, 'text/xml')
  if (errors.length) throw new Error(`XML not well-formed: ${errors.join('; ')}`)
  return doc
}

const elements = (node) => [...(node?.childNodes || [])].filter((n) => n.nodeType === 1)
const all = (doc, local) => [...doc.getElementsByTagName('*')].filter((e) => e.localName === local)

/** ifl:property pairs of an element, in document order */
function propList(el) {
  const ext = elements(el).find((e) => e.localName === 'extensionElements')
  return elements(ext)
    .filter((e) => e.localName === 'property')
    .map((p) => {
      const [k, v] = elements(p)
      return [k.textContent, v ? v.textContent : '']
    })
}

module.exports = { readRef, GROOVY, baseSpec, allStepsSpec, unzip, parseXml, elements, all, propList }
