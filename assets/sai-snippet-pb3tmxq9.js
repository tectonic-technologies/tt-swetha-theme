/* =============================================================================
 * Frequently Bought Together (pb3tmxq9) — bundle widget runtime.
 *
 * Reads the server-emitted JSON payload (data-fbt-payload), manages per-row
 * selection + variant state, and on submit calls Spectrum.cart.add() with
 * every checked product's resolved variant in one batch.
 *
 * Layout-agnostic: the same DOM hooks (data-fbt-checkbox / data-variant-trigger
 * / data-fbt-cta / data-fbt-total / data-fbt-cta-label / data-fbt-error) appear
 * in both vertical and horizontal templates, so this JS doesn't switch on
 * layout. The total element exists in both layouts; only its placement differs
 * (inline span inside the CTA for vertical, side-panel amount for horizontal).
 *
 * Variant picker: a centered modal with pill-style options. Multi-option
 * products (Size + Color) show one group per option; the resolved tuple
 * cascades through `_refreshModal` greying out unavailable combinations.
 *
 * No-bind fallback: if window.__spectrumAi is absent, the widget still works
 * — checkbox toggles, variant switching, and ATC all run; analytics become a
 * noop.
 * ============================================================================= */

;(() => {
  if (window.__sai_pb3tmxq9_initialized__) return
  window.__sai_pb3tmxq9_initialized__ = true

  const SNIPPET_ID = 'pb3tmxq9'
  const TAG = 'sai-pb3tmxq9'
  const FEATURE_SLUG = 'fbt'
  const LOW_STOCK_THRESHOLD = 10
  const MODAL_CLOSE_TIMEOUT_MS = 360

  function noopTrack() {}

  function safeTrack(track) {
    return (name, payload) => {
      try {
        track(name, payload)
      } catch (_) {
        /* analytics is best-effort */
      }
    }
  }

  function formatMoney(cents, currency) {
    if (cents == null) return ''
    const fn = window.Spectrum?.formatMoney
    if (typeof fn === 'function') return fn(cents)
    // Fallback: Intl.NumberFormat with the currency from the payload.
    // The server-rendered initial markup used `| money`; this fallback
    // only fires after variant switches / live total updates.
    const value = Number(cents) / 100
    if (!Number.isFinite(value)) return ''
    try {
      return value.toLocaleString(undefined, {
        style: 'currency',
        currency: currency || 'USD',
      })
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
    // with `available: false` even though the variants are purchasable.
    // Fall back to "any variant matching the tuple" when no variant on the
    // product is reported as available.
    const anyAvailable = product.variants.some((v) => v.available)
    return product.variants.some((v) => {
      if (v.options?.[optionIndex] !== value) return false
      if (anyAvailable && !v.available) return false
      return (v.options || []).every((val, i) => i === optionIndex || val === tuple[i])
    })
  }

  if (!customElements.get(TAG)) {
    class SaiFbt extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true

        this._track = noopTrack
        this._data = this._readPayload()
        this._productsById = new Map()
        this._rows = new Map()
        this._modal = null
        this._modalCandidate = null
        this._ctaBaseLabel = ''
        // Save body scroll state across modal open/close. Initialized lazily
        // in _openModal so we don't perturb the page on init.
        this._scrollLock = null

        if (!this._data) return

        for (const p of this._data.products) {
          this._productsById.set(String(p.id), p)
        }

        this._initRows()
        this._readCtaBaseLabel()
        this._bindRowEvents()
        this._bindCtaEvents()
        this._updateCta()
        this._updateTotal()
      }

      setAnalytics(track) {
        this._track = typeof track === 'function' ? safeTrack(track) : noopTrack
      }

      _readPayload() {
        const node = this.querySelector('script[type="application/json"][data-fbt-payload]')
        if (!node) return null
        try {
          return JSON.parse(node.textContent || '{}')
        } catch (_) {
          return null
        }
      }

      _readCtaBaseLabel() {
        const labelEl = this.querySelector('[data-fbt-cta-label]')
        const raw = labelEl ? (labelEl.textContent || '').trim() : ''
        // Strip the server-rendered "(N)" suffix so we can re-append it on
        // every update.
        this._ctaBaseLabel = raw.replace(/\s*\(\d+\)\s*$/, '')
      }

      _initRows() {
        for (const productId of this._data.order) {
          const product = this._productsById.get(String(productId))
          if (!product) continue
          const firstAvailable = product.variants.find((v) => v.available)
          const initial = firstAvailable || product.variants[0] || null
          // Read initial checked state from the SSR DOM so checkbox_default_state
          // (set in Liquid) drives the JS truth without us having to parse it
          // out of the payload separately.
          const card = this.querySelector(`[data-product-id="${productId}"]`)
          const checkbox = card?.querySelector('[data-fbt-checkbox]')
          const initialChecked = checkbox ? !!checkbox.checked : true
          this._rows.set(String(productId), {
            productId: String(productId),
            variantId: initial ? String(initial.id) : null,
            available: !!initial && !!initial.available,
            checked: initialChecked,
          })
        }
      }

      _bindRowEvents() {
        const cards = this.querySelectorAll('[data-product-id]')
        for (const card of cards) {
          const productId = card.getAttribute('data-product-id')
          if (!productId) continue

          const checkbox = card.querySelector('[data-fbt-checkbox]')
          if (checkbox) {
            checkbox.addEventListener('change', () => {
              const row = this._rows.get(productId)
              if (!row) return
              row.checked = !!checkbox.checked
              this._updateCta()
              this._updateTotal()
              this._track(`${FEATURE_SLUG}:row_toggled`, {
                product_id: productId,
                checked: row.checked,
              })
            })
          }

          const trigger = card.querySelector('[data-variant-trigger]')
          if (trigger) {
            trigger.addEventListener('click', (e) => {
              e.preventDefault()
              this._openModal(productId)
            })
          }
        }
      }

      _bindCtaEvents() {
        const cta = this.querySelector('[data-fbt-cta]')
        if (!cta) return
        cta.addEventListener('click', (e) => {
          e.preventDefault()
          this._submit()
        })
      }

      _selectedItems() {
        const items = []
        for (const row of this._rows.values()) {
          // We don't gate on `row.available` — Shopify reports gift cards
          // and other product types as `available: false` even when they're
          // purchasable. Let `/cart/add.js` decide and surface its error
          // through `_setError` if the add actually fails.
          if (row.checked && row.variantId) {
            items.push({ id: Number(row.variantId), quantity: 1 })
          }
        }
        return items
      }

      _selectedVariants() {
        const variants = []
        for (const row of this._rows.values()) {
          if (!row.checked || !row.variantId) continue
          const product = this._productsById.get(row.productId)
          const variant = product?.variants.find((v) => String(v.id) === row.variantId)
          if (variant) variants.push(variant)
        }
        return variants
      }

      _updateCta() {
        const cta = this.querySelector('[data-fbt-cta]')
        const labelEl = this.querySelector('[data-fbt-cta-label]')
        if (!cta || !labelEl) return
        const count = this._selectedItems().length
        labelEl.textContent = `${this._ctaBaseLabel} (${count})`
        cta.disabled = count === 0
        cta.toggleAttribute('aria-disabled', count === 0)
      }

      _updateTotal() {
        const totalEl = this.querySelector('[data-fbt-total]')
        if (!totalEl) return
        const variants = this._selectedVariants()
        const cents = variants.reduce((sum, v) => sum + (Number(v.price) || 0), 0)
        totalEl.textContent = cents > 0 ? formatMoney(cents, this._data.currency) : ''
      }

      _setError(message) {
        const el = this.querySelector('[data-fbt-error]')
        if (!el) return
        if (!message) {
          el.hidden = true
          el.textContent = ''
          return
        }
        el.textContent = message
        el.hidden = false
      }

      async _submit() {
        const items = this._selectedItems()
        if (items.length === 0) return

        const cta = this.querySelector('[data-fbt-cta]')
        if (cta) cta.disabled = true
        this._setError('')
        this._setLoading(true)

        this._track(`${FEATURE_SLUG}:add_to_cart_clicked`, { item_count: items.length })

        try {
          const cartApi = window.Spectrum?.cart
          if (!cartApi || typeof cartApi.add !== 'function') {
            const res = await fetch('/cart/add.js', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ items }),
            })
            if (!res.ok) {
              const body = await res.json().catch(() => ({}))
              throw new Error(body?.description || body?.message || 'Could not add to cart')
            }
          } else {
            const result = await cartApi.add(items)
            if (result && result.ok === false) {
              throw new Error(result.error?.message || 'Could not add to cart')
            }
          }

          this._track(`${FEATURE_SLUG}:added_to_cart`, { item_count: items.length })

          // Theme integration: dispatch the events that mainstream themes
          // listen for to open their cart drawer / refresh line items.
          // We do NOT navigate to /cart — themes that don't open a drawer
          // keep the user on the PDP, which is the right default for an
          // FBT widget. Themes that want the legacy redirect can listen
          // for `cart:build` and route themselves.
          const cartRefreshEvents = [
            'cart:refresh',
            'cart:build',
            'cart:item-added',
            'cart:updated',
          ]
          for (const name of cartRefreshEvents) {
            window.dispatchEvent(new CustomEvent(name, { detail: { items } }))
            document.dispatchEvent(new CustomEvent(name, { detail: { items } }))
          }
        } catch (err) {
          this._setError(err?.message || 'Could not add to cart')
          this._track(`${FEATURE_SLUG}:add_to_cart_failed`, {
            error_message: err?.message || String(err),
          })
        } finally {
          // Always restore the CTA so the user isn't stuck on themes whose
          // cart drawer doesn't open from the dispatched events. The CTA is
          // disabled during the request, which is the natural double-tap
          // guard while the network call is in flight.
          this._setLoading(false)
          if (cta) {
            const empty = this._selectedItems().length === 0
            cta.disabled = empty
            cta.toggleAttribute('aria-disabled', empty)
          }
        }
      }

      _setLoading(loading) {
        const cta = this.querySelector('[data-fbt-cta]')
        const loader = this.querySelector('[data-fbt-loader]')
        if (cta) {
          if (loading) cta.setAttribute('data-loading', 'true')
          else cta.removeAttribute('data-loading')
        }
        if (loader) loader.hidden = !loading
      }

      // ── Variant modal ──────────────────────────────────────────────────────

      _openModal(productId) {
        const product = this._productsById.get(String(productId))
        if (!product || product.variants.length < 2) return

        const row = this._rows.get(productId)
        if (!row) return

        const currentVariant = product.variants.find((v) => String(v.id) === row.variantId)
        const initialTuple = (currentVariant || product.variants[0]).options.slice()
        const numOptions = optionCount(product)

        this._modalCandidate = { productId, optionValues: initialTuple.slice() }

        const overlay = document.createElement('div')
        overlay.className = 'sai-pb3tmxq9__modal-overlay'
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        overlay.setAttribute('aria-label', 'Variant picker')

        const card = document.createElement('div')
        card.className = 'sai-pb3tmxq9__modal-card'
        overlay.appendChild(card)

        // Header: just the close button — group labels carry the
        // "Option: <value>" copy, so a separate title would duplicate.
        const header = document.createElement('div')
        header.className = 'sai-pb3tmxq9__modal-header'
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'sai-pb3tmxq9__modal-close'
        closeBtn.setAttribute('aria-label', 'Close')
        closeBtn.appendChild(makeIcon('close'))
        closeBtn.addEventListener('click', () => this._closeModal())
        header.appendChild(closeBtn)
        card.appendChild(header)

        // One <fieldset>-style group per option type.
        const groupsContainer = document.createElement('div')
        groupsContainer.className = 'sai-pb3tmxq9__modal-groups'
        card.appendChild(groupsContainer)

        for (let i = 0; i < numOptions; i++) {
          const optionName = product.options?.[i] || `Option ${i + 1}`
          const values = uniqueValuesForOption(product, i)

          const group = document.createElement('div')
          group.className = 'sai-pb3tmxq9__modal-group'
          group.dataset.optionIndex = String(i)

          // Build the group label as text-only nodes — no innerHTML. The
          // option-name and current-value strings come from the server-rendered
          // JSON payload (so they're already `| json`-escaped on the wire), but
          // we still use textContent here because the snippet-library rule
          // bans client-side HTML escaping helpers entirely.
          const groupLabel = document.createElement('div')
          groupLabel.className = 'sai-pb3tmxq9__modal-group-label'
          groupLabel.appendChild(document.createTextNode(`${optionName}: `))
          const currentSpan = document.createElement('span')
          currentSpan.setAttribute('data-group-current', '')
          currentSpan.textContent = initialTuple[i] || ''
          groupLabel.appendChild(currentSpan)
          group.appendChild(groupLabel)

          const pills = document.createElement('div')
          pills.className = 'sai-pb3tmxq9__modal-pills'
          group.appendChild(pills)

          for (const value of values) {
            const pill = document.createElement('button')
            pill.type = 'button'
            pill.className = 'sai-pb3tmxq9__pill'
            pill.dataset.value = value
            pill.dataset.optionIndex = String(i)

            const valueLabel = document.createElement('span')
            valueLabel.className = 'sai-pb3tmxq9__pill-value'
            valueLabel.textContent = value
            pill.appendChild(valueLabel)

            pill.addEventListener('click', () => {
              if (pill.dataset.unavailable === 'true') return
              this._modalCandidate.optionValues[i] = value
              this._refreshModal(card, product)
            })

            pills.appendChild(pill)
          }

          groupsContainer.appendChild(group)
        }

        const stock = document.createElement('div')
        stock.className = 'sai-pb3tmxq9__modal-stock'
        stock.dataset.modalStock = 'true'
        card.appendChild(stock)

        const doneBtn = document.createElement('button')
        doneBtn.type = 'button'
        doneBtn.className = 'sai-pb3tmxq9__modal-done'
        doneBtn.textContent = 'DONE'
        doneBtn.addEventListener('click', () => this._commitModal())
        card.appendChild(doneBtn)

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) this._closeModal()
        })

        const onKey = (e) => {
          if (e.key === 'Escape') this._closeModal()
        }
        document.addEventListener('keydown', onKey)

        // Scroll-lock via inline style: save the prior value so close can
        // restore it byte-for-byte. CSS-class scroll-lock relies on a global
        // `body.<class>` selector which the snippet-library style guide bans;
        // managing overflow inline keeps the rule per-instance.
        this._scrollLock = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        document.body.appendChild(overlay)
        this._modal = { overlay, onKey }

        this._refreshModal(card, product)
      }

      _refreshModal(card, product) {
        const candidate = this._modalCandidate
        if (!candidate) return
        const tuple = candidate.optionValues
        const numOptions = optionCount(product)
        const lastIndex = numOptions - 1

        const pills = card.querySelectorAll('.sai-pb3tmxq9__pill')
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

        const groups = card.querySelectorAll('.sai-pb3tmxq9__modal-group')
        for (const group of groups) {
          const i = Number.parseInt(group.dataset.optionIndex || '0', 10)
          const span = group.querySelector('[data-group-current]')
          if (span) span.textContent = tuple[i] || ''
        }

        const variant =
          findVariantByTuple(product, tuple) ||
          findVariantForValue(product, lastIndex, tuple[lastIndex])

        this._renderStockNote(card, variant)
      }

      _renderStockNote(card, variant) {
        const slot = card.querySelector('[data-modal-stock]')
        if (!slot) return
        const qty = variant?.inventoryQty
        const managed = variant?.inventoryManaged === 'shopify'
        if (variant && managed && qty != null && qty > 0 && qty <= LOW_STOCK_THRESHOLD) {
          slot.textContent = `Low in stock — only ${qty} available`
          slot.hidden = false
        } else {
          slot.textContent = ''
          slot.hidden = true
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

        const row = this._rows.get(candidate.productId)
        if (row) {
          row.variantId = String(variant.id)
          row.available = !!variant.available
        }

        // Reflect new variant in the row UI.
        const card = this.querySelector(`[data-product-id="${candidate.productId}"]`)
        if (card) {
          const label = card.querySelector('.sai-pb3tmxq9__variant-label')
          if (label) label.textContent = variant.title || (variant.options || []).join(' / ')
          const priceEl = card.querySelector('.sai-pb3tmxq9__price')
          if (priceEl) priceEl.textContent = formatMoney(variant.price, this._data.currency)
          const compareEl = card.querySelector('.sai-pb3tmxq9__compare')
          const offEl = card.querySelector('.sai-pb3tmxq9__off-badge')
          const off = offPercent(variant.price, variant.compareAtPrice)
          if (compareEl) {
            if (off != null) {
              compareEl.textContent = formatMoney(variant.compareAtPrice, this._data.currency)
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

        this._track(`${FEATURE_SLUG}:variant_selected`, {
          product_id: candidate.productId,
          variant_id: row?.variantId,
          variant_title: variant.title,
          option_values: variant.options,
        })

        this._updateCta()
        this._updateTotal()
        this._closeModal()
      }

      _closeModal() {
        const m = this._modal
        if (!m) return
        document.removeEventListener('keydown', m.onKey)

        const overlay = m.overlay
        const card = overlay.querySelector('.sai-pb3tmxq9__modal-card')
        overlay.dataset.closing = 'true'

        const restoreScroll = () => {
          // Restore whatever the body's overflow was before we opened. If
          // _scrollLock is null/undefined (no prior modal open recorded),
          // setting to '' is the safe inert default.
          document.body.style.overflow = this._scrollLock || ''
          this._scrollLock = null
        }

        const cleanup = () => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
          restoreScroll()
        }

        // Wait for the card slide-down to finish before removing the overlay.
        // animationend fires on whichever element animates last; the card
        // animation runs longer than the overlay fade. Safety timeout for
        // reduced-motion / browser quirks where animationend never fires.
        if (card) {
          let done = false
          const fire = () => {
            if (done) return
            done = true
            card.removeEventListener('animationend', fire)
            cleanup()
          }
          card.addEventListener('animationend', fire, { once: true })
          setTimeout(fire, MODAL_CLOSE_TIMEOUT_MS)
        } else {
          cleanup()
        }

        this._modal = null
        this._modalCandidate = null
      }
    }
    customElements.define(TAG, SaiFbt)
  }

  // Tiny icon factory — keeps SVG construction off the hot DOM-build paths
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

  function bindAllContainers() {
    const api = window.__spectrumAi?.snippet
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )

    if (!api?.bind) {
      // No Spectrum bind — widget still functions; analytics stay noop.
      return
    }

    for (const node of containers) {
      const handles = api.bind(node, () => {
        // No variant-driven re-render — content is server-baked from the
        // product metafield. Keeping the bind so the analytics envelope is
        // wired correctly for our `track` calls.
      })
      const root = node.querySelector(TAG)
      if (root && handles?.track && typeof root.setAnalytics === 'function') {
        root.setAnalytics(handles.track)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }
})()
