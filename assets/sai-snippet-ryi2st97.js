/**
 * Explore Our Range — Shoppable Grid (snippet ryi2st97)
 *
 * Runtime asset. Ships to the merchant theme as assets/sai-snippet-ryi2st97.js
 * and runs only as a deferred <script src> in a storefront DOM.
 *
 * Lifecycle:
 *   1. Find each instance wrapper by [data-spectrum-snippet-id][data-spectrum-instance-id].
 *   2. Bind via __spectrumAi.snippet.bind(node, cb) — the SDK resolves the
 *      variant (targeting / experiment) and invokes the callback.
 *   3. Read the sibling <script data-spectrum-snippet-pool> for card data.
 *   4. Hydrate each tile: image, gradient, label, arrow link, hotspot pins.
 *   5. Hotspot tap → Mini-PDP popup (variant swatches fetched from
 *      /products/{handle}.js) → window.Spectrum.cart.addAndOpen.
 *
 * No client-side HTML escaping of pool data: it is server-rendered through
 * Liquid's `json` filter. Dynamic text from /products/{handle}.js is written
 * via textContent / setAttribute (DOM-safe by construction), never innerHTML.
 */
;(() => {
  if (window.__sai_ryi2st97_initialized__) return
  window.__sai_ryi2st97_initialized__ = true

  const SNIPPET_ID = 'ryi2st97'
  const TAG = 'sai-ryi2st97'
  const C = 'sai-ryi2st97'
  const EVENT_NS = 'looks'
  const SOURCE_ID = 'spectrum-ryi2st97'

  // ── DOM helpers ──
  function h(tag, attrs, children) {
    const node = document.createElement(tag)
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k]
        if (v === null || v === undefined || v === false) continue
        if (k === 'text') node.textContent = v
        else if (k === 'html') node.innerHTML = v
        else if (k === 'class') node.className = v
        else node.setAttribute(k, v === true ? '' : v)
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
      }
    }
    return node
  }

  const ICON_ARROW =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 8h6M8 5l3 3-3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const ICON_CLOSE =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'

  // ── Pool ──
  function readSnippetPool(node) {
    for (const child of node.children) {
      if (child.tagName === 'SCRIPT' && child.hasAttribute('data-spectrum-snippet-pool')) {
        try {
          return JSON.parse(child.textContent)
        } catch (e) {
          return null
        }
      }
    }
    return null
  }

  function readConfig(rootEl) {
    const d = rootEl.dataset
    return {
      layout: d.layout || 'bento',
      hotspots: d.hotspots !== 'false',
      miniPdp: d.miniPdp !== 'false',
      ctaLabel: d.ctaLabel || 'Shop Now',
      ctaText: d.ctaText || 'Add to Cart',
    }
  }

  // ── Tile hydration ──
  function findTagged(card, tagId, productId) {
    const list = card?.tagged_products || []
    let match = list.find((t) => t.tag_id === tagId)
    if (!match) match = list.find((t) => String(t.product_id) === String(productId))
    return match || null
  }

  function hydrateTile(tileEl, card, cfg, ctx) {
    if (!card || tileEl.dataset.saiHydrated === '1') return
    tileEl.dataset.saiHydrated = '1'
    tileEl.classList.remove(`${C}__tile--placeholder`)
    tileEl.textContent = ''

    if (card.tile_image) {
      tileEl.appendChild(
        h('img', {
          class: `${C}__tile-img`,
          src: card.tile_image,
          alt: card.title || '',
          loading: 'lazy',
          decoding: 'async',
        }),
      )
    }
    tileEl.appendChild(h('span', { class: `${C}__tile-overlay`, 'aria-hidden': 'true' }))

    // Hotspot pins
    if (cfg.hotspots && Array.isArray(card.pins) && card.pins.length) {
      const pinsWrap = h('div', { class: `${C}__pins` })
      for (const pin of card.pins) {
        const tagged = findTagged(card, pin.tag_id, pin.product_id)
        const btn = h('button', {
          type: 'button',
          class: `${C}__pin`,
          'data-tag-id': pin.tag_id,
          'data-product-id': pin.product_id,
          'aria-label': tagged ? tagged.display_name : 'View product',
          style: `--sai-x:${Number(pin.hotspot_x) || 50}%;--sai-y:${Number(pin.hotspot_y) || 50}%;`,
        })
        btn.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          onPinActivate(tileEl, card, pin, btn, cfg, ctx)
        })
        pinsWrap.appendChild(btn)
      }
      tileEl.appendChild(pinsWrap)
    }

    // Bottom bar: label + hover CTA + arrow
    const link = card.cta_url || null
    const labelEl = h('p', { class: `${C}__tile-label`, text: card.title || '' })
    const left = h('div', { class: `${C}__tile-bar-left` }, [labelEl])
    if (link) {
      left.appendChild(h('a', { class: `${C}__tile-cta`, href: link, text: cfg.ctaLabel }))
    }
    const arrow = link
      ? h('a', {
          class: `${C}__tile-arrow`,
          href: link,
          'aria-label': card.title || 'Explore',
          html: ICON_ARROW,
        })
      : h('span', { class: `${C}__tile-arrow`, 'aria-hidden': 'true', html: ICON_ARROW })
    if (link) {
      arrow.addEventListener('click', () => {
        ctx.track(`${EVENT_NS}:product_click`, { card: card.title || '', href: link })
      })
    }
    tileEl.appendChild(h('div', { class: `${C}__tile-bar` }, [left, arrow]))
  }

  // ── Pin → Mini-PDP / compact card ──
  function onPinActivate(tileEl, card, pin, btn, cfg, ctx) {
    const tagged = findTagged(card, pin.tag_id, pin.product_id)
    for (const p of tileEl.querySelectorAll(`.${C}__pin--active`)) {
      p.classList.remove(`${C}__pin--active`)
    }
    btn.classList.add(`${C}__pin--active`)
    ctx.track(`${EVENT_NS}:pin_interact`, {
      kind: 'tap',
      tag_id: pin.tag_id,
      product_id: pin.product_id,
    })
    if (!tagged) return
    openPdp(tagged, cfg, ctx)
  }

  // ── Mini-PDP popup (one per page, reused) ──
  let pdpBackdrop = null
  let pdpState = null
  let prevBodyOverflow = ''

  // Lock the page behind the dialog so scrolling the modal (or overscrolling
  // past its ends) doesn't chain to the document underneath.
  function lockBodyScroll(on) {
    if (on) {
      prevBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = prevBodyOverflow
    }
  }

  function ensurePdp(cfg, ctx) {
    if (pdpBackdrop) return pdpBackdrop
    const card = h('div', {
      class: `${C}__pdp`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Product details',
    })
    pdpBackdrop = h('div', { class: `${C}__pdp-backdrop` }, [card])
    pdpBackdrop._card = card
    pdpBackdrop.addEventListener('click', (e) => {
      if (e.target === pdpBackdrop) closePdp()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pdpBackdrop.dataset.open === 'true') closePdp()
    })
    document.body.appendChild(pdpBackdrop)
    return pdpBackdrop
  }

  function closePdp() {
    if (!pdpBackdrop) return
    pdpBackdrop.dataset.open = 'false'
    pdpState = null
    lockBodyScroll(false)
  }

  function openPdp(tagged, cfg, ctx) {
    ensurePdp(cfg, ctx)
    const card = pdpBackdrop._card
    card.textContent = ''
    pdpBackdrop.dataset.open = 'true'
    lockBodyScroll(true)
    ctx.track(`${EVENT_NS}:overlay_card_view`, {
      tag_id: tagged.tag_id,
      product_id: tagged.product_id,
    })

    // Header
    const head = h('div', { class: `${C}__pdp-head` }, [
      h('h3', { class: `${C}__pdp-title`, text: tagged.display_name || 'Product' }),
      (() => {
        const close = h('button', {
          type: 'button',
          class: `${C}__pdp-close`,
          'aria-label': 'Close',
          html: ICON_CLOSE,
        })
        close.addEventListener('click', closePdp)
        return close
      })(),
    ])
    card.appendChild(head)

    const body = h('div', {
      class: `${C}__pdp-body`,
      style: 'display:flex;flex-direction:column;gap:20px;',
    })
    card.appendChild(body)

    // Instant render from pool data, then upgrade to the full gallery +
    // variant swatches once /products/{handle}.js resolves.
    renderCompact(body, tagged, cfg, ctx)

    if (!cfg.miniPdp || !tagged.handle) return

    fetch(`/products/${tagged.handle}.js`)
      .then((r) => (r.ok ? r.json() : null))
      .then((product) => {
        if (!product || pdpBackdrop.dataset.open !== 'true') return
        renderFull(body, tagged, product, cfg, ctx)
      })
      .catch(() => {})
  }

  // Price column skeleton: a price-row (filled by syncVariant / renderCompact)
  // above the "(Incl. of all taxes)" line.
  function buildPriceBlock() {
    return h('div', { class: `${C}__pdp-price` }, [
      h('div', { class: `${C}__pdp-price-row` }),
      h('span', { class: `${C}__pdp-tax`, text: '(Incl. of all taxes)' }),
    ])
  }

  function money(cents) {
    return window.Spectrum?.format?.money ? window.Spectrum.format.money(cents) : formatMoney(cents)
  }

  function ctaButton(cfg, onClick) {
    const btn = h('button', { type: 'button', class: `${C}__pdp-cta`, text: cfg.ctaText })
    btn.addEventListener('click', () => onClick(btn))
    return btn
  }

  function setLoading(btn, on, cfg) {
    if (on) {
      btn.dataset.loading = '1'
      btn.textContent = ''
      btn.appendChild(h('span', { class: `${C}__pdp-spinner`, 'aria-hidden': 'true' }))
    } else {
      delete btn.dataset.loading
      btn.textContent = cfg.ctaText
    }
  }

  function addToCart(variantId, btn, cfg, ctx, meta) {
    if (!variantId || btn.dataset.loading === '1') return
    setLoading(btn, true, cfg)
    ctx.track(`${EVENT_NS}:add_to_cart`, Object.assign({ variant_id: variantId }, meta))
    const done = () => {
      setLoading(btn, false, cfg)
      ctx.track(`${EVENT_NS}:added_to_cart`, Object.assign({ variant_id: variantId }, meta))
      closePdp()
    }
    const fail = () => setLoading(btn, false, cfg)
    const cartApi = window.Spectrum?.cart
    if (cartApi && typeof cartApi.addAndOpen === 'function') {
      const p = cartApi.addAndOpen({ id: variantId, quantity: 1 }, { sourceId: SOURCE_ID })
      if (p && typeof p.then === 'function') p.then(done).catch(fail)
      else done()
    } else {
      fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: variantId, quantity: 1 }),
      })
        .then((r) => (r.ok ? done() : fail()))
        .catch(fail)
    }
  }

  // Pool-only view: instant render before the product fetch, or final view
  // when the look has no product handle.
  function renderCompact(body, tagged, cfg, ctx) {
    body.textContent = ''
    if (tagged.thumb_url) {
      body.appendChild(
        h('div', { class: `${C}__pdp-gallery` }, [
          h('div', { class: `${C}__pdp-thumbs` }, [
            h('div', { class: `${C}__pdp-thumb` }, [
              h('img', { src: tagged.thumb_url, alt: tagged.display_name || '', loading: 'lazy' }),
            ]),
          ]),
        ]),
      )
    }
    body.appendChild(h('hr', { class: `${C}__pdp-divider` }))
    const priceEl = buildPriceBlock()
    const row = priceEl.querySelector(`.${C}__pdp-price-row`)
    row.appendChild(
      h('span', {
        class: `${C}__pdp-price-now`,
        text: tagged.price_override || tagged.variant_price || '',
      }),
    )
    if (tagged.show_compare && tagged.variant_compare_at_price) {
      row.appendChild(h('span', { class: `${C}__pdp-price-was`, text: 'MRP' }))
      row.appendChild(
        h('s', { class: `${C}__pdp-price-strike`, text: tagged.variant_compare_at_price }),
      )
    }
    const cta = ctaButton(cfg, (btn) =>
      addToCart(tagged.variant_id, btn, cfg, ctx, {
        product_id: tagged.product_id,
        tag_id: tagged.tag_id,
      }),
    )
    if (!tagged.variant_available) {
      cta.disabled = true
      cta.textContent = 'Sold out'
    }
    body.appendChild(h('div', { class: `${C}__pdp-foot` }, [priceEl, cta]))
  }

  // Single-variant products (or the Shopify default "Title / Default Title")
  // carry no real choice — skip the swatch containers entirely.
  function isTrivialOptions(product, optionNames) {
    if (product.variants.length <= 1) return true
    if (optionNames.length === 1) {
      const vals = uniqueOptionValues(product, 0)
      if (vals.length === 1 && vals[0] === 'Default Title') return true
    }
    return false
  }

  // Full Mini-PDP: gallery + carousel dots, bordered option containers with
  // circular image swatches, and a divider + price/CTA footer.
  function renderFull(body, tagged, product, cfg, ctx) {
    body.textContent = ''
    pdpState = { product, optionValues: [], variant: null }

    const images = (product.images || []).slice(0, 6)
    if (images.length) {
      const gallery = h('div', { class: `${C}__pdp-gallery` })
      const thumbs = h('div', { class: `${C}__pdp-thumbs` })
      for (const src of images) {
        thumbs.appendChild(
          h('div', { class: `${C}__pdp-thumb` }, [
            h('img', { src, alt: product.title || '', loading: 'lazy' }),
          ]),
        )
      }
      gallery.appendChild(thumbs)
      if (images.length > 1) {
        const dots = h('div', { class: `${C}__pdp-dots` })
        images.forEach((_, i) =>
          dots.appendChild(
            h('span', {
              class: i === 0 ? `${C}__pdp-dot ${C}__pdp-dot--active` : `${C}__pdp-dot`,
            }),
          ),
        )
        gallery.appendChild(dots)
        thumbs.addEventListener('scroll', () => {
          const per = thumbs.clientWidth / 3 || 1
          const idx = Math.round(thumbs.scrollLeft / per)
          const ds = dots.children
          for (let k = 0; k < ds.length; k++) {
            ds[k].classList.toggle(`${C}__pdp-dot--active`, k === Math.min(idx, ds.length - 1))
          }
        })
      }
      body.appendChild(gallery)
    }

    const initial =
      product.variants.find((v) => String(v.id) === String(tagged.variant_id)) ||
      product.variants.find((v) => v.available) ||
      product.variants[0]
    pdpState.optionValues = initial?.options ? initial.options.slice() : []

    const optionNames = product.options.map((o) => (typeof o === 'string' ? o : o.name))
    const groups = []
    if (!isTrivialOptions(product, optionNames)) {
      optionNames.forEach((name, idx) => {
        const group = h('div', { class: `${C}__pdp-group` })
        const labelEl = h('span', { class: `${C}__pdp-group-label` })
        group.appendChild(labelEl)
        const swatchWrap = h('div', { class: `${C}__pdp-swatches` })
        for (const val of uniqueOptionValues(product, idx)) {
          const sw = buildSwatch(product, idx, val)
          sw.addEventListener('click', () => {
            if (sw.disabled) return
            pdpState.optionValues[idx] = val
            syncVariant(product, groups, priceEl, cta, cfg)
          })
          swatchWrap.appendChild(sw)
        }
        group.appendChild(swatchWrap)
        body.appendChild(group)
        groups.push({ labelEl, swatchWrap, idx, name })
      })
    }

    body.appendChild(h('hr', { class: `${C}__pdp-divider` }))
    const priceEl = buildPriceBlock()
    const cta = ctaButton(cfg, (btn) => {
      const v = pdpState.variant
      if (!v) return
      addToCart(v.id, btn, cfg, ctx, { product_id: product.id, tag_id: tagged.tag_id })
    })
    body.appendChild(h('div', { class: `${C}__pdp-foot` }, [priceEl, cta]))

    syncVariant(product, groups, priceEl, cta, cfg)
  }

  function uniqueOptionValues(product, idx) {
    const seen = []
    for (const v of product.variants) {
      const val = v.options[idx]
      if (val !== undefined && seen.indexOf(val) === -1) seen.push(val)
    }
    return seen
  }

  function isValueAvailable(product, idx, val, optionValues) {
    return product.variants.some((v) => {
      if (v.options[idx] !== val) return false
      for (let i = 0; i < optionValues.length; i++) {
        if (i === idx) continue
        if (optionValues[i] && v.options[i] !== optionValues[i]) return false
      }
      return v.available
    })
  }

  function swatchImageFor(product, idx, val) {
    // Use a variant's featured image whose option[idx] === val (color swatches)
    const v = product.variants.find((x) => x.options[idx] === val && x.featured_image)
    return v?.featured_image ? v.featured_image.src : null
  }

  function buildSwatch(product, idx, val) {
    const img = swatchImageFor(product, idx, val)
    if (img) {
      const sw = h('button', { type: 'button', class: `${C}__swatch`, 'aria-label': val }, [
        h('span', { class: `${C}__swatch-dot`, style: `background-image:url(${img})` }),
      ])
      sw._value = val
      sw._idx = idx
      return sw
    }
    const sw = h('button', { type: 'button', class: `${C}__swatch ${C}__swatch--text`, text: val })
    sw._value = val
    sw._idx = idx
    return sw
  }

  function findVariant(product, optionValues) {
    return (
      product.variants.find((v) => {
        for (let i = 0; i < optionValues.length; i++) {
          if (optionValues[i] && v.options[i] !== optionValues[i]) return false
        }
        return true
      }) || null
    )
  }

  function syncVariant(product, groups, priceEl, cta, cfg) {
    const variant = findVariant(product, pdpState.optionValues)
    pdpState.variant = variant

    // Update group labels (Name : Value) + swatch selected/availability states
    for (const g of groups) {
      const selected = pdpState.optionValues[g.idx]
      g.labelEl.textContent = ''
      g.labelEl.appendChild(document.createTextNode(`${g.name} : `))
      g.labelEl.appendChild(h('b', { text: selected || '' }))
      for (const sw of g.swatchWrap.querySelectorAll(`.${C}__swatch`)) {
        sw.setAttribute('aria-pressed', sw._value === selected ? 'true' : 'false')
        sw.disabled = !isValueAvailable(product, g.idx, sw._value, pdpState.optionValues)
      }
    }

    // Price row: now + MRP strike + "N% OFF" badge
    const row = priceEl.querySelector(`.${C}__pdp-price-row`)
    row.textContent = ''
    if (variant) {
      row.appendChild(h('span', { class: `${C}__pdp-price-now`, text: money(variant.price) }))
      if (variant.compare_at_price && variant.compare_at_price > variant.price) {
        row.appendChild(h('span', { class: `${C}__pdp-price-was`, text: 'MRP' }))
        row.appendChild(
          h('s', { class: `${C}__pdp-price-strike`, text: money(variant.compare_at_price) }),
        )
        const pct = Math.round(
          ((variant.compare_at_price - variant.price) / variant.compare_at_price) * 100,
        )
        if (pct > 0) row.appendChild(h('span', { class: `${C}__pdp-badge`, text: `${pct}% OFF` }))
      }
    }

    if (!variant || !variant.available) {
      cta.disabled = true
      if (cta.dataset.loading !== '1') cta.textContent = 'Sold out'
    } else {
      cta.disabled = false
      if (cta.dataset.loading !== '1') cta.textContent = cfg.ctaText
    }
  }

  // Shopify /products/{h}.js prices are integer cents in the shop currency.
  function formatMoney(cents) {
    const amount = (Number(cents) || 0) / 100
    try {
      return amount.toLocaleString(undefined, {
        style: 'currency',
        currency: window.Shopify?.currency?.active || 'INR',
      })
    } catch (e) {
      return String(amount)
    }
  }

  // ── Bind / bootstrap ──
  function bindInstance(node) {
    const rootEl = node.querySelector(TAG)
    if (!rootEl) return
    const pool = readSnippetPool(node)
    const cards = pool?.cards || {}
    const cfg = readConfig(rootEl)
    const api = window.__spectrumAi?.snippet
    if (!api || typeof api.bind !== 'function') {
      // No SDK — degrade to a no-analytics direct hydration so the grid still works.
      hydrateAll(rootEl, cards, cfg, { track: () => {}, emit: () => {} })
      return
    }

    let trackHandle = () => {}
    let emitHandle = () => {}
    const track = (...args) => trackHandle(...args)
    const emit = (...args) => emitHandle(...args)
    const ctx = { track, emit }

    const handles = api.bind(node, () => {
      hydrateAll(rootEl, cards, cfg, ctx)
    })
    if (handles && typeof handles === 'object') {
      if (typeof handles.track === 'function') trackHandle = handles.track
      if (typeof handles.emit === 'function') emitHandle = handles.emit
    }
    // Render immediately from the SSR pool — don't blank-wait on the SDK's
    // variant-resolved callback, which doesn't fire for placements with no
    // competing experiment/variant. hydrateTile is idempotent, so a later
    // callback re-hydrate is a no-op.
    hydrateAll(rootEl, cards, cfg, ctx)

    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
              track(`${EVENT_NS}:list_impression`, {
                card_count: rootEl.querySelectorAll(`.${C}__tile`).length,
              })
              obs.disconnect()
            }
          }
        },
        { threshold: [0.5] },
      )
      io.observe(node)
    }
  }

  function hydrateAll(rootEl, cards, cfg, ctx) {
    const tiles = rootEl.querySelectorAll(`.${C}__tile`)
    for (const tile of tiles) {
      const card = cards[tile.dataset.handle]
      if (card) hydrateTile(tile, card, cfg, ctx)
    }
    wireNav(rootEl)
  }

  // Header prev/next scroll the grid when it overflows (mobile carousel). On
  // the desktop bento the grid does not scroll, so they no-op but stay visible
  // to match the design header.
  function wireNav(rootEl) {
    const nav = rootEl.querySelector('[data-sai-nav]')
    const grid = rootEl.querySelector(`.${C}__grid`)
    if (!nav || !grid || nav.dataset.saiWired === '1') return
    nav.dataset.saiWired = '1'
    const step = () => Math.max(grid.clientWidth * 0.8, 240)
    const prev = nav.querySelector('[data-sai-prev]')
    const next = nav.querySelector('[data-sai-next]')
    if (prev)
      prev.addEventListener('click', () => grid.scrollBy({ left: -step(), behavior: 'smooth' }))
    if (next)
      next.addEventListener('click', () => grid.scrollBy({ left: step(), behavior: 'smooth' }))
  }

  function initAll() {
    const wrappers = document.querySelectorAll(
      `[data-spectrum-snippet-id="${SNIPPET_ID}"][data-spectrum-instance-id]`,
    )
    for (const w of wrappers) {
      if (w.dataset.saiRyi2st97Bound === '1') continue
      w.dataset.saiRyi2st97Bound = '1'
      bindInstance(w)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll, { once: true })
  } else {
    initAll()
  }

  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__) {
    globalThis.__saiRyi2st97 = {
      SNIPPET_ID,
      EVENT_NS,
      readSnippetPool,
      readConfig,
      findTagged,
      hydrateTile,
      hydrateAll,
      uniqueOptionValues,
      isValueAvailable,
      findVariant,
      bindInstance,
    }
  }
})()
