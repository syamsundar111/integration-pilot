sap.ui.define(['integration/pilot/controller/BaseController', 'sap/ui/model/json/JSONModel', 'sap/ui/core/Fragment', 'integration/pilot/util/api'], (BaseController, JSONModel, Fragment, api) => {
  'use strict'

  const PACKAGE_ID = /^[A-Za-z0-9.]+$/ // CPI rejects underscores and other special characters

  return BaseController.extend('integration.pilot.controller.Packages', {
    onInit() {
      this.setModel(new JSONModel({ packages: [], filtered: [], search: '', busy: true, error: null, form: {} }), 'view')
      this.getRouter()
        .getRoute('packages')
        .attachPatternMatched((e) => {
          // the list is already current after the create dialog dropped "?new=1" (see onDialogClosed)
          if (this._skipLoad) this._skipLoad = false
          else this.load()
          const query = e.getParameter('arguments')['?query'] || {}
          if (query.new === '1') this.onCreate()
        })
    },

    async load() {
      const m = this.getModel('view')
      m.setProperty('/busy', true)
      m.setProperty('/error', null)
      try {
        m.setProperty('/packages', (await api.get('/Packages')).sort((a, b) => (a.name || '').localeCompare(b.name || '')))
        this.applyFilter()
      } catch (e) {
        m.setProperty('/error', { message: e.hint ? `${e.message} — ${e.hint}` : e.message })
      } finally {
        m.setProperty('/busy', false)
      }
    },

    applyFilter() {
      const m = this.getModel('view')
      const term = (m.getProperty('/search') || '').trim().toLowerCase()
      const all = m.getProperty('/packages')
      m.setProperty('/filtered', term ? all.filter((p) => [p.name, p.id, p.shortText].some((v) => v && v.toLowerCase().includes(term))) : all)
    },

    onSearch(e) {
      this.getModel('view').setProperty('/search', e.getParameter('newValue'))
      this.applyFilter()
    },

    onOpenIflows(e) {
      const p = e.getSource().getBindingContext('view').getObject()
      this.getRouter().navTo('iflows', { '?query': { package: p.id } })
    },

    // --- create / edit dialog ------------------------------------------------------

    async openDialog(form) {
      this.getModel('view').setProperty('/form', { busy: false, error: null, idError: null, ...form })
      if (!this._dialog) {
        this._dialog = await Fragment.load({ id: this.getView().getId(), name: 'integration.pilot.fragment.PackageDialog', controller: this })
        this.getView().addDependent(this._dialog)
      }
      this._dialog.open()
    },

    onCreate() {
      this.openDialog({ mode: 'create', id: '', name: '', shortText: '', description: '', version: '1.0.0' })
    },

    onEdit(e) {
      const p = e.getSource().getBindingContext('view').getObject()
      const description = (p.description || '').replace(/<[^>]+>/g, '') // shown as plain text
      this.openDialog({
        mode: 'edit',
        id: p.id,
        name: p.name,
        shortText: p.shortText || '',
        description,
        descriptionShown: description,
        version: p.version || '1.0.0'
      })
    },

    onIdChange(e) {
      const id = e.getParameter('value')
      this.getModel('view').setProperty('/form/idError', id && !PACKAGE_ID.test(id) ? 'Use letters, digits and dots only — CPI does not allow underscores or other special characters' : null)
    },

    async onSave() {
      const m = this.getModel('view')
      const f = m.getProperty('/form')
      m.setProperty('/form/busy', true)
      m.setProperty('/form/error', null)
      try {
        // an unchanged description is not sent: CPI keeps it with its formatting (HTML), which the
        // plain-text field above would otherwise strip
        const description = f.mode === 'create' || f.description !== f.descriptionShown ? f.description : undefined
        const body = { name: f.name, shortText: f.shortText || f.name, description, version: f.version }
        const saved = f.mode === 'create' ? await api.post('/Packages', { id: f.id, ...body }) : await api.patch(`/Packages/${api.seg(f.id)}`, body)
        this.toast(f.mode === 'create' ? `Package created: ${saved.name}` : `Package updated: ${saved.name}`)
        this._dialog.close()
        this.load()
      } catch (err) {
        m.setProperty('/form/error', err.hint ? `${err.message} — ${err.hint}` : err.message)
      } finally {
        m.setProperty('/form/busy', false)
      }
    },

    onCancelDialog() {
      this._dialog.close()
    },

    onDialogClosed() {
      // drop "?new=1" so a refresh does not reopen the dialog
      const hash = window.location.hash
      if (/new=1/.test(hash)) {
        this._skipLoad = true
        this.getRouter().navTo('packages', {}, true)
      }
    },

    // --- delete ----------------------------------------------------------------------

    async onDelete(e) {
      const p = e.getSource().getBindingContext('view').getObject()
      let warning
      try {
        const [iflows, runtime] = await Promise.all([api.get(`/Packages/${api.seg(p.id)}/iflows`), api.get('/RuntimeArtifacts')])
        const deployed = new Set(runtime.map((r) => r.id))
        const hits = iflows.filter((f) => deployed.has(f.id)).map((f) => f.id)
        if (hits.length) warning = `${hits.length} deployed iFlow${hits.length === 1 ? '' : 's'} in this package (${hits.join(', ')}) — undeploy them first, otherwise they keep running or the deletion fails.`
      } catch (err) {
        // the check is best effort; deletion itself reports CPI errors
      }
      const deleted = await this.typeToConfirm({
        title: 'Delete package',
        message: `This permanently deletes "${p.name}" and all iFlows in it from the tenant.`,
        warning,
        confirmText: p.id,
        action: 'Delete package',
        run: () => api.del(`/Packages/${api.seg(p.id)}`)
      })
      if (deleted) {
        this.toast(`Package deleted: ${p.id}`)
        this.load()
      }
    }
  })
})
