/* =============================================================================
 * Frequently Bought Together — Horizontal (u3rw3o3e) — bundle widget runtime.
 *
 * Same selection / variant-modal / cart logic as the Vertical variant
 * (l2dcg7yd). Differences:
 *   - Live `Total` calculation rendered in the right-side panel.
 *   - Aggregate ATC button lives in the panel, not below the cards.
 *   - Plus separators between cards are decorative — handled in Liquid.
 *
 * No-bind fallback: if window.__spectrumAi is absent, the widget still works
 * (selection, variant pickers, cart add); analytics become a noop.
 * ============================================================================= */

;(() => {
  if (window.__sai_u3rw3o3e_initialized__) return
  window.__sai_u3rw3o3e_initialized__ = true

  const SNIPPET_ID = 'u3rw3o3e'
  const TAG = 'sai-u3rw3o3e'
  const FEATURE_SLUG = 'fbt'
  const LOW_STOCK_THRESHOLD = 10

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

  // Variant whose options exactly match `tuple`.
  function findVariantByTuple(product, tuple) {
    return (
      product.variants.find((v) => (v.options || []).every((val, i) => val === tuple[i])) || null
    )
  }

  // First variant where `options[optionIndex] === value`, preferring an
  // available one. Used to repair the tuple when the user changes one option
  // and the resulting combination has no exact match.
  function findVariantForValue(product, optionIndex, value) {
    const matches = product.variants.filter((v) => v.options?.[optionIndex] === value)
    if (matches.length === 0) return null
    return matches.find((v) => v.available) || matches[0]
  }

  // "Is there an available variant where option[optionIndex] === value AND
  // all other options match the currently selected tuple?" Used to grey out
  // pills whose combination is unavailable, mirroring Shopify's default
  // variant picker behaviour.
  function isValueAvailableForTuple(product, optionIndex, value, tuple) {
    // Gift card products (and other Shopify quirks) report every variant
    // with `available: false` even though the variants are purchasable. Fall
    // back to "any variant matching the tuple" when no variant on the
    // product is reported as available.
    const anyAvailable = product.variants.some((v) => v.available)
    return product.variants.some((v) => {
      if (v.options?.[optionIndex] !== value) return false
      if (anyAvailable && !v.available) return false
      return (v.options || []).every((val, i) => i === optionIndex || val === tuple[i])
    })
  }

  function escapeHtml(s) {
    if (s == null) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  if (!customElements.get(TAG)) {
    class SaiFbtHorizontal extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true

        this._track = noopTrack
        this._data = this._readPayload()
        this._rows = new Map()
        this._modal = null
        this._modalCandidate = null
        this._ctaBaseLabel = ''

        if (!this._data) return

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
        // Strip any pre-rendered "(N)" suffix so we can re-append it on every
        // update.
        this._ctaBaseLabel = raw.replace(/\s*\(\d+\)\s*$/, '')
      }

      _initRows() {
        for (const productId of this._data.order) {
          const product = this._data.products[productId]
          if (!product) continue
          const firstAvailable = product.variants.find((v) => v.available)
          const initial = firstAvailable || product.variants[0] || null
          // Read initial checked state from the SSR DOM so checkbox_default_state
          // (set in Liquid) drives the JS truth.
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
          // and a few other product types as `available: false` even when
          // they're purchasable, so we let `/cart/add.js` decide. If the
          // variant truly can't be added the response surfaces the error
          // and `_setError` shows it.
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
          const product = this._data.products[row.productId]
          const variant = product?.variants.find((v) => String(v.id) === row.variantId)
          if (variant) variants.push(variant)
        }
        return variants
      }

      // Pricing total / row enable state should treat gift-card-style
      // "all unavailable" rows as still purchasable. We only flag a row
      // unavailable when its variantId is missing (no variants emitted).

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
        totalEl.textContent = formatMoney(cents, this._data.currency)
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

          // Notify the theme — many themes listen for either of these to open
          // their cart drawer / refresh the line items. We do NOT navigate to
          // /cart as a fallback because the "drawer is open" signal varies by
          // theme (Dawn uses `cart-drawer.is-empty`, others use `drawer-open`,
          // others nothing at all). A blanket class probe ends up navigating
          // away on themes that simply don't expose drawer state in the DOM.
          // Themes that want the legacy redirect can listen for `cart:build`
          // and route to `/cart` themselves.
          window.dispatchEvent(new CustomEvent('cart:refresh'))
          document.dispatchEvent(new CustomEvent('cart:build'))
        } catch (err) {
          this._setError(err?.message || 'Could not add to cart')
          this._track(`${FEATURE_SLUG}:add_to_cart_failed`, {
            error_message: err?.message || String(err),
          })
        } finally {
          if (cta) cta.disabled = this._selectedItems().length === 0
        }
      }

      // ── Variant modal ──────────────────────────────────────────────────────

      _openModal(productId) {
        const product = this._data.products[productId]
        if (!product || product.variants.length < 2) return

        const row = this._rows.get(productId)
        if (!row) return

        const currentVariant = product.variants.find((v) => String(v.id) === row.variantId)
        const initialTuple = (currentVariant || product.variants[0]).options.slice()
        const numOptions = optionCount(product)

        this._modalCandidate = { productId, optionValues: initialTuple.slice() }

        const overlay = document.createElement('div')
        overlay.className = 'sai-u3rw3o3e__modal-overlay'
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        overlay.setAttribute('aria-label', 'Variant picker')

        const card = document.createElement('div')
        card.className = 'sai-u3rw3o3e__modal-card'
        overlay.appendChild(card)

        // Header: just the close button — group labels carry the
        // "Option: <value>" copy, so a separate title would duplicate.
        const header = document.createElement('div')
        header.className = 'sai-u3rw3o3e__modal-header'
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'sai-u3rw3o3e__modal-close'
        closeBtn.setAttribute('aria-label', 'Close')
        closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" focusable="false"><path d="M3 3L13 13M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
        closeBtn.addEventListener('click', () => this._closeModal())
        header.appendChild(closeBtn)
        card.appendChild(header)

        // One <fieldset>-style group per option type.
        const groupsContainer = document.createElement('div')
        groupsContainer.className = 'sai-u3rw3o3e__modal-groups'
        card.appendChild(groupsContainer)

        for (let i = 0; i < numOptions; i++) {
          const optionName = product.options?.[i] || `Option ${i + 1}`
          const values = uniqueValuesForOption(product, i)

          const group = document.createElement('div')
          group.className = 'sai-u3rw3o3e__modal-group'
          group.dataset.optionIndex = String(i)

          const groupLabel = document.createElement('div')
          groupLabel.className = 'sai-u3rw3o3e__modal-group-label'
          groupLabel.innerHTML = `${escapeHtml(optionName)}: <span data-group-current>${escapeHtml(initialTuple[i] || '')}</span>`
          group.appendChild(groupLabel)

          const pills = document.createElement('div')
          pills.className = 'sai-u3rw3o3e__modal-pills'
          group.appendChild(pills)

          for (const value of values) {
            const pill = document.createElement('button')
            pill.type = 'button'
            pill.className = 'sai-u3rw3o3e__pill'
            pill.dataset.value = value
            pill.dataset.optionIndex = String(i)

            const valueLabel = document.createElement('span')
            valueLabel.className = 'sai-u3rw3o3e__pill-value'
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

        // Stock note (under the last option group)
        const stock = document.createElement('div')
        stock.className = 'sai-u3rw3o3e__modal-stock'
        stock.dataset.modalStock = 'true'
        card.appendChild(stock)

        const doneBtn = document.createElement('button')
        doneBtn.type = 'button'
        doneBtn.className = 'sai-u3rw3o3e__modal-done'
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

        document.body.appendChild(overlay)
        document.body.classList.add('sai-u3rw3o3e-modal-open')
        this._modal = { overlay, onKey }

        // Initial render — paints availability + price + stock based on the
        // resolved variant for the initial tuple.
        this._refreshModal(card, product)
      }

      // Re-paint the modal after the candidate tuple changes. Updates pill
      // selected/unavailable states, prices on the last option group, the
      // header title, and the stock note.
      _refreshModal(card, product) {
        const candidate = this._modalCandidate
        if (!candidate) return
        const tuple = candidate.optionValues
        const numOptions = optionCount(product)
        const lastIndex = numOptions - 1

        const pills = card.querySelectorAll('.sai-u3rw3o3e__pill')
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

          // Price label only on the last option group — once we fix the last
          // option to `value` and keep earlier options at the candidate
          // tuple, the variant is uniquely determined.
        }

        // Update each group label's "current value" span.
        const groups = card.querySelectorAll('.sai-u3rw3o3e__modal-group')
        for (const group of groups) {
          const i = Number.parseInt(group.dataset.optionIndex || '0', 10)
          const span = group.querySelector('[data-group-current]')
          if (span) span.textContent = tuple[i] || ''
        }

        // Resolve the variant for the stock note.
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
          slot.textContent = `🔥 Low in stock - Only ${qty} available`
          slot.hidden = false
        } else {
          slot.textContent = ''
          slot.hidden = true
        }
      }

      _commitModal() {
        const candidate = this._modalCandidate
        if (!candidate) return this._closeModal()

        const product = this._data.products[candidate.productId]
        if (!product) return this._closeModal()

        // Resolve the candidate tuple → variant. If no exact match (the
        // user picked an unavailable combination via cascading clicks),
        // fall back to the first variant matching the LAST chosen option.
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

        const card = this.querySelector(`[data-product-id="${candidate.productId}"]`)
        if (card) {
          const label = card.querySelector('.sai-u3rw3o3e__variant-label')
          // Variant trigger button shows the full variant title (e.g.
          // "S / Black") so multi-option products read correctly. Single-
          // option variants (e.g. "S") look identical to before.
          if (label) label.textContent = variant.title || (variant.options || []).join(' / ')
          const priceEl = card.querySelector('.sai-u3rw3o3e__price')
          if (priceEl) priceEl.textContent = formatMoney(variant.price, this._data.currency)
          const compareEl = card.querySelector('.sai-u3rw3o3e__compare')
          if (compareEl) {
            if (variant.compareAtPrice && Number(variant.compareAtPrice) > Number(variant.price)) {
              compareEl.textContent = formatMoney(variant.compareAtPrice, this._data.currency)
              compareEl.hidden = false
            } else {
              compareEl.hidden = true
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
        const card = overlay.querySelector('.sai-u3rw3o3e__modal-card')
        overlay.dataset.closing = 'true'

        const cleanup = () => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
          document.body.classList.remove('sai-u3rw3o3e-modal-open')
        }

        if (card) {
          let done = false
          const fire = () => {
            if (done) return
            done = true
            card.removeEventListener('animationend', fire)
            cleanup()
          }
          card.addEventListener('animationend', fire, { once: true })
          setTimeout(fire, 360)
        } else {
          cleanup()
        }

        this._modal = null
        this._modalCandidate = null
      }
    }
    customElements.define(TAG, SaiFbtHorizontal)
  }

  function bindAllContainers() {
    const api = window.__spectrumAi?.snippet
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )

    if (!api?.bind) return

    for (const node of containers) {
      const handles = api.bind(node, () => {})
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
