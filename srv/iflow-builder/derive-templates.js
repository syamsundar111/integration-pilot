/**
 * Derives the builder templates in ./templates from the exported reference iFlows
 * in ./reference (the source of truth). Run: npm run templates:derive
 *
 * Snippets are cut out of the reference XML by element id, keeping SAP's exact
 * formatting, property keys, cmdVariantUri and componentVersion values. Only the
 * values that vary per iFlow are replaced with {{PLACEHOLDER}} tokens:
 *   {{X}}        plain (already escaped) text
 *   {{X_VALUE}}  a complete <value>…</value> or <value/> element
 * Every replacement must match exactly once, so a changed reference fails loudly.
 */
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

const REF_DIR = path.join(__dirname, 'reference')
const OUT_DIR = path.join(__dirname, 'templates')
// Templates without a reference export: kept as they are (see the end of main())
const HAND_WRITTEN = ['iflw/subprocess-exception.xml', 'iflw/start-error.xml']

async function readZip(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(REF_DIR, file)))
  const files = {}
  for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) files[name] = await zip.files[name].async('string')
  const iflw = Object.keys(files).find((f) => f.endsWith('.iflw'))
  return { files, iflw: files[iflw] }
}

/** Lines of the element whose opening tag contains `anchor`, up to its closing tag (same indentation). */
function block(xml, anchor) {
  const lines = xml.split('\n')
  const start = lines.findIndex((l) => l.includes(anchor))
  if (start < 0) throw new Error(`Anchor not found: ${anchor}`)
  const open = lines[start]
  const indent = open.match(/^\s*/)[0]
  if (/\/>\s*$/.test(open)) return open + '\n'
  const tag = open.trim().match(/^<([\w:]+)/)[1]
  const end = lines.findIndex((l, i) => i > start && l === `${indent}</${tag}>`)
  if (end < 0) throw new Error(`Closing tag not found for: ${anchor}`)
  return lines.slice(start, end + 1).join('\n') + '\n'
}

/** Text between two anchors (inclusive of the start line, exclusive of the end line). */
function between(xml, startAnchor, endAnchor) {
  const lines = xml.split('\n')
  const s = lines.findIndex((l) => l.includes(startAnchor))
  const e = lines.findIndex((l, i) => i > s && l.includes(endAnchor))
  if (s < 0 || e < 0) throw new Error(`Range not found: ${startAnchor} .. ${endAnchor}`)
  return lines.slice(s, e).join('\n') + '\n'
}

