sap.ui.define(['integration/pilot/controller/BaseController', 'integration/pilot/util/api'], (BaseController, api) => {
  'use strict'

  const HEALTH_INTERVAL_MS = 60000

  return BaseController.extend('integration.pilot.controller.App', {
    onInit() {
      this.getOwnerComponent().getRouter().attachRouteMatched((e) => {
        const name = e.getParameter('name')
        this.getModel('app').setProperty('/selectedKey', name)
      })
      this.loadUser()
      this.loadHealth()
      this._healthTimer = setInterval(() => this.loadHealth(), HEALTH_INTERVAL_MS)
    },

    onExit() {
      clearInterval(this._healthTimer)
    },

    async loadHealth() {
      try {
        this.getModel('app').setProperty('/health', await api.get('/health'))
      } catch (e) {
        this.getModel('app').setProperty('/health', { connected: false, tenantHost: null, error: { message: e.message, hint: e.hint } })
      }
    },

    async loadUser() {
      try {
        this.getModel('app').setProperty('/user', await api.get('/me'))
      } catch (e) {
        // shown as "…" in the header; pages report their own errors
      }
    },

    onNavSelect(e) {
      const key = e.getParameter('item').getKey()
      if (key) this.getRouter().navTo(key)
    },

    onSideToggle() {
      const app = this.getModel('app')
      app.setProperty('/sideExpanded', !app.getProperty('/sideExpanded'))
    }
  })
})
