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
      credentialName: 'CREDENTIAL_NAME_VALUE'
    }
  })

  // --- events ------------------------------------------------------------------
  t['iflw/start-message.xml'] = apply(block(x, 'id="StartEvent_2"'), 'start-message', {
    attrs: { 'id="StartEvent_2"': 'id="{{ID}}"', 'name="Start"': 'name="{{NAME}}"', '>SequenceFlow_3<': '>{{OUTGOING}}<' }
  })
  t['iflw/start-timer.xml'] = apply(block(timer.iflw, 'id="StartEvent_4"'), 'start-timer', {
    attrs: {
      'id="StartEvent_4"': 'id="{{ID}}"',
      'name="Start Timer 1"': 'name="{{NAME}}"',
      '>SequenceFlow_8<': '>{{OUTGOING}}<',
      'id="TimerEventDefinition_21607"': 'id="{{TIMER_ID}}"'
    }
  })
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
      "<cell id='Datatype'></cell>": "<cell id='Datatype'>{{DATATYPE}}</cell>"
    }
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
  // attribute_id of an HTTP receiver address, as used in the reference propdef
  t['propdef-attribute-http-address.txt'] = firstRef.match(/attribute_id="([^"]+)"/)[1]

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

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