function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one "${from}", found ${count}`)
  return text.replace(from, () => to)
}

/** Replaces the <value> of the ifl:property with the given key by {{PLACEHOLDER}} */
function prop(text, key, placeholder, label) {
  const re = new RegExp(`(<key>${key}</key>\\s*)<value(?:/>|>[^<]*</value>)`, 'g')
  const count = (text.match(re) || []).length
  if (count !== 1) throw new Error(`${label}: expected exactly one property "${key}", found ${count}`)
  return text.replace(re, (_, k) => `${k}{{${placeholder}}}`)
}

function apply(text, label, { attrs = {}, props = {}, texts = [] } = {}) {
  for (const [from, to] of Object.entries(attrs)) text = replaceOnce(text, from, to, label)
  for (const [key, ph] of Object.entries(props)) text = prop(text, key, ph, label)
  for (const [from, to] of texts) text = replaceOnce(text, from, to, label)
  return text
}

// Dropdown fields whose values the builder writes, per component: the component's elements (matched by
// cmdVariantUri) and its (field, value) pairs. Only values seen in the reference exports are allowed
// (validator), see referenceValues().
const unescape = (v) => String(v || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const tableRows = (v) => [...unescape(v).matchAll(/<row>(.*?)<\/row>/g)].map((r) => [...r[1].matchAll(/<cell(?: id='([^']*)')?>([^<]*)<\/cell>/g)].map((c) => ({ id: c[1], value: c[2] })))
const VALUE_FIELDS = {
  'HTTP Receiver': {
    variant: /cname::(?:sap:)?HTTP\/tp::HTTP\/mp::None\/direction::Receiver\//,
    values: (p) => [['authenticationMethod', p.authenticationMethod], ['proxyType', p.proxyType]]
  },
  // header and property rows: source type, and the data type when one is set
  'Content Modifier': {
    variant: /cname::Enricher\//,
    values: (p) =>
      [...tableRows(p.headerTable), ...tableRows(p.propertyTable)].flatMap((cells) => {
        const cell = (id) => cells.find((c) => c.id === id)?.value ?? ''
        return [['sourceType', cell('Type')], ...(cell('Datatype') ? [['datatype', cell('Datatype')]] : [])]
      })
  },
  // variable rows: name, data type, type, value, scope
  'Write Variables': {
    variant: /cname::Variables\//,
    values: (p) => tableRows(p.variable).flatMap((c) => [['type', c[2]?.value], ['scope', c[4]?.value], ...(c[1]?.value ? [['datatype', c[1].value]] : [])])
  },
  // the route of a router: its condition type (XML, NonXML)
  Router: {
    variant: /cname::GatewayRoute\//,
    values: (p) => [['expressionType', p.expressionType]]
  },
  // an Escalation End: its category (ErrorCode: Others, RoutingConditionNotMet, ReceiverNotFound, ...)
  'Escalation End': {
    variant: /cname::EscalationEndEvent\//,
    values: (p) => [['category', p.ErrorCode]]
  },
  // the schedule of a timer start: repeat (NONE, MINUTES, ...) and, when repeating, the interval
  Timer: {
    variant: /cname::intermediatetimer\//,
    values: (p) => {
      const schedule = unescape(Object.fromEntries(tableRows(p.scheduleKey).map((c) => [c[0]?.value, c[1]?.value])).schedule1)
      const get = (k) => schedule.match(new RegExp(`(?:^|&)${k.replace('.', '\\.')}=([^&]*)`))?.[1]
      return [['repeat', get('simple.repeat')], ['every', get('simple.every')], ['timeZone', get('trigger.timeZone')]].filter(([, v]) => v != null)
    }
  }
}

/**
 * The values of VALUE_FIELDS in all reference exports:
 * { component: { field: { value: { references: [reference, ...], confirmed?: note } } } }, one reference
 * entry per use of the value. confirmed comes from reference/confirmed-values.json (re-selected in the
 * CPI editor); an unconfirmed value seen once is a warning in the validator.
 */
async function referenceValues() {
  const out = Object.fromEntries(Object.keys(VALUE_FIELDS).map((c) => [c, {}]))
  for (const file of fs.readdirSync(REF_DIR).filter((f) => f.endsWith('.zip')).sort()) {
    const { iflw } = await readZip(file)
    if (!iflw) continue // e.g. a Message Mapping artifact
    for (const [element] of iflw.matchAll(/<bpmn2:(messageFlow|callActivity|startEvent|sequenceFlow|endEvent)\b[^>]*[^/]>[\s\S]*?<\/bpmn2:\1>/g)) {
      const props = Object.fromEntries([...element.matchAll(/<key>([^<]*)<\/key>\s*(?:<value>([^<]*)<\/value>|<value\/>)/g)].map((m) => [m[1], m[2] ?? '']))
      for (const [component, { variant, values }] of Object.entries(VALUE_FIELDS)) {
        if (!variant.test(props.cmdVariantUri || '')) continue
        for (const [field, value] of values(props)) if (value != null) ((out[component][field] ??= {})[value] ??= { references: [] }).references.push(file.replace(/\.zip$/, ''))
      }
    }
  }
  const confirmed = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'confirmed-values.json'), 'utf8'))
  for (const [adapter, keys] of Object.entries(confirmed).filter(([a]) => !a.startsWith('_')))
    for (const [k, values] of Object.entries(keys))
      for (const [value, note] of Object.entries(values)) {
        const entry = out[adapter]?.[k]?.[value]
        if (!entry) throw new Error(`confirmed-values.json: ${adapter} ${k} '${value}' is in no reference export`)
        entry.confirmed = note
      }
  return out
}

async function main() {
  const all = await readZip('Reference_AllSteps.zip')
  const timer = await readZip('Reference_Timer.zip')
  const x = all.iflw
  const t = {}

  // --- iflw skeleton -------------------------------------------------------
  const head = between(x, '<?xml', '<bpmn2:participant id="Participant_1"')
  const processParticipant = block(x, 'id="Participant_Process_1"')
  const processHead = between(x, '<bpmn2:process id="Process_1"', '<bpmn2:callActivity id="CallActivity_8"')
  const diagramHead = between(x, '<bpmndi:BPMNDiagram', '<bpmndi:BPMNShape bpmnElement="EndEvent_2"')
  t['iflw/definitions.xml'] =
    head +
    '{{PARTICIPANTS}}' +
    processParticipant +
    '{{MESSAGE_FLOWS}}' +
    '    </bpmn2:collaboration>\n' +
    processHead +
    '{{PROCESS_ELEMENTS}}' +
    '{{SEQUENCE_FLOWS}}' +
    '    </bpmn2:process>\n' +
    diagramHead +
    '{{SHAPES}}' +
    '{{EDGES}}' +
    '        </bpmndi:BPMNPlane>\n    </bpmndi:BPMNDiagram>\n</bpmn2:definitions>'

  // --- participants ----------------------------------------------------------
  t['iflw/participant-sender.xml'] = apply(block(x, 'id="Participant_1"'), 'participant-sender', {
    attrs: { 'id="Participant_1"': 'id="{{ID}}"', 'name="Sender"': 'name="{{NAME}}"' }
  })
  t['iflw/participant-receiver.xml'] = apply(block(x, 'id="Participant_2"'), 'participant-receiver', {
    attrs: { 'id="Participant_2"': 'id="{{ID}}"', 'name="Receiver"': 'name="{{NAME}}"' }
  })

  // --- adapters (message flows) ---------------------------------------------
  t['iflw/messageflow-https-sender.xml'] = apply(block(x, 'id="MessageFlow_4"'), 'https-sender', {
    attrs: { 'id="MessageFlow_4"': 'id="{{ID}}"', 'sourceRef="Participant_1"': 'sourceRef="{{SOURCE}}"', 'targetRef="StartEvent_2"': 'targetRef="{{TARGET}}"' },
    props: { urlPath: 'ADDRESS_VALUE', system: 'SYSTEM_VALUE' }
  })
  t['iflw/messageflow-http-receiver.xml'] = apply(block(x, 'id="MessageFlow_22"'), 'http-receiver', {
    attrs: { 'id="MessageFlow_22"': 'id="{{ID}}"', 'sourceRef="ServiceTask_18"': 'sourceRef="{{SOURCE}}"', 'targetRef="Participant_21"': 'targetRef="{{TARGET}}"' },
    props: {
      httpMethod: 'METHOD_VALUE',
      system: 'SYSTEM_VALUE',
      httpAddressWithoutQuery: 'ADDRESS_VALUE',
      httpAddressQuery: 'ADDRESS_QUERY_VALUE',
      authenticationMethod: 'AUTH_METHOD_VALUE',
      credentialName: 'CREDENTIAL_NAME_VALUE',
      proxyType: 'PROXY_TYPE_VALUE',
      locationID: 'LOCATION_ID_VALUE',
      httpRequestTimeout: 'TIMEOUT_VALUE'
    }
  })

  // --- events ------------------------------------------------------------------
  t['iflw/start-message.xml'] = apply(block(x, 'id="StartEvent_2"'), 'start-message', {
    attrs: { 'id="StartEvent_2"': 'id="{{ID}}"', 'name="Start"': 'name="{{NAME}}"', '>SequenceFlow_3<': '>{{OUTGOING}}<' }
  })
  // the schedule (scheduleKey's schedule1, stored escaped twice) is a placeholder: timer-schedules.json
  const ONCE = 'simple.repeat=NONE&amp;amp;trigger.timeZone=Etc/GMT'
  t['iflw/start-timer.xml'] = apply(block(timer.iflw, 'id="StartEvent_4"'), 'start-timer', {
    attrs: {
      'id="StartEvent_4"': 'id="{{ID}}"',
      'name="Start Timer 1"': 'name="{{NAME}}"',
      '>SequenceFlow_8<': '>{{OUTGOING}}<',
      'id="TimerEventDefinition_21607"': 'id="{{TIMER_ID}}"'
    },
    texts: [[ONCE, '{{SCHEDULE}}']]
  })
  // "every N minutes" as the newer scheduler stores it (Ref_Router_Ends: Repeat Minutes, Every 15, Etc/GMT)
  const routerEnds = await readZip('Ref_Router_Ends.zip')
  const every = routerEnds.iflw.match(/schedule1&lt;\/cell&gt;&lt;cell&gt;(simple\.repeat=MINUTES&amp;amp;simple\.every=)15(&amp;amp;trigger\.timeZone=Etc\/GMT)&lt;/)
  if (!every) throw new Error('Ref_Router_Ends.zip: no "every 15 minutes" schedule')
  t['timer-schedules.json'] = JSON.stringify({ once: ONCE, everyMinutes: `${every[1]}{{MINUTES}}${every[2]}` }, null, 2) + '\n'
  t['iflw/end-message.xml'] = apply(block(x, 'id="EndEvent_2"'), 'end-message', {
    attrs: { 'id="EndEvent_2"': 'id="{{ID}}"', 'name="End"': 'name="{{NAME}}"', '>SequenceFlow_19<': '>{{INCOMING}}<' }
  })

  // --- steps ---------------------------------------------------------------------
  const step = (id, name, incoming, outgoing, props = {}) =>
    apply(block(x, `id="${id}"`), id, {
      attrs: { [`id="${id}"`]: 'id="{{ID}}"', [`name="${name}"`]: 'name="{{NAME}}"', [`>${incoming}<`]: '>{{INCOMING}}<', [`>${outgoing}<`]: '>{{OUTGOING}}<' },
      props
    })
  t['iflw/step-content-modifier.xml'] = step('CallActivity_5', 'Content Modifier 1', 'SequenceFlow_3', 'SequenceFlow_6', {
    bodyType: 'BODY_TYPE_VALUE',
    propertyTable: 'PROPERTY_TABLE_VALUE',
    headerTable: 'HEADER_TABLE_VALUE',
    wrapContent: 'BODY_VALUE'
  })
  // One row of headerTable/propertyTable, stored unescaped (the builder escapes it into the <value>)
  const headerTable = x.match(/<key>headerTable<\/key>\s*<value>([^<]*)<\/value>/)[1]
  const row = headerTable.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  t['content-modifier-row.xml'] = apply(row, 'content-modifier-row', {
    attrs: {
      "<cell id='Type'>constant</cell>": "<cell id='Type'>{{TYPE}}</cell>",
      "<cell id='Value'>Pilot</cell>": "<cell id='Value'>{{VALUE}}</cell>",
      "<cell id='Name'>Source</cell>": "<cell id='Name'>{{NAME}}</cell>",
      "<cell id='Default'></cell>": "<cell id='Default'>{{DEFAULT}}</cell>",
      "<cell id='Datatype'></cell>": "<cell id='Datatype'>{{DATATYPE}}</cell>"
    }
  })
  // Write Variables (Ref_Variables): the step, and one row of its variable table stored unescaped
  const variables = await readZip('Ref_Variables.zip')
  t['iflw/step-write-variables.xml'] = apply(block(variables.iflw, 'id="CallActivity_9"'), 'step-write-variables', {
    attrs: { 'id="CallActivity_9"': 'id="{{ID}}"', 'name="WV_Variables"': 'name="{{NAME}}"', '>SequenceFlow_8<': '>{{INCOMING}}<', '>SequenceFlow_9<': '>{{OUTGOING}}<' },
    props: { variable: 'VARIABLES_VALUE' }
  })
  const variableTable = variables.iflw.match(/<key>variable<\/key>\s*<value>([^<]*)<\/value>/)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  t['write-variables-row.xml'] = apply(variableTable.match(/<row>.*?<\/row>/g)[1], 'write-variables-row', {
    texts: [['<cell>DUMMY_LOCAL_VAR</cell><cell>java.lang.String</cell><cell>xpath</cell><cell>/root/value</cell><cell>local</cell>', '<cell>{{NAME}}</cell><cell>{{DATATYPE}}</cell><cell>{{TYPE}}</cell><cell>{{VALUE}}</cell><cell>{{SCOPE}}</cell>']]
  })

  // Router (Ref_Router_Ends): the gateway, a route with a condition, the default route (stored with its
  // expression type, as R_Other after re-saving), and the Escalation and Error End events
  const re = routerEnds.iflw
  t['iflw/router.xml'] = apply(block(re, 'id="ExclusiveGateway_11"'), 'router', {
    attrs: { 'default="SequenceFlow_11"': 'default="{{DEFAULT}}"', 'id="ExclusiveGateway_11"': 'id="{{ID}}"', 'name="RT_Xml"': 'name="{{NAME}}"', '>SequenceFlow_10<': '>{{INCOMING}}<' },
    texts: [['<bpmn2:outgoing>SequenceFlow_11</bpmn2:outgoing>\n            <bpmn2:outgoing>SequenceFlow_13</bpmn2:outgoing>', '<bpmn2:outgoing>{{OUTGOING}}</bpmn2:outgoing>']]
  })
  const conditionFlow = block(re, 'id="SequenceFlow_13"')
  const conditionId = conditionFlow.match(/id="(FormalExpression_SequenceFlow_13_\d+)"/)[1] // with an export timestamp
  t['iflw/route-condition.xml'] = apply(conditionFlow, 'route-condition', {
    attrs: {
      'id="SequenceFlow_13"': 'id="{{ID}}"',
      'name="R_TypeX"': 'name="{{NAME}}"',
      'sourceRef="ExclusiveGateway_11"': 'sourceRef="{{SOURCE}}"',
      'targetRef="CallActivity_14"': 'targetRef="{{TARGET}}"',
      [`id="${conditionId}"`]: 'id="{{CONDITION_ID}}"',
      ">/root/type = 'X'<": '>{{CONDITION}}<'
    },
    props: { expressionType: 'EXPRESSION_TYPE_VALUE' }
  })
  t['iflw/route-default.xml'] = apply(block(re, 'id="SequenceFlow_11"'), 'route-default', {
    attrs: { 'id="SequenceFlow_11"': 'id="{{ID}}"', 'name="R_Other"': 'name="{{NAME}}"', 'sourceRef="ExclusiveGateway_11"': 'sourceRef="{{SOURCE}}"', 'targetRef="CallActivity_15"': 'targetRef="{{TARGET}}"' },
    props: { expressionType: 'EXPRESSION_TYPE_VALUE' }
  })
  t['iflw/end-escalation.xml'] = apply(block(re, 'id="EndEvent_16"'), 'end-escalation', {
    attrs: { 'id="EndEvent_16"': 'id="{{ID}}"', 'name="EE_Route"': 'name="{{NAME}}"', '>SequenceFlow_17<': '>{{INCOMING}}<' },
    props: { ErrorCode: 'CATEGORY_VALUE' } // the escalation category (Routing condition not met, Others, ...)
  })
  t['iflw/end-error.xml'] = apply(block(re, 'id="EndEvent_1"'), 'end-error', {
    attrs: { 'id="EndEvent_1"': 'id="{{ID}}"', 'name="ERR_Route"': 'name="{{NAME}}"', '>SequenceFlow_8<': '>{{INCOMING}}<' }
  })

  t['iflw/step-groovy-script.xml'] = step('CallActivity_8', 'Groovy Script 1', 'SequenceFlow_6', 'SequenceFlow_14', { script: 'SCRIPT_VALUE' })
  t['iflw/step-json-to-xml.xml'] = step('CallActivity_11', 'JSON to XML Converter 1', 'SequenceFlow_14', 'SequenceFlow_12')
  t['iflw/step-xml-to-json.xml'] = step('CallActivity_15', 'XML to JSON Converter 1', 'SequenceFlow_12', 'SequenceFlow_16')
  t['iflw/step-request-reply.xml'] = step('ServiceTask_18', 'Request Reply 1', 'SequenceFlow_16', 'SequenceFlow_19')

  t['iflw/sequence-flow.xml'] = apply(block(x, 'id="SequenceFlow_3"'), 'sequence-flow', {
    attrs: { 'id="SequenceFlow_3"': 'id="{{ID}}"', 'sourceRef="StartEvent_2"': 'sourceRef="{{SOURCE}}"', 'targetRef="CallActivity_5"': 'targetRef="{{TARGET}}"' }
  })

  // --- diagram ---------------------------------------------------------------------
  t['iflw/shape.xml'] = apply(block(x, 'id="BPMNShape_EndEvent_2"'), 'shape', {
    attrs: {
      'bpmnElement="EndEvent_2"': 'bpmnElement="{{ELEMENT}}"',
      'id="BPMNShape_EndEvent_2"': 'id="{{ID}}"',
      'height="32.0" width="32.0" x="1038.0" y="148.0"': 'height="{{HEIGHT}}" width="{{WIDTH}}" x="{{X}}" y="{{Y}}"'
    }
  })
  const edge = block(x, 'id="BPMNEdge_SequenceFlow_3"')
  const waypoints = edge.split('\n').filter((l) => l.includes('<di:waypoint'))
  t['iflw/edge.xml'] = apply(edge, 'edge', {
    attrs: {
      'bpmnElement="SequenceFlow_3"': 'bpmnElement="{{ELEMENT}}"',
      'id="BPMNEdge_SequenceFlow_3"': 'id="{{ID}}"',
      'sourceElement="BPMNShape_StartEvent_2"': 'sourceElement="{{SOURCE}}"',
      'targetElement="BPMNShape_CallActivity_5"': 'targetElement="{{TARGET}}"',
      [waypoints.join('\n') + '\n']: '{{WAYPOINTS}}'
    }
  })
  t['iflw/waypoint.xml'] = apply(waypoints[0] + '\n', 'waypoint', { attrs: { 'x="308.0"': 'x="{{X}}"', 'y="158.0"': 'y="{{Y}}"' } })

  // --- bundle files --------------------------------------------------------------
  const manifest = all.files['META-INF/MANIFEST.MF']
  t['MANIFEST.MF'] = apply(manifest, 'manifest', {
    // Origin-* first: "Bundle-Name: …" is also a substring of "Origin-Bundle-Name: …"
    attrs: {
      'Origin-Bundle-Name: Reference_AllSteps\r\n': '{{ORIGIN_BUNDLE_NAME}}',
      'Origin-Bundle-SymbolicName: Reference_AllSteps\r\n': '{{ORIGIN_BUNDLE_SYMBOLIC_NAME}}',
      'Bundle-Name: Reference_AllSteps\r\n': '{{BUNDLE_NAME}}',
      'Bundle-SymbolicName: Reference_AllSteps; singleton:=true\r\n': '{{BUNDLE_SYMBOLIC_NAME}}'
    }
  })
  t['project.xml'] = apply(all.files['.project'], 'project', { attrs: { '<name>Reference_AllSteps</name>': '<name>{{NAME}}</name>' } })
  t['metainfo.prop'] = all.files['metainfo.prop'].replace(/^#(?!Store).*$/m, '#{{DATE}}').replace(/^description=.*$/m, 'description={{DESCRIPTION}}')

  const propdef = all.files['src/main/resources/parameters.propdef']
  const firstParam = propdef.match(/<parameter>[\s\S]*?<\/parameter>/)[0]
  const firstRef = propdef.match(/<reference [^>]*\/>/)[0]
  t['parameters.propdef'] = propdef.slice(0, propdef.indexOf('<parameter>')) + '{{PARAMETERS}}{{PARAM_REFERENCES}}</parameters>'
  t['propdef-parameter.xml'] = apply(firstParam, 'propdef-parameter', { attrs: { '<name>TargetURL</name>': '<name>{{NAME}}</name>' } })
  t['propdef-reference.xml'] = apply(firstRef, 'propdef-reference', {
    attrs: {
      'attribute_category="Receiver1"': 'attribute_category="{{CATEGORY}}"',
      'attribute_id="ctype::AdapterVariant/cname::HTTP/tp::HTTP/mp::None/direction::Receiver/version::1.22.0/attrId::httpAddressWithoutQuery"':
        'attribute_id="{{ATTRIBUTE_ID}}"',
      'attribute_uilabel="Address"': 'attribute_uilabel="{{UILABEL}}"',
      'param_key="TargetURL"': 'param_key="{{PARAM_KEY}}"'
    }
  })
  // Parameter references of HTTP receiver fields (parameters.propdef): attribute_id, label and the
  // category after the receiver's system name ("<system>.Receiver.Auth" for the credential name).
  // The address comes from Reference_AllSteps; credential name and location ID from Ref_Receivers,
  // whose adapter is 1.22.1: their attribute_id gets the version of the template's adapter.
  const addressId = firstRef.match(/attribute_id="([^"]+)"/)[1]
  const version = addressId.match(/\/version::([^/]+)\//)[1]
  const receivers = await readZip('Ref_Receivers.zip')
  const receiversPropdef = receivers.files['src/main/resources/parameters.propdef']
  const refOf = (attr) => {
    const r = receiversPropdef.match(new RegExp(`<reference attribute_category="([^"]+)" attribute_id="([^"]+/attrId::${attr})" attribute_uilabel="([^"]+)" param_key="([^"]+)"/>`))
    if (!r) throw new Error(`Ref_Receivers.zip: no parameter reference for ${attr}`)
    const flow = receivers.iflw.match(new RegExp(`<bpmn2:messageFlow\\b[\\s\\S]*?<\\/bpmn2:messageFlow>`, 'g')).find((f) => f.includes(`{{${r[4]}}}`))
    const system = flow.match(/<key>system<\/key>\s*<value>([^<]*)<\/value>/)[1]
    if (!r[1].startsWith(system)) throw new Error(`Ref_Receivers.zip: category ${r[1]} does not start with the receiver ${system}`)
    return { attributeId: r[2].replace(/\/version::[^/]+\//, `/version::${version}/`), uilabel: r[3], categorySuffix: r[1].slice(system.length) }
  }
  t['propdef-receiver-attributes.json'] =
    JSON.stringify({ address: { attributeId: addressId, uilabel: 'Address', categorySuffix: '' }, credentialName: refOf('credentialName'), locationID: refOf('locationID') }, null, 2) + '\n'

  // --- allowed values -----------------------------------------------------------------
  t['reference-values.json'] = JSON.stringify(await referenceValues(), null, 2) + '\n'

  // --- not in the reference exports yet ---------------------------------------------
  // Exception subprocess and its error start event are written by hand (CPI's export format).
  // Replace them with block() cuts once a reference export contains an exception subprocess.
  for (const name of HAND_WRITTEN) t[name] = fs.readFileSync(path.join(OUT_DIR, name), 'utf8')

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const [name, content] of Object.entries(t)) {
    const file = path.join(OUT_DIR, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  console.log(`Derived ${Object.keys(t).length} templates into ${path.relative(process.cwd(), OUT_DIR)}`)
}

if (require.main === module)
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })

module.exports = { referenceValues }
