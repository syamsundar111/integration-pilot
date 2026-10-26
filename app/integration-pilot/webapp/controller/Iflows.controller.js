sap.ui.define(
  [
    'integration/pilot/controller/BaseController',
    'sap/ui/model/json/JSONModel',
    'integration/pilot/util/api',
    'integration/pilot/util/flowDiagram',
    'integration/pilot/util/ExplainDialog',
    'sap/m/Dialog',
    'sap/m/Button',
    'sap/m/Select',
    'sap/m/Text',
    'sap/m/VBox',
    'sap/m/MessageStrip',
    'sap/ui/core/Item'
  ],
  (BaseController, JSONModel, api, flowDiagram, ExplainDialog, Dialog, Button, Select, Text, VBox, MessageStrip, Item) => {
    'use strict'

    const MAX_ZIP_MB = 10

    return BaseController.extend('integration.pilot.controller.Iflows', {
      onInit() {
        this.setModel(
          new JSONModel({
            layout: 'OneColumn',
            backups: [],
            packages: [],
            packageId: '',
            iflows: [],
            filtered: [],
            search: '',
            busy: false,
            error: null,
            runtimeById: {},
            iflowId: null,
            selected: null,
            tab: 'overview',
            parsed: { adapters: [], scripts: [] },
            parsedBusy: false,
            parsedError: null,
            diagramHtml: '',
            configs: [],
            original: {},
            changes: 0,
            configsBusy: false,
            configsError: null,
            runtime: null,
            runtimeBusy: false,
            runtimeError: null
          }),
          'view'
        )
        this.getRouter().getRoute('iflows').attachPatternMatched(this.onRoute, this)
      },

      // --- routing: #/iflows?package=<id>&iflow=<id> ---------------------------------------

      async onRoute(e) {
        const query = e.getParameter('arguments')['?query'] || {}
        const m = this.getModel('view')
        if (!m.getProperty('/packages').length) await this.loadPackages()
        const packages = m.getProperty('/packages')
        if (!query.package) {
          // default to the first package
          if (packages.length) this.getRouter().navTo('iflows', { '?query': { package: [...packages].sort((a, b) => a.name.localeCompare(b.name))[0].id } }, true)
          return
        }
        // Compare with the package whose list is shown: /packageId alone may already hold the new value
        if (query.package !== this._listPackageId || !m.getProperty('/iflows').length) {
          m.setProperty('/packageId', query.package)
          await Promise.all([this.loadIflows(), this.loadRuntimeMap()])
        }
        if (query.iflow) this.openDetail(query.iflow)
        else {
          m.setProperty('/iflowId', null)
          m.setProperty('/layout', 'OneColumn')
        }
      },

      navigate(iflow) {
        const query = { package: this.getModel('view').getProperty('/packageId') }
        if (iflow) query.iflow = iflow
        this.getRouter().navTo('iflows', { '?query': query })
      },

      // --- list ------------------------------------------------------------------------------

      async loadPackages() {
        try {
          this.getModel('view').setProperty('/packages', await api.get('/Packages'))
        } catch (e) {
          this.getModel('view').setProperty('/error', { message: e.hint ? `${e.message} — ${e.hint}` : e.message })
        }
      },

      async loadIflows() {
        const m = this.getModel('view')
        // Only the latest request may write the list: a slower answer for a previously
        // selected package must not overwrite the list of the current one
        const request = (this._iflowsRequest = (this._iflowsRequest || 0) + 1)
        const packageId = m.getProperty('/packageId')
        m.setProperty('/busy', true)
        m.setProperty('/error', null)
        try {
          const list = await api.get(`/Packages/${api.seg(packageId)}/iflows`)
          if (request !== this._iflowsRequest) return
          this._listPackageId = packageId
          m.setProperty('/iflows', list.sort((a, b) => a.name.localeCompare(b.name)))
        } catch (e) {
          if (request !== this._iflowsRequest) return
          this._listPackageId = null
          m.setProperty('/iflows', [])
          m.setProperty('/error', { message: e.hint ? `${e.message} — ${e.hint}` : e.message })
        } finally {
          if (request === this._iflowsRequest) {
            m.setProperty('/busy', false)
            this.applyFilter()
          }
        }
      },

      async loadRuntimeMap() {
        try {
          const runtime = await api.get('/RuntimeArtifacts')
          this.getModel('view').setProperty('/runtimeById', Object.fromEntries(runtime.map((r) => [r.id, r.status])))
        } catch (e) {
          // badges show "Not deployed" if runtime data is unavailable
        }
        this.applyFilter()
      },

      applyFilter() {
        const m = this.getModel('view')
        const term = (m.getProperty('/search') || '').trim().toLowerCase()
        const runtime = m.getProperty('/runtimeById')
        const list = m
          .getProperty('/iflows')
          .filter((f) => !term || f.name.toLowerCase().includes(term) || f.id.toLowerCase().includes(term))
          .map((f) => ({ ...f, runtime: runtime[f.id] || 'NOT_DEPLOYED' }))
        m.setProperty('/filtered', list)
      },

      onSearch(e) {
        this.getModel('view').setProperty('/search', e.getParameter('newValue'))
        this.applyFilter()
      },

      onPackageChange(e) {
        this.getRouter().navTo('iflows', { '?query': { package: e.getParameter('selectedItem').getKey() } })
      },

      onRefresh() {
        this.loadIflows()
        this.loadRuntimeMap()
        if (this.getModel('view').getProperty('/iflowId')) this.loadRuntime()
      },

      onSelect(e) {
        const item = e.getParameter('listItem')
        this.navigate(item.getBindingContext('view').getProperty('id'))
      },

      // --- detail ----------------------------------------------------------------------------

      openDetail(id) {
        const m = this.getModel('view')
        const selected = m.getProperty('/iflows').find((f) => f.id === id) || { id, name: id }
        const changed = m.getProperty('/iflowId') !== id
        m.setProperty('/iflowId', id)
        m.setProperty('/selected', selected)
        if (m.getProperty('/layout') === 'OneColumn') m.setProperty('/layout', 'TwoColumnsMidExpanded')
        if (!changed) return
        m.setProperty('/tab', 'overview')
        this.loadParsed()
        this.loadConfigs()
        this.loadRuntime()
        this.loadBackups()
      },

      // --- backups from approved updates: "Restore previous version" ------------------------------

      async loadBackups() {
        const m = this.getModel('view')
        const id = m.getProperty('/iflowId')
        m.setProperty('/backups', [])
        try {
          const backups = await api.get(`/Iflows/${api.seg(id)}/backups()`)
          if (m.getProperty('/iflowId') === id) m.setProperty('/backups', backups)
        } catch (e) {
          // no backups shown; the iFlow itself still works
        }
      },

      backupText(b) {
        const when = this.formatter.dateTime(b.at || b.createdAt)
        return `${when} · version ${b.version || '?'}${b.savedVersion ? ` (also CPI version ${b.savedVersion})` : ''}`
      },

      onRestore() {
        const m = this.getModel('view')
        const id = m.getProperty('/iflowId')
        const backups = m.getProperty('/backups')
        const select = new Select({ width: '100%', items: backups.map((b) => new Item({ key: b.proposalId, text: this.backupText(b) })) })
        const dialog = new Dialog({
          title: `Restore ${id}?`,
          type: 'Message',
          state: 'Warning',
          contentWidth: '32rem',
          content: new VBox({
            renderType: 'Bare',
            items: [
              new Text({ text: 'The content this iFlow had before the chosen update is put back. Its current content is saved as a CPI version first. The restored iFlow is not deployed.' }),
              select,
              new MessageStrip({ type: 'Information', showIcon: true, text: 'Deploy the iFlow afterwards to run the restored version.' })
            ]
          }).addStyleClass('ipGapS'),
          beginButton: new Button({
            text: 'Restore',
            type: 'Emphasized',
            press: async () => {
              dialog.setBusy(true)
              try {
                const r = await api.post(`/Iflows/${api.seg(id)}/restore`, { proposalId: select.getSelectedKey() })
                dialog.close()
                this.toast(`Restored version ${r.restoredFrom.version || ''} of ${id}${r.savedCurrentAs ? `; the replaced content is CPI version ${r.savedCurrentAs}` : ''}. Deploy to activate it.`)
                if (r.warning) this.showError({ message: r.warning }, 'Restored with a warning')
                this.loadParsed()
                this.loadConfigs()
                this.loadIflows()
              } catch (e) {
                this.showError(e, 'Restore failed')
              } finally {
                dialog.setBusy(false)
              }
            }
          }),
          endButton: new Button({ text: this.text('cancel'), press: () => dialog.close() }),
          afterClose: () => dialog.destroy()
        })
        this.getView().addDependent(dialog)
        dialog.open()
      },

      async loadParsed() {
        const m = this.getModel('view')
        const id = m.getProperty('/iflowId')
        m.setProperty('/parsedBusy', true)
        m.setProperty('/parsedError', null)
        m.setProperty('/diagramHtml', '')
        m.setProperty('/parsed', { adapters: [], scripts: [] })
        try {
          const parsed = await api.get(`/Iflows/${api.seg(id)}/parsed`)
          if (m.getProperty('/iflowId') !== id) return
          m.setProperty('/parsed', parsed)
          m.setProperty('/diagramHtml', flowDiagram.toHtml(flowDiagram.fromParsed(parsed)))
        } catch (e) {
          if (m.getProperty('/iflowId') === id) m.setProperty('/parsedError', e.hint ? `${e.message} — ${e.hint}` : e.message)
        } finally {
          if (m.getProperty('/iflowId') === id) m.setProperty('/parsedBusy', false)
        }
      },

      async loadConfigs() {
        const m = this.getModel('view')
        const id = m.getProperty('/iflowId')
        m.setProperty('/configsBusy', true)
        m.setProperty('/configsError', null)
        try {
          const configs = await api.get(`/Iflows/${api.seg(id)}/configurations`)
          if (m.getProperty('/iflowId') !== id) return // another iFlow was opened meanwhile: its parameters must not be overwritten
          m.setProperty('/configs', configs.map((c) => ({ ...c, value: c.value || '' })))
          m.setProperty('/original', Object.fromEntries(configs.map((c) => [c.key, c.value || ''])))
        } catch (e) {
          if (m.getProperty('/iflowId') !== id) return
          m.setProperty('/configs', [])
          m.setProperty('/configsError', e.hint ? `${e.message} — ${e.hint}` : e.message) // not "no externalized parameters"
        } finally {
          if (m.getProperty('/iflowId') === id) {
            m.setProperty('/changes', 0)
            m.setProperty('/configsBusy', false)
          }
        }
      },

      async loadRuntime() {
        const m = this.getModel('view')
        const id = m.getProperty('/iflowId')
        if (!id) return
        m.setProperty('/runtimeBusy', true)
        try {
          const runtime = await api.get(`/Iflows/${api.seg(id)}/runtime`)
          if (m.getProperty('/iflowId') !== id) return // another iFlow was opened meanwhile
          m.setProperty('/runtime', runtime)
          m.setProperty('/runtimeError', null)
          if (runtime && runtime.status === 'ERROR') {
            const err = await api.get(`/RuntimeArtifacts/${api.seg(id)}/errorInfo`).catch(() => null)
            if (m.getProperty('/iflowId') === id) m.setProperty('/runtimeError', err && err.message)
          }
        } catch (e) {
          if (m.getProperty('/iflowId') === id) m.setProperty('/runtime', null)
        } finally {
          if (m.getProperty('/iflowId') === id) m.setProperty('/runtimeBusy', false)
        }
      },

      onCloseDetail() {
        this.navigate(null)
      },

      onToggleFullScreen() {
        const m = this.getModel('view')
        m.setProperty('/layout', m.getProperty('/layout') === 'MidColumnFullScreen' ? 'TwoColumnsMidExpanded' : 'MidColumnFullScreen')
      },

      // --- parameters --------------------------------------------------------------------------

      onParamChange() {
        const m = this.getModel('view')
        const original = m.getProperty('/original')
        m.setProperty('/changes', m.getProperty('/configs').filter((c) => c.value !== original[c.key]).length)
      },

      onResetParams() {
        const m = this.getModel('view')
        const original = m.getProperty('/original')
        m.setProperty('/configs', m.getProperty('/configs').map((c) => ({ ...c, value: original[c.key] })))
        m.setProperty('/changes', 0)
      },

      async onSaveParams() {
        const m = this.getModel('view')
        const original = m.getProperty('/original')
        const changes = m.getProperty('/configs').filter((c) => c.value !== original[c.key])
        const ok = await this.confirm({
          title: 'Save parameters?',
          message: changes.map((c) => `${c.key} = ${c.value || '(empty)'}`).join('\n'),
          action: 'Save'
        })
        if (!ok) return
        try {
          await api.post(`/Iflows/${api.seg(m.getProperty('/iflowId'))}/updateConfigurations`, {
            parameters: changes.map((c) => ({ key: c.key, value: c.value, dataType: c.dataType }))
          })
          this.toast('Parameters saved. Redeploy the iFlow to apply them at runtime.')
          this.loadConfigs()
        } catch (e) {
          this.showError(e, 'Saving the parameters failed')
        }
      },

      // --- actions -----------------------------------------------------------------------------

      async onDownload() {
        const id = this.getModel('view').getProperty('/iflowId')
        try {
          await api.download(`/Iflows/${api.seg(id)}/download`, `${id}.zip`)
        } catch (e) {
          this.showError(e, 'Download failed')
        }
      },

      async onDeploy() {
        const id = this.getModel('view').getProperty('/iflowId')
        const ok = await this.confirm({
          title: `Deploy ${id}?`,
          message: 'The current design-time version is deployed to the runtime. Make sure the iFlow is closed in the CPI web editor.',
          action: 'Deploy'
        })
        if (!ok) return
        try {
          await api.post(`/Iflows/${api.seg(id)}/deploy`)
          this.toast(`Deployment triggered. It can take a few minutes until ${id} shows a runtime status (longer on trial tenants).`)
          this.afterRuntimeChange()
        } catch (e) {
          this.showError(e, 'Deployment failed')
        }
      },

      async onUndeploy() {
        const id = this.getModel('view').getProperty('/iflowId')
        const ok = await this.confirm({ title: `Undeploy ${id}?`, message: 'The iFlow stops processing messages. The design-time artifact is kept.', action: 'Undeploy', danger: true })
        if (!ok) return
        try {
          await api.post(`/Iflows/${api.seg(id)}/undeploy`)
          this.toast(`Undeployed ${id}`)
          this.afterRuntimeChange()
        } catch (e) {
          this.showError(e, 'Undeploy failed')
        }
      },

      afterRuntimeChange() {
        this.loadRuntime()
        this.loadRuntimeMap()
        // deployments take a while; check again shortly
        setTimeout(() => {
          this.loadRuntime()
          this.loadRuntimeMap()
        }, 8000)
      },

      async onDelete() {
        const m = this.getModel('view')
        const id = m.getProperty('/iflowId')
        const deleted = await this.typeToConfirm({
          title: 'Delete iFlow',
          message: 'This permanently deletes the design-time artifact from the tenant.',
          warning: m.getProperty('/runtime') ? 'This iFlow is deployed. Undeploy it first, otherwise the runtime artifact keeps running.' : undefined,
          confirmText: id,
          action: 'Delete iFlow',
          run: () => api.del(`/Iflows/${api.seg(id)}`)
        })
        if (deleted) {
          this.toast(`iFlow deleted: ${id}`)
          this.navigate(null)
          this.loadIflows()
        }
      },

      onExplain() {
        const m = this.getModel('view')
        ExplainDialog.open(this.getView(), { iflowId: m.getProperty('/iflowId'), label: m.getProperty('/selected/name') })
      },

      // --- explain from ZIP ----------------------------------------------------------------------

      onZipSelected(e) {
        const file = (e.getParameter('files') || [])[0]
        if (!file) return
        if (file.size > MAX_ZIP_MB * 1024 * 1024) return this.showError({ message: `The file is larger than ${MAX_ZIP_MB} MB.` })
        const reader = new FileReader()
        reader.onload = () => {
          const zipBase64 = String(reader.result).replace(/^data:[^,]*,/, '')
          ExplainDialog.open(this.getView(), { zipBase64, label: file.name })
          e.getSource().clear()
        }
        reader.onerror = () => this.showError({ message: 'The file could not be read.' })
        reader.readAsDataURL(file)
      },

      onZipTypeMismatch() {
        this.showError({ message: 'Please choose a .zip file.', hint: 'Upload the .zip of a single iFlow (iFlows page → Download ZIP, or Export in the CPI web editor).' })
      }
    })
  }
)
