sap.ui.define(['sap/ui/core/IconPool', 'integration/pilot/util/markdown'], (IconPool, markdown) => {
  'use strict'

  /**
   * Horizontal step diagram (trigger -> steps -> end -> receiver) as HTML for sap.ui.core.HTML.
   * Built from an iFlow spec (proposals) or a parsed iFlow (tenant / uploaded zip).
   * Styling: css/style.css (.ipFlow*), using Horizon theme parameters.
   */
  const esc = markdown.escape

  const STEP_LABELS = {
    contentModifier: 'Content Modifier',
    groovyScript: 'Groovy Script',
    jsonToXml: 'JSON → XML',
    xmlToJson: 'XML → JSON',
    requestReplyHttp: 'Request Reply',
    router: 'Router'
  }
  const DEFAULT_NAMES = {
    contentModifier: 'Content Modifier',
    groovyScript: 'Groovy Script',
    jsonToXml: 'JSON to XML Converter',
    xmlToJson: 'XML to JSON Converter',
    requestReplyHttp: 'Request Reply'
  }
  const ICONS = {
    https: 'sap-icon://internet-browser',
    timer: 'sap-icon://fob-watch',
    other: 'sap-icon://inbox',
    none: 'sap-icon://media-play',
    end: 'sap-icon://stop',
    receiver: 'sap-icon://globe',
    contentModifier: 'sap-icon://edit',
    groovyScript: 'sap-icon://source-code',
    jsonToXml: 'sap-icon://switch-views',
    xmlToJson: 'sap-icon://switch-views',
    requestReplyHttp: 'sap-icon://outbox',
    unknown: 'sap-icon://puzzle'
  }

  function icon(name) {
    const info = IconPool.getIconInfo(ICONS[name] || ICONS.unknown)
    return info ? `<span class="ipFlowIcon" style="font-family:'${info.fontFamily}'" aria-hidden="true">${info.content}</span>` : ''
  }

  /** Spec (proposal) -> diagram model */
  function fromSpec(spec) {
    const counters = {}
    let rr = 0
    return {
      trigger: spec.trigger.type === 'httpsSender' ? { kind: 'https', label: 'HTTPS', detail: spec.trigger.address } : { kind: 'timer', label: 'Timer', detail: 'Run once' },
      steps: spec.steps.map((s) => {
        counters[s.type] = (counters[s.type] || 0) + 1
        const name = s.name || `${DEFAULT_NAMES[s.type] || s.type} ${counters[s.type]}`
        if (s.type === 'requestReplyHttp') return { type: s.type, name, detail: s.method, receiver: { name: s.system || `Receiver${++rr}`, detail: s.url } }
        if (s.type === 'groovyScript') return { type: s.type, name, detail: `${s.fileName}.groovy` }
        if (s.type === 'contentModifier') {
          const n = (s.headers || []).length + (s.properties || []).length
          return { type: s.type, name, detail: [n ? `${n} value${n === 1 ? '' : 's'}` : null, s.body ? 'body' : null].filter(Boolean).join(' · ') || undefined }
        }
        return { type: s.type, name }
      }),
      end: spec.end.type === 'httpReceiver' ? { receiver: { name: spec.end.system || 'Receiver', detail: `${spec.end.method} ${spec.end.url}` } } : {},
      exception: spec.exceptionSubprocess
        ? {
            name: spec.exceptionSubprocess.name || 'Exception Subprocess 1',
            steps: (spec.exceptionSubprocess.steps || []).map((s) => {
              counters[s.type] = (counters[s.type] || 0) + 1
              return s.name || `${DEFAULT_NAMES[s.type] || s.type} ${counters[s.type]}`
            })
          }
        : null
    }
  }

  /** Parsed iFlow (srv/iflow-builder/parser.js) -> diagram model */
  function fromParsed(p) {
    const t = p.trigger || {}
    const trigger =
      t.type === 'httpsSender'
        ? { kind: 'https', label: 'HTTPS', detail: t.address }
        : t.type === 'timer'
          ? { kind: 'timer', label: 'Timer', detail: t.mode === 'once' ? 'Run once' : 'Scheduled' }
          : t.type === 'sender'
            ? { kind: 'other', label: t.adapter || 'Sender', detail: t.address }
            : { kind: 'none', label: 'Start' }
    const e = p.end || {}
    return {
      trigger,
      steps: (p.steps || []).map((s) => ({
        type: s.type,
        name: s.name,
        detail: s.type === 'groovyScript' ? s.script || `${s.fileName}.groovy` : s.type === 'requestReplyHttp' ? s.method : undefined,
        receiver: s.type === 'requestReplyHttp' ? { name: s.system || 'Receiver', detail: s.url } : undefined
      })),
      end:
        e.type === 'httpReceiver'
          ? { receiver: { name: e.system || 'Receiver', detail: `${e.method || ''} ${e.url || ''}`.trim() } }
          : e.type === 'receiver'
            ? { receiver: { name: e.adapter || 'Receiver', detail: e.address } }
            : {},
      exception: p.exceptionSubprocess ? { name: p.exceptionSubprocess.name, steps: (p.exceptionSubprocess.steps || []).map((s) => s.name) } : null,
      linear: p.linear
    }
  }

  const arrow = '<div class="ipFlowArrow" aria-hidden="true"></div>'

  function receiver(r) {
    return `<div class="ipFlowReceiver" title="${esc(r.detail || '')}">${icon('receiver')}<div><div class="ipFlowReceiverName">${esc(r.name)}</div>${
      r.detail ? `<div class="ipFlowMono">${esc(r.detail)}</div>` : ''
    }</div></div>`
  }

  function toHtml(model) {
    const label = `Flow: ${model.trigger.label}, ${model.steps.map((s) => s.name).join(', ')}, end`
    const parts = [
      `<div class="ipFlowEvent ipFlowStart"><div class="ipFlowCircle">${icon(model.trigger.kind)}</div><div class="ipFlowEventLabel">${esc(model.trigger.label)}</div>${
        model.trigger.detail ? `<div class="ipFlowMono">${esc(model.trigger.detail)}</div>` : ''
      }</div>`
    ]
    for (const s of model.steps) {
      const known = s.type in STEP_LABELS
      parts.push(arrow)
      parts.push(
        `<div class="ipFlowStepCol"><div class="ipFlowStep${known ? '' : ' ipFlowUnknown'}"><div class="ipFlowStepHead"><div class="ipFlowStepIcon">${icon(s.type)}</div><div class="ipFlowStepText"><div class="ipFlowStepName" title="${esc(
          s.name
        )}">${esc(s.name)}</div><div class="ipFlowStepType">${esc(STEP_LABELS[s.type] || s.type)}</div></div></div>${s.detail ? `<div class="ipFlowMono">${esc(s.detail)}</div>` : ''}</div>${
          s.receiver ? `<div class="ipFlowDash"></div>${receiver(s.receiver)}` : ''
        }</div>`
      )
    }
    parts.push(arrow)
    parts.push(`<div class="ipFlowEvent ipFlowEnd"><div class="ipFlowCircle">${icon('end')}</div><div class="ipFlowEventLabel">End</div></div>`)
    if (model.end.receiver) {
      parts.push(arrow)
      parts.push(`<div class="ipFlowEndReceiver">${receiver(model.end.receiver)}</div>`)
    }
    const note = model.linear === false ? '<div class="ipFlowNote">This flow branches; steps are shown in processing order.</div>' : ''
    const exception = model.exception
      ? `<div class="ipFlowNote">On error: ${esc(model.exception.name)} — ${['Error Start', ...model.exception.steps, 'End (response to sender)'].map(esc).join(' → ')}</div>`
      : ''
    return `<div class="ipFlow" role="img" aria-label="${esc(label)}"><div class="ipFlowRow">${parts.join('')}</div>${exception}${note}</div>`
  }

  return { fromSpec, fromParsed, toHtml }
})
