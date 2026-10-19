sap.ui.define(
  ['integration/pilot/controller/BaseController', 'sap/ui/model/json/JSONModel', 'sap/m/Dialog', 'sap/m/Button', 'sap/m/Text', 'integration/pilot/util/api'],
  (BaseController, JSONModel, Dialog, Button, Text, api) => {
    'use strict'

    return BaseController.extend('integration.pilot.controller.Activity', {
      onInit() {
        this.setModel(
          new JSONModel({ entries: [], filtered: [], actions: [], action: '', status: '', search: '', busy: true, usage: { totals: {}, byDay: [], byModel: [] }, usageDays: '30', usageBusy: false }),
          'view'
        )
        this.getRouter()
          .getRoute('activity')
          .attachPatternMatched(() => this.onRefresh())
      },

      /** AI usage of chat requests for the selected period */
      async loadUsage() {
        const m = this.getModel('view')
        m.setProperty('/usageBusy', true)
        try {
          m.setProperty('/usage', await api.get(`/usage(days=${Number(m.getProperty('/usageDays')) || 30})`))
        } catch (e) {
          // the audit log below still works without the usage summary
        } finally {
          m.setProperty('/usageBusy', false)
        }
      },

      /** "largest 262k (87 %) · 0 stopped" */
      budgetText(maxPerRequest, maxShare, stopped) {
        if (maxPerRequest == null) return ''
        return `largest ${this.formatter.tokens(maxPerRequest)} (${maxShare} %) · ${stopped || 0} stopped at the budget`
      },

      inOut(input, output) {
        return `${this.formatter.tokens(input)} / ${this.formatter.tokens(output)}`
      },

      async load() {
        const m = this.getModel('view')
        m.setProperty('/busy', true)
        try {
          const entries = await api.get(`/AuditLog${api.q({ $orderby: 'createdAt desc', $top: 500 })}`)
          m.setProperty('/entries', entries)
          const actions = [...new Set(entries.map((a) => a.action))].sort()
          m.setProperty('/actions', [{ key: '', text: 'All actions' }, ...actions.map((a) => ({ key: a, text: this.formatter.humanize(a) }))])
          this.applyFilter()
        } catch (e) {
          this.showError(e, 'The activity log could not be loaded')
        } finally {
          m.setProperty('/busy', false)
        }
      },

      onRefresh() {
        this.load()
        this.loadUsage()
      },

      applyFilter() {
        const m = this.getModel('view')
        const term = (m.getProperty('/search') || '').trim().toLowerCase()
        const action = m.getProperty('/action')
        const status = m.getProperty('/status')
        m.setProperty(
          '/filtered',
          m
            .getProperty('/entries')
            .filter(
              (a) =>
                (!action || a.action === action) &&
                (!status || a.status === status) &&
                (!term || [a.targetId, a.user, a.targetType].some((v) => v && v.toLowerCase().includes(term)))
            )
        )
      },

      onSearch(e) {
        this.getModel('view').setProperty('/search', e.getParameter('newValue'))
        this.applyFilter()
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
          content: [new Text({ text: pretty, renderWhitespace: true }).addStyleClass('ipPre')],
          endButton: new Button({ text: this.text('close'), press: () => dialog.close() }),
          afterClose: () => dialog.destroy()
        }).addStyleClass('sapUiContentPadding')
        this.getView().addDependent(dialog)
        dialog.open()
      }
    })
  }
)
