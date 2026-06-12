/**
 * Cart Line Item snippet-author runtime.
 *
 * Ships to the merchant theme as an async <script src> per render. Reads the
 * sibling config blob, fetches the live cart via Spectrum.cart.get(), and
 * renders one line per cart item honouring the merchant's config. Quantity,
 * remove, and variant-swap mutations go through Spectrum.cart.change; the cart
 * is re-fetched and re-rendered after each mutation and on the theme's
 * cart-update event.
 *
 * Browser-only (theme <script src>) — no environment guards beyond feature
 * detection. Container-scoped: every query is rooted at the instance node. No
 * global side effects on load beyond the multi-execution guard.
 *
 * Data limits (draft): cart.js exposes per-line price/original_price/quantity/
 * options but NOT product compare-at, rating, inventory, or editorial badge
 * signals. Compare-at + discount-% are derived from original_price vs price;
 * rating, scarcity qty, EDD date, and bestseller/new badges read from
 * line.properties when present. Editable variants fetch /products/{handle}.js
 * on demand. Wire the remaining first-class sources during finalisation.
 */
;(() => {
  if (window.__sai_zj3bpb6w_initialized__) return
  window.__sai_zj3bpb6w_initialized__ = true

  const SNIPPET_ID = 'zj3bpb6w'
  const FEATURE_SLUG = 'cart_line'

  // Last cart payload across instances. When the theme morphs the cart
  // section (replacing our rendered DOM), the re-initialized instance paints
  // synchronously from this cache instead of leaving a blank gap for the
  // duration of a /cart.js round trip; the async refresh then reconciles.
  let lastCart = null
  const NS = 'http://www.w3.org/2000/svg'

  const ICONS = {
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    x: 'M18 6L6 18M6 6l12 12',
  }

  function readConfig(node) {
    // Scoped lookup (not direct-children only) so the config blob is found
    // whether the snippet-id attribute sits on the snippet root or a wrapper
    // ancestor. One config blob per instance, so no isolation concern.
    const script = node.querySelector('script[data-sai-cart-line-config]')
    if (!script) return {}
    try {
      return JSON.parse(script.textContent || '{}')
    } catch {
      return {}
    }
  }

  function money(cents, currency) {
    const amount = (Number(cents) || 0) / 100
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol' }).format(amount)
    } catch {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount)
      } catch {
        return amount.toFixed(2)
      }
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  // Broadcast after this snippet mutates the cart so sibling Spectrum
  // snippets (progress bar, upsell) re-read it. Listeners coalesce, so the
  // self-delivered copy costs one no-op refresh, never a loop.
  function emitCartUpdated() {
    document.dispatchEvent(new CustomEvent('spectrum:cart:updated'))
  }

  // The theme's summary (totals, subtotals, badges) is theme-owned SSR HTML
  // that only the theme's own cart ops refresh. After cart changes, re-render
  // the enclosing section via the Section Rendering API and SURGICALLY sync
  // only theme-owned subtrees. Never replace any subtree containing a
  // Spectrum snippet root — a whole-section swap wipes live snippet DOM and
  // cascades re-inits (visible collapse + main-thread churn). Unchanged theme
  // parts are skipped via isEqualNode, so repeat syncs are no-ops. The
  // ?sections= GET does not match the cart-watch regex, so no feedback loop.
  const SPECTRUM_ROOTS = '[data-spectrum-snippet-id],[data-spectrum-lq-snippet],[data-sai-progress],[data-sai-cart-line]'
  // Children are matched by tag+class key, not index — the live DOM's child
  // list drifts from the SSR shape (theme JS adds/removes wrappers), and
  // index pairing bails on the first drift, leaving totals stale forever.
  const domKey = (el) => `${el.tagName}|${el.getAttribute('class') || ''}`
  function syncThemeDom(curr, fresh) {
    if (curr.matches && curr.matches(SPECTRUM_ROOTS)) return
    const holdsSnippet = curr.querySelector && curr.querySelector(SPECTRUM_ROOTS)
    if (!holdsSnippet) {
      if (fresh && !curr.isEqualNode(fresh)) curr.replaceWith(fresh)
      return
    }
    if (!fresh) return
    const freshKids = Array.prototype.slice.call(fresh.children)
    const used = new Set()
    Array.prototype.slice.call(curr.children).forEach((child) => {
      let match = null
      for (let i = 0; i < freshKids.length; i++) {
        if (!used.has(i) && domKey(freshKids[i]) === domKey(child)) {
          match = freshKids[i]
          used.add(i)
          break
        }
      }
      syncThemeDom(child, match)
    })
  }

  let sectionRefreshTimer = null
  function refreshThemeSection(node) {
    const sec = node.closest('[id^="shopify-section-"]')
    if (!sec) return
    const sectionId = sec.id.replace('shopify-section-', '')
    clearTimeout(sectionRefreshTimer)
    sectionRefreshTimer = setTimeout(async () => {
      try {
        // No Accept: application/json header — on /cart that header makes
        // Shopify return the cart resource instead of the section render.
        const res = await fetch(`${window.location.pathname}?sections=${encodeURIComponent(sectionId)}`)
        const data = await res.json()
        const html = data && data[sectionId]
        if (!html) return
        const tpl = document.createElement('div')
        tpl.innerHTML = html
        const fresh = tpl.querySelector('[id^="shopify-section-"]') || tpl
        if (!sec.isConnected) return
        syncThemeDom(sec, fresh)
      } catch {
        /* totals refresh is cosmetic — cart state itself is already correct */
      }
    }, 350)
  }

  // Swap a control's glyph/number for a spinner in place. The element is
  // replaced wholesale on the next render(), so no teardown is needed.
  function showSpinner(elm) {
    if (!elm) return
    // Lock the current footprint so swapping in the spinner causes no layout shift.
    const w = elm.offsetWidth
    const h = elm.offsetHeight
    if (w) elm.style.minWidth = w + 'px'
    if (h) elm.style.minHeight = h + 'px'
    elm.classList.add('sai-zj3bpb6w__busy')
    elm.setAttribute('aria-busy', 'true')
    const spin = el('span', 'sai-zj3bpb6w__spinner')
    spin.setAttribute('role', 'status')
    spin.setAttribute('aria-label', 'Updating')
    elm.textContent = ''
    elm.appendChild(spin)
  }

  function svgIcon(path) {
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', path)
    svg.appendChild(p)
    return svg
  }

  const prop = (line, key) => (line.properties && line.properties[key]) != null ? line.properties[key] : null
  const bundleId = (line) => prop(line, '_bundle_id') || prop(line, '__bundle_id') || null
  const isBundleChild = (line) => Boolean(prop(line, '_bundle_parent') || prop(line, '__bundle_parent'))
  const isFreeGift = (line) => Number(line.price) === 0 || Number(line.total_discount) >= Number(line.original_line_price)

  function visibleProperties(line) {
    const props = line.properties || {}
    return Object.keys(props)
      .filter((k) => k.charAt(0) !== '_' && props[k] != null && props[k] !== '')
      .map((k) => `${k}: ${props[k]}`)
  }

  // ── Variant block ──
  function variantText(line) {
    if (Array.isArray(line.options_with_values) && line.options_with_values.length) {
      return line.options_with_values
    }
    return line.variant_title ? [{ name: '', value: line.variant_title }] : []
  }

  function buildVariant(line, cfg, ctx) {
    const opts = variantText(line)
    if (!opts.length) return null

    if (cfg.variantEditable) {
      const wrap = el('div', 'sai-zj3bpb6w__variant-pills')
      for (const o of opts) {
        const sel = el('select', 'sai-zj3bpb6w__select')
        sel.setAttribute('data-sai-variant-option', o.name || '')
        const opt = el('option', null, `${o.name ? o.name + ': ' : ''}${o.value}`)
        opt.value = o.value
        opt.selected = true
        sel.appendChild(opt)
        // Sibling options are fetched lazily on first focus to keep the
        // initial render cheap on multi-line carts.
        sel.addEventListener('focus', () => ctx.populateVariantOptions(line, sel, o.name), { once: true })
        sel.addEventListener('change', () => ctx.onVariantChange(line))
        wrap.appendChild(sel)
      }
      return wrap
    }

    if (cfg.variantRenderMode === 'pills') {
      const wrap = el('div', 'sai-zj3bpb6w__variant-pills')
      for (const o of opts) wrap.appendChild(el('span', 'sai-zj3bpb6w__pill', `${o.name ? o.name + ': ' : ''}${o.value}`))
      return wrap
    }

    if (cfg.variantRenderMode === 'plain') {
      return el('div', 'sai-zj3bpb6w__variant', opts.map((o) => o.value).join(' / '))
    }

    // label_value — one "Name: Value" per line (stacked), matching the cart drawer.
    const wrap = el('div', 'sai-zj3bpb6w__variant')
    for (const o of opts) wrap.appendChild(el('div', null, `${o.name ? o.name + ': ' : ''}${o.value}`))
    return wrap
  }

  // ── Prices ──
  function buildPrices(line, cfg, currency) {
    const wrap = el('div', 'sai-zj3bpb6w__prices')
    // Display the LINE total (price × quantity) so the amount tracks quantity
    // changes — matches standard cart UIs. Per-unit price is the secondary line.
    const lineNow = Number(line.final_line_price != null ? line.final_line_price : line.line_price)
    const lineWas = Number(line.original_line_price != null ? line.original_line_price : lineNow)
    const hasDiscount = lineWas > lineNow
    const isFree = lineNow === 0

    // Free lines strike the original through `freeShowOriginalStrikethrough`;
    // priced lines through `showCompareAt`.
    const showCmp = hasDiscount && (isFree ? cfg.freeShowOriginalStrikethrough : cfg.showCompareAt)
    if (showCmp) {
      const cmp = el('span', 'sai-zj3bpb6w__compare', money(lineWas, currency))
      if (!isFree && !cfg.compareAtStrikethrough) cmp.classList.add('sai-zj3bpb6w__compare--nostrike')
      wrap.appendChild(cmp)
    }

    // Free lines show the "FREE" label in the price slot, not a ₹0 amount.
    wrap.appendChild(el('span', 'sai-zj3bpb6w__price', isFree ? (cfg.freeLabelText || 'Free') : money(lineNow, currency)))

    if (cfg.showPerUnitPrice && Number(line.quantity) > 1) {
      wrap.appendChild(el('span', 'sai-zj3bpb6w__unit', `${money(line.price, currency)} each`))
    }

    if (cfg.showSavings && hasDiscount) {
      const savedCents = lineWas - lineNow
      const pct = Math.round((savedCents / lineWas) * 100)
      let text = ''
      if (cfg.savingsFormat === 'absolute') text = `Save ${money(savedCents, currency)}`
      else if (cfg.savingsFormat === 'both') text = `Save ${money(savedCents, currency)} (${pct}%)`
      else text = `Save ${pct}%`
      wrap.appendChild(el('span', 'sai-zj3bpb6w__savings', text))
    }
    return wrap
  }

  // ── Quantity control ──
  function buildQuantity(line, cfg, ctx) {
    const ctl = el('div', 'sai-zj3bpb6w__qtyctl')
    const min = cfg.removeAtZero ? 0 : Math.max(0, Number(cfg.minQuantity) || 0)
    const max = Math.max(min + 1, Number(cfg.maxQuantity) || 99)

    if (cfg.quantityControl === 'dropdown') {
      const sel = el('select', 'sai-zj3bpb6w__select')
      sel.setAttribute('aria-label', 'Quantity')
      for (let q = Math.max(min, cfg.removeAtZero ? 0 : 1); q <= max; q++) {
        const o = el('option', null, `Qty: ${q}`)
        o.value = String(q)
        if (q === Number(line.quantity)) o.selected = true
        sel.appendChild(o)
      }
      sel.addEventListener('change', () => ctx.changeQuantity(line.key, Number(sel.value), ctl))
      ctl.appendChild(sel)
      return ctl
    }

    const stepper = el('div', 'sai-zj3bpb6w__stepper')
    const dec = el('button', 'sai-zj3bpb6w__step', '−')
    dec.type = 'button'
    dec.setAttribute('data-sai-step', '-1')
    dec.setAttribute('aria-label', 'Decrease quantity')
    if (Number(line.quantity) <= min) dec.disabled = true
    const qty = el('span', 'sai-zj3bpb6w__qty', String(line.quantity))
    const inc = el('button', 'sai-zj3bpb6w__step', '+')
    inc.type = 'button'
    inc.setAttribute('data-sai-step', '1')
    inc.setAttribute('aria-label', 'Increase quantity')
    if (Number(line.quantity) >= max) inc.disabled = true
    stepper.appendChild(dec)
    stepper.appendChild(qty)
    stepper.appendChild(inc)
    ctl.appendChild(stepper)
    return ctl
  }

  // ── Remove control ──
  function buildRemove(cfg) {
    const btn = el('button', 'sai-zj3bpb6w__remove')
    btn.type = 'button'
    btn.setAttribute('data-sai-remove', '')
    btn.setAttribute('aria-label', 'Remove item')
    if (cfg.removeStyle === 'text') btn.textContent = 'Remove'
    else btn.appendChild(svgIcon(ICONS[cfg.removeStyle] || ICONS.trash))
    return btn
  }

  // ── Badges / meta ──
  function buildBadges(line, cfg) {
    const types = Array.isArray(cfg.badgeTypes) ? cfg.badgeTypes : []
    const wrap = el('div', 'sai-zj3bpb6w__badges')
    const hasDiscount = Number(line.original_price) > Number(line.price)
    if (types.indexOf('discount_percent') !== -1 && hasDiscount) {
      const pct = Math.round((1 - Number(line.price) / Number(line.original_price)) * 100)
      if (pct > 0) wrap.appendChild(el('span', 'sai-zj3bpb6w__badge', `-${pct}%`))
    }
    if (types.indexOf('bestseller') !== -1 && (prop(line, '_bestseller') || prop(line, 'bestseller'))) {
      wrap.appendChild(el('span', 'sai-zj3bpb6w__badge', 'Bestseller'))
    }
    if (types.indexOf('new') !== -1 && (prop(line, '_new') || prop(line, 'new'))) {
      wrap.appendChild(el('span', 'sai-zj3bpb6w__badge', 'New'))
    }
    if (types.indexOf('custom') !== -1 && cfg.badgeCustomText) {
      wrap.appendChild(el('span', 'sai-zj3bpb6w__badge', cfg.badgeCustomText))
    }
    return wrap.children.length ? wrap : null
  }

  function fillTemplate(tpl, token, value) {
    return String(tpl || '').split(token).join(value)
  }

  // ── One line ──
  function buildLine(line, cfg, ctx, currency) {
    const li = el('li', 'sai-zj3bpb6w__line')
    li.setAttribute('data-line-key', line.key)
    const gift = isFreeGift(line)
    if (gift) li.classList.add('sai-zj3bpb6w__line--gift')
    if (cfg.bundleDisplay === 'grouped' && isBundleChild(line)) li.classList.add('sai-zj3bpb6w__line--bundle-child')

    // Thumbnail
    const imgSrc = line.image || (gift && cfg.freeGiftImagePlaceholder && cfg.freeGiftImagePlaceholder.url)
    if (imgSrc) {
      const img = el('img', 'sai-zj3bpb6w__thumb')
      img.src = imgSrc
      img.alt = line.product_title || line.title || ''
      img.loading = 'lazy'
      li.appendChild(img)
    } else {
      li.appendChild(el('div', 'sai-zj3bpb6w__thumb'))
    }

    // Body
    const body = el('div', 'sai-zj3bpb6w__body')

    const badges = cfg.showBadges ? buildBadges(line, cfg) : null
    if (badges) body.appendChild(badges)

    const titleEl = cfg.titleLinksToPdp && line.url ? el('a', 'sai-zj3bpb6w__title', line.product_title || line.title || '') : el('div', 'sai-zj3bpb6w__title', line.product_title || line.title || '')
    if (cfg.titleLinksToPdp && line.url) titleEl.href = line.url
    body.appendChild(titleEl)

    const variantEl = buildVariant(line, cfg, ctx)
    if (variantEl) body.appendChild(variantEl)

    // Optional subtitle/description (e.g. a free-coupon's usage note).
    if (prop(line, '_subtitle')) body.appendChild(el('div', 'sai-zj3bpb6w__meta', prop(line, '_subtitle')))

    if (cfg.showRating && prop(line, '_rating')) {
      body.appendChild(el('div', 'sai-zj3bpb6w__rating', `★ ${prop(line, '_rating')}`))
    }
    if (cfg.showEdd) {
      const date = prop(line, '_edd') || prop(line, '_delivery_date') || ''
      const text = fillTemplate(cfg.eddTemplate, '{date}', date)
      if (date || cfg.eddTemplate.indexOf('{date}') === -1) body.appendChild(el('div', 'sai-zj3bpb6w__meta', text))
    }
    if (cfg.showScarcity) {
      const qty = prop(line, '_inventory_quantity') || prop(line, '_stock') || ''
      const text = fillTemplate(cfg.scarcityTemplate, '{qty}', qty)
      if (qty || cfg.scarcityTemplate.indexOf('{qty}') === -1) body.appendChild(el('div', 'sai-zj3bpb6w__meta', text))
    }
    if (cfg.showMicroline && cfg.microlineText) {
      body.appendChild(el('div', 'sai-zj3bpb6w__meta', cfg.microlineText))
    }
    if (cfg.showItemProperties) {
      const props = visibleProperties(line)
      if (props.length) {
        if (cfg.propertiesDisplay === 'accordion') {
          const details = el('details', 'sai-zj3bpb6w__props')
          details.appendChild(el('summary', 'sai-zj3bpb6w__props-summary', 'Details'))
          details.appendChild(el('div', null, props.join(' · ')))
          body.appendChild(details)
        } else {
          body.appendChild(el('p', 'sai-zj3bpb6w__props', props.join(' · ')))
        }
      }
    }
    if (cfg.showWishlist) {
      const wish = el('button', 'sai-zj3bpb6w__wishlist', cfg.wishlistLabel || 'Move to wishlist')
      wish.type = 'button'
      wish.setAttribute('data-sai-wishlist', '')
      body.appendChild(wish)
    }
    li.appendChild(body)

    // Quantity (skip stepper for non-removable free gift)
    const lockGift = gift && !cfg.freeRemovable
    if (!lockGift) {
      li.appendChild(buildQuantity(line, cfg, ctx))
    } else {
      li.appendChild(el('div', 'sai-zj3bpb6w__qtyctl'))
    }

    // Aside: prices + remove
    const aside = el('div', 'sai-zj3bpb6w__aside')
    const showLinePrice = !gift || cfg.freeShowOriginalStrikethrough || !isBundleChild(line) || cfg.showComponentPrices
    if (showLinePrice) aside.appendChild(buildPrices(line, cfg, currency))
    if ((!lockGift || cfg.freeRemovable) && cfg.removeStyle) aside.appendChild(buildRemove(cfg))
    li.appendChild(aside)

    return li
  }

  function orderLines(items, cfg) {
    if (cfg.bundleDisplay === 'grouped') {
      const copy = items.slice()
      copy.sort((a, b) => {
        const ba = bundleId(a) || a.key
        const bb = bundleId(b) || b.key
        return ba < bb ? -1 : ba > bb ? 1 : 0
      })
      if (!cfg.showComponentLines) return copy.filter((l) => !isBundleChild(l))
      return copy
    }
    return items
  }

  function render(node, cfg, ctx, cart) {
    const list = node.querySelector('[data-sai-cart-lines]')
    const empty = node.querySelector('[data-sai-cart-empty]')
    if (!list) return
    const items = (cart && cart.items) || []
    list.textContent = ''
    if (!items.length) {
      if (empty) empty.hidden = false
      return
    }
    if (empty) empty.hidden = true
    const frag = document.createDocumentFragment()
    for (const line of orderLines(items, cfg)) frag.appendChild(buildLine(line, cfg, ctx, cart.currency))
    list.appendChild(frag)
  }

  function makeContext(node, cfg, track) {
    const cart = window.Spectrum && window.Spectrum.cart
    const productCache = {}

    async function refresh() {
      if (!cart) return
      try {
        const fresh = await cart.get()
        lastCart = fresh
        render(node, cfg, ctx, fresh)
      } catch {
        /* fail soft: keep last render */
      }
    }

    async function changeQuantity(key, quantity, busyEl) {
      if (!cart) return
      if (cfg.removeConfirmation && quantity === 0 && !window.confirm('Remove this item?')) {
        return
      }
      const li = node.querySelector(`[data-line-key="${key}"]`)
      showSpinner(busyEl)
      try {
        const updated = await cart.change({ id: key, quantity })
        if (quantity === 0) {
          track('cart_line:remove', { line_key: key })
          if (li && cfg.enableMicroanimations) {
            li.classList.add('sai-zj3bpb6w__line--leaving')
            await new Promise((r) => setTimeout(r, 180))
          }
        } else {
          track('cart_line:qty_change', { line_key: key, quantity })
        }
        lastCart = updated
        render(node, cfg, ctx, updated)
        emitCartUpdated()
        refreshThemeSection(node)
      } catch {
        refresh()
      }
    }

    async function fetchProduct(handle) {
      if (!handle) return null
      if (productCache[handle]) return productCache[handle]
      try {
        const res = await fetch(`/products/${handle}.js`, { headers: { Accept: 'application/json' } })
        const json = await res.json()
        productCache[handle] = json
        return json
      } catch {
        return null
      }
    }

    async function populateVariantOptions(line, select, optionName) {
      const product = await fetchProduct(line.handle)
      if (!product || !Array.isArray(product.options)) return
      const idx = product.options.findIndex((o) => (o.name || o) === optionName)
      if (idx < 0) return
      const seen = {}
      const values = []
      for (const v of product.variants || []) {
        const val = v.options ? v.options[idx] : null
        if (val != null && !seen[val]) {
          seen[val] = true
          values.push(val)
        }
      }
      const current = select.value
      select.textContent = ''
      for (const val of values) {
        const o = el('option', null, `${optionName ? optionName + ': ' : ''}${val}`)
        o.value = val
        if (val === current) o.selected = true
        select.appendChild(o)
      }
    }

    async function onVariantChange(line) {
      const product = await fetchProduct(line.handle)
      if (!product) return
      const li = node.querySelector(`[data-line-key="${line.key}"]`)
      if (!li) return
      const selects = li.querySelectorAll('[data-sai-variant-option]')
      const chosen = Array.prototype.map.call(selects, (s) => s.value)
      const match = (product.variants || []).find((v) => v.options && v.options.every((val, i) => val === chosen[i]))
      if (!match || match.id === line.variant_id) return
      showSpinner(li.querySelector('.sai-zj3bpb6w__variant-pills'))
      try {
        // Swap variant: remove the old line, add the new variant at same qty.
        await cart.change({ id: line.key, quantity: 0 })
        await cart.add([{ id: match.id, quantity: line.quantity }])
        track('cart_line:variant_change', { line_key: line.key, variant_id: match.id })
        emitCartUpdated()
        refreshThemeSection(node)
        refresh()
      } catch {
        refresh()
      }
    }

    const ctx = { refresh, changeQuantity, populateVariantOptions, onVariantChange }
    return ctx
  }

  function wire(node, cfg, ctx, track) {
    node.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const li = target.closest('[data-line-key]')
      if (!li) return
      const key = li.getAttribute('data-line-key')

      const step = target.closest('[data-sai-step]')
      if (step) {
        const delta = Number(step.getAttribute('data-sai-step')) || 0
        const qtyEl = li.querySelector('.sai-zj3bpb6w__qty')
        const current = Number(qtyEl && qtyEl.textContent) || 0
        // Spinner swaps in place of the quantity NUMBER only — the pill and
        // +/- buttons stay put (no layout shift).
        ctx.changeQuantity(key, Math.max(0, current + delta), li.querySelector('.sai-zj3bpb6w__qty'))
        return
      }
      const removeBtn = target.closest('[data-sai-remove]')
      if (removeBtn) {
        ctx.changeQuantity(key, 0, removeBtn)
        return
      }
      if (target.closest('[data-sai-wishlist]')) {
        track('cart_line:wishlist_nudge_click', { line_key: key })
        node.dispatchEvent(new CustomEvent('sai:cart-line:wishlist', { bubbles: true, detail: { lineKey: key } }))
      }
    })

    // Refresh on every cart-change event the Spectrum SDK emits (it dispatches
    // these on both document and window) plus our own test event. Coalesced so
    // the several aliases fired for one action cause a single re-render.
    let cartEventPending = false
    function onCartEvent() {
      // Section swaps replace the instance root but document-level listeners
      // survive — a disconnected node's listeners must become no-ops or every
      // swap would add another fetch per cart event.
      if (!node.isConnected) return
      if (cartEventPending) return
      cartEventPending = true
      setTimeout(() => {
        cartEventPending = false
        if (!node.isConnected) return
        ctx.refresh()
        // Keep theme-owned totals in sync no matter who mutated the cart
        // (upsell adds, third-party apps). Debounced inside; section swaps
        // never re-fire cart events, so this cannot loop.
        refreshThemeSection(node)
      }, 0)
    }
    const CART_EVENTS = ['spectrum:cart:updated', 'cart:updated', 'cart:update', 'cart:refresh', 'cart:item-added', 'cart:add', 'cart:build']
    CART_EVENTS.forEach((name) => {
      document.addEventListener(name, onCartEvent)
      window.addEventListener(name, onCartEvent)
    })
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) ctx.refresh()
    })
  }

  function initNode(node) {
    if (node.__saiCartLineBound) return
    node.__saiCartLineBound = true
    const cfg = readConfig(node)
    let track = () => {}
    if (window.__spectrumAi && window.__spectrumAi.snippet) {
      const handles = window.__spectrumAi.snippet.bind(node, () => {})
      if (handles && typeof handles.track === 'function') track = handles.track
    }
    const ctx = makeContext(node, cfg, track)
    wire(node, cfg, ctx, track)
    if (lastCart) {
      try {
        render(node, cfg, ctx, lastCart)
      } catch {
        /* cache paint is best-effort; the refresh below is authoritative */
      }
    }
    ctx.refresh()
  }

  function init() {
    document.querySelectorAll(`[data-spectrum-snippet-id="${SNIPPET_ID}"]`).forEach(initNode)
  }

  // Theme JS (native steppers, recommendation adds, third-party apps) mutates
  // the cart without firing any event name we can rely on — theme event
  // vocabularies vary per theme. Watching the network layer is the only
  // theme-agnostic signal, so this is a deliberate exception to the
  // no-global-side-effects rule: installed once across all Spectrum snippets
  // (window guard), transparent pass-through, GET /cart.js reads don't match.
  function installCartWatch() {
    if (window.__saiCartWatch__) return
    window.__saiCartWatch__ = true
    const isCartMutation = (url) => /\/cart\/(add|change|update|clear)/.test(String(url || ''))
    const origFetch = window.fetch
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url
      const p = origFetch.apply(this, args)
      if (isCartMutation(url)) p.then(() => emitCartUpdated()).catch(() => {})
      return p
    }
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (isCartMutation(url)) this.addEventListener('load', () => emitCartUpdated())
      return origOpen.call(this, method, url, ...rest)
    }
  }

  // Quick-add forms that no theme JS handles fall back to a native POST to
  // /cart/add — a full page navigation that visibly reloads everything.
  // When a cart-line instance is on the page, convert that native submit to
  // an AJAX add so the cart UI updates in place. Bubble phase + the
  // defaultPrevented check guarantee themes that already AJAX their adds are
  // never touched; on fetch failure the native submit proceeds as fallback.
  function installAddFormIntercept() {
    if (window.__saiAddIntercept__) return
    window.__saiAddIntercept__ = true
    document.addEventListener('submit', (e) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      if (e.defaultPrevented) return
      if (!/\/cart\/add/.test(form.getAttribute('action') || '')) return
      if (!document.querySelector('[data-sai-cart-line]')) return
      e.preventDefault()
      fetch('/cart/add.js', { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
        .then((r) => {
          if (!r.ok) throw new Error('add failed')
          // The cart-watch fetch patch already broadcasts; nothing else to do.
        })
        .catch(() => {
          window.__saiAddIntercept__ = false
          form.submit()
        })
    })
  }

  // Themes morph/replace the cart section's DOM after cart mutations
  // (Section Rendering API). That discards bound instance roots, so re-scan
  // on every subtree change — initNode is a no-op for already-bound nodes,
  // and fresh (replaced) roots get bound + rendered immediately.
  function watchDom() {
    if (typeof MutationObserver === 'undefined') return
    let pending = false
    const mo = new MutationObserver(() => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        init()
      }, 60)
    })
    mo.observe(document.body, { childList: true, subtree: true })
  }

  function ready() {
    if (window.Spectrum && window.__spectrumAi) {
      installCartWatch()
      installAddFormIntercept()
      init()
      watchDom()
      return true
    }
    return false
  }

  if (!ready()) {
    document.addEventListener('spectrum:ready', init, { once: true })
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (ready() || tries > 50) clearInterval(timer)
    }, 100)
  }
})()
