sap.ui.define(
  [
    'sap/ui/core/mvc/Controller',
    'sap/ui/core/UIComponent',
    'sap/m/MessageBox',
    'sap/m/MessageToast',
    'sap/m/Dialog',
    'sap/m/Button',
    'sap/m/Input',
    'sap/m/Label',
    'sap/m/Text',
    'sap/m/MessageStrip',
    'sap/m/VBox',
    'integration/pilot/util/formatter'
  ],
  (Controller, UIComponent, MessageBox, MessageToast, Dialog, Button, Input, Label, Text, MessageStrip, VBox, formatter) => {
    'use strict'

    return Controller.extend('integration.pilot.controller.BaseController', {
      formatter,

      getRouter() {
        return UIComponent.getRouterFor(this)
      },

      getModel(name) {
        return this.getView().getModel(name) || this.getOwnerComponent().getModel(name)
      },

      setModel(model, name) {
        return this.getView().setModel(model, name)
      },

      text(key, args) {
        return this.getOwnerComponent().getModel('i18n').getResourceBundle().getText(key, args)
      },

      toast(message) {
        MessageToast.show(message, { width: '24rem' })
      },

      /** Error from the API (message + hint) in a MessageBox */
      showError(err, title) {
        const message = title ? `${title}\n\n${err.message}` : err.message || String(err)
        MessageBox.error(message, { details: err.hint || undefined, contentWidth: '28rem' })
      },

      /** Confirmation for writes; resolves true when confirmed */
      confirm({ title, message, action = 'Confirm', danger = false }) {
        return new Promise((resolve) => {
          MessageBox[danger ? 'warning' : 'confirm'](message, {
            title,
            actions: [action, MessageBox.Action.CANCEL],
            emphasizedAction: action,
            onClose: (a) => resolve(a === action)
          })
        })
      },

      /**
       * Destructive action that requires typing an id. `run` is awaited inside the dialog;
       * on failure the dialog stays open and shows the error.
       */
      typeToConfirm({ title, message, warning, confirmText, action, run }) {
        return new Promise((resolve) => {
          const error = new MessageStrip({ type: 'Error', visible: false, showIcon: true })
          const input = new Input({ placeholder: confirmText, liveChange: (e) => ok.setEnabled(e.getParameter('value') === confirmText) })
          const ok = new Button({
            text: action,
            type: 'Reject',
            enabled: false,
            press: async () => {
              dialog.setBusy(true)
              error.setVisible(false)
              try {
                await run()
                dialog.close()
                resolve(true)
              } catch (e) {
                error.setText(e.hint ? `${e.message} — ${e.hint}` : e.message).setVisible(true)
              } finally {
                dialog.setBusy(false)
              }
            }
          })
          // setText: a constructor string with { } would be parsed as a data binding
          const content = [new Text().setText(message)]
          if (warning) content.push(new MessageStrip({ type: 'Warning', showIcon: true }).setText(warning))
          content.push(new Label({ text: `Type "${confirmText}" to confirm`, labelFor: input }), input, error)
          const dialog = new Dialog({
            title,
            type: 'Message',
            state: 'Warning',
            contentWidth: '28rem',
            content: new VBox({ items: content, renderType: 'Bare' }).addStyleClass('ipGapS'),
            beginButton: ok,
            endButton: new Button({ text: this.text('cancel'), press: () => dialog.close() }),
            afterClose: () => {
              dialog.destroy()
              resolve(false)
            }
          })
          this.getView().addDependent(dialog)
          dialog.open()
        })
      },

      /**
       * Asks for one line of text. `run(value)` is awaited inside the dialog; on failure the
       * dialog stays open and shows the error. Resolves true when `run` succeeded.
       */
      promptText({ title, label, value = '', action, run }) {
        return new Promise((resolve) => {
          let done = false
          const error = new MessageStrip({ type: 'Error', visible: false, showIcon: true })
          const submit = async () => {
            if (!input.getValue().trim()) return
            dialog.setBusy(true)
            error.setVisible(false)
            try {
              await run(input.getValue().trim())
              done = true
              dialog.close()
            } catch (e) {
              error.setText(e.hint ? `${e.message} — ${e.hint}` : e.message).setVisible(true)
            } finally {
              dialog.setBusy(false)
            }
          }
          const input = new Input({
            maxLength: 200,
            submit,
            liveChange: (e) => ok.setEnabled(!!e.getParameter('value').trim())
          }).setValue(value) // setValue: a constructor string with { } would be parsed as a data binding
          const ok = new Button({ text: action, type: 'Emphasized', enabled: !!value.trim(), press: submit })
          const dialog = new Dialog({
            title,
            contentWidth: '24rem',
            content: new VBox({ items: [new Label({ text: label, labelFor: input }), input, error], renderType: 'Bare' }).addStyleClass('ipGapS sapUiSmallMargin'),
            beginButton: ok,
            endButton: new Button({ text: this.text('cancel'), press: () => dialog.close() }),
            afterOpen: () => input.focus(),
            afterClose: () => {
              dialog.destroy()
              resolve(done)
            }
          })
          this.getView().addDependent(dialog)
          dialog.open()
        })
      }
    })
  }
)
