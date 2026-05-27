/* =============================================================================
 * FBT Individual ATC (fbtatc4z) — per-card Add To Cart runtime.
 *
 * Each card adds a single variant via Spectrum.cart.addAndOpen(). No bundle
 * selection state — one click, one product, one cart-add call.
 *
 * Analytics mirror the pb3tmxq9 bundle widget convention:
 *   - recommendations_fbt:add_to_cart      (intent — fires before the call)
 *   - recommendations_fbt:added_to_cart    (confirmation — same shape)
 *
 * No `:add_to_cart_failed` event — an intent without a matching confirmation
 * surfaces the failure in the funnel.
 *
 * No-bind fallback: if window.__spectrumAi is absent, analytics become a
 * noop. The cart-add itself depends on window.Spectrum.cart and will surface
 * an error in the per-card error region if that's missing.
 * ============================================================================= */

;(() => {
  if (window.__sai_fbtatc4z_initialized__) return
  window.__sai_fbtatc4z_initialized__ = true

  const SNIPPET_ID = 'fbtatc4z'
  const TAG = 'sai-fbtatc4z'
  const FEATURE_SLUG = 'recommendations_fbt'
  // After a successful add, hold the per-card CTA in "Added" state briefly.
  // Long enough for visual feedback when the theme doesn't open a drawer;
  // short enough that the merchant can keep clicking other cards.
  const SUCCESS_FEEDBACK_MS = 1500

  function noopTrack() {}
  function noopEmit() {}

  function safeTrack(track) {
    return (name, payload) => {
      try {
        track(name, payload)
      } catch (_) {
        /* analytics is best-effort */
      }
    }
  }

  function safeEmit(emit) {
    return (name, payload) => {
      try {
        emit(name, payload)
      } catch (_) {
        /* analytics is best-effort */
      }
    }
  }

  // Formats cents to a string matching the shop's Liquid `| money` output.
  // Accepts either the full data payload `{ moneyFormat, currency }` or a
  // legacy currency string. Using `shop.money_format` (e.g. `"${{amount}}"`)
  // makes JS-rendered prices match SSR ones; `Intl.NumberFormat` was
  // producing `US$699.95` while Liquid renders `$699.95`.
  function formatMoney(cents, ctx) {
    if (cents == null) return ''
    const fn = window.Spectrum?.formatMoney
    if (typeof fn === 'function') return fn(cents)
    const value = Number(cents) / 100
    if (!Number.isFinite(value)) return ''
    const moneyFormat = ctx && typeof ctx === 'object' ? ctx.moneyFormat : null
    if (typeof moneyFormat === 'string' && moneyFormat.includes('{{')) {
      return moneyFormat
        .replace(/{{\s*amount\s*}}/g, value.toFixed(2))
        .replace(/{{\s*amount_no_decimals\s*}}/g, String(Math.round(value)))
        .replace(/{{\s*amount_with_comma_separator\s*}}/g, value.toFixed(2).replace('.', ','))
        .replace(/{{\s*amount_no_decimals_with_comma_separator\s*}}/g, String(Math.round(value)))
        .replace(/{{\s*amount_with_space_separator\s*}}/g, value.toFixed(2).replace('.', ' '))
        .replace(/{{\s*amount_no_decimals_with_space_separator\s*}}/g, String(Math.round(value)))
        .replace(/{{\s*amount_with_apostrophe_separator\s*}}/g, value.toFixed(2).replace('.', "'"))
    }
    // No money_format available — `$X.XX` is the right default for the
    // majority of shops (USD/CAD/AUD/NZD). Avoids Intl's "US$" prefix.
    return `$${value.toFixed(2)}`
  }

  function offPercent(price, compareAt) {
    if (price == null || compareAt == null) return null
    const p = Number(price)
    const c = Number(compareAt)
    if (!(c > p)) return null
    return Math.round(((c - p) / c) * 100)
  }

  // ── Multi-option helpers (name-keyed, mirrors i2m3o6sr) ───────────────
  // A Shopify product has 1–3 option types (Size, Color, Material, etc.).
  // `product.options` is the list of option names; `variant.options` is the
  // ordered tuple of values for that variant. The quickshop tracks the
  // shopper's current selection in an `{ [optName]: value }` map for
  // cleaner pill bookkeeping than positional indices.

  function optionNames(product) {
    return (product.options || []).map((o) => (typeof o === 'string' ? o : o.name))
  }

  function isMeaningfulOptionSet(product) {
    const names = optionNames(product)
    return !(names.length === 1 && names[0] === 'Title')
  }

  function uniqueValuesByOptionIndex(product, optionIndex) {
    const seen = new Set()
    const values = []
    for (const v of product.variants || []) {
      const value = v.options?.[optionIndex]
      if (value != null && !seen.has(value)) {
        seen.add(value)
        values.push(value)
      }
    }
    return values
  }

  // Find first variant whose values match every locked-in option from the
  // current selection map. Returns null when nothing matches yet (e.g. the
  // shopper changed one axis to a value with no co-occurring variant).
  function findVariantByOptions(product, optionValues) {
    const names = optionNames(product)
    for (const v of product.variants || []) {
      const vOpts = v.options || []
      let hit = true
      for (let i = 0; i < names.length; i++) {
        if (vOpts[i] !== optionValues[names[i]]) {
          hit = false
          break
        }
      }
      if (hit) return v
    }
    return null
  }

  // Cross-axis availability — given the locked-in other-axis values, is
  // {optName: optValue} reachable by *some available* variant? Used to grey
  // out pills as the shopper narrows their selection. Always respects
  // `v.available` — if every variant is OOS the merchant wants the product
  // shown as fully unavailable (e.g. sold-out gift cards), not silently
  // marked available because of a historical Shopify gift-card quirk.
  function isOptionValueAvailable(product, optName, optValue, currentValues) {
    const names = optionNames(product)
    for (const v of product.variants || []) {
      if (!v.available) continue
      const vOpts = v.options || []
      let hit = true
      for (let i = 0; i < names.length; i++) {
        const name = names[i]
        const target = name === optName ? optValue : currentValues[name]
        if (target != null && target !== '' && vOpts[i] !== target) {
          hit = false
          break
        }
      }
      if (hit) return true
    }
    return false
  }

  function pickInitialVariant(product, preselectedId) {
    const variants = product.variants || []
    if (preselectedId) {
      const target = variants.find((v) => String(v.id) === String(preselectedId))
      // Only honor the preselected variant if it's available — opening the
      // picker on an OOS variant traps the shopper on a "Sold out" pill
      // until they manually flip both axes. Fall through to the first
      // available variant if the preselected one isn't purchasable.
      if (target?.available) return target
    }
    return variants.find((v) => v.available) || variants[0] || null
  }

  function optionValuesFromVariant(product, variant) {
    const out = {}
    const names = optionNames(product)
    const vOpts = variant?.options || []
    names.forEach((n, i) => {
      out[n] = vOpts[i] ?? ''
    })
    return out
  }

  // Derive a per-value swatch image by taking the featuredImage of the
  // first variant matching that value. Works best on Color (each variant
  // usually has its own image); for Size etc. it falls back to null and
  // the pill renders text-only. Same trick i2m3o6sr uses.
  function swatchImageForValue(product, optionIndex, value) {
    for (const v of product.variants || []) {
      if (v.options?.[optionIndex] === value && v.featuredImage) return v.featuredImage
    }
    return null
  }

  // Tiny SVG icon factory — keeps construction off the DOM-build hot path
  // and out of innerHTML.
  function makeIcon(kind) {
    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('focusable', 'false')
    if (kind === 'close') {
      const path = document.createElementNS(svgNS, 'path')
      path.setAttribute('d', 'M3 3L13 13M13 3L3 13')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      svg.appendChild(path)
    }
    return svg
  }

  // Focusable elements inside the modal panel. Used to scope Tab navigation
  // to the modal and to pick the initial focus target.
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]):not([aria-disabled="true"]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

  function focusablesIn(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hidden && el.offsetParent !== null,
    )
  }

  class SaiFbtAtcWidget extends HTMLElement {
    constructor() {
      super()
      this._data = null
      this._productsById = new Map()
      this._afterAddAction = 'stay'
      this._ctaTimers = new Map()
      this._modal = null
      this._scrollLock = null
      this._track = noopTrack
      this._emit = noopEmit
      this._onClick = this._onClick.bind(this)
    }

    connectedCallback() {
      if (this._initialized) return
      this._initialized = true
      this._readPayload()
      this._bindEvents()
    }

    disconnectedCallback() {
      this.removeEventListener('click', this._onClick)
      // Clear any pending success-state timers so a delayed redirect can't
      // fire after the user has navigated away.
      for (const t of this._ctaTimers.values()) clearTimeout(t)
      this._ctaTimers.clear()
      // Tear down an open quickshop — removes the document-level keydown
      // listener + restores scroll-lock that would otherwise leak.
      if (this._modal) this._closeQuickshop()
    }

    setAnalytics(track, emit) {
      this._track = typeof track === 'function' ? safeTrack(track) : noopTrack
      this._emit = typeof emit === 'function' ? safeEmit(emit) : noopEmit
    }

    _readPayload() {
      const node = this.querySelector('script[type="application/json"][data-fbtatc-payload]')
      if (!node) return
      try {
        this._data = JSON.parse(node.textContent)
      } catch (_) {
        this._data = null
        return
      }
      this._afterAddAction = this._data.afterAddAction || 'stay'
      for (const p of this._data.products || []) {
        this._productsById.set(String(p.id), p)
      }
    }

    _bindEvents() {
      this.addEventListener('click', this._onClick)
    }

    _onClick(evt) {
      // Below-title pill click → open the quickshop. The pill only exists
      // when variant_selector_mode == 'below_title' AND the product has >1
      // variant (Liquid gates the markup).
      const trigger = evt.target.closest('[data-variant-trigger]')
      if (trigger && this.contains(trigger)) {
        evt.preventDefault()
        const card = trigger.closest('[data-product-id]')
        if (!card) return
        const cardCta = card.querySelector('[data-fbtatc-cta]')
        this._openQuickshop(card.dataset.productId, cardCta)
        return
      }

      const button = evt.target.closest('[data-fbtatc-cta]')
      if (!button || !this.contains(button)) return
      evt.preventDefault()
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return
      const productId = button.dataset.productId
      const product = this._productsById.get(String(productId))
      const multiVariant =
        product && isMeaningfulOptionSet(product) && (product.variants?.length || 0) > 1

      // In `on_atc` mode, +ADD on a multi-variant product opens the
      // quickshop. In `below_title` mode the picker is the dedicated pill
      // above — +ADD just adds the currently-selected variant directly so
      // the shopper isn't re-prompted after they already chose.
      const selectorMode = this._data?.variantSelectorMode || 'below_title'
      if (multiVariant && selectorMode === 'on_atc') {
        this._openQuickshop(productId, button)
        return
      }
      const variantId = button.dataset.variantId
      if (!variantId) return
      this._addToCart(button, productId, variantId)
    }

    async _addToCart(button, productId, variantId) {
      this._clearError()
      this._setLoading(button, true)

      const product = this._productsById.get(String(productId))
      const atcPayload = {
        bundle_size: 1,
        items: [
          {
            product_id: product?.id ?? productId,
            variant_id: variantId,
            quantity: 1,
          },
        ],
      }
      // Fire intent before the call so failures still get an `add_to_cart`
      // (without a matching `added_to_cart`), keeping the funnel honest.
      this._track(`${FEATURE_SLUG}:add_to_cart`, atcPayload)
      this._emit(`${FEATURE_SLUG}:add_to_cart`, atcPayload)

      let succeeded = false
      try {
        const cartApi = window.Spectrum?.cart
        if (!cartApi || typeof cartApi.addAndOpen !== 'function') {
          throw new Error('Spectrum cart API unavailable')
        }
        // addAndOpen handles section refresh + drawer-open detection + cart
        // event dispatch. We pass a single-variant items list; the API
        // batches gracefully whether it's 1 or N items.
        const cartResponse = await cartApi.addAndOpen([{ id: variantId, quantity: 1 }], {
          sourceId: `spectrum-${SNIPPET_ID}`,
        })
        if (cartResponse && cartResponse.ok === false) {
          throw new Error(cartResponse.error?.message || 'Could not add to cart')
        }

        succeeded = true
        this._track(`${FEATURE_SLUG}:added_to_cart`, atcPayload)
        this._emit(`${FEATURE_SLUG}:added_to_cart`, atcPayload)
      } catch (err) {
        this._setError(err?.message || 'Could not add to cart')
      } finally {
        this._setLoading(button, false)
        if (succeeded) {
          this._enterSuccessState(button)
        }
      }
    }

    _setLoading(button, loading) {
      const loader = button.querySelector('[data-fbtatc-loader]')
      if (loading) {
        button.setAttribute('data-loading', 'true')
        button.disabled = true
      } else {
        button.removeAttribute('data-loading')
        // Don't re-enable on `aria-disabled="true"` set elsewhere (e.g.
        // out-of-stock variant SSR'd as disabled).
        if (button.getAttribute('aria-disabled') !== 'true') {
          button.disabled = false
        }
      }
      if (loader) loader.hidden = !loading
    }

    _enterSuccessState(button) {
      const labelEl = button.querySelector('[data-fbtatc-cta-label]')
      if (!labelEl) return
      const baseLabel = labelEl.textContent
      button.setAttribute('data-state', 'added')
      button.disabled = true
      labelEl.textContent = 'Added ✓'

      const action = this._afterAddAction || 'stay'
      const prev = this._ctaTimers.get(button)
      if (prev) clearTimeout(prev)
      const timer = setTimeout(() => {
        if (action === 'redirect-to-cart') {
          window.location.href = '/cart'
          return
        }
        if (action === 'redirect-to-checkout') {
          window.location.href = '/checkout'
          return
        }
        button.removeAttribute('data-state')
        labelEl.textContent = baseLabel
        if (button.getAttribute('aria-disabled') !== 'true') {
          button.disabled = false
        }
        this._ctaTimers.delete(button)
      }, SUCCESS_FEEDBACK_MS)
      this._ctaTimers.set(button, timer)
    }

    _setError(message) {
      const el = this.querySelector('[data-fbtatc-error]')
      if (!el) return
      el.textContent = message
      el.hidden = !message
    }

    _clearError() {
      this._setError('')
    }

    // ── Mini-PDP / quickshop ────────────────────────────────────────────
    // Triggered when +ADD is clicked on a multi-variant product. The modal
    // *is* the purchase surface — image + title + live price + option pills
    // (with swatches when variants carry per-value featured images) + ATC
    // button. ATC inside the modal funnels back through `_addToCart` with
    // the committed variantId and closes on success.

    _openQuickshop(productId, triggerButton) {
      const product = this._productsById.get(String(productId))
      if (!product || (product.variants?.length || 0) < 2) return

      // Double-open guard: if a previous overlay is still mid-close (DOM
      // still attached during the slide-out transition), sync-remove it
      // before building a new one. Without this two aria-modal dialogs
      // can be live simultaneously and screen readers double-count.
      for (const stale of document.querySelectorAll('.sai-fbtatc4z__quickshop')) {
        if (stale.parentNode) stale.parentNode.removeChild(stale)
      }

      const initialVariant = pickInitialVariant(product, triggerButton?.dataset.variantId)
      this._modal = {
        productId: String(productId),
        product,
        triggerButton,
        optionValues: optionValuesFromVariant(product, initialVariant),
        variantId: initialVariant ? String(initialVariant.id) : '',
        // Captured so the close path can return focus to the element the
        // shopper was on when the modal opened — meeting the
        // role=dialog + aria-modal accessibility contract.
        previousFocus: document.activeElement,
      }

      const overlay = document.createElement('div')
      overlay.className = 'sai-fbtatc4z__quickshop'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-label', 'Choose variant')
      // The Studio style bake is scoped via
      // `[data-spectrum-instance-id="X"][data-spectrum-variant-id="Y"] .target`.
      // Since the overlay is appended to <body> (escapes the snippet
      // stacking context so it can rise above PDP chrome), the bake
      // selector can't reach inner elements unless those data attrs
      // ride along on the overlay itself. Copy them from the host
      // wrapper so the merchant's Styling-panel edits apply.
      const wrapper = this.closest('[data-spectrum-instance-id]')
      const instanceId = wrapper?.getAttribute('data-spectrum-instance-id')
      const variantId = wrapper?.getAttribute('data-spectrum-variant-id')
      if (instanceId) overlay.setAttribute('data-spectrum-instance-id', instanceId)
      if (variantId) overlay.setAttribute('data-spectrum-variant-id', variantId)

      const backdrop = document.createElement('div')
      backdrop.className = 'sai-fbtatc4z__quickshop-backdrop'
      backdrop.addEventListener('click', () => this._closeQuickshop())
      overlay.appendChild(backdrop)

      const panel = document.createElement('div')
      panel.className = 'sai-fbtatc4z__quickshop-panel'
      overlay.appendChild(panel)

      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'sai-fbtatc4z__quickshop-close'
      closeBtn.setAttribute('aria-label', 'Close')
      closeBtn.appendChild(makeIcon('close'))
      closeBtn.addEventListener('click', () => this._closeQuickshop())
      panel.appendChild(closeBtn)

      // Header: image + title + price (all live-update on variant change).
      const header = document.createElement('div')
      header.className = 'sai-fbtatc4z__quickshop-header'
      const media = document.createElement('div')
      media.className = 'sai-fbtatc4z__quickshop-media'
      const img = document.createElement('img')
      img.className = 'sai-fbtatc4z__quickshop-image'
      img.dataset.qsImage = ''
      img.alt = product.title || ''
      media.appendChild(img)
      header.appendChild(media)

      const meta = document.createElement('div')
      meta.className = 'sai-fbtatc4z__quickshop-meta'
      const titleEl = document.createElement('a')
      titleEl.className = 'sai-fbtatc4z__quickshop-title'
      titleEl.dataset.qsTitle = ''
      titleEl.href = product.url || '#'
      titleEl.textContent = product.title || ''
      meta.appendChild(titleEl)
      const priceWrap = document.createElement('p')
      priceWrap.className = 'sai-fbtatc4z__quickshop-price'
      const priceEl = document.createElement('span')
      priceEl.dataset.qsPrice = ''
      priceWrap.appendChild(priceEl)
      const compareEl = document.createElement('span')
      compareEl.className = 'sai-fbtatc4z__quickshop-price-compare'
      compareEl.dataset.qsCompare = ''
      compareEl.hidden = true
      priceWrap.appendChild(compareEl)
      meta.appendChild(priceWrap)
      header.appendChild(meta)
      panel.appendChild(header)

      // Option groups — one per product option type.
      const optionsContainer = document.createElement('div')
      optionsContainer.className = 'sai-fbtatc4z__quickshop-options'
      panel.appendChild(optionsContainer)

      const names = optionNames(product)
      const meaningful = isMeaningfulOptionSet(product)
      if (meaningful) {
        names.forEach((optName, i) => {
          const group = document.createElement('div')
          group.className = 'sai-fbtatc4z__quickshop-group'

          const head = document.createElement('div')
          head.className = 'sai-fbtatc4z__quickshop-group-head'
          const nameEl = document.createElement('span')
          nameEl.className = 'sai-fbtatc4z__quickshop-group-name'
          nameEl.textContent = `${optName}:`
          head.appendChild(nameEl)
          const selectedEl = document.createElement('span')
          selectedEl.className = 'sai-fbtatc4z__quickshop-group-selected'
          selectedEl.dataset.qsSelected = optName
          selectedEl.textContent = this._modal.optionValues[optName] || ''
          head.appendChild(selectedEl)
          group.appendChild(head)

          const pills = document.createElement('div')
          pills.className = 'sai-fbtatc4z__quickshop-group-pills'
          pills.dataset.qsPills = optName
          pills.setAttribute('role', 'radiogroup')
          pills.setAttribute('aria-label', optName)
          group.appendChild(pills)

          for (const value of uniqueValuesByOptionIndex(product, i)) {
            const pill = document.createElement('button')
            pill.type = 'button'
            pill.className = 'sai-fbtatc4z__quickshop-pill'
            pill.setAttribute('role', 'radio')
            pill.dataset.optionName = optName
            pill.dataset.optionValue = value
            const swatchUrl = swatchImageForValue(product, i, value)
            if (swatchUrl) {
              const swatch = document.createElement('span')
              swatch.className = 'sai-fbtatc4z__quickshop-pill-swatch'
              // setProperty defends against future changes to the URL
              // source — direct string interpolation into `style.cssText`
              // would be unsafe; .style.backgroundImage works today but
              // setProperty is the canonical safe API for URL values.
              swatch.style.setProperty('background-image', `url("${swatchUrl}")`)
              pill.appendChild(swatch)
            }
            const label = document.createElement('span')
            label.textContent = value
            pill.appendChild(label)
            pill.addEventListener('click', () => {
              if (pill.getAttribute('aria-disabled') === 'true') return
              this._modal.optionValues[optName] = value
              this._refreshQuickshop()
            })
            pills.appendChild(pill)
          }
          optionsContainer.appendChild(group)
        })
      }

      const atc = document.createElement('button')
      atc.type = 'button'
      atc.className = 'sai-fbtatc4z__quickshop-atc'
      atc.dataset.qsAtc = ''
      atc.textContent = this._data?.ctaLabel || 'Add to cart'
      atc.addEventListener('click', () => this._commitQuickshop())
      panel.appendChild(atc)

      // Keyboard contract: Escape closes; Tab is trapped inside the panel
      // so keyboard users can't navigate into the page underneath while
      // the modal is visible (it declares role=dialog + aria-modal).
      const onKey = (e) => {
        if (e.key === 'Escape') {
          this._closeQuickshop()
          return
        }
        if (e.key !== 'Tab') return
        const focusables = focusablesIn(panel)
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || !panel.contains(active))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
          e.preventDefault()
          first.focus()
        }
      }
      document.addEventListener('keydown', onKey)
      this._modal.onKey = onKey

      // Scroll-lock inline — restored byte-for-byte on close.
      this._scrollLock = document.body.style.overflow
      document.body.style.overflow = 'hidden'

      document.body.appendChild(overlay)
      this._modal.overlay = overlay
      // Trigger transition on next frame so the slide-up animates, then
      // place initial focus inside the panel. Picking the close button
      // is the least disruptive choice — pills auto-announce on Tab.
      requestAnimationFrame(() => {
        overlay.classList.add('sai-fbtatc4z__quickshop--open')
        const target =
          panel.querySelector('.sai-fbtatc4z__quickshop-close') ||
          panel.querySelector(FOCUSABLE_SELECTOR)
        if (target && typeof target.focus === 'function') {
          target.focus({ preventScroll: true })
        }
      })

      this._refreshQuickshop()
    }

    _refreshQuickshop() {
      const m = this._modal
      if (!m || !m.overlay) return
      const product = m.product
      const variant = findVariantByOptions(product, m.optionValues)
      m.variantId = variant ? String(variant.id) : ''

      // Pills — toggle selected + cross-disable on unavailable combinations.
      for (const pills of m.overlay.querySelectorAll('[data-qs-pills]')) {
        const optName = pills.dataset.qsPills
        for (const pill of pills.querySelectorAll('.sai-fbtatc4z__quickshop-pill')) {
          const value = pill.dataset.optionValue
          const selected = m.optionValues[optName] === value
          pill.classList.toggle('sai-fbtatc4z__quickshop-pill--selected', selected)
          pill.setAttribute('aria-checked', selected ? 'true' : 'false')
          const available = isOptionValueAvailable(product, optName, value, m.optionValues)
          pill.classList.toggle('sai-fbtatc4z__quickshop-pill--oos', !available)
          pill.setAttribute('aria-disabled', available ? 'false' : 'true')
          // Set the native `disabled` attribute too — aria-disabled alone
          // doesn't block Enter/Space activation from keyboard focus on a
          // <button>. Mirrors pb3tmxq9's belt-and-suspenders pattern.
          pill.disabled = !available
        }
        const sel = m.overlay.querySelector(`[data-qs-selected="${CSS.escape(optName)}"]`)
        if (sel) sel.textContent = m.optionValues[optName] || ''
      }

      // Image — prefer the variant's featuredImage, fall back to the
      // product's. Variants without their own image inherit the product
      // image (matches Shopify's own behaviour on the PDP).
      const img = m.overlay.querySelector('[data-qs-image]')
      if (img) {
        img.src = variant?.featuredImage || product.imageUrl || ''
        img.alt = product.title || ''
      }

      // Price + compare-at — live-update; compare hidden when not on sale.
      const priceEl = m.overlay.querySelector('[data-qs-price]')
      if (priceEl) priceEl.textContent = formatMoney(variant?.price ?? product.price, this._data)
      const compareEl = m.overlay.querySelector('[data-qs-compare]')
      if (compareEl) {
        const compare = variant?.compareAtPrice ?? product.compareAtPrice
        const price = variant?.price ?? product.price
        if (compare && Number(compare) > Number(price)) {
          compareEl.textContent = formatMoney(compare, this._data)
          compareEl.hidden = false
        } else {
          compareEl.hidden = true
        }
      }

      const atc = m.overlay.querySelector('[data-qs-atc]')
      if (atc) atc.disabled = !m.variantId || !variant?.available
    }

    async _commitQuickshop() {
      const m = this._modal
      if (!m || !m.variantId) return
      const variant = (m.product.variants || []).find((v) => String(v.id) === m.variantId)
      if (!variant) return

      this._track(`${FEATURE_SLUG}:variant_selected`, {
        product_id: m.productId,
        variant_id: m.variantId,
        variant_title: variant.title,
        option_values: variant.options,
      })

      // Reflect the picked variant on the card so subsequent ATC clicks
      // (after re-open) start from the shopper's last choice.
      const card = this.querySelector(`[data-product-id="${CSS.escape(m.productId)}"]`)
      const cardCta = card?.querySelector('[data-fbtatc-cta]')
      if (cardCta) {
        cardCta.dataset.variantId = m.variantId
        if (variant.available) {
          cardCta.disabled = false
          cardCta.removeAttribute('aria-disabled')
        }
      }
      this._syncCardPrice(card, variant)

      // Pin the trigger button (and keep the modal open) while the add is
      // in flight so the user can't double-tap into multiple cart adds.
      const trigger = m.triggerButton
      const atc = m.overlay.querySelector('[data-qs-atc]')
      if (atc) atc.disabled = true

      try {
        await this._addToCart(trigger || cardCta, m.productId, m.variantId)
      } finally {
        this._closeQuickshop()
      }
    }

    _syncCardPrice(card, variant) {
      if (!card) return
      // Below-title variant pill label reflects the shopper's last pick so
      // re-opens of the picker and direct +ADD clicks line up.
      const triggerLabel = card.querySelector('.sai-fbtatc4z__variant-label')
      if (triggerLabel) {
        triggerLabel.textContent = variant.title || (variant.options || []).join(' / ')
      }
      const priceEl = card.querySelector('.sai-fbtatc4z__price')
      if (priceEl) priceEl.textContent = formatMoney(variant.price, this._data)
      const compareEl = card.querySelector('.sai-fbtatc4z__compare')
      const offEl = card.querySelector('.sai-fbtatc4z__off-badge')
      const off = offPercent(variant.price, variant.compareAtPrice)
      if (compareEl) {
        if (off != null) {
          compareEl.textContent = formatMoney(variant.compareAtPrice, this._data)
          compareEl.hidden = false
        } else {
          compareEl.hidden = true
        }
      }
      if (offEl) {
        if (off != null) {
          offEl.textContent = `${off}% OFF`
          offEl.hidden = false
        } else {
          offEl.hidden = true
        }
      }
    }

    _closeQuickshop() {
      const m = this._modal
      if (!m || !m.overlay) return
      document.removeEventListener('keydown', m.onKey)

      const overlay = m.overlay
      overlay.classList.remove('sai-fbtatc4z__quickshop--open')

      document.body.style.overflow = this._scrollLock || ''
      this._scrollLock = null

      // Restore focus to the element the shopper was on when the modal
      // opened — the second half of the role=dialog + aria-modal contract.
      // Guarded against the saved element being detached / unfocusable.
      const prev = m.previousFocus
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus({ preventScroll: true })
      }

      // Wait out the slide-down transition before removing the node.
      // Safety timeout in case `transitionend` never fires (background tab,
      // prefers-reduced-motion).
      let removed = false
      const remove = () => {
        if (removed) return
        removed = true
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      }
      overlay.addEventListener('transitionend', remove, { once: true })
      setTimeout(remove, 320)

      this._modal = null
    }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, SaiFbtAtcWidget)
  }

  // ── Bind to Spectrum analytics envelope ────────────────────────────────
  // `__spectrumAi.snippet.bind(node, callback)` is the canonical entrypoint —
  // it returns track/emit handles pre-bound to the standard envelope
  // (snippet_id, snippet_instance_id, experience_id, experience_handle,
  // experience_variant_id, page_context). Without going through bind() the
  // events fire without that envelope and the funnel pairing breaks.
  // Callback is a no-op here — fbtatc4z's payload is server-baked from the
  // SlotEnvelope, no variant-driven re-render to handle.
  function bindContainer(node) {
    const api = window.__spectrumAi?.snippet
    const root = node.querySelector(TAG)
    if (!root) return
    if (!api?.bind) return
    const handles = api.bind(node, () => {})
    if (handles && typeof root.setAnalytics === 'function') {
      root.setAnalytics(handles.track, handles.emit)
    }
  }

  // Snippet library JS contract: read data-spectrum-vis before any meaningful
  // work. Live wrappers SSR with vis="off" — bootstrap flips to "on" only
  // when the owning experience wins targeting + conflict resolution. Draft
  // (editor preview) wrappers SSR with vis="on" directly. Wrappers that
  // never emit the attribute at all (e.g. legacy themes pre-vis-gate) are
  // treated as visible.
  function waitForVis(node) {
    const wrapper = node.closest('[data-spectrum-lq-snippet]') || node
    if (
      !wrapper ||
      wrapper.getAttribute('data-spectrum-vis') === 'on' ||
      !wrapper.hasAttribute('data-spectrum-vis')
    ) {
      bindContainer(node)
      return
    }
    const observer = new MutationObserver(() => {
      if (wrapper.getAttribute('data-spectrum-vis') === 'on') {
        observer.disconnect()
        bindContainer(node)
      }
    })
    observer.observe(wrapper, { attributes: true, attributeFilter: ['data-spectrum-vis'] })
  }

  function bootAll() {
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )
    for (const node of containers) waitForVis(node)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll, { once: true })
  } else {
    bootAll()
  }
})()
