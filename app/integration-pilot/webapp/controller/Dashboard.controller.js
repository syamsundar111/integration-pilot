sap.ui.define(['integration/pilot/controller/BaseController', 'sap/ui/model/json/JSONModel', 'integration/pilot/util/api'], (BaseController, JSONModel, api) => {
  'use strict'

  return BaseController.extend('integration.pilot.controller.Dashboard', {
    onInit() {
      this.setModel(new JSONModel({ stats: null, statsError: null, failed: [], failedBusy: true, failedError: null, proposals: [], proposalsBusy: true, proposalsError: null }), 'view')
      this.getRouter().getRoute('dashboard').attachPatternMatched(() => this.load(false))
    },

    load(fresh) {
      const m = this.getModel('view')
      m.setProperty('/statsError', null)
      api.get(`/stats${fresh ? '?fresh=true' : ''}`).then(
        (s) => m.setProperty('/stats', s),
        (e) => m.setProperty('/statsError', { message: e.hint ? `${e.message} — ${e.hint}` : e.message })
      )
      // a failed load shows its error in the card, not "nothing failed" / "no proposals yet"
      const card = (name, request) => {
        m.setProperty(`/${name}Busy`, true)
        return request
          .then(
            (d) => {
              m.setProperty(`/${name}`, d)
              m.setProperty(`/${name}Error`, null)
            },
            (e) => {
              m.setProperty(`/${name}`, [])
              m.setProperty(`/${name}Error`, e.hint ? `${e.message} — ${e.hint}` : e.message)
            }
          )
          .finally(() => m.setProperty(`/${name}Busy`, false))
      }
      return Promise.all([
        card('failed', api.get(`/messageLogs${api.q({ status: 'FAILED', sinceHours: 24, top: 20 })}`)), // the card scrolls its list
        // only the user's own: a proposal opens its conversation, and conversations are private
        card(
          'proposals',
          api.get('/me').then(({ id }) =>
            api.get(`/Proposals${api.q({ $filter: `createdBy eq '${String(id).replace(/'/g, "''")}'`, $orderby: 'createdAt desc', $top: 20, $select: 'ID,kind,status,iflowId,packageId,createdAt,session_ID' })}`)
          )
        )
      ])
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
      this.getRouter().navTo('generate', { '?query': { new: '1' } }) // a new conversation, not the last one
    },

    onProposal(e) {
      const p = e.getSource().getBindingContext('view').getObject()
      this.getRouter().navTo('generate', { '?query': { session: p.session_ID } })
    }
  })
})
