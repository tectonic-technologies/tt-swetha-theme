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

  function formatMoney(cents, currency) {
    if (cents == null) return ''
    const fn = window.Spectrum?.formatMoney
    if (typeof fn === 'function') return fn(cents)
    const value = Number(cents) / 100
    if (!Number.isFinite(value)) return ''
    try {
      return value.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD' })
    } catch (_) {
      return value.toFixed(2)
    }
  }

  function offPercent(price, compareAt) {
    if (price == null || compareAt == null) return null
    const p = Number(price)
    const c = Number(compareAt)
    if (!(c > p)) return null
    return Math.round(((c - p) / c) * 100)
  }

  // ── Multi-option helpers ────────────────────────────────────────────────
  // A Shopify product has 1–3 option types (Size, Color, Material, etc.).
  // `product.options` is the list of option names, `variant.options` is the
  // tuple of values for one variant. Helpers below operate on the full tuple.

  function optionCount(product) {
    return Math.min(product.options?.length || 0, product.variants?.[0]?.options?.length || 0)
  }

  function uniqueValuesForOption(product, optionIndex) {
    const seen = new Set()
    const values = []
    for (const v of product.variants) {
      const value = v.options?.[optionIndex]
      if (value != null && !seen.has(value)) {
        seen.add(value)
        values.push(value)
      }
    }
    return values
  }

  function findVariantByTuple(product, tuple) {
    return (
      product.variants.find((v) => (v.options || []).every((val, i) => val === tuple[i])) || null
    )
  }

  function findVariantForValue(product, optionIndex, value) {
    const matches = product.variants.filter((v) => v.options?.[optionIndex] === value)
    if (matches.length === 0) return null
    return matches.find((v) => v.available) || matches[0]
  }

  function isValueAvailableForTuple(product, optionIndex, value, tuple) {
    // Gift card products (and other Shopify quirks) report every variant
    // with `available: false`. Fall back to "any variant matching the tuple"
    // when no variant on the product reports available.
    const anyAvailable = product.variants.some((v) => v.available)
    return product.variants.some((v) => {
      if (v.options?.[optionIndex] !== value) return false
      if (anyAvailable && !v.available) return false
      return (v.options || []).every((val, i) => i === optionIndex || val === tuple[i])
    })
  }

  class SaiFbtAtcWidget extends HTMLElement {
    constructor() {
      super()
      this._data = null
      this._productsById = new Map()
      this._afterAddAction = 'stay'
      this._ctaTimers = new Map()
      this._modal = null
      this._modalCandidate = null
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
      // Tear down an open modal — `_closeModal` removes the document-level
      // keydown listener that would otherwise leak.
      if (this._modal) this._closeModal()
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
      const variantTrigger = evt.target.closest('[data-variant-trigger]')
      if (variantTrigger && this.contains(variantTrigger)) {
        evt.preventDefault()
        const card = variantTrigger.closest('[data-product-id]')
        if (!card) return
        this._openModal(card.dataset.productId)
        return
      }
      const button = evt.target.closest('[data-fbtatc-cta]')
      if (!button || !this.contains(button)) return
      evt.preventDefault()
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return
      const productId = button.dataset.productId
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

    // ── Variant picker modal ────────────────────────────────────────────
    // Mirrors pb3tmxq9 — a centered overlay with one pill group per option
    // type. Pills cross-disable on tuple conflicts; committing writes the
    // resolved variant id back onto the card's CTA and updates the price.

    _openModal(productId) {
      const product = this._productsById.get(String(productId))
      if (!product || !product.variants || product.variants.length < 2) return

      const card = this.querySelector(`[data-product-id="${CSS.escape(productId)}"]`)
      if (!card) return

      const cta = card.querySelector('[data-fbtatc-cta]')
      const currentVariantId = cta?.dataset.variantId
      const currentVariant =
        product.variants.find((v) => String(v.id) === String(currentVariantId)) ||
        product.variants[0]
      const initialTuple = (currentVariant.options || []).slice()
      const numOptions = optionCount(product)

      this._modalCandidate = { productId, optionValues: initialTuple.slice() }

      const overlay = document.createElement('div')
      overlay.className = 'sai-fbtatc4z__modal-overlay'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-label', 'Variant picker')

      const modalCard = document.createElement('div')
      modalCard.className = 'sai-fbtatc4z__modal-card'
      overlay.appendChild(modalCard)

      const header = document.createElement('div')
      header.className = 'sai-fbtatc4z__modal-header'
      const title = document.createElement('h3')
      title.className = 'sai-fbtatc4z__modal-title'
      // Server-validated string; payload prop falls back to 'Choose variant'
      // so the header is never blank.
      title.textContent = this._data?.variantModalTitle || 'Choose variant'
      header.appendChild(title)
      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'sai-fbtatc4z__modal-close'
      closeBtn.setAttribute('aria-label', 'Close')
      closeBtn.textContent = '×'
      closeBtn.addEventListener('click', () => this._closeModal())
      header.appendChild(closeBtn)
      modalCard.appendChild(header)

      const groupsContainer = document.createElement('div')
      groupsContainer.className = 'sai-fbtatc4z__modal-groups'
      modalCard.appendChild(groupsContainer)

      for (let i = 0; i < numOptions; i++) {
        const optionName = product.options?.[i] || `Option ${i + 1}`
        const values = uniqueValuesForOption(product, i)

        const group = document.createElement('div')
        group.className = 'sai-fbtatc4z__modal-group'
        group.dataset.optionIndex = String(i)

        // Group label built with text nodes — no innerHTML, no HTML escape
        // helper (the snippet-library style guide bans client-side escaping).
        const groupLabel = document.createElement('div')
        groupLabel.className = 'sai-fbtatc4z__modal-group-label'
        groupLabel.appendChild(document.createTextNode(`${optionName}: `))
        const currentSpan = document.createElement('span')
        currentSpan.setAttribute('data-group-current', '')
        currentSpan.textContent = initialTuple[i] || ''
        groupLabel.appendChild(currentSpan)
        group.appendChild(groupLabel)

        const pills = document.createElement('div')
        pills.className = 'sai-fbtatc4z__modal-pills'
        group.appendChild(pills)

        for (const value of values) {
          const pill = document.createElement('button')
          pill.type = 'button'
          pill.className = 'sai-fbtatc4z__pill'
          pill.dataset.value = value
          pill.dataset.optionIndex = String(i)
          pill.textContent = value
          pill.addEventListener('click', () => {
            if (pill.dataset.unavailable === 'true') return
            this._modalCandidate.optionValues[i] = value
            this._refreshModal(modalCard, product)
          })
          pills.appendChild(pill)
        }

        groupsContainer.appendChild(group)
      }

      const doneBtn = document.createElement('button')
      doneBtn.type = 'button'
      doneBtn.className = 'sai-fbtatc4z__modal-done'
      doneBtn.textContent = 'DONE'
      doneBtn.addEventListener('click', () => this._commitModal())
      modalCard.appendChild(doneBtn)

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeModal()
      })

      const onKey = (e) => {
        if (e.key === 'Escape') this._closeModal()
      }
      document.addEventListener('keydown', onKey)

      // Inline scroll-lock — saves prior value so close can restore it
      // byte-for-byte. CSS-class scroll-lock would need a global body
      // selector which the snippet-library style guide bans.
      this._scrollLock = document.body.style.overflow
      document.body.style.overflow = 'hidden'

      document.body.appendChild(overlay)
      this._modal = { overlay, onKey }

      this._refreshModal(modalCard, product)
    }

    _refreshModal(modalCard, product) {
      const candidate = this._modalCandidate
      if (!candidate) return
      const tuple = candidate.optionValues

      const pills = modalCard.querySelectorAll('.sai-fbtatc4z__pill')
      for (const pill of pills) {
        const i = Number.parseInt(pill.dataset.optionIndex || '0', 10)
        const value = pill.dataset.value
        const isAvailable = isValueAvailableForTuple(product, i, value, tuple)
        const isSelected = tuple[i] === value

        if (isSelected) pill.dataset.selected = 'true'
        else delete pill.dataset.selected

        if (isAvailable) {
          delete pill.dataset.unavailable
          pill.disabled = false
        } else {
          pill.dataset.unavailable = 'true'
          pill.disabled = true
        }
      }

      const groups = modalCard.querySelectorAll('.sai-fbtatc4z__modal-group')
      for (const group of groups) {
        const i = Number.parseInt(group.dataset.optionIndex || '0', 10)
        const span = group.querySelector('[data-group-current]')
        if (span) span.textContent = tuple[i] || ''
      }
    }

    _commitModal() {
      const candidate = this._modalCandidate
      if (!candidate) return this._closeModal()
      const product = this._productsById.get(String(candidate.productId))
      if (!product) return this._closeModal()

      const lastIndex = optionCount(product) - 1
      const variant =
        findVariantByTuple(product, candidate.optionValues) ||
        findVariantForValue(product, lastIndex, candidate.optionValues[lastIndex])
      if (!variant) return this._closeModal()

      const card = this.querySelector(`[data-product-id="${CSS.escape(candidate.productId)}"]`)
      if (card) {
        const triggerLabel = card.querySelector('.sai-fbtatc4z__variant-label')
        if (triggerLabel) {
          triggerLabel.textContent = variant.title || (variant.options || []).join(' / ')
        }
        const priceEl = card.querySelector('.sai-fbtatc4z__price')
        if (priceEl) priceEl.textContent = formatMoney(variant.price, this._data?.currency)
        const compareEl = card.querySelector('.sai-fbtatc4z__compare')
        const offEl = card.querySelector('.sai-fbtatc4z__off-badge')
        const off = offPercent(variant.price, variant.compareAtPrice)
        if (compareEl) {
          if (off != null) {
            compareEl.textContent = formatMoney(variant.compareAtPrice, this._data?.currency)
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
        const ctaBtn = card.querySelector('[data-fbtatc-cta]')
        if (ctaBtn) {
          ctaBtn.dataset.variantId = String(variant.id)
          if (variant.available) {
            ctaBtn.disabled = false
            ctaBtn.removeAttribute('aria-disabled')
          } else {
            ctaBtn.disabled = true
            ctaBtn.setAttribute('aria-disabled', 'true')
          }
        }
      }

      this._track(`${FEATURE_SLUG}:variant_selected`, {
        product_id: candidate.productId,
        variant_id: String(variant.id),
        variant_title: variant.title,
        option_values: variant.options,
      })

      this._closeModal()
    }

    _closeModal() {
      const m = this._modal
      if (!m) return
      document.removeEventListener('keydown', m.onKey)

      const overlay = m.overlay
      overlay.dataset.closing = 'true'

      const restoreScroll = () => {
        document.body.style.overflow = this._scrollLock || ''
        this._scrollLock = null
      }

      const cleanup = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        restoreScroll()
      }

      let cleanedUp = false
      const once = () => {
        if (cleanedUp) return
        cleanedUp = true
        cleanup()
      }
      overlay.addEventListener('animationend', once, { once: true })
      // Safety net — if the close animation never fires (browser tab in
      // background, prefers-reduced-motion, etc.), tear down anyway.
      setTimeout(once, 360)

      this._modal = null
      this._modalCandidate = null
    }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, SaiFbtAtcWidget)
  }

  // Bind analytics once the spectrum bridge appears. The bridge is async;
  // hydrate every host in the page that hasn't already been wired.
  function bindAllContainers(track, emit) {
    for (const el of document.querySelectorAll(TAG)) {
      if (typeof el.setAnalytics === 'function') el.setAnalytics(track, emit)
    }
  }

  const ai = window.__spectrumAi
  if (ai && typeof ai.track === 'function') {
    bindAllContainers(ai.track, ai.emit)
  } else {
    window.addEventListener(
      '__spectrumAi:ready',
      () => {
        const a = window.__spectrumAi
        if (a && typeof a.track === 'function') bindAllContainers(a.track, a.emit)
      },
      { once: true },
    )
  }
})()
