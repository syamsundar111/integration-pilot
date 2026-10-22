/**
 * Header and property types (system prompt review, item 3): `expression` only when the value
 * contains ${...}; a plain value is a constant. normalizeTypes fixes the spec and reports it; the
 * builder writes constant for a plain value even if a spec says expression.
 */
const JSZip = require('jszip')
const { normalizeTypes, validate } = require('../srv/iflow-builder/validator')
const { build } = require('../srv/iflow-builder/builder')
const { baseSpec } = require('./helpers')

const spec = baseSpec({
  steps: [
    {
      type: 'contentModifier',
      name: 'Set Values',
      headers: [{ name: 'Content-Type', type: 'expression', value: 'application/json' }],
      properties: [
        { name: 'Source', type: 'expression', value: 'Shop' },
        { name: 'Received', type: 'expression', value: "${date:now:yyyy-MM-dd}" },
        { name: 'Target', type: 'constant', value: 'ERP' }
      ]
    }
  ],
  exceptionSubprocess: { steps: [{ type: 'contentModifier', name: 'Set Error', properties: [{ name: 'Code', type: 'expression', value: '500' }] }] }
})

describe('header and property types', () => {
  test('an expression without ${...} becomes a constant, and the fix is reported', () => {
    const { spec: fixed, fixes } = normalizeTypes(spec)
    expect(fixed.steps[0].headers).toEqual([{ name: 'Content-Type', type: 'constant', value: 'application/json' }])
    expect(fixed.steps[0].properties.map((p) => p.type)).toEqual(['constant', 'expression', 'constant'])
    expect(fixed.exceptionSubprocess.steps[0].properties[0].type).toBe('constant')
    expect(fixes).toEqual(['Set Values: header Content-Type', 'Set Values: property Source', 'Set Error: property Code'])
    expect(validate(fixed)).toMatchObject({ valid: true })
    expect(spec.steps[0].properties[0].type).toBe('expression') // the input is not changed
  })

  test('a spec that is already right is returned unchanged', () => {
    const { spec: once } = normalizeTypes(spec)
    expect(normalizeTypes(once)).toEqual({ spec: once, fixes: [] })
  })

  test('the builder writes constant for a plain value even if the spec says expression', async () => {
    const zip = await JSZip.loadAsync(Buffer.from((await build(spec)).zipBase64, 'base64'))
    const iflw = await zip.file(/\.iflw$/)[0].async('string')
    const typeOf = (name) => iflw.match(new RegExp(`&lt;cell id='Type'&gt;(\\w+)&lt;/cell&gt;&lt;cell id='Value'&gt;[^&]*&lt;/cell&gt;&lt;cell id='Default'&gt;&lt;/cell&gt;&lt;cell id='Name'&gt;${name}&lt;`))?.[1]
    expect(typeOf('Source')).toBe('constant')
    expect(typeOf('Content-Type')).toBe('constant')
    expect(typeOf('Received')).toBe('expression')
  })
})
