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
  const FEATURE_SLUG = 'recommendations_fbt'
  const LOW_STOCK_THRESHOLD = 10
  const MODAL_CLOSE_TIMEOUT_MS = 360
  // After a successful add, hold the CTA in "Added" state briefly. Long
  // enough for visual feedback when the theme doesn't open a drawer; short
  // enough that selection edits feel responsive.
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
  // Accepts the full data payload (`{ moneyFormat, currency }`) or a legacy
  // currency-string for backward compat. Using `shop.money_format` makes
  // JS-rendered prices match SSR ones — Intl.NumberFormat produced
  // `US$699.95` while Liquid renders `$699.95`.
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
    return `$${value.toFixed(2)}`
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

  // Derive a per-value swatch image by taking the featuredImage of the
  // first variant whose options[optionIndex] === value. Works best on
  // Color (each variant tends to have its own image); Size/Material fall
  // back to null and the pill renders text-only. Same trick i2m3o6sr and
  // fbtatc4z use.
  function swatchImageForValueByIndex(product, optionIndex, value) {
    for (const v of product.variants || []) {
      if (v.options?.[optionIndex] === value && v.featuredImage) return v.featuredImage
    }
    return null
  }

  function isValueAvailableForTuple(product, optionIndex, value, tuple) {
    // Always respect `v.available`. The earlier gift-card workaround
    // (treat every variant as available when ALL are unavailable) hid
    // genuine sold-out states — if every variant is OOS the merchant
    // wants the product shown as unavailable, not magically purchasable.
    return product.variants.some((v) => {
      if (v.options?.[optionIndex] !== value) return false
      if (!v.available) return false
      return (v.options || []).every((val, i) => i === optionIndex || val === tuple[i])
    })
  }

  if (!customElements.get(TAG)) {
    class SaiFbt extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true

        this._track = noopTrack
        this._emit = noopEmit
        this._data = this._readPayload()
        this._productsById = new Map()
        this._rows = new Map()
        this._modal = null
        this._modalCandidate = null
        this._ctaBaseLabel = ''
        this._successTimer = null
        // Save body scroll state across modal open/close. Initialized lazily
        // in _openModal so we don't perturb the page on init.
        this._scrollLock = null

        if (!this._data) return

        // Resolved once at init from the server-validated payload (Liquid
        // allowlist-guards the value before serializing); used by
        // `_enterSuccessState` to decide what to do after the success-state
        // timeout. Defaults to 'stay' if the payload omits the key.
        this._afterAddAction = this._data.afterAddAction || 'stay'

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

      disconnectedCallback() {
        // Clear the post-add success-state timer. If we don't, a user who
        // navigates away during the 1.5s window can have their next page
        // hijacked by a stale window.location.href call from `redirect-to-cart`
        // / `redirect-to-checkout`.
        if (this._successTimer) {
          clearTimeout(this._successTimer)
          this._successTimer = null
        }
        // Tear down an open modal — `_closeModal` removes the
        // document-level keydown listener that would otherwise leak (along
        // with its closure over this element + payload + maps).
        if (this._modal) {
          this._closeModal()
        }
      }

      setAnalytics(track, emit) {
        this._track = typeof track === 'function' ? safeTrack(track) : noopTrack
        this._emit = typeof emit === 'function' ? safeEmit(emit) : noopEmit
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

      // Per-item shape for the analytics payload — mirrors the
      // shoppable_videos `{ product_id, variant_id, quantity }` shape so
      // dashboards can union event streams across snippets. `product_id`
      // and `variant_id` stay as strings to match how the rest of the
      // FBT events serialize them (DOM `data-product-id` is always a
      // string; `_rows` keeps the variant id stringified for the same
      // reason).
      _selectedRowsForPayload() {
        const out = []
        for (const row of this._rows.values()) {
          if (!row.checked || !row.variantId) continue
          out.push({
            product_id: row.productId,
            variant_id: row.variantId,
            quantity: 1,
          })
        }
        return out
      }

      _updateCta() {
        const cta = this.querySelector('[data-fbt-cta]')
        const labelEl = this.querySelector('[data-fbt-cta-label]')
        if (!cta || !labelEl) return
        const count = this._selectedItems().length
        labelEl.textContent = `${this._ctaBaseLabel} (${count})`
        cta.disabled = count === 0
        // WAI-ARIA expects an explicit "true" / "false" value — `toggleAttribute`
        // sets it to empty string which some assistive tech treats inconsistently.
        cta.setAttribute('aria-disabled', String(count === 0))
      }

      _updateTotal() {
        const totalEl = this.querySelector('[data-fbt-total]')
        if (!totalEl) return
        const variants = this._selectedVariants()
        const cents = variants.reduce((sum, v) => sum + (Number(v.price) || 0), 0)
        totalEl.textContent = cents > 0 ? formatMoney(cents, this._data) : ''
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

        // Build payload up front so the intent (`add_to_cart`) and
        // confirmation (`added_to_cart`) events carry an identical shape —
        // the funnel assumes a 1:1 pairing keyed off the envelope, and an
        // `add_to_cart` without a matching `added_to_cart` reveals failures
        // (we deliberately do NOT emit a `:add_to_cart_failed` event).
        // Mirrors the shoppable_videos convention.
        const atcPayload = {
          bundle_size: items.length,
          items: this._selectedRowsForPayload(),
        }
        this._track(`${FEATURE_SLUG}:add_to_cart`, atcPayload)
        this._emit(`${FEATURE_SLUG}:add_to_cart`, atcPayload)

        let succeeded = false
        try {
          const cartApi = window.Spectrum?.cart
          if (!cartApi || typeof cartApi.addAndOpen !== 'function') {
            throw new Error('Spectrum cart API unavailable')
          }
          // addAndOpen performs the section detection, server-side render
          // request, section-swap, drawer-open cascade, and cart-update
          // event firehose. This snippet was the original reference for
          // that flow; it now lives in spectrum-sdk.js.
          const cartResponse = await cartApi.addAndOpen(items, {
            sourceId: `spectrum-${SNIPPET_ID}`,
          })
          if (cartResponse && cartResponse.ok === false) {
            throw new Error(cartResponse.error?.message || 'Could not add to cart')
          }

          succeeded = true
          // Confirmation — identical payload to the intent event so PostHog
          // can pair them off the envelope (snippet_instance_id + session)
          // without any field-level matching.
          this._track(`${FEATURE_SLUG}:added_to_cart`, atcPayload)
          this._emit(`${FEATURE_SLUG}:added_to_cart`, atcPayload)

          // `_afterAddAction` was resolved at init from `_data.afterAddAction`
          // — `_enterSuccessState` reads it in the `finally` block below to
          // decide whether to stay on page, navigate to /cart, or
          // navigate to /checkout once the brief confirmation expires.
        } catch (err) {
          // No `:add_to_cart_failed` event — by convention, an
          // `:add_to_cart` intent without a matching `:added_to_cart`
          // confirmation surfaces the failure in the funnel. The error UI
          // still renders below the CTA so the shopper sees what happened.
          this._setError(err?.message || 'Could not add to cart')
        } finally {
          this._setLoading(false)
          if (succeeded) {
            // Hold the CTA in a brief "Added" state. Two reasons:
            //   1. Visual feedback — themes that don't open a drawer
            //      otherwise leave the user with no signal that the add
            //      worked.
            //   2. Double-tap guard — the user can't add the same bundle
            //      again until the success state clears.
            this._enterSuccessState()
          } else if (cta) {
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
        // Toggling the [hidden] attribute is what flips the loader between
        // display:none (SSR default) and display:inline-flex (base rule).
        // The data-loading attribute on the CTA hides the sibling label so
        // the absolute-positioned spinner sits on top.
        if (loader) loader.hidden = !loading
      }

      _enterSuccessState() {
        const cta = this.querySelector('[data-fbt-cta]')
        const labelEl = this.querySelector('[data-fbt-cta-label]')
        if (!cta || !labelEl) return
        cta.disabled = true
        cta.setAttribute('aria-disabled', 'true')
        cta.setAttribute('data-state', 'added')
        labelEl.textContent = 'Added to cart ✓'
        const action = this._afterAddAction || 'stay'
        if (this._successTimer) clearTimeout(this._successTimer)
        this._successTimer = setTimeout(() => {
          if (action === 'redirect-to-cart') {
            window.location.href = '/cart'
            return
          }
          if (action === 'redirect-to-checkout') {
            window.location.href = '/checkout'
            return
          }
          cta.removeAttribute('data-state')
          // _updateCta restores the "Add To Cart (N)" label from
          // _ctaBaseLabel + current selection count, and flips disabled
          // based on whether anything is still selected.
          this._updateCta()
          this._successTimer = null
        }, SUCCESS_FEEDBACK_MS)
      }

      // ── Variant modal ──────────────────────────────────────────────────────

      // ── Variant picker mini-PDP (quickshop) ───────────────────────────
      // Mobile bottom sheet → desktop centred modal. Header carries the
      // product image + title + live-updating price; one option group per
      // option type with name-keyed pills and per-value swatches (where the
      // first matching variant has a featuredImage). DONE button commits
      // the variant to the row + closes — does NOT add to cart (pb3tmxq9
      // is a bundle widget, the aggregate ATC outside the modal does the
      // adding). Mirrors fbtatc4z / i2m3o6sr quickshop visuals.
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
        overlay.setAttribute('aria-label', 'Choose variant')

        const backdrop = document.createElement('div')
        backdrop.className = 'sai-pb3tmxq9__modal-backdrop'
        backdrop.addEventListener('click', () => this._closeModal())
        overlay.appendChild(backdrop)

        const card = document.createElement('div')
        card.className = 'sai-pb3tmxq9__modal-card'
        overlay.appendChild(card)

        // Floating close button (top-right of panel).
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'sai-pb3tmxq9__modal-close'
        closeBtn.setAttribute('aria-label', 'Close')
        closeBtn.appendChild(makeIcon('close'))
        closeBtn.addEventListener('click', () => this._closeModal())
        card.appendChild(closeBtn)

        // Header: image + title + live price (variant picks update all three).
        const header = document.createElement('div')
        header.className = 'sai-pb3tmxq9__modal-header'
        const media = document.createElement('div')
        media.className = 'sai-pb3tmxq9__modal-media'
        const img = document.createElement('img')
        img.className = 'sai-pb3tmxq9__modal-image'
        img.dataset.modalImage = ''
        img.alt = product.title || ''
        media.appendChild(img)
        header.appendChild(media)

        const meta = document.createElement('div')
        meta.className = 'sai-pb3tmxq9__modal-meta'
        const titleEl = document.createElement('a')
        titleEl.className = 'sai-pb3tmxq9__modal-title'
        titleEl.dataset.modalTitle = ''
        titleEl.href = product.url || '#'
        titleEl.textContent = product.title || ''
        meta.appendChild(titleEl)
        const priceWrap = document.createElement('p')
        priceWrap.className = 'sai-pb3tmxq9__modal-price'
        const priceEl = document.createElement('span')
        priceEl.dataset.modalPrice = ''
        priceWrap.appendChild(priceEl)
        const compareEl = document.createElement('span')
        compareEl.className = 'sai-pb3tmxq9__modal-price-compare'
        compareEl.dataset.modalCompare = ''
        compareEl.hidden = true
        priceWrap.appendChild(compareEl)
        meta.appendChild(priceWrap)
        header.appendChild(meta)
        card.appendChild(header)

        // One bordered group per option type.
        const groupsContainer = document.createElement('div')
        groupsContainer.className = 'sai-pb3tmxq9__modal-groups'
        card.appendChild(groupsContainer)

        for (let i = 0; i < numOptions; i++) {
          const optionName = product.options?.[i] || `Option ${i + 1}`
          const values = uniqueValuesForOption(product, i)

          const group = document.createElement('div')
          group.className = 'sai-pb3tmxq9__modal-group'
          group.dataset.optionIndex = String(i)

          const head = document.createElement('div')
          head.className = 'sai-pb3tmxq9__modal-group-head'
          const nameEl = document.createElement('span')
          nameEl.className = 'sai-pb3tmxq9__modal-group-name'
          nameEl.textContent = `${optionName}:`
          head.appendChild(nameEl)
          const selectedEl = document.createElement('span')
          selectedEl.className = 'sai-pb3tmxq9__modal-group-selected'
          selectedEl.setAttribute('data-group-current', '')
          selectedEl.textContent = initialTuple[i] || ''
          head.appendChild(selectedEl)
          group.appendChild(head)

          const pills = document.createElement('div')
          pills.className = 'sai-pb3tmxq9__modal-pills'
          pills.setAttribute('role', 'radiogroup')
          pills.setAttribute('aria-label', optionName)
          group.appendChild(pills)

          for (const value of values) {
            const pill = document.createElement('button')
            pill.type = 'button'
            pill.className = 'sai-pb3tmxq9__pill'
            pill.setAttribute('role', 'radio')
            pill.dataset.value = value
            pill.dataset.optionIndex = String(i)

            // Swatch — first variant with this value contributes its
            // featuredImage. Works on Color products; Size/Material fall
            // back to a text-only pill.
            const swatchUrl = swatchImageForValueByIndex(product, i, value)
            if (swatchUrl) {
              const swatch = document.createElement('span')
              swatch.className = 'sai-pb3tmxq9__pill-swatch'
              swatch.style.backgroundImage = `url('${swatchUrl}')`
              pill.appendChild(swatch)
            }

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

        const stock = document.createElement('p')
        stock.className = 'sai-pb3tmxq9__modal-stock'
        stock.dataset.modalStock = 'true'
        stock.hidden = true
        card.appendChild(stock)

        const doneBtn = document.createElement('button')
        doneBtn.type = 'button'
        doneBtn.className = 'sai-pb3tmxq9__modal-done'
        doneBtn.textContent = 'DONE'
        doneBtn.addEventListener('click', () => this._commitModal())
        card.appendChild(doneBtn)

        const onKey = (e) => {
          if (e.key === 'Escape') this._closeModal()
        }
        document.addEventListener('keydown', onKey)

        // Inline scroll-lock — restored byte-for-byte on close.
        this._scrollLock = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        document.body.appendChild(overlay)
        this._modal = { overlay, onKey }
        // Trigger slide-up on next frame so the transition animates.
        requestAnimationFrame(() => overlay.classList.add('sai-pb3tmxq9__modal-overlay--open'))

        this._refreshModal(card, product)
      }

      _refreshModal(card, product) {
        const candidate = this._modalCandidate
        if (!candidate) return
        const tuple = candidate.optionValues
        const numOptions = optionCount(product)
        const lastIndex = numOptions - 1

        // Pills — selected + cross-disable on unreachable combinations.
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
            pill.setAttribute('aria-disabled', 'false')
          } else {
            pill.dataset.unavailable = 'true'
            pill.disabled = true
            pill.setAttribute('aria-disabled', 'true')
          }
          pill.setAttribute('aria-checked', isSelected ? 'true' : 'false')
        }

        // Group "Color: Red" labels.
        const groups = card.querySelectorAll('.sai-pb3tmxq9__modal-group')
        for (const group of groups) {
          const i = Number.parseInt(group.dataset.optionIndex || '0', 10)
          const span = group.querySelector('[data-group-current]')
          if (span) span.textContent = tuple[i] || ''
        }

        const variant =
          findVariantByTuple(product, tuple) ||
          findVariantForValue(product, lastIndex, tuple[lastIndex])

        // Header image — prefer the variant's featured image, fall back to
        // the product's. Variants without their own image inherit the
        // product image, matching Shopify's PDP behaviour.
        const img = card.querySelector('[data-modal-image]')
        if (img) {
          img.src = variant?.featuredImage || product.imageUrl || ''
          img.alt = product.title || ''
        }

        // Live price + compare-at.
        const priceEl = card.querySelector('[data-modal-price]')
        if (priceEl) {
          priceEl.textContent = formatMoney(variant?.price ?? product.price, this._data)
        }
        const compareEl = card.querySelector('[data-modal-compare]')
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
          if (priceEl) priceEl.textContent = formatMoney(variant.price, this._data)
          const compareEl = card.querySelector('.sai-pb3tmxq9__compare')
          const offEl = card.querySelector('.sai-pb3tmxq9__off-badge')
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
        overlay.classList.remove('sai-pb3tmxq9__modal-overlay--open')

        // Restore inline body overflow saved at open time. '' is the inert
        // default when no prior value was recorded.
        document.body.style.overflow = this._scrollLock || ''
        this._scrollLock = null

        // Wait out the panel slide-down before removing the node. Safety
        // timeout in case transitionend never fires (background tab,
        // prefers-reduced-motion).
        let removed = false
        const remove = () => {
          if (removed) return
          removed = true
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        }
        overlay.addEventListener('transitionend', remove, { once: true })
        setTimeout(remove, MODAL_CLOSE_TIMEOUT_MS)

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
        // wired correctly for our `track` / `emit` calls.
      })
      const root = node.querySelector(TAG)
      if (root && handles && typeof root.setAnalytics === 'function') {
        // Pass both track + emit. `emit` dispatches a paired DOM event so
        // theme code (Klaviyo bridges, custom adapters) can subscribe to
        // `add_to_cart` / `added_to_cart` without going through PostHog.
        root.setAnalytics(handles.track, handles.emit)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }
})()
