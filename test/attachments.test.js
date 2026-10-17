/**
 * Attached files in specs: validation, injection by the builder, and the way back
 * (parser + to-spec) for existing iFlows with XSLT files.
 */
const JSZip = require('jszip')
const { validate } = require('../srv/iflow-builder/validator')
const { build, injectAttachments } = require('../srv/iflow-builder/builder')
const { parse } = require('../srv/iflow-builder/parser')
const { specFromParsed } = require('../srv/iflow-builder/to-spec')
const { referencedBy, check } = require('../srv/lib/attachments')
const { baseSpec, GROOVY } = require('./helpers')

const XSL = '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><out/></xsl:template></xsl:stylesheet>'
const attachments = { 'mapUsers.groovy': GROOVY, 'transform.xsl': XSL }
const spec = baseSpec({
  steps: [{ type: 'groovyScript', name: 'Map Users', fileName: 'mapUsers' }],
  exceptionSubprocess: { steps: [{ type: 'groovyScript', name: 'Inline', fileName: 'inline', code: GROOVY }] },
  resources: ['transform.xsl']
})

describe('attachments', () => {
  test('a script without code needs an attached file; attached files must not get code', () => {
    expect(validate(spec, { attachments: Object.keys(attachments) })).toMatchObject({ valid: true })
    const missing = validate(spec).issues
    expect(missing.map((i) => i.code)).toEqual(['ATTACHMENT_MISSING', 'ATTACHMENT_MISSING'])
    expect(missing[0].message).toMatch(/steps\[0\]: no code and no attached file 'mapUsers.groovy'/)
    expect(missing[1].message).toMatch(/resources\[0\]: 'transform.xsl' is not an attached file/)
    const retyped = { ...spec, steps: [{ ...spec.steps[0], code: GROOVY }] }
    expect(validate(retyped, { attachments: Object.keys(attachments) }).issues).toEqual([expect.objectContaining({ code: 'ATTACHED_CODE' })])
  })

  test('the builder injects attached scripts and XSLT files', async () => {
    const { zipBase64 } = await build(spec, { attachments })
    const zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
    expect(await zip.file('src/main/resources/script/mapUsers.groovy').async('string')).toBe(GROOVY)
    expect(await zip.file('src/main/resources/script/inline.groovy').async('string')).toBe(GROOVY)
    expect(await zip.file('src/main/resources/mapping/transform.xsl').async('string')).toBe(XSL)
    await expect(build(spec)).rejects.toMatchObject({ code: 'INVALID_SPEC' })
    expect(injectAttachments(spec, attachments).steps[0].code).toBe(GROOVY)
    expect(referencedBy(spec)).toEqual(['mapUsers.groovy', 'transform.xsl'])
  })

  test('an iFlow with an XSLT file converts back to a spec with resources', async () => {
    const { zipBase64 } = await build(spec, { attachments })
    const back = specFromParsed(await parse(zipBase64), { packageId: 'PilotReference' })
    expect(back.blockers).toEqual([])
    expect(back.spec.resources).toEqual(['transform.xsl'])
    expect(back.resources).toEqual({ 'transform.xsl': XSL })
    expect(back.spec.steps[0]).toMatchObject({ fileName: 'mapUsers', code: GROOVY })
  })

  test('file names and sizes are checked', () => {
    expect(check({ fileName: 'mapUsers.groovy', content: GROOVY })).toMatchObject({ kind: 'groovy', lines: GROOVY.split('\n').length })
    expect(() => check({ fileName: 'map-users.groovy', content: GROOVY })).toThrow(/name it like mapUsers.groovy/)
    expect(() => check({ fileName: 'notes.txt', content: 'x' })).toThrow(/only .groovy and .xsl/)
    expect(() => check({ fileName: 'big.xsl', content: 'x'.repeat(210 * 1024) })).toThrow(/at most 200 KB/)
    expect(() => check({ fileName: 'empty.groovy', content: ' ' })).toThrow(/empty/)
  })
})
