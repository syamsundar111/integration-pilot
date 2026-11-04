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
    writeVariables: 'Write Variables',
    router: 'Router',
    splitter: 'Splitter',
    gather: 'Gather',
    processCall: 'Process Call',
    requestReplySoap: 'Request Reply (SOAP)',
    requestReplyProcessDirect: 'Request Reply (ProcessDirect)',
    sendMail: 'Send (Mail)',
    messageMapping: 'Message Mapping',
    xsltMapping: 'XSLT Mapping',
    multicast: 'Multicast'
  }
  const DEFAULT_NAMES = {
    contentModifier: 'Content Modifier',
    groovyScript: 'Groovy Script',
    jsonToXml: 'JSON to XML Converter',
    xmlToJson: 'XML to JSON Converter',
    requestReplyHttp: 'Request Reply',
    writeVariables: 'Write Variables',
    iteratingSplitter: 'Iterating Splitter',
    generalSplitter: 'General Splitter',
    gather: 'Gather',
    processCall: 'Process Call',
    loopingProcessCall: 'Looping Process Call',
    sendMail: 'Send',
    messageMapping: 'Message Mapping',
    xsltMapping: 'XSLT Mapping',
    parallelMulticast: 'Parallel Multicast',
    sequentialMulticast: 'Sequential Multicast'
  }
  /** The key of a step's default name, as the builder counts them (validator.js defaultKey) */
  const defaultKey = (s) =>
    s.type === 'multicast' ? `${s.mode === 'sequential' ? 'sequential' : 'parallel'}Multicast` : s.type === 'splitter' ? `${s.kind === 'general' ? 'general' : 'iterating'}Splitter` : s.type === 'processCall' && s.loop ? 'loopingProcessCall' : s.type === 'requestReplySoap' ? 'requestReplyHttp' : s.type
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
    requestReplySoap: 'sap-icon://outbox',
    requestReplyProcessDirect: 'sap-icon://outbox',
    sendMail: 'sap-icon://email',
    messageMapping: 'sap-icon://map-2',
    xsltMapping: 'sap-icon://map-2',
    writeVariables: 'sap-icon://save',
    router: 'sap-icon://split',
    multicast: 'sap-icon://org-chart',
    splitter: 'sap-icon://expand-group',
    gather: 'sap-icon://collapse-group',
    processCall: 'sap-icon://process',
    unknown: 'sap-icon://puzzle'
  }

  /** "Run once", "Every 15 min (UTC)" or "Scheduled" */
  const timerText = (t) => (t.mode === 'once' ? 'Run once' : t.mode === 'every' ? `Every ${t.minutes} min (UTC)` : 'Scheduled')

  function icon(name) {
    const info = IconPool.getIconInfo(ICONS[name] || ICONS.unknown)
    return info ? `<span class="ipFlowIcon" style="font-family:'${info.fontFamily}'" aria-hidden="true">${info.content}</span>` : ''
  }

  /** Short details of a splitter, gather or process call (spec and parsed steps alike) */
  const detailOf = (s) =>
    s.type === 'splitter'
      ? `${s.kind === 'general' ? 'General' : s.kind === 'iterating' ? 'Iterating' : s.splitType || ''} ${s.expression || ''}`.trim()
      : s.type === 'gather'
        ? s.target
          ? `into ${s.target}`
          : 'Combine'
        : s.type === 'processCall'
          ? `→ ${s.process || '?'}${s.loop ? `, loop max ${s.loop.max}` : ''}`
          : s.type === 'messageMapping'
            ? s.mapping || s.file
            : s.type === 'xsltMapping'
              ? s.file
              : s.type === 'multicast'
                ? s.mode === 'sequential' ? 'Sequential' : 'Parallel'
                : undefined

  /** Marks the steps after a splitter up to its gather (or the end) as per item */
  function markPerItem(steps) {
    let split = false
    for (const s of steps) {
      if (s.type === 'gather') split = false
      else if (split) s.perItem = true
      if (s.type === 'splitter') split = true
    }
    return steps
  }

  /** Spec (proposal) -> diagram model */
  function fromSpec(spec) {
    const counters = {}
    let rr = 0
    const nameOf = (s) => {
      const key = defaultKey(s)
      counters[key] = (counters[key] || 0) + 1
      return s.name || `${DEFAULT_NAMES[key] || s.type} ${counters[key]}`
    }
    // a branch's steps with the steps inside its routes, in flow order as the builder counts them
    const branchNames = (list) => list.flatMap((s) => [nameOf(s), ...(s.type === 'router' ? (s.routes || []).flatMap((r) => (r.steps || []).map(nameOf)) : [])])
    return {
      trigger:
        spec.trigger.type === 'httpsSender'
          ? { kind: 'https', label: 'HTTPS', detail: spec.trigger.address }
          : spec.trigger.type === 'soapSender'
            ? { kind: 'https', label: 'SOAP', detail: spec.trigger.address }
            : spec.trigger.type === 'processDirectSender'
              ? { kind: 'other', label: 'ProcessDirect', detail: spec.trigger.address }
              : spec.trigger.type === 'jmsSender'
                ? { kind: 'other', label: 'JMS', detail: spec.trigger.queue }
                : spec.trigger.type === 'sftpSender'
                  ? { kind: 'other', label: 'SFTP', detail: `${spec.trigger.host} ${spec.trigger.directory}` }
                : { kind: 'timer', label: 'Timer', detail: timerText(spec.trigger) },
      steps: markPerItem(spec.steps.map((s) => {
        const name = nameOf(s)
        if (s.type === 'requestReplyHttp') return { type: s.type, name, detail: s.method, receiver: { name: s.system || `Receiver${++rr}`, detail: s.url } }
        if (s.type === 'requestReplySoap') return { type: s.type, name, detail: 'SOAP 1.x', receiver: { name: s.system || `Receiver${++rr}`, detail: s.url } }
        if (s.type === 'requestReplyProcessDirect') return { type: s.type, name, detail: 'ProcessDirect', receiver: { name: s.system || `Receiver${++rr}`, detail: s.address } }
        if (s.type === 'sendMail') return { type: s.type, name, detail: `to ${s.to}`, receiver: { name: s.system || `Receiver${++rr}`, detail: s.server } }
        if (s.type === 'groovyScript') return { type: s.type, name, detail: `${s.fileName}.groovy` }
        if (s.type === 'contentModifier') {
          const n = (s.headers || []).length + (s.properties || []).length
          return { type: s.type, name, detail: [n ? `${n} value${n === 1 ? '' : 's'}` : null, s.body ? 'body' : null].filter(Boolean).join(' · ') || undefined }
        }
        if (s.type === 'writeVariables') return { type: s.type, name, detail: (s.variables || []).map((v) => v.name).join(', ') || undefined }
        if (s.type === 'router')
          return {
            type: s.type,
            name,
            detail: s.expressionType === 'XML' ? 'XML (XPath)' : 'Non-XML',
            routes: (s.routes || []).map((r) => ({
              name: r.name,
              condition: r.default ? null : r.condition,
              steps: (r.steps || []).map(nameOf),
              end: r.end ? r.end.event || 'message' : null
            }))
          }
        if (s.type === 'multicast')
          return { type: s.type, name, detail: detailOf(s), branches: (s.branches || []).map((b, i) => ({ name: b.name || `Branch ${i + 1}`, steps: branchNames(b.steps || []) })) }
        return { type: s.type, name, detail: detailOf(s) }
      })),
      end: {
        ...(spec.end.type === 'httpReceiver' && { receiver: { name: spec.end.system || 'Receiver', detail: `${spec.end.method} ${spec.end.url}` } }),
        ...(spec.end.type === 'processDirectReceiver' && { receiver: { name: spec.end.system || 'Receiver', detail: `ProcessDirect ${spec.end.address}` } }),
        event: spec.end.event || 'message',
        // every route of the last router ends: the main flow has no end of its own
        none: (() => {
          const last = spec.steps[spec.steps.length - 1]
          return !!last && last.type === 'router' && (last.routes || []).every((r) => r.end)
        })()
      },
      exception: spec.exceptionSubprocess
        ? {
            name: spec.exceptionSubprocess.name || 'Exception Subprocess 1',
            steps: (spec.exceptionSubprocess.steps || []).map(nameOf),
            end: (spec.exceptionSubprocess.end && spec.exceptionSubprocess.end.event) || 'message'
          }
        : null,
      locals: (spec.localProcesses || []).map((lp) => ({ name: lp.name, steps: (lp.steps || []).map(nameOf) }))
    }
  }

  /** Parsed iFlow (srv/iflow-builder/parser.js) -> diagram model */
  function fromParsed(p) {
    const t = p.trigger || {}
    const trigger =
      t.type === 'httpsSender'
        ? { kind: 'https', label: 'HTTPS', detail: t.address }
        : t.type === 'timer'
          ? { kind: 'timer', label: 'Timer', detail: timerText(t) }
          : t.type === 'sender'
            ? { kind: 'other', label: t.adapter || 'Sender', detail: t.address }
            : { kind: 'none', label: 'Start' }
    // a branching flow the spec can hold: its routers with their routes (else the steps in processing order)
    const routed = p.routed && !p.routed.unsupported ? p.routed : null
    const e = (routed ? routed.end : p.end) || {}
    const parsedStep = (s) => ({
      type: s.type,
      name: s.name,
      detail:
        s.type === 'groovyScript'
          ? s.script || `${s.fileName}.groovy`
          : s.type === 'requestReplyHttp'
            ? s.method
            : s.type === 'requestReplySoap'
            ? 'SOAP 1.x'
            : s.type === 'requestReplyProcessDirect'
            ? 'ProcessDirect'
            : s.type === 'sendMail'
            ? `to ${s.to}`
            : s.type === 'writeVariables'
              ? (s.variables || []).map((v) => v.name).join(', ') || undefined
              : s.type === 'router' && s.routes
                ? s.expressionType === 'XML'
                  ? 'XML (XPath)'
                  : 'Non-XML'
                : detailOf(s),
      receiver:
        s.type === 'requestReplyHttp' || s.type === 'requestReplySoap'
          ? { name: s.system || 'Receiver', detail: s.url }
          : s.type === 'sendMail'
            ? { name: s.system || 'Receiver', detail: s.server }
            : s.type === 'requestReplyProcessDirect'
              ? { name: s.system || 'Receiver', detail: s.address }
              : undefined,
      routes:
        routed && s.type === 'router'
          ? s.routes.map((r) => ({ name: r.name, condition: r.default ? null : r.condition, steps: r.steps.map((x) => x.name), end: r.end ? r.end.kind : null }))
          : undefined,
      branches:
        routed && s.type === 'multicast'
          ? s.branches.map((b) => ({ name: b.name, steps: b.steps.flatMap((x) => [x.name, ...(x.type === 'router' ? x.routes.flatMap((r) => r.steps.map((y) => y.name)) : [])]) }))
          : undefined
    })
    return {
      trigger,
      steps: markPerItem((routed ? routed.steps : p.steps || []).map(parsedStep)),
      end: {
        ...(e.type === 'httpReceiver'
          ? { receiver: { name: e.system || 'Receiver', detail: `${e.method || ''} ${e.url || ''}`.trim() } }
          : e.type === 'processDirectReceiver'
            ? { receiver: { name: e.system || 'Receiver', detail: `ProcessDirect ${e.address}` } }
          : e.type === 'receiver'
            ? { receiver: { name: e.adapter || 'Receiver', detail: e.address } }
            : {}),
        event: e.kind || 'message',
        none: !!routed && !routed.end
      },
      exception: p.exceptionSubprocess ? { name: p.exceptionSubprocess.name, steps: (p.exceptionSubprocess.steps || []).map((s) => s.name), end: p.exceptionSubprocess.end || 'message' } : null,
      locals: (p.localProcessSteps || []).map((lp) => ({ name: lp.name, steps: lp.steps.map((s) => s.name) })),
      linear: routed ? true : p.linear
    }
  }

  const arrow = '<div class="ipFlowArrow" aria-hidden="true"></div>'

  const END_LABELS = { message: 'End', escalation: 'Escalation End', error: 'Error End', terminate: 'Terminate End' }
  // the exception subprocess's end: a Message End answers the sender and the message looks completed
  const EXCEPTION_END_LABELS = { message: 'End (response to sender; shown as completed)', escalation: 'Escalation End (escalated)', error: 'Error End (failed)', terminate: 'Terminate End' }

  /** The routes of a router, one line each: name, condition (or default), its steps, how it ends */
  const routesHtml = (routes) =>
    `<div class="ipFlowRoutes">${routes
      .map(
        (r) =>
          `<div class="ipFlowRoute"><span class="ipFlowRouteName">${esc(r.name)}</span> ${esc(r.condition ? r.condition : 'default')}: ${[
            ...r.steps,
            r.end ? END_LABELS[r.end] || 'End' : 'continues'
          ]
            .map(esc)
            .join(' → ')}</div>`
      )
      .join('')}</div>`

  /** The branches of a multicast, one line each: name and steps, up to the Join */
  const branchesHtml = (branches) =>
    `<div class="ipFlowRoutes">${branches.map((b) => `<div class="ipFlowRoute"><span class="ipFlowRouteName">${esc(b.name)}</span> ${[...b.steps, 'Join'].map(esc).join(' → ')}</div>`).join('')}</div>`

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
        )}">${esc(s.name)}</div><div class="ipFlowStepType">${esc(STEP_LABELS[s.type] || s.type)}${s.perItem ? ' · per item' : ''}</div></div></div>${s.detail ? `<div class="ipFlowMono">${esc(s.detail)}</div>` : ''}</div>${
          s.receiver ? `<div class="ipFlowDash"></div>${receiver(s.receiver)}` : ''
        }${s.routes ? routesHtml(s.routes) : ''}${s.branches ? branchesHtml(s.branches) : ''}</div>`
      )
    }
    if (!model.end.none) {
      parts.push(arrow)
      parts.push(`<div class="ipFlowEvent ipFlowEnd"><div class="ipFlowCircle">${icon('end')}</div><div class="ipFlowEventLabel">${esc(END_LABELS[model.end.event] || 'End')}</div></div>`)
    }
    if (model.end.receiver) {
      parts.push(arrow)
      parts.push(`<div class="ipFlowEndReceiver">${receiver(model.end.receiver)}</div>`)
    }
    const note = model.linear === false ? '<div class="ipFlowNote">This flow branches; steps are shown in processing order.</div>' : ''
    const exception = model.exception
      ? `<div class="ipFlowNote">On error: ${esc(model.exception.name)} — ${['Error Start', ...model.exception.steps, EXCEPTION_END_LABELS[model.exception.end || 'message']]
          .map(esc)
          .join(' → ')}</div>`
      : ''
    const locals = (model.locals || [])
      .map((lp) => `<div class="ipFlowNote">Local process ${esc(lp.name)}: ${['Start', ...lp.steps, 'End'].map(esc).join(' → ')}</div>`)
      .join('')
    return `<div class="ipFlow" role="img" aria-label="${esc(label)}"><div class="ipFlowRow">${parts.join('')}</div>${exception}${locals}${note}</div>`
  }

  return { fromSpec, fromParsed, toHtml }
})
