/**
 * Fidelity against the CPI exports: building a spec equivalent to Reference_AllSteps
 * must reproduce SAP's XML — same elements, same ifl:property keys/values in the same
 * order — differing only in generated ids and diagram coordinates.
 */
const JSZip = require('jszip')
const { build } = require('../srv/iflow-builder/builder')
const { readRef, allStepsSpec, unzip, parseXml, all, elements, propList } = require('./helpers')

const NOW = new Date('2026-10-10T13:05:46Z') // the reference export's timestamp

async function referenceFiles(zipName) {
  const zip = await JSZip.loadAsync(readRef(zipName))
  const files = {}
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) files[name] = await entry.async('string')
  return files
}

/** Element signature independent of ids/layout: tag, name, ifl:type, ordered properties */
function signature(doc, local) {
  return all(doc, local)
    .map((el) => ({ tag: el.localName, name: el.getAttribute('name'), iflType: el.getAttribute('ifl:type') || null, props: propList(el) }))
    .sort((a, b) => (a.name + JSON.stringify(a.props)).localeCompare(b.name + JSON.stringify(b.props)))
}

describe('fidelity with Reference_AllSteps.zip', () => {
  let ref, gen, refDoc, genDoc

  beforeAll(async () => {
    ref = await referenceFiles('Reference_AllSteps.zip')
    gen = await unzip((await build(await allStepsSpec(), { now: NOW })).zipBase64)
    const iflw = 'src/main/resources/scenarioflows/integrationflow/Reference_AllSteps.iflw'
    refDoc = parseXml(ref[iflw])
    genDoc = parseXml(gen[iflw])
  })

  test('same file list', () => {
    expect(Object.keys(gen).sort()).toEqual(Object.keys(ref).sort())
  })

  test.each(['META-INF/MANIFEST.MF', '.project', 'metainfo.prop', 'src/main/resources/parameters.prop', 'src/main/resources/parameters.propdef', 'src/main/resources/script/script1.groovy'])(
    '%s is byte-identical',
    (file) => expect(gen[file]).toBe(ref[file])
  )

  test('collaboration and process settings are identical', () => {
    for (const local of ['collaboration', 'process']) expect(propList(all(genDoc, local)[0])).toEqual(propList(all(refDoc, local)[0]))
  })

  test.each(['participant', 'messageFlow', 'startEvent', 'endEvent', 'callActivity', 'serviceTask'])('%s elements match (properties, order, values)', (local) => {
    expect(signature(genDoc, local)).toEqual(signature(refDoc, local))
  })

  test('same number of sequence flows, shapes and edges', () => {
    for (const local of ['sequenceFlow', 'BPMNShape', 'BPMNEdge']) expect(all(genDoc, local)).toHaveLength(all(refDoc, local).length)
  })

  test('the message start/end events keep their event definitions', () => {
    for (const local of ['startEvent', 'endEvent'])
      expect(elements(all(genDoc, local)[0]).map((e) => e.localName)).toEqual(elements(all(refDoc, local)[0]).map((e) => e.localName))
  })
})

describe('fidelity with Reference_Timer.zip', () => {
  test('timer start event matches the reference', async () => {
    const ref = await referenceFiles('Reference_Timer.zip')
    const spec = { id: 'Reference_Timer', name: 'Reference_Timer', packageId: 'PilotReference', trigger: { type: 'timer', mode: 'once' }, steps: [{ type: 'contentModifier' }], end: { type: 'none' } }
    const gen = await unzip((await build(spec, { now: new Date('2026-10-10T13:15:05Z') })).zipBase64)
    const iflw = 'src/main/resources/scenarioflows/integrationflow/Reference_Timer.iflw'
    const refDoc = parseXml(ref[iflw])
    const genDoc = parseXml(gen[iflw])
    const timerProps = (doc) => propList(all(doc, 'timerEventDefinition')[0])
    expect(timerProps(genDoc)).toEqual(timerProps(refDoc))
    expect(all(genDoc, 'startEvent')[0].getAttribute('name')).toBe('Start Timer 1')
    expect(signature(genDoc, 'callActivity')).toEqual(signature(refDoc, 'callActivity'))
    expect(signature(genDoc, 'endEvent')).toEqual(signature(refDoc, 'endEvent'))
    for (const f of ['META-INF/MANIFEST.MF', '.project', 'metainfo.prop', 'src/main/resources/parameters.prop', 'src/main/resources/parameters.propdef'])
      expect(gen[f]).toBe(ref[f])
  })
})
