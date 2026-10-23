sap.ui.define(
  ['integration/pilot/controller/BaseController', 'sap/ui/model/json/JSONModel', 'sap/m/Dialog', 'sap/m/Button', 'sap/m/Text', 'sap/m/BusyIndicator', 'integration/pilot/util/api'],
  (BaseController, JSONModel, Dialog, Button, Text, BusyIndicator, api) => {
    'use strict'

    const REFRESH_MS = 60000

    return BaseController.extend('integration.pilot.controller.Monitor', {
      onInit() {
        this.setModel(
          new JSONModel({
            runtime: [],
            runtimeRows: [],
            runtimeBusy: true,
            counts: { ALL: 0, STARTED: 0, ERROR: 0, STARTING: 0 },
            status: 'ALL',
            pending: [],
            pendingText: '',
            logs: [],
            logsBusy: true,
            logsError: null,
            logStatus: '',
            hours: '24'
          }),
          'view'
        )
        const route = this.getRouter().getRoute('monitor')
        route.attachPatternMatched((e) => {
          const query = e.getParameter('arguments')['?query'] || {}
          const m = this.getModel('view')
          // every link sets the whole filter state: what it does not name goes back to the default
          // (the Error tile's filter must not stay when the Deployed tile opens the page)
          m.setProperty('/status', query.status || 'ALL')
          m.setProperty('/logStatus', query.logs || '')
          m.setProperty('/hours', query.hours || '24')
          this.applyFilter() // the table follows at once, not only after the refresh
          this.onRefresh()
          clearInterval(this._timer)
          this._timer = setInterval(() => this.loadRuntime(), REFRESH_MS)
        })
        // stop auto-refresh when leaving the page
        this.getRouter().attachRouteMatched((e) => e.getParameter('name') !== 'monitor' && clearInterval(this._timer))
      },

      onExit() {
        clearInterval(this._timer)
      },

      onRefresh() {
        this.loadRuntime()
        this.loadLogs()
      },

      async loadRuntime() {
        const m = this.getModel('view')
        m.setProperty('/runtimeBusy', true)
        try {
          const [runtime, done] = await Promise.all([
            api.get('/RuntimeArtifacts'),
            api.get(`/Proposals${api.q({ $filter: "status eq 'DONE' and kind eq 'IFLOW'", $orderby: 'modifiedAt desc', $top: 20 })}`).catch(() => [])
          ])
          m.setProperty('/runtime', runtime)
          const counts = { ALL: runtime.length, STARTED: 0, ERROR: 0, STARTING: 0 }
          for (const r of runtime) counts[r.status] = (counts[r.status] || 0) + 1
          m.setProperty('/counts', counts)
          // deployments that CPI accepted but has not started yet (from approved proposals, last 24h)
          const deployed = new Set(runtime.map((r) => r.id))
          const dayAgo = Date.now() - 24 * 3600000
          const pending = done.filter((p) => p.result && p.result.warning && p.iflowId && !deployed.has(p.iflowId) && new Date(p.modifiedAt || p.createdAt).getTime() > dayAgo)
          m.setProperty('/pending', pending)
          m.setProperty('/pendingText', pending.map((p) => p.iflowId).join(', '))
          this.applyFilter()
        } catch (e) {
          this.showError(e, 'Runtime artifacts could not be loaded')
        } finally {
          m.setProperty('/runtimeBusy', false)
        }
      },

      applyFilter() {
        const m = this.getModel('view')
        const status = m.getProperty('/status')
        const rows = m
          .getProperty('/runtime')
          .filter((r) => status === 'ALL' || r.status === status)
          .sort((a, b) => (b.status === 'ERROR') - (a.status === 'ERROR') || a.name.localeCompare(b.name))
        m.setProperty('/runtimeRows', rows)
      },

      onStatusFilter() {
        this.applyFilter()
      },

      async loadLogs() {
        const m = this.getModel('view')
        m.setProperty('/logsBusy', true)
        m.setProperty('/logsError', null)
        try {
          m.setProperty('/logs', await api.get(`/messageLogs${api.q({ status: m.getProperty('/logStatus') || undefined, sinceHours: m.getProperty('/hours'), top: 100 })}`))
        } catch (e) {
          m.setProperty('/logs', [])
          m.setProperty('/logsError', e.hint ? `${e.message} — ${e.hint}` : e.message)
        } finally {
          m.setProperty('/logsBusy', false)
        }
      },

      /** Error details of a runtime artifact in ERROR */
      onShowError(e) {
        const r = e.getSource().getBindingContext('view').getObject()
        if (r.status !== 'ERROR') return
        const text = new Text({ text: 'Loading…', renderWhitespace: true }).addStyleClass('ipPre ipPreError')
        const dialog = new Dialog({
          title: `Error: ${r.name}`,
          state: 'Error',
          contentWidth: '40rem',
          content: [text],
          endButton: new Button({ text: this.text('close'), press: () => dialog.close() }),
          afterClose: () => dialog.destroy()
        }).addStyleClass('sapUiContentPadding')
        this.getView().addDependent(dialog)
        dialog.open()
        api
          .get(`/RuntimeArtifacts/${api.seg(r.id)}/errorInfo`)
          .then((err) => text.setText((err && err.message) || 'No error details available.'))
          .catch((err) => text.setText(err.message))
      }
    })
  }
)
