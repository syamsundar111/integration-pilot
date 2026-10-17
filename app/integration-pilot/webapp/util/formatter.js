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
    }
  }
})
