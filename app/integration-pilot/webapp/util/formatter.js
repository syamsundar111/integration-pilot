sap.ui.define(['sap/ui/core/format/DateFormat'], (DateFormat) => {
  'use strict'

  const GREEN = ['STARTED', 'DONE', 'SUCCESS', 'COMPLETED']
  const RED = ['ERROR', 'FAILED', 'ESCALATED', 'ABANDONED']
  const AMBER = ['PENDING', 'STARTING', 'APPROVED', 'PROCESSING', 'RETRY', 'STOPPING']

  const dateTime = DateFormat.getDateTimeInstance({ style: 'medium' })
  const relative = DateFormat.getDateTimeInstance({ relative: true, relativeScale: 'auto', relativeStyle: 'short' })

  const toDate = (v) => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }

  return {
    /** sap.ui.core.ValueState for a CPI / proposal / audit status */
    statusState(status) {
      const s = String(status || '').toUpperCase()
      if (GREEN.includes(s)) return 'Success'
      if (RED.includes(s)) return 'Error'
      if (AMBER.includes(s)) return 'Warning'
      return 'None'
    },

    statusText(status) {
      if (!status || status === 'NOT_DEPLOYED') return 'Not deployed'
      return String(status).replace(/_/g, ' ')
    },

    relativeTime(v) {
      const d = toDate(v)
      return d ? relative.format(d) : '—'
    },

    dateTime(v) {
      const d = toDate(v)
      return d ? dateTime.format(d) : '—'
    },

    duration(start, end) {
      const a = toDate(start)
      const b = toDate(end)
      if (!a || !b) return '—'
      const ms = b - a
      if (ms < 1000) return `${ms} ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
      return `${Math.round(ms / 60000)} min`
    },

    /** Icon + colour for proposal execution steps */
    stepIcon(status) {
      return {
        done: 'sap-icon://sys-enter-2',
        running: 'sap-icon://synchronize',
        failed: 'sap-icon://error',
        warning: 'sap-icon://alert',
        skipped: 'sap-icon://less'
      }[status] || 'sap-icon://circle-task'
    },

    stepColor(status) {
      return { done: 'Positive', running: 'Critical', failed: 'Negative', warning: 'Critical' }[status] || 'Neutral'
    },

    humanize(action) {
      if (!action) return ''
      return action.charAt(0) + action.slice(1).toLowerCase().replace(/_/g, ' ')
    },

    initials(id) {
      return String(id || '?').slice(0, 2).toUpperCase()
    },

    /** 1234 -> "1.2k", 1234567 -> "1.23M" */
    tokens(n) {
      const v = Number(n) || 0
      if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
      return String(v)
    },

    /** One line of AI usage: "3 model calls · 12.4k in / 1.1k out tokens · 48 s · model" */
    usageLine(u) {
      if (!u || !u.modelCalls) return ''
      const secs = Math.round((u.durationMs || 0) / 1000)
      const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`
      return [
        `${u.modelCalls} model call${u.modelCalls === 1 ? '' : 's'}`,
        `${this.tokens(u.inputTokens)} in / ${this.tokens(u.outputTokens)} out tokens`,
        time,
        u.model
      ]
        .filter(Boolean)
        .join(' · ')
    }
  }
})
