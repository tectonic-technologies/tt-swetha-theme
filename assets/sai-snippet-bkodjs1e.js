/* =============================================================================
 * Best Price Widget (bkodjs1e) — PDP discount surface.
 *
 * Reads the JSON payload emitted by the Liquid shell, evaluates the
 * StorefrontDiscount[] list against merchant priority/fallback/visibility
 * rules, and renders one of three display modes (inline callout / expandable
 * card / dropdown). Optional countdown to the discount's expiry, optional
 * alternative-discount list, optional sticky mobile bar (additive).
 *
 * Cart-live-sync: patches window.fetch + XMLHttpRequest once per page so
 * threshold-based discounts re-evaluate as the cart total / quantity
 * changes. Theme cart:updated / cart:refresh events are listened to as a
 * backup. Debounced 120ms.
 *
 * Variant-aware: variants ship their per-variant discount blob in the
 * payload, so option swaps recompute instantly without a server round-trip.
 *
 * No-bind fallback: if window.__spectrumAi is absent the widget still
 * functions — render, countdown, sticky bar, cart sync. Analytics become
 * a noop.
 * ============================================================================= */

;(() => {
  if (window.__sai_bkodjs1e_initialized__) return
  window.__sai_bkodjs1e_initialized__ = true

  const SNIPPET_ID = 'bkodjs1e'
  const TAG = 'sai-bkodjs1e'
  const FEATURE_SLUG = 'best_price'
  const CART_SYNC_DEBOUNCE_MS = 120
  const CART_MUTATION_PATHS = ['/cart/add', '/cart/change', '/cart/update', '/cart/clear']

  // ── Analytics helpers ────────────────────────────────────────────────────
  function noop() {}

  function escapeHtml(str) {
    if (str == null) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
  function safe(fn) {
    return (name, payload) => {
      try {
        fn(name, payload)
      } catch (_) {
        /* analytics is best-effort */
      }
    }
  }

  // ── Currency formatting ──────────────────────────────────────────────────
  // Discount payloads ship monetary values as decimals in store currency
  // (StorefrontDiscount.discountValue.amount, qualification.remainingValue,
  // etc.). Product price/compareAtPrice from Shopify Liquid arrive as cents.
  // We coerce both at consumption sites.

  function formatMoney(amount, currency, locale) {
    if (amount == null || !Number.isFinite(Number(amount))) return ''
    const value = Number(amount)
    try {
      return new Intl.NumberFormat(locale || undefined, {
        style: 'currency',
        currency: currency || 'USD',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 2,
      }).format(value)
    } catch (_) {
      try {
        return new Intl.NumberFormat(locale || undefined, {
          style: 'currency',
          currency: currency || 'USD',
        }).format(value)
      } catch (__) {
        return value.toFixed(2)
      }
    }
  }

  // Cents-to-decimal — Shopify Liquid `product.price` is integer cents.
  function centsToDecimal(cents) {
    if (cents == null) return null
    const n = Number(cents)
    return Number.isFinite(n) ? n / 100 : null
  }

  // ── Template interpolation ───────────────────────────────────────────────
  // Single-brace placeholders so Liquid doesn't pre-interpolate them at
  // template render. Replacing {x} only when the value is present so empty
  // values leave a clean residual rather than literal "{x}".

  function fillTemplate(tpl, vars) {
    if (!tpl) return ''
    return String(tpl)
      .replace(/\{(\w+)\}/g, (match, key) => {
        const v = vars[key]
        return v == null || v === '' ? '' : String(v)
      })
      .replace(/\s+/g, ' ')
      .trim()
  }

  // ── Discount evaluation ──────────────────────────────────────────────────
  // Spectrum's StorefrontDiscount carries everything we need:
  //   qualification.applicability ∈ 'current' | 'potential' | 'never'
  //   qualification.isSatisfied / progressMetric / progressPercent
  //   qualification.remainingValue / requiredValue / currentValue
  //   applicationType ∈ 'manual' | 'automatic'
  //   discountValue.{ type, amount, percentage, currencyCode }
  //   stackConfig — used as a stacked-discount signal
  //   visibilityConfig — used for member gating + expiry
  //   customerGetsConfig — member-only signal fallback
  //
  // None of the fields are individually required — we treat absent fields
  // as the permissive option (e.g., no visibilityConfig means not
  // member-gated, no expiry).

  function isMemberOnly(d) {
    // Best-effort signal — exact path depends on server contract. Check the
    // two most likely places before falling back to false.
    const vc = d?.visibilityConfig
    if (vc) {
      if (vc.memberOnly === true) return true
      if (vc.customerSelection === 'members' || vc.audience === 'members') return true
      if (Array.isArray(vc.customerSegments) && vc.customerSegments.length > 0) return true
    }
    const cg = d?.customerGetsConfig
    if (cg && cg.requiresCustomer === true) return true
    return false
  }

  function isStackable(d) {
    const sc = d?.stackConfig
    if (!sc) return false
    if (sc.canStack === true) return true
    if (Array.isArray(sc.stacksWith) && sc.stacksWith.length > 0) return true
    return false
  }

  function endsAtMs(d) {
    const vc = d?.visibilityConfig
    const raw = vc?.endsAt ?? vc?.endDate ?? d?.endsAt ?? null
    if (!raw) return null
    const t = typeof raw === 'number' ? raw : Date.parse(raw)
    return Number.isFinite(t) ? t : null
  }

  function startsAtMs(d) {
    const vc = d?.visibilityConfig
    const raw = vc?.startsAt ?? vc?.startDate ?? d?.startsAt ?? null
    if (!raw) return null
    const t = typeof raw === 'number' ? raw : Date.parse(raw)
    return Number.isFinite(t) ? t : null
  }

  // Discount savings vs the product's regular price at qty 1. Returns an
  // object with absolute (store currency decimal) and percentage. Returns
  // null when we can't compute — e.g., FREE_SHIPPING, or DISCOUNTED_QUANTITY
  // we can't reduce to a per-item value without the cart context.
  function savingsAtQty1(d, productPriceDecimal) {
    if (productPriceDecimal == null) return null
    const dv = d?.discountValue
    if (!dv) return null
    switch (dv.type) {
      case 'PERCENTAGE': {
        const pct = Number(dv.percentage)
        if (!Number.isFinite(pct)) return null
        return {
          absolute: (productPriceDecimal * pct) / 100,
          percentage: pct,
        }
      }
      case 'FIXED': {
        const amt = Number(dv.amount)
        if (!Number.isFinite(amt)) return null
        const absolute = dv.appliesOnEachItem ? amt : Math.min(amt, productPriceDecimal)
        return {
          absolute,
          percentage: productPriceDecimal > 0 ? (absolute / productPriceDecimal) * 100 : 0,
        }
      }
      case 'DISCOUNTED_QUANTITY': {
        // Effect-on-Nth-item — at qty 1 we approximate the per-item savings.
        const eff = dv.effect
        if (!eff) return null
        if (eff.type === 'PERCENTAGE') {
          const pct = Number(eff.percentage)
          if (!Number.isFinite(pct)) return null
          return {
            absolute: (productPriceDecimal * pct) / 100,
            percentage: pct,
          }
        }
        if (eff.type === 'FIXED') {
          const amt = Number(eff.amount)
          if (!Number.isFinite(amt)) return null
          return {
            absolute: amt,
            percentage: productPriceDecimal > 0 ? (amt / productPriceDecimal) * 100 : 0,
          }
        }
        return null
      }
      case 'FREE_SHIPPING':
        return null
      default:
        return null
    }
  }

  function discountedPrice(d, productPriceDecimal) {
    const s = savingsAtQty1(d, productPriceDecimal)
    if (!s) return productPriceDecimal
    const result = productPriceDecimal - s.absolute
    return result < 0 ? 0 : result
  }

  // remainingValue per StorefrontDiscount may be in store currency or in
  // qty units. progressMetric tells us which.
  function thresholdGap(d) {
    const q = d?.qualification
    if (!q) return null
    const remaining = Number(q.remainingValue)
    if (!Number.isFinite(remaining)) return null
    return remaining
  }

  function applicability(d) {
    return d?.qualification?.applicability || 'never'
  }

  function filterByVisibility(discounts, config) {
    const minSavings = Number(config.minSavingsToShow) || 0
    const maxGap = Number(config.maxThresholdGapToShow) || 0
    return discounts
      .filter((d) => {
        if (applicability(d) === 'never') return false
        if (!config.considerMemberDiscounts && isMemberOnly(d)) return false
        if (!config.considerStackedDiscounts && isStackable(d)) return false
        // Drop expired discounts unless the merchant explicitly chose to keep them.
        const ends = endsAtMs(d)
        if (ends != null && ends <= Date.now()) return false
        const starts = startsAtMs(d)
        if (starts != null && starts > Date.now()) return false
        return true
      })
      .filter((d) => {
        // Min-savings floor — only applies once we know the savings (i.e. we
        // need productPrice context downstream; this filter runs in
        // evaluate() where it has price).
        if (minSavings <= 0 && maxGap <= 0) return true
        if (maxGap > 0 && applicability(d) === 'potential') {
          const gap = thresholdGap(d)
          if (gap != null && gap > maxGap) return false
        }
        return true
      })
  }

  function pickBest(discounts, config, productPriceDecimal) {
    if (discounts.length === 0) return null
    const minSavings = Number(config.minSavingsToShow) || 0

    const withSignals = discounts
      .map((d) => {
        const s = savingsAtQty1(d, productPriceDecimal)
        const gap = thresholdGap(d)
        const required = Number(d?.qualification?.requiredValue) || 0
        return {
          d,
          savingsAbs: s?.absolute ?? 0,
          savingsPct: s?.percentage ?? 0,
          gap: gap ?? Number.POSITIVE_INFINITY,
          gapRatio:
            required > 0 ? (gap ?? Number.POSITIVE_INFINITY) / required : Number.POSITIVE_INFINITY,
          isCurrent: applicability(d) === 'current',
        }
      })
      .filter((x) => x.savingsAbs >= minSavings || minSavings === 0)

    if (withSignals.length === 0) return null

    const currents = withSignals.filter((x) => x.isCurrent)
    const potentials = withSignals.filter((x) => !x.isCurrent)

    function bestOf(list) {
      if (list.length === 0) return null
      const sorted = [...list]
      switch (config.priorityLogic) {
        case 'highest_percentage':
          sorted.sort((a, b) => b.savingsPct - a.savingsPct)
          break
        case 'easiest_to_unlock':
          sorted.sort((a, b) => a.gapRatio - b.gapRatio || b.savingsAbs - a.savingsAbs)
          break
        case 'merchant_order':
          // Preserve original order — no sort.
          break
        default:
          // highest_savings (default)
          sorted.sort((a, b) => b.savingsAbs - a.savingsAbs)
      }
      return sorted[0]
    }

    // Prefer current; fall through to potential, applying fallbackLogic.
    if (currents.length > 0) return bestOf(currents)

    switch (config.fallbackLogic) {
      case 'maximum_savings':
        return bestOf(potentials)
      case 'none':
        return null
      default: {
        // nearest_threshold (default)
        if (potentials.length === 0) return null
        const sorted = [...potentials].sort((a, b) => a.gap - b.gap)
        return sorted[0]
      }
    }
  }

  function evaluate(state) {
    const productPrice = centsToDecimal(state.product.price) // store-currency decimal
    const visible = filterByVisibility(state.discounts, state.config)
    const best = pickBest(visible, state.config, productPrice)
    if (!best) {
      return { best: null, alternatives: [], productPrice }
    }
    // Alternatives: everything visible minus the headline, sorted by the
    // same priority logic, capped at maxAlternatives.
    const others = visible.filter((d) => d !== best.d)
    const ranked = pickAlternatives(others, state.config, productPrice)
    const cap = Math.max(0, Math.min(Number(state.config.maxAlternatives) || 0, 50))
    return {
      best,
      alternatives: ranked.slice(0, cap),
      productPrice,
    }
  }

  function pickAlternatives(discounts, config, productPriceDecimal) {
    const withSignals = discounts.map((d) => {
      const s = savingsAtQty1(d, productPriceDecimal)
      const gap = thresholdGap(d)
      return {
        d,
        savingsAbs: s?.absolute ?? 0,
        savingsPct: s?.percentage ?? 0,
        gap: gap ?? Number.POSITIVE_INFINITY,
        isCurrent: applicability(d) === 'current',
      }
    })
    switch (config.priorityLogic) {
      case 'highest_percentage':
        withSignals.sort(
          (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.savingsPct - a.savingsPct,
        )
        break
      case 'easiest_to_unlock':
        withSignals.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.gap - b.gap)
        break
      case 'merchant_order':
        break
      default:
        // highest_savings (default)
        withSignals.sort(
          (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.savingsAbs - a.savingsAbs,
        )
    }
    return withSignals
  }

  // ── Threshold display rendering ──────────────────────────────────────────
  function thresholdSummary(d, mode, money) {
    const q = d?.qualification
    if (!q) return null
    const metric = q.progressMetric
    const required = q.requiredValue
    const useCart =
      mode === 'cart_value_only' || mode === 'both' || (mode === 'smart' && metric === 'cart_value')
    const useQty =
      mode === 'quantity_only' || mode === 'both' || (mode === 'smart' && metric === 'quantity')
    const parts = []
    if (
      useCart &&
      required != null &&
      (metric === 'cart_value' || mode === 'cart_value_only' || mode === 'both')
    ) {
      parts.push(`Orders ${money(required, true)}+`)
    }
    if (
      useQty &&
      required != null &&
      (metric === 'quantity' || mode === 'quantity_only' || mode === 'both')
    ) {
      parts.push(`${required}+ items`)
    }
    return parts.length > 0 ? parts.join(' · ') : null
  }

  // ── Countdown ────────────────────────────────────────────────────────────
  function pad2(n) {
    return n < 10 ? `0${n}` : String(n)
  }

  function formatCountdown(remainingMs, format, showSeconds) {
    if (remainingMs <= 0) return '0'
    const totalSec = Math.floor(remainingMs / 1000)
    const days = Math.floor(totalSec / 86400)
    const hours = Math.floor((totalSec % 86400) / 3600)
    const minutes = Math.floor((totalSec % 3600) / 60)
    const seconds = totalSec % 60

    switch (format) {
      case 'long': {
        const parts = []
        if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`)
        if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
        if (minutes > 0 || (days === 0 && hours === 0))
          parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
        if (showSeconds && days === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`)
        return parts.join(' ')
      }
      case 'compact': {
        if (days > 0) {
          return showSeconds
            ? `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
            : `${days}d ${pad2(hours)}:${pad2(minutes)}`
        }
        return showSeconds
          ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
          : `${pad2(hours)}:${pad2(minutes)}`
      }
      default: {
        // short (default)
        const parts = []
        if (days > 0) parts.push(`${days}d`)
        if (hours > 0 || days > 0) parts.push(`${hours}h`)
        parts.push(`${minutes}m`)
        if (showSeconds && days === 0) parts.push(`${pad2(seconds)}s`)
        return parts.join(' ')
      }
    }
  }

  // ── Cart-live-sync ───────────────────────────────────────────────────────
  // One global patch per page; instances subscribe to a shared event. The
  // patch detects cart-mutation responses (200 + a known URL), then fires
  // the event after the response has been parsed by the theme so any
  // cart-state DOM updates are already in place.

  const CART_SYNC_EVENT = '__sai_bkodjs1e_cart_changed__'

  function installGlobalCartSync() {
    if (window.__sai_bkodjs1e_cart_patched__) return
    window.__sai_bkodjs1e_cart_patched__ = true

    const fire = debounce(() => {
      window.dispatchEvent(new CustomEvent(CART_SYNC_EVENT))
    }, CART_SYNC_DEBOUNCE_MS)

    const origFetch = window.fetch
    if (typeof origFetch === 'function') {
      window.fetch = function patchedFetch(input, ...rest) {
        const url = typeof input === 'string' ? input : input?.url || ''
        const isMutation = CART_MUTATION_PATHS.some((p) => url.includes(p))
        const result = origFetch.call(this, input, ...rest)
        if (isMutation) {
          result.then(() => fire()).catch(() => {})
        }
        return result
      }
    }

    if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
      const origOpen = XMLHttpRequest.prototype.open
      const origSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
        this.__saiBpwUrl = url
        return origOpen.call(this, method, url, ...rest)
      }
      XMLHttpRequest.prototype.send = function patchedSend(...rest) {
        const url = this.__saiBpwUrl || ''
        const isMutation = CART_MUTATION_PATHS.some((p) => String(url).includes(p))
        if (isMutation) {
          this.addEventListener('load', () => fire())
        }
        return origSend.call(this, ...rest)
      }
    }

    // Backup: theme-emitted events. Different themes use different names —
    // listen to the common ones; duplicate fires are no-op (debounced).
    const events = ['cart:updated', 'cart:refresh', 'cart:change', 'cart:item-added']
    for (const evt of events) {
      document.addEventListener(evt, fire)
    }
  }

  function debounce(fn, ms) {
    let t = null
    return (...args) => {
      if (t) clearTimeout(t)
      t = setTimeout(() => fn(...args), ms)
    }
  }

  async function fetchCartTotal() {
    try {
      const res = await fetch('/cart.js', { credentials: 'same-origin' })
      if (!res.ok) return null
      const data = await res.json()
      return {
        total: typeof data.total_price === 'number' ? data.total_price / 100 : null,
        itemCount: typeof data.item_count === 'number' ? data.item_count : null,
      }
    } catch (_) {
      return null
    }
  }

  // ── Custom element ───────────────────────────────────────────────────────
  if (!customElements.get(TAG)) {
    class SaiBestPrice extends HTMLElement {
      connectedCallback() {
        if (this._initialized) return
        this._initialized = true

        this._track = noop
        this._emit = noop
        this._countdownTimer = null
        this._cartListener = null
        this._docClickListener = null
        this._modalKeyListener = null

        const payload = this._readPayload()
        if (!payload) return
        this._state = {
          discounts: this._extractDiscounts(payload.discounts),
          product: payload.product,
          shop: payload.shop,
          config: payload.config,
          labels: payload.labels,
          cart: { total: null, itemCount: null },
        }
        // Variant id → variant — for fast lookup on variant change.
        this._variantsById = new Map()
        for (const v of payload.product.variants || []) {
          this._variantsById.set(String(v.id), v)
        }
        this._currentVariantId = String(payload.product.currentVariantId)

        this._render()
        this._bindModeInteractions()
        this._bindStickyInteractions()
        this._bindCartSync()
        this._bindVariantChange()
      }

      disconnectedCallback() {
        this._teardownCountdown()
        if (this._cartListener) {
          window.removeEventListener(CART_SYNC_EVENT, this._cartListener)
          this._cartListener = null
        }
        if (this._docClickListener) {
          document.removeEventListener('click', this._docClickListener)
          this._docClickListener = null
        }
        if (this._modalKeyListener) {
          document.removeEventListener('keydown', this._modalKeyListener)
          this._modalKeyListener = null
        }
      }

      setAnalytics(track, emit) {
        this._track = typeof track === 'function' ? safe(track) : noop
        this._emit = typeof emit === 'function' ? safe(emit) : noop
      }

      onVariantChange(variantId) {
        if (!variantId) return
        const next = this._variantsById.get(String(variantId))
        if (!next) return
        this._currentVariantId = String(variantId)
        // Variant-scoped discounts override product-level when present.
        if (next.discounts) {
          this._state.discounts = this._extractDiscounts(next.discounts)
        }
        this._state.product.price = next.price
        this._state.product.compareAtPrice = next.compareAtPrice
        this._playPriceAnimation()
        this._render()
      }

      _readPayload() {
        const node = this.querySelector('script[type="application/json"][data-sai-payload]')
        if (!node) return null
        try {
          return JSON.parse(node.textContent || '{}')
        } catch (_) {
          return null
        }
      }

      _extractDiscounts(raw) {
        if (!raw) return []
        // Server emits `{"discounts": [...]}` (object) or `null` per variant.
        if (Array.isArray(raw)) return raw
        if (Array.isArray(raw.discounts)) return raw.discounts
        return []
      }

      _moneyFn() {
        const { currency, locale } = this._state.shop
        return (decimal) => formatMoney(decimal, currency, locale)
      }

      _render() {
        const { config, labels } = this._state
        const evaluated = evaluate(this._state)
        this._lastEvaluated = evaluated

        if (!evaluated.best) {
          if (config.hideWhenNoDiscounts) {
            this.classList.add('sai-bkodjs1e--hidden')
            this._teardownCountdown()
            return
          }
        }
        this.classList.remove('sai-bkodjs1e--hidden')

        const mode = config.displayMode
        // Headline price-row is shared by all three modes.
        this._renderHeadline(evaluated)
        this._renderBadge(labels.heading)

        // Mode-specific body — unlock/bullets/alternatives placement varies.
        if (mode === 'dropdown') {
          this._renderDropdown(evaluated)
        } else if (mode === 'expandable-card') {
          this._renderExpandable(evaluated)
        } else {
          this._renderInlineCallout(evaluated)
        }

        if (config.stickyMobileBar) {
          this._renderSticky(evaluated)
        }

        this._setupCountdown(evaluated)
      }

      _renderBadge(text) {
        const badge = this.querySelector('[data-sai-badge]')
        const heading = this.querySelector('[data-sai-heading]')
        if (!badge || !heading) return
        if (this._state.config.displayMode === 'default') {
          heading.textContent = text || 'Best offers'
          badge.hidden = false
        } else {
          badge.hidden = true
        }
      }

      _renderHeadline(evaluated) {
        const row = this.querySelector('[data-sai-price-row]')
        const priceEl = this.querySelector('[data-sai-price]')
        const savingsEl = this.querySelector('[data-sai-savings]')
        const prefixEl = this.querySelector('[data-sai-prefix]')
        if (!row || !priceEl) return

        const money = this._moneyFn()
        const product = this._state.product
        const productPriceDecimal = centsToDecimal(product.price)

        if (!evaluated.best) {
          row.hidden = true
          return
        }
        row.hidden = false

        // Headline displays the price *with* the best discount applied at qty 1.
        // For potential (near-miss) discounts the value is still useful — it
        // shows the price the customer *would* pay once they unlock it.
        const finalPrice = discountedPrice(evaluated.best.d, productPriceDecimal)
        priceEl.textContent = money(finalPrice)

        // Prefix label.
        if (prefixEl) {
          prefixEl.textContent = this._state.labels.bestPricePrefix || ''
          prefixEl.hidden = !this._state.labels.bestPricePrefix
        }

        // Savings delta.
        if (savingsEl) {
          if (this._state.config.showSavingsDelta && productPriceDecimal != null) {
            const saving = productPriceDecimal - finalPrice
            const format = this._state.config.savingsDeltaFormat
            const pct =
              productPriceDecimal > 0 ? Math.round((saving / productPriceDecimal) * 100) : 0
            let text = ''
            if (saving > 0) {
              if (format === 'percentage') text = `${pct}% off`
              else if (format === 'absolute') text = `You save ${money(saving)}`
              else text = `You save ${money(saving)} (${pct}% off)`
            }
            savingsEl.textContent = text
            savingsEl.hidden = !text
          } else {
            savingsEl.hidden = true
          }
        }
      }

      _renderInlineCallout(evaluated) {
        this._renderBullets(evaluated, this.querySelector('[data-sai-bullets]'))
        this._renderUnlock(evaluated, this.querySelector('[data-sai-unlock]'))
        // Alternatives shown directly when showAlternatives is on in this mode.
        if (this._state.config.showAlternatives) {
          this._renderAlternatives(evaluated, this.querySelector('[data-sai-alt-list]'))
        } else {
          const alt = this.querySelector('[data-sai-alt-list]')
          if (alt) alt.hidden = true
        }
        this._setHidden('[data-sai-expand-trigger]', true)
        this._setHidden('[data-sai-dropdown-trigger]', true)
        this._setHidden('[data-sai-dropdown-panel]', true)
      }

      _renderExpandable(evaluated) {
        this._renderBullets(evaluated, this.querySelector('[data-sai-bullets]'))
        this._renderUnlock(evaluated, this.querySelector('[data-sai-unlock]'))

        const trigger = this.querySelector('[data-sai-expand-trigger]')
        const triggerLabel = this.querySelector('[data-sai-expand-label]')
        const body = this.querySelector('[data-sai-expand-body-inner]')

        this._setHidden('[data-sai-dropdown-trigger]', true)
        this._setHidden('[data-sai-dropdown-panel]', true)

        if (!trigger || !body) return
        trigger.hidden = false
        const expanded = this.getAttribute('data-expanded') === 'true'
        if (triggerLabel) {
          triggerLabel.textContent = expanded
            ? this._state.labels.collapseTriggerText
            : this._state.labels.expandTriggerText
        }
        // Body content: alternatives when configured + countdown is already
        // in the headline. We populate the body so the grid-template-rows
        // animation has something to grow into.
        body.innerHTML = ''
        if (this._state.config.expandedShowAlternatives && this._state.config.showAlternatives) {
          const list = document.createElement('ul')
          list.className = 'sai-bkodjs1e__alt-list'
          this._renderAlternatives(evaluated, list, /* alreadyAttached */ true)
          body.appendChild(list)
        }

        // Hide the top-level inline alt list since the expanded body owns it.
        const topAlt = this.querySelector('[data-sai-alt-list]')
        if (topAlt) topAlt.hidden = true
      }

      _renderDropdown(evaluated) {
        const trigger = this.querySelector('[data-sai-dropdown-trigger]')
        const triggerLabel = this.querySelector('[data-sai-dropdown-label]')
        const calloutLabel = this.querySelector('[data-sai-callout-label]')

        // Dropdown mode hides every other inline region — the modal owns
        // all detail content.
        this._setHidden('[data-sai-expand-trigger]', true)
        this._setHidden('[data-sai-bullets]', true)
        this._setHidden('[data-sai-unlock]', true)
        this._setHidden('[data-sai-alt-list]', true)
        this._setHidden('[data-sai-price-row]', true)
        this._setHidden('[data-sai-badge]', true)
        this._setHidden('[data-sai-heading]', true)
        this._setHidden('[data-sai-dropdown-panel]', true)

        if (!trigger) return
        trigger.hidden = false
        if (triggerLabel) {
          triggerLabel.textContent = this._state.labels.dropdownTriggerText || 'View Details'
        }
        if (calloutLabel) {
          calloutLabel.textContent = this._buildCalloutText(evaluated)
        }

        this._wireDropdownPopup(evaluated)
      }

      _buildCalloutText(evaluated) {
        if (!evaluated.best) return this._state.labels.bestPricePrefix || 'Best offer'
        const money = this._moneyFn()
        const productPrice = centsToDecimal(this._state.product.price)
        const finalPrice = discountedPrice(evaluated.best.d, productPrice)
        return `Get it at ${money(finalPrice)}`
      }

      _wireDropdownPopup(evaluated) {
        const triggerBtn = this.querySelector('[data-sai-popup-trigger]')
        if (!triggerBtn) return
        // Idempotent — replace any prior handler bound to a stale evaluator.
        if (this._popupClickHandler) triggerBtn.removeEventListener('click', this._popupClickHandler)
        this._popupClickHandler = () => this._openDropdownPopup(this._lastEvaluated || evaluated)
        triggerBtn.addEventListener('click', this._popupClickHandler)
      }

      _openDropdownPopup(evaluated) {
        if (!evaluated || !evaluated.best) return
        const money = this._moneyFn()
        const productPrice = centsToDecimal(this._state.product.price)
        const labels = this._state.labels

        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

        const root = document.createElement('div')
        root.className = 'sai-bkodjs1e-popup'
        root.setAttribute('role', 'dialog')
        root.setAttribute('aria-modal', 'true')
        root.setAttribute('aria-labelledby', 'sai-bkodjs1e-popup-title')
        root.setAttribute('data-state', 'closed')

        const TAG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><circle cx="9.5" cy="9.5" r=".75" fill="currentColor"/><circle cx="14.5" cy="14.5" r=".75" fill="currentColor"/></svg>'

        root.innerHTML = `
          <div class="sai-bkodjs1e-popup__backdrop" data-sai-popup-dismiss></div>
          <div class="sai-bkodjs1e-popup__panel" data-sai-popup-panel>
            <div class="sai-bkodjs1e-popup__header">
              <span class="sai-bkodjs1e-popup__title" id="sai-bkodjs1e-popup-title">${escapeHtml(labels.heading || 'Best offers').toUpperCase()}</span>
              <button type="button" class="sai-bkodjs1e-popup__close" aria-label="Close" data-sai-popup-dismiss>&times;</button>
            </div>
            <div class="sai-bkodjs1e-popup__highlight">
              <span class="sai-bkodjs1e__callout-icon">${TAG_SVG.replace('<svg ', '<svg class="sai-bkodjs1e__callout-icon" ')}</span>
              <span>${escapeHtml(this._buildCalloutText(evaluated))}</span>
            </div>
            <div class="sai-bkodjs1e-popup__body" data-sai-popup-body></div>
          </div>
        `

        const body = root.querySelector('[data-sai-popup-body]')
        body.appendChild(this._buildPopupSection(evaluated.best.d, productPrice, money, /* primary */ true))

        if (this._state.config.showAlternatives && evaluated.alternatives.length > 0) {
          // Divider + alternative sections live INSIDE the body so they
          // share the body's padding and scroll with it. The divider has
          // negative inline margins to span the body's padding for the
          // full-width grey strip look.
          const divider = document.createElement('div')
          divider.className = 'sai-bkodjs1e-popup__divider'
          divider.innerHTML = `<span class="sai-bkodjs1e-popup__divider-icon">${TAG_SVG.replace('<svg ', '<svg class="sai-bkodjs1e-popup__divider-icon" ')}</span><span>Other Offers</span>`
          body.appendChild(divider)
          for (const item of evaluated.alternatives.slice(0, this._state.config.dropdownMaxItems || 5)) {
            body.appendChild(this._buildPopupSection(item.d, productPrice, money, false))
          }
        }

        document.body.appendChild(root)
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        const close = () => {
          root.setAttribute('data-state', 'closed')
          const cleanup = () => {
            document.removeEventListener('keydown', onKey, true)
            if (root.parentNode) root.parentNode.removeChild(root)
            document.body.style.overflow = prevOverflow
            if (previouslyFocused) previouslyFocused.focus()
          }
          const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          if (reduced) cleanup()
          else setTimeout(cleanup, 240)
        }
        const onKey = (e) => { if (e.key === 'Escape') close() }
        root.addEventListener('click', (e) => {
          const t = e.target
          if (t instanceof Element && t.closest('[data-sai-popup-dismiss]')) { e.preventDefault(); close() }
        })
        document.addEventListener('keydown', onKey, true)

        // Wire copy buttons inside the popup.
        root.addEventListener('click', async (e) => {
          const t = e.target
          if (!(t instanceof Element)) return
          const btn = t.closest('[data-sai-popup-copy]')
          if (!btn) return
          const code = btn.getAttribute('data-sai-popup-copy') || ''
          try { await navigator.clipboard.writeText(code) } catch (_) {}
          btn.setAttribute('aria-pressed', 'true')
          setTimeout(() => btn.setAttribute('aria-pressed', 'false'), 1200)
        })

        // Force reflow + double rAF so the transition has a clean from-state.
        void root.offsetHeight
        requestAnimationFrame(() => requestAnimationFrame(() => {
          root.setAttribute('data-state', 'open')
          const firstFocusable = root.querySelector('button, [href], [tabindex]:not([tabindex="-1"])')
          if (firstFocusable instanceof HTMLElement) firstFocusable.focus()
        }))
      }

      _buildPopupSection(d, productPrice, money, isPrimary) {
        const section = document.createElement('div')
        section.className = 'sai-bkodjs1e-popup__section' + (isPrimary ? ' sai-bkodjs1e-popup__section--primary' : '')

        if (d.summary || d.shortSummary) {
          const p = document.createElement('p')
          p.className = 'sai-bkodjs1e-popup__desc'
          p.textContent = d.summary || d.shortSummary
          section.appendChild(p)
        }

        const saving = savingsAtQty1(d, productPrice)
        if (saving && saving.absolute > 0) {
          const p = document.createElement('p')
          p.className = 'sai-bkodjs1e-popup__saving'
          p.innerHTML = `You Save <span class="sai-bkodjs1e-popup__saving-amount">${escapeHtml(money(saving.absolute))}</span>`
          section.appendChild(p)
        }

        const code = Array.isArray(d.codes) && d.codes.length > 0
          ? (typeof d.codes[0] === 'string' ? d.codes[0] : d.codes[0]?.code)
          : null
        if (code) {
          const row = document.createElement('div')
          row.className = 'sai-bkodjs1e-popup__code-row'
          row.innerHTML = `
            <span class="sai-bkodjs1e-popup__code">${escapeHtml(code)}</span>
            <button type="button" class="sai-bkodjs1e-popup__copy" data-sai-popup-copy="${escapeHtml(code)}" aria-pressed="false" aria-label="Copy code">
              <svg class="sai-bkodjs1e-popup__copy-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="4" y="4" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
                <path d="M3 11.5V3.5A1.5 1.5 0 0 1 4.5 2H11" fill="none" stroke="currentColor" stroke-width="1.4"/>
              </svg>
            </button>
          `
          section.appendChild(row)
        }
        return section
      }

      _renderBullets(evaluated, container) {
        if (!container) return
        container.innerHTML = ''
        const built = this._buildBullets(evaluated)
        if (built) {
          container.replaceWith(built)
          // Re-attach data attribute so subsequent renders find it.
          built.setAttribute('data-sai-bullets', '')
          // Update reference if needed — done implicitly via re-query.
          built.hidden = false
        } else {
          container.hidden = true
        }
      }

      _buildBullets(evaluated) {
        if (!evaluated.best) return null
        const { d } = evaluated.best
        const { config, labels } = this._state
        const money = this._moneyFn()

        const lines = []

        // 1. Applicable / threshold line.
        const threshold = thresholdSummary(d, config.thresholdDisplayMode, money)
        if (threshold) {
          lines.push({ label: 'Applicable on', value: threshold })
        } else if (d.summary) {
          lines.push({ label: 'Applicable on', value: d.summary })
        }

        // 2. Coupon code line.
        if (Array.isArray(d.codes) && d.codes.length > 0) {
          const code = typeof d.codes[0] === 'string' ? d.codes[0] : d.codes[0]?.code
          if (code) lines.push({ label: 'Coupon code', value: code, strong: true })
        }

        // 3. Coupon discount + savings line.
        const productPrice = centsToDecimal(this._state.product.price)
        const saving = savingsAtQty1(d, productPrice)
        if (saving) {
          const pct = Math.round(saving.percentage)
          const savingText = ` (Your total saving: ${money(saving.absolute)})`
          lines.push({ label: 'Coupon discount', value: `${pct}% off${savingText}` })
        }

        if (lines.length === 0) return null
        const ul = document.createElement('ul')
        ul.className = 'sai-bkodjs1e__bullets'
        ul.setAttribute('data-sai-bullets', '')
        for (const line of lines) {
          const li = document.createElement('li')
          li.className = 'sai-bkodjs1e__bullet'
          const labelNode = document.createTextNode(`${line.label}: `)
          li.appendChild(labelNode)
          if (line.strong) {
            const strong = document.createElement('strong')
            strong.textContent = line.value
            li.appendChild(strong)
          } else {
            li.appendChild(document.createTextNode(line.value))
          }
          ul.appendChild(li)
        }
        return ul
      }

      _renderUnlock(evaluated, container) {
        if (!container) return
        // When the headline discount is already current, the bullets list
        // already shows the "Applicable on:" line — emitting the same text
        // here as a green callout is duplication. Keep the callout for the
        // action-y "Spend X more to unlock" case only.
        const isCurrentHeadline = evaluated.best && applicability(evaluated.best.d) === 'current'
        if (isCurrentHeadline) {
          container.hidden = true
          container.textContent = ''
          return
        }
        const built = this._buildUnlock(evaluated)
        if (!built) {
          container.hidden = true
          container.textContent = ''
          return
        }
        container.replaceChildren(built)
        container.hidden = false
      }

      _buildUnlock(evaluated) {
        if (!evaluated.best) return null
        if (!this._state.config.showUnlockMessage) return null
        const { d } = evaluated.best
        const { labels } = this._state
        const money = this._moneyFn()
        const isCurrent = applicability(d) === 'current'

        const vars = {
          amount: this._formatRemaining(d, money),
          quantity: this._formatRemainingQty(d),
          discount_name: d?.shortSummary || d?.title || '',
          description: d?.summary || '',
        }

        const tpl = isCurrent ? labels.applicableTemplate : labels.unlockTemplate
        const text = fillTemplate(tpl, vars)
        if (!text) return null
        const span = document.createElement('span')
        span.textContent = text
        return span
      }

      _formatRemaining(d, money) {
        const q = d?.qualification
        if (!q) return ''
        const metric = q.progressMetric
        const remaining = Number(q.remainingValue)
        if (!Number.isFinite(remaining)) return ''
        if (metric === 'cart_value') return money(remaining)
        return String(remaining)
      }

      _formatRemainingQty(d) {
        const q = d?.qualification
        if (!q) return ''
        if (q.progressMetric === 'quantity') {
          const remaining = Number(q.remainingValue)
          return Number.isFinite(remaining) ? String(remaining) : ''
        }
        return ''
      }

      _renderAlternatives(evaluated, container, alreadyAttached) {
        if (!container) return
        container.innerHTML = ''
        if (evaluated.alternatives.length === 0) {
          container.hidden = true
          return
        }
        container.hidden = false

        const money = this._moneyFn()
        const productPrice = centsToDecimal(this._state.product.price)
        const grouped =
          this._state.config.dropdownGroupByType && this._state.config.displayMode === 'dropdown'
            ? this._groupAlternatives(evaluated.alternatives)
            : null

        // Mini-heading so users know what these rows are. Only emit when
        // there's at least one alt to show, and skip in grouped mode (which
        // already renders per-group labels).
        if (!grouped) {
          const head = document.createElement('li')
          head.className = 'sai-bkodjs1e__alt-heading'
          head.textContent = 'Other offers'
          container.appendChild(head)
        }

        if (grouped) {
          for (const group of grouped) {
            const label = document.createElement('li')
            label.className = 'sai-bkodjs1e__alt-group-label'
            label.textContent = group.label
            container.appendChild(label)
            for (const item of group.items) {
              container.appendChild(this._buildAltItem(item, productPrice, money))
            }
          }
        } else {
          const cap =
            this._state.config.displayMode === 'dropdown'
              ? Math.max(1, Number(this._state.config.dropdownMaxItems) || 5)
              : evaluated.alternatives.length
          for (const item of evaluated.alternatives.slice(0, cap)) {
            container.appendChild(this._buildAltItem(item, productPrice, money))
          }
        }
        if (!alreadyAttached) {
          container.setAttribute('data-sai-alt-list', '')
        }
      }

      _buildAltItem(item, productPrice, money) {
        const li = document.createElement('li')
        li.className = 'sai-bkodjs1e__alt-item'
        if (item.isCurrent) li.classList.add('sai-bkodjs1e__alt-item--current')
        const left = document.createElement('span')
        left.className = 'sai-bkodjs1e__alt-name'
        left.textContent = item.d.shortSummary || item.d.title || ''
        const right = document.createElement('span')
        right.className = 'sai-bkodjs1e__alt-value'
        right.textContent = this._altRightText(item, productPrice, money)
        li.appendChild(left)
        li.appendChild(right)
        return li
      }

      _altRightText(item, productPrice, money) {
        // For applicable alternatives, show what you save.
        // For potential ones, show what you need to do to unlock — no more
        // effective-price math (the original "$X · $Y" rendering confused
        // users about what the right number meant).
        if (item.isCurrent) {
          const saving = savingsAtQty1(item.d, productPrice)
          if (saving && saving.absolute > 0) return `Save ${money(saving.absolute)}`
          return 'Applies now'
        }
        const q = item.d?.qualification
        const metric = q && q.progressMetric
        const remaining = q && Number(q.remainingValue)
        if (Number.isFinite(remaining) && remaining > 0) {
          if (metric === 'cart_value' || metric === 'subtotal') {
            return `Spend ${money(remaining)} more to unlock`
          }
          if (metric === 'quantity') {
            return `Add ${remaining} more to unlock`
          }
        }
        return 'Not yet eligible'
      }

      _groupAlternatives(items) {
        const applicable = []
        const nearMiss = []
        const memberOnly = []
        for (const item of items) {
          if (isMemberOnly(item.d)) memberOnly.push(item)
          else if (item.isCurrent) applicable.push(item)
          else nearMiss.push(item)
        }
        const out = []
        if (applicable.length > 0) out.push({ label: 'Applicable', items: applicable })
        if (nearMiss.length > 0) out.push({ label: 'Near-miss', items: nearMiss })
        if (memberOnly.length > 0) out.push({ label: 'Member-only', items: memberOnly })
        return out
      }

      _renderSticky(evaluated) {
        const sticky = this.querySelector('[data-sai-sticky]')
        const price = this.querySelector('[data-sai-sticky-price]')
        const label = this.querySelector('[data-sai-sticky-label]')
        const infoBtn = this.querySelector('[data-sai-sticky-info-button]')
        const cta = this.querySelector('[data-sai-sticky-cta]')
        if (!sticky) return
        if (!evaluated.best) {
          sticky.hidden = true
          return
        }
        sticky.hidden = false
        const money = this._moneyFn()
        const productPrice = centsToDecimal(this._state.product.price)
        const finalPrice = discountedPrice(evaluated.best.d, productPrice)
        if (price) price.textContent = money(finalPrice)
        if (label) {
          label.textContent =
            applicability(evaluated.best.d) === 'current'
              ? evaluated.best.d?.shortSummary || evaluated.best.d?.title || ''
              : this._buildUnlockText(evaluated.best.d)
        }
        if (infoBtn) {
          const trigger = this._state.config.stickyModalTrigger
          infoBtn.hidden = trigger === 'tap_price'
        }
        if (cta) {
          cta.hidden = !this._state.config.stickyCombineWithATC
        }
      }

      _buildUnlockText(d) {
        const money = this._moneyFn()
        const vars = {
          amount: this._formatRemaining(d, money),
          quantity: this._formatRemainingQty(d),
          discount_name: d?.shortSummary || d?.title || '',
          description: d?.summary || '',
        }
        return fillTemplate(this._state.labels.unlockTemplate, vars)
      }

      _setHidden(selector, hidden) {
        const el = this.querySelector(selector)
        if (el) el.hidden = hidden
      }

      _bindModeInteractions() {
        // Expandable trigger toggle.
        const expandTrigger = this.querySelector('[data-sai-expand-trigger]')
        if (expandTrigger) {
          expandTrigger.addEventListener('click', () => {
            const next = this.getAttribute('data-expanded') !== 'true'
            this._setExpanded(next)
            this._track(`${FEATURE_SLUG}:expand_toggle`, { expanded: next })
          })
        }

        // Dropdown trigger toggle.
        const dropdownTrigger = this.querySelector('[data-sai-dropdown-trigger]')
        if (dropdownTrigger) {
          dropdownTrigger.addEventListener('click', () => {
            const next = this.getAttribute('data-dropdown-open') !== 'true'
            this._setDropdownOpen(next)
            this._track(`${FEATURE_SLUG}:dropdown_toggle`, { open: next })
          })
          // Outside-click closes the dropdown.
          this._docClickListener = (event) => {
            if (this.getAttribute('data-dropdown-open') !== 'true') return
            if (!this.contains(event.target)) {
              this._setDropdownOpen(false)
            }
          }
          document.addEventListener('click', this._docClickListener)
        }
      }

      _setExpanded(expanded) {
        this.setAttribute('data-expanded', expanded ? 'true' : 'false')
        const trigger = this.querySelector('[data-sai-expand-trigger]')
        if (trigger) trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false')
        const label = this.querySelector('[data-sai-expand-label]')
        if (label) {
          label.textContent = expanded
            ? this._state.labels.collapseTriggerText
            : this._state.labels.expandTriggerText
        }
        // Force a reflow before flipping classes so the grid-template-rows
        // animation actually plays — single rAF is sometimes coalesced.
        void this.offsetHeight
      }

      _setDropdownOpen(open) {
        this.setAttribute('data-dropdown-open', open ? 'true' : 'false')
        const trigger = this.querySelector('[data-sai-dropdown-trigger]')
        if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
      }

      _bindStickyInteractions() {
        const sticky = this.querySelector('[data-sai-sticky]')
        if (!sticky) return
        const price = this.querySelector('[data-sai-sticky-price]')
        const info = this.querySelector('[data-sai-sticky-info]')
        const infoBtn = this.querySelector('[data-sai-sticky-info-button]')
        const cta = this.querySelector('[data-sai-sticky-cta]')
        const trigger = this._state.config.stickyModalTrigger

        const open = () => {
          this._openModal()
          this._track(`${FEATURE_SLUG}:sticky_tap`, { trigger })
        }

        if (trigger === 'tap_price' || trigger === 'both') {
          if (info) info.addEventListener('click', open)
          if (price) price.addEventListener('click', open)
        }
        if (trigger === 'tap_info_icon' || trigger === 'both') {
          if (infoBtn) infoBtn.addEventListener('click', open)
        }
        if (cta) {
          cta.addEventListener('click', () => {
            // Combine-with-ATC: trigger the page's primary ATC if one exists.
            // Heuristic: look for [data-product-form] or form[action='/cart/add'].
            const form = document.querySelector('form[action*="/cart/add"]')
            const button = form?.querySelector('button[type="submit"], [type="submit"]')
            if (button) button.click()
            this._track(`${FEATURE_SLUG}:sticky_cta`, {})
          })
        }
      }

      _openModal() {
        const modal = this.querySelector('[data-sai-modal]')
        const close = this.querySelector('[data-sai-modal-close]')
        const content = this.querySelector('[data-sai-modal-content]')
        if (!modal || !content) return
        // Re-render the inline-callout into the modal so customers see full
        // details. The widget's own body keeps its display mode.
        content.innerHTML = ''
        const evaluated = this._lastEvaluated || evaluate(this._state)
        const unlock = this._buildUnlock(evaluated)
        if (unlock) {
          const u = document.createElement('div')
          u.className = 'sai-bkodjs1e__unlock'
          u.appendChild(unlock)
          content.appendChild(u)
        }
        const bullets = this._buildBullets(evaluated)
        if (bullets) content.appendChild(bullets)
        if (this._state.config.showAlternatives) {
          const list = document.createElement('ul')
          list.className = 'sai-bkodjs1e__alt-list'
          this._renderAlternatives(evaluated, list, true)
          content.appendChild(list)
        }

        modal.setAttribute('data-open', 'true')
        if (close && !close._bound) {
          close._bound = true
          close.addEventListener('click', () => this._closeModal())
        }
        const onKey = (event) => {
          if (event.key === 'Escape') this._closeModal()
        }
        this._modalKeyListener = onKey
        document.addEventListener('keydown', onKey)
        // Backdrop click closes.
        modal.addEventListener(
          'click',
          (event) => {
            if (event.target === modal) this._closeModal()
          },
          { once: true },
        )
      }

      _closeModal() {
        const modal = this.querySelector('[data-sai-modal]')
        if (modal) modal.setAttribute('data-open', 'false')
        if (this._modalKeyListener) {
          document.removeEventListener('keydown', this._modalKeyListener)
          this._modalKeyListener = null
        }
      }

      _bindCartSync() {
        installGlobalCartSync()
        this._cartListener = () => {
          fetchCartTotal().then((cart) => {
            if (!cart) return
            this._state.cart = cart
            // Synthesize a `currentValue` update on every potential discount
            // so re-evaluation reflects the new cart total. Per
            // StorefrontDiscount: progressMetric/currentValue/remainingValue
            // are server-computed; we approximate locally on cart change for
            // immediate feedback. The next product-sync will reconcile.
            for (const d of this._state.discounts) {
              const q = d?.qualification
              if (!q) continue
              if (q.progressMetric === 'cart_value' && cart.total != null) {
                q.currentValue = cart.total
                if (typeof q.requiredValue === 'number') {
                  q.remainingValue = Math.max(0, q.requiredValue - cart.total)
                  q.progressPercent =
                    q.requiredValue > 0 ? Math.min(100, (cart.total / q.requiredValue) * 100) : 100
                  q.isSatisfied = cart.total >= q.requiredValue
                  q.applicability = q.isSatisfied ? 'current' : 'potential'
                }
              }
              if (q.progressMetric === 'quantity' && cart.itemCount != null) {
                q.currentValue = cart.itemCount
                if (typeof q.requiredValue === 'number') {
                  q.remainingValue = Math.max(0, q.requiredValue - cart.itemCount)
                  q.progressPercent =
                    q.requiredValue > 0
                      ? Math.min(100, (cart.itemCount / q.requiredValue) * 100)
                      : 100
                  q.isSatisfied = cart.itemCount >= q.requiredValue
                  q.applicability = q.isSatisfied ? 'current' : 'potential'
                }
              }
            }
            this._playPriceAnimation()
            this._render()
          })
        }
        window.addEventListener(CART_SYNC_EVENT, this._cartListener)
      }

      _bindVariantChange() {
        // Many Shopify themes fire `variant:change` on the document. Dawn,
        // for example, emits a `change` event on `variant-radios` /
        // `variant-selects` and updates `product.selected_variant` in URL
        // search params. Cover both.
        const handler = (event) => {
          const variantId =
            event?.detail?.variant?.id ?? event?.detail?.variantId ?? event?.detail?.id
          if (variantId) this.onVariantChange(variantId)
        }
        document.addEventListener('variant:change', handler)
        document.addEventListener('product:variant-change', handler)

        // URL-driven variant change — listen to popstate as a fallback.
        window.addEventListener('popstate', () => {
          try {
            const params = new URLSearchParams(window.location.search)
            const variantId = params.get('variant')
            if (variantId) this.onVariantChange(variantId)
          } catch (_) {}
        })
      }

      _playPriceAnimation() {
        const anim = this._state.config.priceUpdateAnimation
        if (anim === 'none') return
        // Force reflow + class refresh so the keyframe restarts.
        const price = this.querySelector('[data-sai-price]')
        if (!price) return
        price.style.animation = 'none'
        void price.offsetHeight
        price.style.animation = ''
      }

      _setupCountdown(evaluated) {
        this._teardownCountdown()
        const countdownEl = this.querySelector('[data-sai-countdown]')
        const textEl = this.querySelector('[data-sai-countdown-text]')
        if (!countdownEl || !textEl) return
        if (!this._state.config.showCountdown || !evaluated.best) {
          countdownEl.hidden = true
          return
        }
        const ends = endsAtMs(evaluated.best.d)
        if (ends == null) {
          countdownEl.hidden = true
          return
        }
        countdownEl.hidden = false

        const tick = () => {
          const remaining = ends - Date.now()
          if (remaining <= 0) {
            clearInterval(this._countdownTimer)
            this._countdownTimer = null
            this._handleCountdownExpiry(evaluated.best.d)
            return
          }
          textEl.textContent = formatCountdown(
            remaining,
            this._state.config.countdownFormat,
            this._state.config.countdownShowSeconds,
          )
        }
        tick()
        this._countdownTimer = setInterval(tick, 1000)
      }

      _teardownCountdown() {
        if (this._countdownTimer) {
          clearInterval(this._countdownTimer)
          this._countdownTimer = null
        }
      }

      _handleCountdownExpiry(expiredDiscount) {
        const behavior = this._state.config.countdownExpiredBehavior
        this._track(`${FEATURE_SLUG}:countdown_expired`, {
          discount_id: expiredDiscount?.id || null,
          behavior,
        })
        switch (behavior) {
          case 'hide_widget':
            this.classList.add('sai-bkodjs1e--hidden')
            return
          case 'show_next_best': {
            // Remove the expired discount from state and re-render.
            this._state.discounts = this._state.discounts.filter((d) => d !== expiredDiscount)
            this._render()
            return
          }
          case 'show_expired_message': {
            const countdownEl = this.querySelector('[data-sai-countdown]')
            const textEl = this.querySelector('[data-sai-countdown-text]')
            if (countdownEl) countdownEl.classList.add('sai-bkodjs1e__countdown--expired')
            if (textEl) textEl.textContent = this._state.labels.expiredMessage || 'Offer ended'
            return
          }
          default:
            return
        }
      }
    }

    customElements.define(TAG, SaiBestPrice)
  }

  // ── Bind to Spectrum analytics envelope ─────────────────────────────────
  function bindAllContainers() {
    const api = window.__spectrumAi?.snippet
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )

    for (const node of containers) {
      const root = node.querySelector(TAG)
      if (!root) continue

      if (api?.bind) {
        const handles = api.bind(node, ({ currentVariantId } = {}) => {
          // Variant-resolution callback — re-evaluate against the new variant.
          if (currentVariantId && typeof root.onVariantChange === 'function') {
            root.onVariantChange(currentVariantId)
          }
        })
        if (handles && typeof root.setAnalytics === 'function') {
          root.setAnalytics(handles.track, handles.emit)
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }
})()
