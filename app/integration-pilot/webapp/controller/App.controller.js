sap.ui.define(['integration/pilot/controller/BaseController', 'integration/pilot/util/api'], (BaseController, api) => {
  'use strict'

  const HEALTH_INTERVAL_MS = 60000

  return BaseController.extend('integration.pilot.controller.App', {
    onInit() {
      const router = this.getOwnerComponent().getRouter()
      router.attachRouteMatched((e) => {
        const name = e.getParameter('name')
        this.getModel('app').setProperty('/selectedKey', name)
      })
      // "Page not found" is no route: no menu entry is highlighted (not the page shown before);
      // an empty key alone leaves the previous item selected in the SideNavigation
      router.attachBypassed(() => {
        this.getModel('app').setProperty('/selectedKey', '')
        this.byId('sideNav').setSelectedItem(null)
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
      // Generate from the menu continues the conversation open last (the page resolves ?resume=1)
      if (key === 'generate') this.getRouter().navTo('generate', { '?query': { resume: '1' } })
      else if (key) this.getRouter().navTo(key)
    },

    onSideToggle() {
      const app = this.getModel('app')
      app.setProperty('/sideExpanded', !app.getProperty('/sideExpanded'))
    }
  })
})
