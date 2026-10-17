sap.ui.define(['sap/ui/core/UIComponent', 'sap/ui/model/json/JSONModel', 'sap/ui/Device'], (UIComponent, JSONModel, Device) => {
  'use strict'

  return UIComponent.extend('integration.pilot.Component', {
    metadata: { manifest: 'json', interfaces: ['sap.ui.core.IAsyncContentCreation'] },

    init() {
      UIComponent.prototype.init.apply(this, arguments)
      // "app": shell state shared by all pages (tenant health, current user, selected navigation item)
      this.setModel(new JSONModel({ health: null, user: null, selectedKey: 'dashboard', sideExpanded: !Device.system.tablet }), 'app')
      this.setModel(new JSONModel(Device).setDefaultBindingMode('OneWay'), 'device')
      this.getRouter().initialize()
    }
  })
})
