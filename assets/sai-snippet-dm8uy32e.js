/**
 * Rich PDP Content snippet-author runtime.
 *
 * Sections are inline in the slot payload JSON (entry.content.sections).
 * SSR emits the shell (heading + empty sections container). This JS
 * renders the full section content from the envelope on bind + variant swap.
 */
;(() => {
  if (window.__sai_dm8uy32e_initialized__) return
  window.__sai_dm8uy32e_initialized__ = true

  const SNIPPET_ID = 'dm8uy32e'

  function readEnvelope(node) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (child.tagName === 'SCRIPT' && child.hasAttribute('data-spectrum-envelope')) {
        try {
          return JSON.parse(child.textContent || '')
        } catch {
          return null
        }
      }
    }
    return null
  }

  function getSections(envelope, variant, entry) {
    const slotKey = variant?.meta?.contentSlot?.slotKey || 'default'
    const slot = envelope?.slotsByKey?.[slotKey]
    if (!slot) return []

    const resolvedEntry = entry || slot.entries?.find((e) => e.isDefault) || slot.entries?.[0]
    return resolvedEntry?.content?.sections || []
  }

  function renderSections(sectionsEl, sectionHandles, sections) {
    const byHandle = {}
    for (const s of sections) {
      if (s.handle) byHandle[s.handle] = s
    }

    const parts = []
    const handles = sectionHandles?.length ? sectionHandles : sections.map((s) => s.handle)

    for (const handle of handles) {
      const section = byHandle[handle]
      if (!section?.html) {
        parts.push(
          `<div class="sai-dm8uy32e__section sai-dm8uy32e__section--unavailable" data-handle="${handle}" aria-hidden="true"></div>`,
        )
        continue
      }
      let html = `<div class="sai-dm8uy32e__section" data-section-type="${section.sectionType || ''}" data-handle="${handle}">`
      if (section.css) html += `<style>${section.css}</style>`
      html += section.html
      html += '</div>'
      parts.push(html)
    }
    sectionsEl.innerHTML = parts.join('')
  }

  const bind = window.__spectrumAi?.snippet?.bind
  if (typeof bind !== 'function') return

  const containers = document.querySelectorAll(`[data-spectrum-snippet-id="${SNIPPET_ID}"]`)
  for (const node of containers) {
    bind(node, (ctx) => {
      const envelope = readEnvelope(node)
      if (!envelope) return

      const inner = node.querySelector('.sai-dm8uy32e')
      if (!inner) return

      const variant = ctx.variant
      const entry = ctx.entry
      const sections = getSections(envelope, variant, entry)
      const sectionHandles = entry?.content?.sectionHandles

      const sectionsEl = inner.querySelector('.sai-dm8uy32e__sections')
      if (sectionsEl && sections.length > 0) {
        renderSections(sectionsEl, sectionHandles, sections)
      }
    })
  }
})()
