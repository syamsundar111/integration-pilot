sap.ui.define(['integration/pilot/controller/BaseController', 'sap/ui/model/json/JSONModel', 'integration/pilot/util/api'], (BaseController, JSONModel, api) => {
  'use strict'

  return BaseController.extend('integration.pilot.controller.Dashboard', {
    onInit() {
      this.setModel(new JSONModel({ stats: null, statsError: null, failed: [], failedBusy: true, proposals: [], proposalsBusy: true }), 'view')
      this.getRouter().getRoute('dashboard').attachPatternMatched(() => this.load(false))
    },

    load(fresh) {
      const m = this.getModel('view')
      m.setProperty('/statsError', null)
      api.get(`/stats${fresh ? '?fresh=true' : ''}`).then(
        (s) => m.setProperty('/stats', s),
        (e) => m.setProperty('/statsError', { message: e.hint ? `${e.message} — ${e.hint}` : e.message })
      )
      m.setProperty('/failedBusy', true)
      api
        .get(`/messageLogs${api.q({ status: 'FAILED', sinceHours: 24, top: 6 })}`)
        .then((d) => m.setProperty('/failed', d), () => m.setProperty('/failed', []))
        .finally(() => m.setProperty('/failedBusy', false))
      m.setProperty('/proposalsBusy', true)
      api
        .get(`/Proposals${api.q({ $orderby: 'createdAt desc', $top: 6, $select: 'ID,kind,status,iflowId,packageId,createdAt,session_ID' })}`)
        .then((d) => m.setProperty('/proposals', d), () => m.setProperty('/proposals', []))
        .finally(() => m.setProperty('/proposalsBusy', false))
    },

    onRefresh() {
      this.load(true) // bypasses the 30s server-side cache
    },

    onNav(e) {
      this.getRouter().navTo(e.getSource().data('route'))
    },

    onNavErrors() {
      this.getRouter().navTo('monitor', { '?query': { status: 'ERROR' } })
    },

    onMonitorFailed() {
      this.getRouter().navTo('monitor', { '?query': { logs: 'FAILED' } })
    },

    onCreatePackage() {
      this.getRouter().navTo('packages', { '?query': { new: '1' } })
    },

    onNewIflow() {
      this.getRouter().navTo('generate')
    },

    onProposal(e) {
      const p = e.getSource().getBindingContext('view').getObject()
      this.getRouter().navTo('generate', { '?query': { session: p.session_ID } })
    }
  })
})
