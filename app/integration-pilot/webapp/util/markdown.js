sap.ui.define([], () => {
  'use strict'

  /**
   * Minimal Markdown -> HTML for agent replies, limited to tags that sap.m.FormattedText
   * renders (p, strong, em, code, pre, ul, ol, li, h3-h5, a, br, blockquote).
   * All text is HTML-escaped first, so model output can never inject markup.
   */
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function inline(text) {
    return escape(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
  }

  function toHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
    const out = []
    let list = null // 'ul' | 'ol'
    let para = []
    let code = null

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
      para = []
    }
    const closeList = () => {
      if (list) out.push(`</${list}>`)
      list = null
    }

    for (const line of lines) {
      if (code !== null) {
        if (/^```/.test(line)) {
          out.push(`<pre>${escape(code.join('\n'))}</pre>`)
          code = null
        } else code.push(line)
        continue
      }
      if (/^```/.test(line)) {
        flushPara()
        closeList()
        code = []
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      if (heading) {
        flushPara()
        closeList()
        const level = Math.min(5, heading[1].length + 2) // h3..h5 keep chat text compact
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      } else if (bullet || numbered) {
        flushPara()
        const type = bullet ? 'ul' : 'ol'
        if (list !== type) {
          closeList()
          out.push(`<${type}>`)
          list = type
        }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`)
      } else if (/^\s*>\s?/.test(line)) {
        flushPara()
        closeList()
        out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`)
      } else if (!line.trim()) {
        flushPara()
        closeList()
      } else {
        if (list && /^\s{2,}/.test(line)) {
          // continuation of the previous list item
          out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, `<br>${inline(line.trim())}</li>`)
        } else {
          closeList()
          para.push(line)
        }
      }
    }
    if (code !== null) out.push(`<pre>${escape(code.join('\n'))}</pre>`)
    flushPara()
    closeList()
    return out.join('')
  }

  return { toHtml, escape }
})
