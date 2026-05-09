/**
 * Image Banner snippet-author runtime.
 *
 * Binds each `[data-spectrum-instance-id][data-spectrum-snippet-id="ibx7zk9p"]`
 * container on the page via `__spectrumAi.snippet.bind(node, callback)`. The callback
 * fires once with the SSR-resolved default variant, then again on every
 * `$spectrum:variant_resolved` event for this instance.
 *
 * applyVariant updates EVERY variant.content field on the DOM:
 *   - image (src, srcset, width, height)
 *   - alt_text (alt)
 *   - aspect_ratio (root.style.aspectRatio)
 *   - link_url (root.href — root is always <a>)
 *   - lazy_load (img.loading attribute)
 *
 * Container-scoped: every DOM read/write goes through `node`; multi-render
 * pages cannot collide.
 *
 * SRCSET_WIDTHS — keep in sync with the srcset block in
 * _sai-snippet-ibx7zk9p.liquid. The drift-prevention test in
 * __tests__/srcset-parity.test.ts asserts equality.
 *
 * Test surface: when `globalThis.__SAI_TEST_HARNESS__ === true`, the IIFE
 * exposes `globalThis.__saiIbx7zk9p` with `{ applyVariant, buildSrcset,
 * appendWidth, SRCSET_WIDTHS, PRIMARY_WIDTH }` for unit tests. Production
 * never sets that flag, so production never carries the global — keeps the
 * "no global side effects on load" rule honest.
 */
;(() => {
  if (typeof window === 'undefined') return

  const SNIPPET_ID = 'ibx7zk9p'
  const ROOT_SELECTOR = `.sai-${SNIPPET_ID}`
  const IMG_SELECTOR = `.sai-${SNIPPET_ID}__image`
  const SRCSET_WIDTHS = [600, 1200, 2400]
  const PRIMARY_WIDTH = 2400

  function appendWidth(url, w) {
    try {
      const u = new URL(url, window.location.href)
      u.searchParams.set('width', String(w))
      return u.toString()
    } catch {
      // Fallback for pathological inputs — should not occur for Shopify CDN URLs.
      const sep = url.includes('?') ? '&' : '?'
      return `${url}${sep}width=${w}`
    }
  }

  function buildSrcset(baseUrl) {
    return SRCSET_WIDTHS.map((w) => `${appendWidth(baseUrl, w)} ${w}w`).join(', ')
  }

  function applyVariant(node, content, pools) {
    const root = node.querySelector(ROOT_SELECTOR)
    const img = node.querySelector(IMG_SELECTOR)
    if (!root || !img) return

    // ── Image src / srcset / width / height ──
    const imageMarker = content.image
    if (imageMarker && imageMarker.kind === 'images' && imageMarker.refId) {
      const resolved = pools.images?.[imageMarker.refId]
      if (resolved && typeof resolved.url === 'string') {
        img.src = appendWidth(resolved.url, PRIMARY_WIDTH)
        img.srcset = buildSrcset(resolved.url)
        if (typeof resolved.width === 'number') img.width = resolved.width
        if (typeof resolved.height === 'number') img.height = resolved.height
      }
    }

    // ── Alt text ──
    if (typeof content.alt_text === 'string') {
      img.alt = content.alt_text
    } else {
      img.alt = ''
    }

    // ── Aspect ratio ──
    if (typeof content.aspect_ratio === 'string' && content.aspect_ratio !== 'auto') {
      root.style.aspectRatio = content.aspect_ratio
    } else {
      // 'auto' or missing → clear the inline style; CSS controls layout.
      root.style.removeProperty('aspect-ratio')
    }

    // ── Link URL (root is always <a>) ──
    if (typeof content.link_url === 'string' && content.link_url !== '') {
      root.setAttribute('href', content.link_url)
    } else {
      root.removeAttribute('href')
    }

    // ── Lazy load ──
    if (content.lazy_load === true) {
      img.setAttribute('loading', 'lazy')
    } else {
      img.removeAttribute('loading')
    }
  }

  // Test surface — pure helpers only. Gated behind `__SAI_TEST_HARNESS__`
  // so production never receives the assignment; only the unit-test harness
  // in __tests__/apply-variant.test.ts opts in.
  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiIbx7zk9p = {
      applyVariant,
      buildSrcset,
      appendWidth,
      SRCSET_WIDTHS,
      PRIMARY_WIDTH,
    }
  }

  const snippetApi = window.__spectrumAi?.snippet
  if (!snippetApi || typeof snippetApi.bind !== 'function') return

  // Select THIS snippet's instances only — not every container on the page.
  // The wrapper emits data-spectrum-snippet-id on every per-render container
  // (snippet-instance-wrapper.ts buildRenderBlock); the attribute selector
  // keeps the iteration cleanly snippet-scoped so we never bind to (e.g.)
  // a Shoppable Videos container by mistake.
  const containers = document.querySelectorAll(
    `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
  )
  for (const node of containers) {
    snippetApi.bind(node, ({ pools, variants, currentVariantId }) => {
      const variant = variants.find((v) => v.variantId === currentVariantId)
      if (!variant || !variant.content) return
      applyVariant(node, variant.content, pools || {})
    })
  }
})()
