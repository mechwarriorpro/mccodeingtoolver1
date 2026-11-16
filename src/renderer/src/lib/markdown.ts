/**
 * Tiny markdown subset renderer. Deliberately dependency-free and safe:
 * it escapes HTML first, then applies inline/code/heading/list rules.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderMarkdown(src: string): string {
  const codeBlocks: string[] = []
  let text = escapeHtml(src)

  // fenced code blocks -> placeholders
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`)
    return `\u0000CODE${idx}\u0000`
  })

  // inline code
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>')

  // bold + italic
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')

  // links
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')

  // headings
  text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>')
  text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>')
  text = text.replace(/^# (.*)$/gm, '<h1>$1</h1>')

  // lists
  text = text.replace(/(?:^|\n)((?:[-*] .*(?:\n|$))+)/g, (m) => {
    const items = m
      .trim()
      .split(/\n/)
      .map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`)
      .join('')
    return `\n<ul>${items}</ul>`
  })
  text = text.replace(/(?:^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m) => {
    const items = m
      .trim()
      .split(/\n/)
      .map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`)
      .join('')
    return `\n<ol>${items}</ol>`
  })

  // paragraphs
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim()
      if (!trimmed) return ''
      if (/^<(h[1-3]|ul|ol|pre|blockquote)/.test(trimmed) || /^\u0000CODE\d+\u0000$/.test(trimmed)) return trimmed
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`
    })
    .join('\n')

  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)] ?? '')
  return text
}
