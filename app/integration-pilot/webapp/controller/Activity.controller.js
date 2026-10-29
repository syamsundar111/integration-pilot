sap.ui.define(
  ['integration/pilot/controller/BaseController', 'sap/ui/model/json/JSONModel', 'sap/m/Dialog', 'sap/m/Button', 'sap/m/Text', 'integration/pilot/util/api', 'integration/pilot/util/charts'],
  (BaseController, JSONModel, Dialog, Button, Text, api, charts) => {
    'use strict'

    const LOG_PAGE = 50 // log entries per request
    // before the first load and after a failed one: zeros, not "undefined failed"
    const emptyUsage = () => ({ totals: { requests: 0, failed: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 }, byDay: [], byModel: [] })
    const emptySummary = () => ({ totals: { writes: 0, failed: 0 }, byDay: [], byAction: [] })

    /**
     * Every day of the period, oldest first, with the values of `rows` (by "day": YYYY-MM-DD) or zeros:
     * the columns of a day without data stay visible as gaps.
     */
    function eachDay(days, rows, fields) {
      const byDay = Object.fromEntries(rows.map((r) => [r.day, r]))
      const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
      return Array.from({ length: days }, (_, i) => {
        const day = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)
        const r = byDay[day] || {}
        return { day, date: new Date(day + 'T00:00:00Z'), ...Object.fromEntries(fields.map((f) => [f, r[f] || 0])) }
      })
    }

    return BaseController.extend('integration.pilot.controller.Activity', {
      onInit() {
        this.setModel(
          new JSONModel({
            days: '30',
            usage: emptyUsage(),
            usageBusy: false,
            usageError: null,
            summary: emptySummary(),
            summaryBusy: false,
            summaryError: null,
            charts: { tokensByDay: [], tokensByModel: [] },
            entries: [],
            more: false,
            busy: false,
            logError: null,
            filtered: false,
            actions: [{ key: '', text: 'All actions' }],
            action: '',
            status: '',
            search: ''
          }),
          'view'
        )
        this.getRouter()
          .getRoute('activity')
          .attachPatternMatched(() => this.onRefresh())
        this._charts = this.createCharts()
      },

      /** The two AI usage column charts, bound to /charts (sap.viz is loaded on first use) */
      createCharts() {
        const day = { name: 'Day', value: 'date' } // a date on the time axis (fits any period)
        return Promise.all([
          charts.column(this.byId('tokensByDayChart'), {
            model: 'view',
            path: '/charts/tokensByDay',
            dimension: day,
            measures: [
              { name: 'Input tokens', value: 'inputTokens' },
              { name: 'Output tokens', value: 'outputTokens' }
            ],
            stacked: true,
            time: true
          }),
          charts.column(this.byId('tokensByModelChart'), {
            model: 'view',
            path: '/charts/tokensByModel',
            dimension: { name: 'Model', value: 'model' },
            measures: [
              { name: 'Input tokens', value: 'inputTokens' },
              { name: 'Output tokens', value: 'outputTokens' }
            ],
            stacked: true
          })
        ]).catch((e) => this.getModel('view').setProperty('/usageError', `charts could not be loaded (${e.message})`))
      },

      onRefresh() {
        this.loadUsage()
        this.loadSummary()
        this.loadLog()
      },

      onPeriod() {
        this.onRefresh()
      },

      days() {
        return Number(this.getModel('view').getProperty('/days')) || 30
      },

      /** AI usage of chat requests for the period: figures and the two token charts */
      async loadUsage() {
        const m = this.getModel('view')
        const days = this.days()
        m.setProperty('/usageBusy', true)
        try {
          const usage = await api.get(`/usage(days=${days})`)
          if (days !== this.days()) return // another period was chosen meanwhile
          m.setProperty('/usage', usage)
          m.setProperty('/usageError', null)
        } catch (e) {
          if (days !== this.days()) return
          // shown in the usage panel; the rest of the page works without it
          m.setProperty('/usage', emptyUsage()) // not the numbers of the previous period
          m.setProperty('/usageError', e.hint ? `${e.message} — ${e.hint}` : e.message)
        } finally {
          if (days === this.days()) m.setProperty('/usageBusy', false)
        }
        const u = m.getProperty('/usage')
        m.setProperty('/charts/tokensByDay', eachDay(days, u.byDay || [], ['inputTokens', 'outputTokens']))
        // the model without its provider prefix ("nvidia/…"), so the column labels stay readable
        m.setProperty('/charts/tokensByModel', (u.byModel || []).map((x) => ({ model: x.model.replace(/^[^/]+\//, ''), inputTokens: x.inputTokens, outputTokens: x.outputTokens })))
      },

      /** The actions of the period, for the log's action filter (counted on the server) */
      async loadSummary() {
        const m = this.getModel('view')
        const days = this.days()
        m.setProperty('/summaryBusy', true)
        try {
          const summary = await api.get(`/activitySummary(days=${days})`)
          if (days !== this.days()) return
          m.setProperty('/summary', summary)
          m.setProperty('/summaryError', null)
        } catch (e) {
          if (days !== this.days()) return
          m.setProperty('/summary', emptySummary())
          m.setProperty('/summaryError', e.hint ? `${e.message} — ${e.hint}` : e.message)
        } finally {
          if (days === this.days()) m.setProperty('/summaryBusy', false)
        }
        const s = m.getProperty('/summary')
        // the action filter offers the actions of the period
        const current = m.getProperty('/action')
        const actions = (s.byAction || []).map((a) => a.action).sort()
        m.setProperty('/actions', [{ key: '', text: 'All actions' }, ...actions.map((a) => ({ key: a, text: this.formatter.humanize(a) }))])
        if (current && !actions.includes(current)) m.setProperty('/action', '')
      },

      /** budget line under "Budget per message": "largest 262k (87 %) · 0 stopped" */
      budgetText(maxPerRequest, maxShare, stopped) {
        if (maxPerRequest == null) return ''
        return `largest ${this.formatter.tokens(maxPerRequest)} (${maxShare} %) · ${stopped || 0} stopped at the budget`
      },

      // --- the log: paged on the server ---------------------------------------------------------

      /** OData $filter of the log for the period, action, result and search */
      logFilter() {
        const m = this.getModel('view')
        const str = (v) => `'${String(v).replace(/'/g, "''")}'`
        const since = new Date(Date.now() - this.days() * 86_400_000).toISOString()
        const parts = [`createdAt ge ${since}`]
        if (m.getProperty('/action')) parts.push(`action eq ${str(m.getProperty('/action'))}`)
        if (m.getProperty('/status')) parts.push(`status eq ${str(m.getProperty('/status'))}`)
        const term = (m.getProperty('/search') || '').trim().toLowerCase()
        if (term) parts.push(`(${['targetId', 'user', 'targetType'].map((f) => `contains(tolower(${f}),${str(term)})`).join(' or ')})`)
        return parts.join(' and ')
      },

      /** First page for the current filters (a filter change starts over) */
      loadLog() {
        return this.fetchLog(false)
      },

      onLoadMore() {
        return this.fetchLog(true)
      },

      onSearch(e) {
        this.getModel('view').setProperty('/search', e.getParameter('query') || '')
        return this.loadLog()
      },

      async fetchLog(more) {
        const m = this.getModel('view')
        const filter = this.logFilter()
        const key = filter.replace(/createdAt ge \S+/, `days ${this.days()}`) // the period, not the moment
        const skip = more ? m.getProperty('/entries').length : 0
        m.setProperty('/busy', true)
        m.setProperty('/logError', null)
        try {
          const page = await api.get(`/AuditLog${api.q({ $filter: filter, $orderby: 'createdAt desc', $top: LOG_PAGE, ...(skip && { $skip: skip }) })}`)
          if (key !== this.logFilter().replace(/createdAt ge \S+/, `days ${this.days()}`)) return // the filters changed meanwhile
          m.setProperty('/entries', more ? [...m.getProperty('/entries'), ...page] : page)
          m.setProperty('/more', page.length === LOG_PAGE)
          m.setProperty('/filtered', !!(m.getProperty('/action') || m.getProperty('/status') || (m.getProperty('/search') || '').trim()))
        } catch (e) {
          if (!more) m.setProperty('/entries', [])
          m.setProperty('/logError', e.hint ? `${e.message} — ${e.hint}` : e.message)
        } finally {
          m.setProperty('/busy', false)
        }
      },

      onDetails(e) {
        const a = e.getSource().getBindingContext('view').getObject()
        if (!a.details) return
        let pretty = a.details
        try {
          pretty = JSON.stringify(JSON.parse(a.details), null, 2)
        } catch (err) {
          // plain text details
        }
        const dialog = new Dialog({
          title: `${this.formatter.humanize(a.action)} · ${a.targetId}`,
          contentWidth: '36rem',
          content: [new Text({ renderWhitespace: true }).setText(pretty).addStyleClass('ipPre')], // JSON: setText, no binding parsing
          endButton: new Button({ text: this.text('close'), press: () => dialog.close() }),
          afterClose: () => dialog.destroy()
        }).addStyleClass('sapUiContentPadding')
        this.getView().addDependent(dialog)
        dialog.open()
      }
    })
  }
)
