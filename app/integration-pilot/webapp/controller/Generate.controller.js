sap.ui.define(
  [
    'integration/pilot/controller/BaseController',
    'sap/ui/model/json/JSONModel',
    'sap/m/Dialog',
    'sap/m/Button',
    'sap/m/TextArea',
    'sap/m/Label',
    'sap/m/VBox',
    'sap/m/MessageStrip',
    'integration/pilot/util/api',
    'integration/pilot/util/markdown',
    'integration/pilot/util/flowDiagram',
    'integration/pilot/util/promptLint'
  ],
  (BaseController, JSONModel, Dialog, Button, TextArea, Label, VBox, MessageStrip, api, markdown, flowDiagram, promptLint) => {
    'use strict'

    const POLL_MS = 2000
    const PACKAGE_ID = /^[A-Za-z0-9.]+$/ // CPI rejects underscores and other special characters
    const NO_DEFAULTS = { packageId: '', timer: '', authNote: '' }
    const MAX_ATTACHMENT_KB = 200
    const MAX_IMPORT_MB = 10
    const ATTACHMENT_NAME = /^([A-Za-z][A-Za-z0-9_]*\.groovy|[A-Za-z][A-Za-z0-9_.-]*\.xslt?)$/
    const STEP_TYPES = {
      contentModifier: 'Content Modifier',
      groovyScript: 'Groovy Script',
      jsonToXml: 'JSON to XML',
      xmlToJson: 'XML to JSON',
      requestReplyHttp: 'Request Reply (HTTP)'
    }

    const esc = markdown.escape
    const userHtml = (text) => `<p>${esc(text).replace(/\n/g, '<br>')}</p>`

    // --- closest existing package (typos, case, partial names) — same rules as the agent ---
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    function distance(a, b) {
      let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
      for (let i = 1; i <= a.length; i++) {
        const cur = [i]
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = cur
      }
      return prev[b.length]
    }
    function closestPackage(packages, requested) {
      const want = norm(requested)
      if (!want) return null
      const scored = packages
        .map((p) => {
          const id = norm(p.id)
          const name = norm(p.name)
          const score = id === want || name === want ? 0 : id.includes(want) || want.includes(id) || name.includes(want) ? 1 : Math.min(distance(id, want), distance(name, want))
          return { p, score }
        })
        .filter((x) => x.score <= Math.max(2, Math.floor(want.length / 4)))
        .sort((a, b) => a.score - b.score)
      return scored.length ? scored[0].p : null
    }

    return BaseController.extend('integration.pilot.controller.Generate', {
      onInit() {
        this.setModel(
          new JSONModel({
            sessions: [],
            sessionId: '',
            messages: [],
            input: '',
            turn: null,
            starting: false,
            loadingSession: false,
            proposals: [],
            activeId: null,
            active: null,
            packages: [],
            pkg: { editing: false },
            defaults: { ...NO_DEFAULTS },
            importing: false,
            files: [] // attached files: { fileName, pending, content? } (pending: sent with the next message) or stored { ID, fileName, lines, origin }
          }),
          'chat'
        )
        this.getRouter().getRoute('generate').attachPatternMatched(this.onRoute, this)
      },

      onAfterRendering() {
        // Enter sends, Shift+Enter adds a new line
        const input = this.byId('input')
        if (!this._keyHandler) {
          this._keyHandler = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              this.onSend()
            }
          }
          input.attachBrowserEvent('keydown', this._keyHandler)
        }
      },

      onExit() {
        this.stopTurnPolling()
        this.stopProposalPolling()
      },

      chat() {
        return this.getModel('chat')
      },

      // --- sessions & routing: #/generate?session=<id> -----------------------------------------

      onRoute(e) {
        const query = e.getParameter('arguments')['?query'] || {}
        const sessionId = query.session || ''
        this.loadSessions()
        this.loadPackages()
        if (sessionId === this._skipLoad) return // session just created by sending
        this.chat().setProperty('/sessionId', sessionId)
        this.loadSession(sessionId)
      },

      async loadSessions() {
        try {
          const sessions = await api.get(`/ChatSessions${api.q({ $orderby: 'modifiedAt desc', $top: 30, $select: 'ID,title,modifiedAt' })}`)
          this.chat().setProperty('/sessions', sessions)
        } catch (e) {
          // history is optional
        }
      },

      async loadPackages() {
        try {
          this.chat().setProperty('/packages', await api.get('/Packages'))
          this.refreshActive()
        } catch (e) {
          // the package check is skipped without package data
        }
      },

      async loadSession(sessionId) {
        const c = this.chat()
        this.stopTurnPolling()
        c.setProperty('/turn', null)
        if (!sessionId) {
          c.setProperty('/messages', [])
          c.setProperty('/proposals', [])
          c.setProperty('/defaults', { ...NO_DEFAULTS })
          c.setProperty('/files', [])
          this.setActive(null)
          return
        }
        c.setProperty('/loadingSession', true)
        try {
          const [session, msgs, proposals, running] = await Promise.all([
            api.get(`/ChatSessions/${api.seg(sessionId)}`),
            api.get(`/ChatSessions/${api.seg(sessionId)}/messages${api.q({ $orderby: 'seq' })}`),
            api.get(`/Proposals${api.q({ $filter: `session_ID eq ${sessionId}`, $orderby: 'createdAt desc' })}`),
            api.get(`/ChatTurns${api.q({ $filter: `session_ID eq ${sessionId} and status eq 'RUNNING'`, $top: 1 })}`)
          ])
          const messages = msgs
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
            .map((m) => this.toMessage(m.role, m.content, m.usage ? JSON.parse(m.usage) : null))
          if (running[0]) {
            // the running turn's messages are stored when it finishes; show its question meanwhile
            messages.push(this.toMessage('user', running[0].message))
            this.startTurnPolling(running[0].ID, new Date(running[0].createdAt).getTime(), running[0].events || [])
          }
          c.setProperty('/messages', messages)
          c.setProperty('/defaults', { ...NO_DEFAULTS, ...(session.defaults ? JSON.parse(session.defaults) : {}) })
          c.setProperty('/files', [])
          this.loadAttachments(sessionId)
          c.setProperty('/proposals', proposals)
          this.setActive(proposals[0] ? proposals[0].ID : null)
          this.scrollChat()
        } catch (e) {
          this.showError(e, 'Could not load the conversation')
        } finally {
          c.setProperty('/loadingSession', false)
        }
      },

      onSessionsOpen(e) {
        this.loadSessions()
        this.byId('sessionPopover').openBy(e.getSource())
      },

      onSessionPick(e) {
        const id = e.getSource().getBindingContext('chat').getProperty('ID')
        this.byId('sessionPopover').close()
        this._skipLoad = null
        this.getRouter().navTo('generate', { '?query': { session: id } })
      },

      async onDeleteSession(e) {
        const { ID, title } = e.getParameter('listItem').getBindingContext('chat').getObject()
        const ok = await this.confirm({
          title: 'Delete conversation',
          message: `Delete "${title || 'Untitled'}" and its chat history? Pending proposals of this conversation are deleted too. iFlows and packages already created on the tenant are not affected.`,
          action: 'Delete',
          danger: true
        })
        if (!ok) return
        try {
          await api.post(`/ChatSessions/${api.seg(ID)}/remove`)
          this.toast('Conversation deleted')
          if (ID === this.chat().getProperty('/sessionId')) {
            this.byId('sessionPopover').close()
            this.onNewChat()
          }
          this.loadSessions()
        } catch (err) {
          this.showError(err, 'Could not delete the conversation')
        }
      },

      onNewChat() {
        this._skipLoad = null
        this.chat().setProperty('/input', '')
        this.getRouter().navTo('generate')
        setTimeout(() => this.byId('input').focus(), 100)
      },

      // --- messages ------------------------------------------------------------------------------

      /** @param {object} [usage] AI usage of the turn this answer ends (shown under it) */
      toMessage(role, content, usage) {
        const extra = { usage: usage || null, usageText: this.formatter.usageLine(usage) }
        if (role === 'user') return { kind: 'user', html: userHtml(content), usage: null, usageText: '' }
        if (content.startsWith('⚠️')) return { kind: 'error', html: userHtml(content.replace(/^⚠️\s*/, '')), ...extra }
        if (content === 'Cancelled.') return { kind: 'muted', html: userHtml(content), ...extra }
        return { kind: 'assistant', html: markdown.toHtml(content), ...extra }
      },

      addMessage(msg) {
        this.chat().setProperty('/messages', [...this.chat().getProperty('/messages'), msg])
        this.scrollChat()
      },

      scrollChat() {
        setTimeout(() => {
          const dom = this.byId('chatScroll') && this.byId('chatScroll').getDomRef()
          if (dom) dom.scrollTop = dom.scrollHeight
        }, 60)
      },

      /** Fills the composer with the request template (trigger / steps / receivers / auth / package / error handling) */
      onUseTemplate() {
        this.chat().setProperty('/input', promptLint.TEMPLATE)
        setTimeout(() => this.byId('input').focus(), 50)
      },

      onSend() {
        this.send(this.chat().getProperty('/input'))
      },

      /**
       * Shows the prompt linter's warnings; resolves true for "Send anyway", false for "Edit"
       * @param {{ key: string, message: string }[]} warnings
       */
      confirmWarnings(warnings) {
        return new Promise((resolve) => {
          let choice = false
          const close = (send) => {
            choice = send
            dialog.close()
          }
          const dialog = new Dialog({
            title: 'Check your request',
            type: 'Message',
            state: 'Warning',
            contentWidth: '32rem',
            content: new VBox({
              renderType: 'Bare',
              items: warnings.map((w) => new MessageStrip({ text: w.message, type: 'Warning', showIcon: true }))
            }).addStyleClass('ipGapS'),
            beginButton: new Button({ text: 'Send anyway', type: 'Emphasized', press: () => close(true) }),
            endButton: new Button({ text: 'Edit', press: () => close(false) }),
            afterClose: () => {
              dialog.destroy()
              resolve(choice)
            }
          })
          this.getView().addDependent(dialog)
          dialog.open()
        })
      },

      async send(text) {
        const c = this.chat()
        const message = (text || '').trim()
        if (!message || c.getProperty('/turn') || c.getProperty('/starting')) return
        const defaults = this.currentDefaults()
        const warnings = promptLint.lint(message, { defaults })
        if (warnings.length && !(await this.confirmWarnings(warnings))) {
          setTimeout(() => this.byId('input').focus(), 50)
          return
        }
        c.setProperty('/input', '')
        this.addMessage(this.toMessage('user', message))
        c.setProperty('/starting', true)
        const sessionId = c.getProperty('/sessionId')
        try {
          // the defaults go with every message as structured context; the server stores them on the session
          const pending = c.getProperty('/files').filter((f) => f.pending)
          const attachments = pending.map((f) => ({ fileName: f.fileName, content: f.content }))
          const started = await api.post('/chat', { ...(sessionId && { sessionId }), message, defaults, ...(attachments.length && { attachments }) })
          this.startTurnPolling(started.turnId, Date.now(), [])
          if (attachments.length) this.loadAttachments(started.sessionId)
          if (!sessionId) {
            this._skipLoad = started.sessionId
            c.setProperty('/sessionId', started.sessionId)
            this.getRouter().navTo('generate', { '?query': { session: started.sessionId } }, true)
            this.loadSessions() // the new conversation's title on the button
          }
        } catch (e) {
          this.addMessage({ kind: 'error', html: userHtml(e.message + (e.hint ? `\n${e.hint}` : '')) })
        } finally {
          c.setProperty('/starting', false)
        }
      },

      // --- session defaults (package, timer, auth note) ---------------------------------------------

      /** The defaults panel's values, trimmed */
      currentDefaults() {
        const d = this.chat().getProperty('/defaults')
        return { packageId: d.packageId.trim(), timer: d.timer, authNote: d.authNote.trim() }
      },

      /** Panel header: what is set */
      defaultsSummary(packageId, timer, authNote) {
        const parts = [packageId && `package ${packageId.trim()}`, timer === 'once' && 'timer, run once', authNote && authNote.trim() && 'auth note'].filter(Boolean)
        return parts.length ? parts.join(' · ') : 'none set: the assistant asks for package, trigger and authentication'
      },

      defaultsPackageState(packageId) {
        return packageId && !PACKAGE_ID.test(packageId.trim()) ? 'Error' : 'None'
      },

      // --- AI usage ---------------------------------------------------------------------------------

      /** Session total over the answers' usage: "This conversation: 3 requests · 90.0k tokens · 10 model calls" */
      sessionUsageText(messages) {
        const used = (messages || []).map((m) => m.usage).filter((u) => u && u.modelCalls)
        if (!used.length) return ''
        const sum = (k) => used.reduce((n, u) => n + (u[k] || 0), 0)
        return `This conversation: ${used.length} request${used.length === 1 ? '' : 's'} · ${this.formatter.tokens(sum('totalTokens'))} tokens (${this.formatter.tokens(
          sum('inputTokens')
        )} in / ${this.formatter.tokens(sum('outputTokens'))} out) · ${sum('modelCalls')} model calls`
      },

      // --- attached files (.groovy, .xsl): the model sees their names, the builder uses their content ---

      async loadAttachments(sessionId) {
        try {
          const stored = await api.get(`/Attachments${api.q({ $filter: `session_ID eq ${sessionId}`, $select: 'ID,fileName,lines,origin', $orderby: 'fileName' })}`)
          if (this.chat().getProperty('/sessionId') !== sessionId) return
          this.chat().setProperty('/files', stored.map((f) => ({ ...f, pending: false })))
        } catch (e) {
          // the list is informational
        }
      },

      async onAttach(e) {
        const chosen = Array.from(e.getParameter('files') || [])
        e.getSource().clear()
        const c = this.chat()
        for (const file of chosen) {
          if (!ATTACHMENT_NAME.test(file.name))
            return this.showError({
              message: `${file.name}: attach .groovy or .xsl/.xslt files named like mapUsers.groovy or transform.xsl.`,
              hint: 'The name of a Groovy file (without .groovy) becomes the script fileName in the iFlow: a letter, then letters, digits or underscore.'
            })
          if (file.size > MAX_ATTACHMENT_KB * 1024) return this.showError({ message: `${file.name} is larger than ${MAX_ATTACHMENT_KB} KB.` })
          const content = await file.text()
          const others = c.getProperty('/files').filter((f) => !(f.pending && f.fileName === file.name))
          c.setProperty('/files', [...others, { fileName: file.name, pending: true, content }])
        }
      },

      onAttachTypeMismatch() {
        this.showError({ message: 'Attach Groovy (.groovy) or XSLT (.xsl, .xslt) files.' })
      },

      fileTokenText(fileName, pending, lines, origin) {
        if (pending) return `${fileName} · sent with your next message`
        return `${fileName} · ${lines} lines${origin === 'iflow' ? ' · from the iFlow' : ''}`
      },

      async onFileDelete(e) {
        const c = this.chat()
        for (const token of e.getParameter('tokens') || []) {
          const f = token.getBindingContext('chat').getObject()
          if (f.pending) c.setProperty('/files', c.getProperty('/files').filter((x) => x !== f))
          else
            try {
              await api.post(`/Attachments/${api.seg(f.ID)}/remove`)
              c.setProperty('/files', c.getProperty('/files').filter((x) => x.ID !== f.ID))
            } catch (err) {
              this.showError(err, `Could not remove ${f.fileName}`)
            }
        }
      },

      // --- import an iFlow (.zip / .iflw) as the conversation's draft spec ------------------------------

      async onImport(e) {
        const file = (e.getParameter('files') || [])[0]
        e.getSource().clear()
        if (!file) return
        if (file.size > MAX_IMPORT_MB * 1024 * 1024) return this.showError({ message: `${file.name} is larger than ${MAX_IMPORT_MB} MB.` })
        const c = this.chat()
        c.setProperty('/importing', true)
        try {
          const contentBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
            reader.onerror = () => reject(new Error('The file could not be read.'))
            reader.readAsDataURL(file)
          })
          const sessionId = c.getProperty('/sessionId')
          const packageId = this.currentDefaults().packageId
          const result = await api.post('/importIflow', { ...(sessionId && { sessionId }), fileName: file.name, contentBase64, ...(packageId && { packageId }) })
          this.toast(`Imported ${result.spec.id}${result.placeholders ? ` — ${result.placeholders} placeholder(s) to replace` : ''}`)
          this._skipLoad = null
          if (result.sessionId === sessionId) await this.loadSession(sessionId)
          else this.getRouter().navTo('generate', { '?query': { session: result.sessionId } })
          c.setProperty('/input', 'Propose the imported iFlow as a new iFlow.')
        } catch (err) {
          this.showError(err, `Could not import ${file.name}`)
        } finally {
          c.setProperty('/importing', false)
        }
      },

      onImportTypeMismatch() {
        this.showError({ message: 'Import a .zip export of an iFlow or a .iflw file.' })
      },

      // --- async turn: poll GET /api/chat/turns/{id} every 2s --------------------------------------

      startTurnPolling(turnId, startedAt, events) {
        const c = this.chat()
        this.stopTurnPolling()
        c.setProperty('/turn', { id: turnId, startedAt, seconds: 0, cancelling: false, events: this.toEvents(events) })
        this._tick = setInterval(() => c.setProperty('/turn/seconds', Math.max(0, Math.round((Date.now() - startedAt) / 1000))), 1000)
        const poll = async () => {
          try {
            const t = await api.get(`/chat/turns/${api.seg(turnId)}`)
            if (!c.getProperty('/turn') || c.getProperty('/turn/id') !== turnId) return
            if (t.status === 'RUNNING') {
              c.setProperty('/turn/events', this.toEvents(t.events))
              if (t.cancelRequested) c.setProperty('/turn/cancelling', true)
              this.scrollChat()
            } else this.finishTurn(t)
          } catch (e) {
            // transient network error: keep polling
          }
        }
        poll()
        this._poll = setInterval(poll, POLL_MS)
      },

      stopTurnPolling() {
        clearInterval(this._poll)
        clearInterval(this._tick)
      },

      toEvents(events) {
        const list = events && events.length ? events : [{ label: 'Thinking…' }]
        return list.map((e, i) => ({ label: e.label, detail: e.detail || '', current: i === list.length - 1 }))
      },

      finishTurn(t) {
        this.stopTurnPolling()
        const c = this.chat()
        const usage = { modelCalls: t.modelCalls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, totalTokens: t.totalTokens, durationMs: t.durationMs, model: t.model }
        if (t.status === 'DONE') this.addMessage(this.toMessage('assistant', t.text || '', usage))
        else if (t.status === 'CANCELLED') this.addMessage(this.toMessage('assistant', 'Cancelled.', usage))
        else {
          const err = t.error || { message: 'The assistant failed.' }
          this.addMessage({ kind: 'error', html: userHtml(err.message + (err.hint ? `\n${err.hint}` : '')), usage, usageText: this.formatter.usageLine(usage) })
          if (err.code === 'LLM_RATE_LIMITED') this.toast('AI rate limit reached — wait a minute before the next message.')
        }
        const created = t.proposals || []
        if (created.length) {
          const existing = c.getProperty('/proposals').filter((p) => !created.some((x) => x.ID === p.ID))
          c.setProperty('/proposals', [...created.slice().reverse(), ...existing])
          this.setActive(created[created.length - 1].ID)
          this.fetchProposal(created[created.length - 1].ID) // full record incl. result/packageName
        }
        c.setProperty('/turn', null)
        this.loadSessions()
        setTimeout(() => this.byId('input').focus(), 50)
      },

      async onCancel() {
        const c = this.chat()
        const turn = c.getProperty('/turn')
        if (!turn) return
        c.setProperty('/turn/cancelling', true)
        try {
          await api.post(`/chat/turns/${api.seg(turn.id)}/cancel`)
        } catch (e) {
          // 409: it finished meanwhile; the next poll picks up the result
          if (e.status !== 409) this.showError(e, 'Could not cancel')
        }
      },

      // --- proposals ---------------------------------------------------------------------------------

      onProposalTab(e) {
        this.setActive(e.getParameter('key'))
      },

      setActive(id) {
        this.chat().setProperty('/activeId', id)
        this.chat().setProperty('/pkg', { editing: false })
        this.refreshActive(true)
        this.stopProposalPolling()
        const p = this.currentProposal()
        if (p && (p.status === 'APPROVED' || p.result === undefined)) this.startProposalPolling(p.ID)
      },

      currentProposal() {
        const c = this.chat()
        return c.getProperty('/proposals').find((p) => p.ID === c.getProperty('/activeId')) || null
      },

      updateProposal(p) {
        const c = this.chat()
        c.setProperty('/proposals', c.getProperty('/proposals').map((x) => (x.ID === p.ID ? { ...x, ...p } : x)))
        if (p.ID === c.getProperty('/activeId')) this.refreshActive()
      },

      async fetchProposal(id) {
        try {
          this.updateProposal(await api.get(`/Proposals/${api.seg(id)}`))
        } catch (e) {
          // keep what we have
        }
      },

      startProposalPolling(id) {
        this.stopProposalPolling()
        const poll = async () => {
          await this.fetchProposal(id)
          const p = this.currentProposal()
          if (!p || p.ID !== id || p.status !== 'APPROVED') this.stopProposalPolling()
        }
        poll()
        this._proposalPoll = setInterval(poll, POLL_MS)
      },

      stopProposalPolling() {
        clearInterval(this._proposalPoll)
      },

      /**
       * Tab label of a proposal: several proposals of one conversation can target the same iFlow
       * (create, then updates), so the label says what the proposal does and when it was made
       */
      proposalTabText(iflowId, packageId, kind, operation, createdAt) {
        const what = kind === 'PACKAGE' ? 'New package' : operation === 'UPDATE' ? 'Update' : 'Create'
        const d = createdAt ? new Date(createdAt) : null
        const time = d && !isNaN(d) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
        return [iflowId || packageId, what, time].filter(Boolean).join(' · ')
      },

      /** Builds the view model of the active proposal (chat>/active) */
      refreshActive(resetPackageEditor) {
        const c = this.chat()
        const p = this.currentProposal()
        if (!p) return c.setProperty('/active', null)
        const isIflow = p.kind === 'IFLOW'
        const isUpdate = isIflow && p.operation === 'UPDATE'
        const spec = p.spec || {}
        const r = p.result || {}
        const pending = p.status === 'PENDING'
        const packages = c.getProperty('/packages')
        const current = packages.find((x) => x.id === p.packageId)
        const showPackage = isIflow && !isUpdate && pending && packages.length > 0
        const needsPackage = showPackage && !current && !p.packageName

        const active = {
          ID: p.ID,
          isIflow,
          pending,
          status: p.status,
          spec,
          title: spec.name || p.iflowId || p.packageId,
          subtitle: `${isUpdate ? 'Update of ' : ''}${isIflow ? p.iflowId : p.packageId}${isIflow ? ` in ${p.packageId}` : ''} · ${this.formatter.relativeTime(p.createdAt)}`,
          showPackage,
          needsPackage,
          isUpdate,
          packageSummary: current
            ? `Target package <strong>${esc(current.name)}</strong> <code>${esc(current.id)}</code>`
            : `New package <strong>${esc(p.packageName || '')}</strong> <code>${esc(p.packageId || '')}</code> is created on approval`,
          packageHeading: needsPackage ? `Package "${p.packageId}" does not exist on the tenant` : 'Change target package',
          packageHint: '',
          showExecution: !pending && p.status !== 'REJECTED' && !!(r.steps && r.steps.length),
          execSteps: (r.steps || []).map((s) => ({ ...s, detail: s.detail || '' })),
          doneText: p.status === 'DONE' && !r.warning ? (isIflow ? `${isUpdate ? 'Updated' : 'Created'} ${p.iflowId}${r.runtimeStatus ? ` · runtime ${r.runtimeStatus}` : ''}` : `Created package ${p.packageId}`) : '',
          warningText: p.status === 'DONE' && r.warning ? `${isUpdate ? 'Updated' : 'Created'} — deployment still in progress. ${r.warning}` : '',
          errorText: p.status === 'FAILED' ? `Execution failed: ${p.error || ''}` : '',
          rejectedText: p.status === 'REJECTED' ? `Rejected: ${r.reason || 'no reason given'}` : '',
          diagramHtml: '',
          stepCards: [],
          params: [],
          scripts: [],
          resourcesText: '',
          hasHttpReceiver: false
        }

        const stepCard = (s, prefix) => ({
          title: `${prefix} ${s.name || STEP_TYPES[s.type]}`,
          type: STEP_TYPES[s.type] || s.type,
          description: s.description || '',
          lines:
            s.type === 'contentModifier'
              ? [
                  ...(s.headers || []).map((h) => `header ${h.name} = ${h.value} (${h.type})`),
                  ...(s.properties || []).map((x) => `property ${x.name} = ${x.value} (${x.type})`),
                  s.body ? `body = ${s.body.length > 80 ? `${s.body.slice(0, 80)}…` : s.body}` : null
                ]
                  .filter(Boolean)
                  .join('\n')
              : s.type === 'requestReplyHttp'
                ? `${s.method} ${s.url}`
                : s.type === 'groovyScript'
                  ? `script/${s.fileName}.groovy${s.code == null ? ' (attached file)' : ''}`
                  : ''
        })

        if (isIflow && spec.trigger) {
          active.diagramHtml = flowDiagram.toHtml(flowDiagram.fromSpec(spec))
          active.stepCards = [
            { title: 'Trigger', type: spec.trigger.type === 'httpsSender' ? 'HTTPS sender' : 'Timer', lines: spec.trigger.type === 'httpsSender' ? spec.trigger.address : 'Runs once after deployment' },
            ...spec.steps.map((s, i) => stepCard(s, `${i + 1}.`)),
            { title: 'End', type: spec.end.type === 'httpReceiver' ? 'HTTP receiver' : 'No receiver', lines: spec.end.type === 'httpReceiver' ? `${spec.end.method} ${spec.end.url}` : '' },
            ...(spec.exceptionSubprocess
              ? [
                  { title: spec.exceptionSubprocess.name || 'Exception Subprocess 1', type: 'Exception Subprocess', lines: 'Runs when a step fails; its result is returned to the sender' },
                  ...spec.exceptionSubprocess.steps.map((s, i) => stepCard(s, `E${i + 1}.`))
                ]
              : [])
          ]
          active.params = Object.entries(spec.parameters || {}).map(([key, value]) => ({ key, value }))
          const attached = p.attachments || {}
          active.scripts = [...spec.steps, ...((spec.exceptionSubprocess && spec.exceptionSubprocess.steps) || [])]
            .filter((s) => s.type === 'groovyScript')
            .map((s) => ({
              fileName: `${s.fileName}.groovy${s.code == null ? ' (attached file)' : ''}`,
              code: s.code != null ? s.code : attached[`${s.fileName}.groovy`] || ''
            }))
          active.resourcesText = (spec.resources || []).length
            ? `XSLT files added as src/main/resources/mapping/: ${spec.resources.join(', ')}. v1 has no XSLT step — add an XSLT Mapping step for them in the CPI web editor.`
            : ''
          active.hasHttpReceiver = spec.end.type === 'httpReceiver' || spec.steps.some((s) => s.type === 'requestReplyHttp')
        }

        // package editor defaults: closest existing package, else create under the requested id
        if (showPackage) {
          const suggestion = current || closestPackage(packages, p.packageId)
          if (needsPackage && suggestion) active.packageHint = `Choose where to create the iFlow before approving. Did you mean <strong>${esc(suggestion.name)}</strong>?`
          else if (needsPackage) active.packageHint = 'Choose where to create the iFlow before approving.'
          if (resetPackageEditor || !c.getProperty('/pkg/initialized')) {
            const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name))
            c.setProperty('/pkg', {
              initialized: true,
              editing: needsPackage,
              mode: suggestion ? 'existing' : 'new',
              existingId: (suggestion || sorted[0] || {}).id || '',
              newId: PACKAGE_ID.test(p.packageId || '') && !current ? p.packageId : '',
              newName: p.packageName || '',
              newIdError: null,
              error: null
            })
          } else if (needsPackage) c.setProperty('/pkg/editing', true)
        }
        c.setProperty('/active', active)
      },

      // --- target package --------------------------------------------------------------------------

      onPackageEdit() {
        this.chat().setProperty('/pkg/editing', true)
      },

      onPackageCancel() {
        this.chat().setProperty('/pkg/editing', false)
      },

      onPackageModeExisting(e) {
        if (e.getParameter('selected')) this.chat().setProperty('/pkg/mode', 'existing')
      },

      onPackageModeNew(e) {
        if (e.getParameter('selected')) this.chat().setProperty('/pkg/mode', 'new')
      },

      onPackageIdChange(e) {
        const id = e.getParameter('value')
        const exists = this.chat()
          .getProperty('/packages')
          .some((p) => p.id === id)
        this.chat().setProperty(
          '/pkg/newIdError',
          !id ? null : !PACKAGE_ID.test(id) ? 'Letters, digits and dots only — CPI does not allow underscores' : exists ? 'This package exists — choose "Use an existing package"' : null
        )
      },

      async onPackageApply() {
        const c = this.chat()
        const pkg = c.getProperty('/pkg')
        const p = this.currentProposal()
        c.setProperty('/pkg/error', null)
        try {
          const body = pkg.mode === 'existing' ? { packageId: pkg.existingId } : { packageId: pkg.newId, packageName: pkg.newName.trim() }
          this.updateProposal(await api.post(`/Proposals/${api.seg(p.ID)}/setPackage`, body))
          c.setProperty('/pkg/editing', false)
        } catch (e) {
          c.setProperty('/pkg/error', e.hint ? `${e.message} — ${e.hint}` : e.message)
        }
      },

      // --- approve / reject / retry --------------------------------------------------------------------

      async approve(deploy) {
        const p = this.currentProposal()
        const a = this.chat().getProperty('/active')
        const target = p.packageName && !this.chat().getProperty('/packages').some((x) => x.id === p.packageId) ? `the new package "${p.packageName}" (${p.packageId})` : `package ${p.packageId}`
        const ok = await this.confirm({
          title: a.isUpdate ? `${deploy ? 'Update and deploy' : 'Update'} ${p.iflowId}?` : deploy ? `Create and deploy ${p.iflowId}?` : `Create ${a.isIflow ? p.iflowId : p.packageId}?`,
          message: a.isUpdate
            ? `The current content of ${p.iflowId} is backed up first (kept with this proposal and saved as a CPI version), then replaced and its parameters are set.${deploy ? ' It is then deployed; the status is checked for up to 2 minutes.' : ' It is not deployed.'} "Restore previous version" on the iFlows page puts the backup back.`
            : a.isIflow
              ? `The iFlow is created in ${target} and its parameters are set.${deploy ? ' It is then deployed; the status is checked for up to 2 minutes.' : ' It is not deployed.'}`
              : 'The package is created on the tenant.',
          action: deploy ? 'Approve, create & deploy' : 'Approve & create'
        })
        if (!ok) return
        try {
          this.updateProposal(await api.post(`/Proposals/${api.seg(p.ID)}/approve`, { deploy }))
          this.toast(deploy ? 'Approved — creating and deploying…' : 'Approved — creating…')
          this.startProposalPolling(p.ID)
        } catch (e) {
          this.showError(e, 'Approval failed')
        }
      },

      onApprove() {
        this.approve(false)
      },

      onApproveDeploy() {
        this.approve(true)
      },

      async onRetry() {
        const p = this.currentProposal()
        const ok = await this.confirm({ title: 'Retry execution?', message: 'All steps run again. An iFlow already created by the earlier attempt is updated, not duplicated.', action: 'Retry' })
        if (!ok) return
        try {
          this.updateProposal(await api.post(`/Proposals/${api.seg(p.ID)}/retry`, {}))
          this.startProposalPolling(p.ID)
        } catch (e) {
          this.showError(e, 'Retry failed')
        }
      },

      onRequestChanges() {
        this.chat().setProperty('/input', 'Please change the proposal: ')
        setTimeout(() => this.byId('input').focus(), 50)
      },

      onReject() {
        const p = this.currentProposal()
        const reason = new TextArea({ rows: 3, width: '100%', placeholder: 'e.g. wrong receiver URL' })
        const dialog = new Dialog({
          title: 'Reject proposal',
          contentWidth: '28rem',
          content: new VBox({ items: [new Label({ text: 'Reason (optional) — the assistant sees it in your next message', labelFor: reason, wrapping: true }), reason] }).addStyleClass('sapUiSmallMargin'),
          beginButton: new Button({
            text: 'Reject',
            type: 'Reject',
            press: async () => {
              dialog.setBusy(true)
              try {
                this.updateProposal(await api.post(`/Proposals/${api.seg(p.ID)}/reject`, { reason: reason.getValue() }))
                this.toast('Proposal rejected')
                dialog.close()
              } catch (e) {
                this.showError(e, 'Reject failed')
              } finally {
                dialog.setBusy(false)
              }
            }
          }),
          endButton: new Button({ text: 'Cancel', press: () => dialog.close() }),
          afterClose: () => dialog.destroy()
        })
        this.getView().addDependent(dialog)
        dialog.open()
      },

      onOpenCreated() {
        const p = this.currentProposal()
        this.getRouter().navTo('iflows', { '?query': { package: p.packageId, iflow: p.iflowId } })
      }
    })
  }
)
