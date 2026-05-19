/* =============================================================================
 * Best Price Widget (bkodjs1e) — PDP discount surface.
 *
 * Reads the JSON payload emitted by the Liquid shell, evaluates the
 * StorefrontDiscount[] list against the merchant's priority rule at the
 * selected variant's price (qty 1), and renders a dropdown pill that opens
 * a popup (modal on desktop, bottom-drawer on mobile) listing the headline
 * discount plus alternatives.
 *
 * The host is SSR-hidden. JS reveals it only when at least one discount
 * (headline OR alternative) is available for the current variant. When the
 * pool becomes empty (e.g., after a variant switch) the host hides again.
 *
 * Cart-live-sync: subscribes to Spectrum.events (cart:added / updated /
 * removed / refresh / change) plus theme-emitted DOM events. Each
 * subscription returns an unsubscribe handle that disconnectedCallback runs
 * at teardown — no global side effects on load, no fetch/XHR
 * monkey-patching, no leaks across instances. Debounced 120ms.
 *
 * Variant-aware: variants ship their per-variant discount blob in the
 * payload, so option swaps recompute instantly without a server round-trip.
 * ============================================================================= */

;(() => {
  if (window.__sai_bkodjs1e_initialized__) return
  window.__sai_bkodjs1e_initialized__ = true

  const SNIPPET_ID = 'bkodjs1e'
  const TAG = 'sai-bkodjs1e'
  // featureSlug is also exposed by the wrapper as data-spectrum-feature-slug.
  // Each instance prefers that runtime value if present; this literal is the
  // default kept in sync with meta.json's `featureSlug`.
  const FEATURE_SLUG_DEFAULT = 'best_price'
  function getFeatureSlug(host) {
    const fs = host?.getAttribute?.('data-spectrum-feature-slug')
    return fs || FEATURE_SLUG_DEFAULT
  }
  const CART_SYNC_DEBOUNCE_MS = 120

  // ── Analytics helpers ────────────────────────────────────────────────────
  function noop() {}

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
  // Discount payloads ship monetary values as decimals in store currency.
  // Product price/compareAtPrice from Shopify Liquid arrive as cents. We
  // coerce both at consumption sites.

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

  function centsToDecimal(cents) {
    if (cents == null) return null
    const n = Number(cents)
    return Number.isFinite(n) ? n / 100 : null
  }

  // ── Template interpolation ───────────────────────────────────────────────
  // Single-brace placeholders so Liquid doesn't pre-interpolate them at
  // template render time.

  function fillTemplate(tpl, vars) {
    if (!tpl) return ''
    return String(tpl)
      .replace(/\{(\w+)\}/g, (_match, key) => {
        const v = vars[key]
        return v == null || v === '' ? '' : String(v)
      })
      .replace(/\s+/g, ' ')
      .trim()
  }

  // ── Discount evaluation ──────────────────────────────────────────────────
  // StorefrontDiscount carries:
  //   qualification.applicability ∈ 'current' | 'potential' | 'never'
  //   qualification.isSatisfied / progressMetric / progressPercent
  //   qualification.remainingValue / requiredValue / currentValue
  //   applicationType ∈ 'manual' | 'automatic'
  //   discountValue.{ type, amount, percentage, currencyCode }
  //   visibilityConfig — used for expiry windows
  //
  // None of the fields are individually required — absent fields are treated
  // as the permissive option (no visibilityConfig means no expiry window).

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

  // Savings vs the product's regular price at qty 1. Returns absolute (store
  // currency decimal) and percentage. Returns null for FREE_SHIPPING or
  // DISCOUNTED_QUANTITY without a per-item effect.
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

  function filterByVisibility(discounts) {
    const now = Date.now()
    return discounts.filter((d) => {
      if (applicability(d) === 'never') return false
      const ends = endsAtMs(d)
      if (ends != null && ends <= now) return false
      const starts = startsAtMs(d)
      if (starts != null && starts > now) return false
      return true
    })
  }

  // Sort a list of {d, signals...} entries by the merchant's chosen rule.
  // `applicability` prefers current over potential, then highest savings.
  // `highest_savings` prefers absolute savings regardless of applicability.
  // `easiest_to_unlock` prefers the smallest unlock gap (current discounts
  // count as zero gap).
  function sortBy(entries, rule) {
    const list = [...entries]
    switch (rule) {
      case 'highest_savings':
        list.sort((a, b) => b.savingsAbs - a.savingsAbs)
        break
      case 'easiest_to_unlock':
        list.sort((a, b) => a.unlockGap - b.unlockGap || b.savingsAbs - a.savingsAbs)
        break
      default:
        // applicability (default)
        list.sort(
          (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.savingsAbs - a.savingsAbs,
        )
    }
    return list
  }

  function annotate(discounts, productPriceDecimal) {
    return discounts.map((d) => {
      const s = savingsAtQty1(d, productPriceDecimal)
      const gap = thresholdGap(d)
      const isCurrent = applicability(d) === 'current'
      return {
        d,
        savingsAbs: s?.absolute ?? 0,
        savingsPct: s?.percentage ?? 0,
        // current discounts have no "gap" — set to 0 so they sort first when
        // ranking by easiest_to_unlock.
        unlockGap: isCurrent ? 0 : (gap ?? Number.POSITIVE_INFINITY),
        isCurrent,
      }
    })
  }

  function evaluate(state) {
    const productPrice = centsToDecimal(state.product.price)
    const visible = filterByVisibility(state.discounts)
    const annotated = annotate(visible, productPrice)
    const sortedForBest = sortBy(annotated, state.config.priorityLogic)
    const best = sortedForBest[0] || null

    let alternatives = []
    if (best) {
      const others = annotated.filter((x) => x.d !== best.d)
      const sortRule = state.config.dropdownSortBy || state.config.priorityLogic
      const ranked = sortBy(others, sortRule)
      const cap = Math.max(0, Math.min(Number(state.config.maxAlternatives) || 0, 50))
      alternatives = ranked.slice(0, cap)
    }

    return { best, alternatives, productPrice }
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
        this._cartUnsubs = null

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
        this._variantsById = new Map()
        for (const v of payload.product.variants || []) {
          this._variantsById.set(String(v.id), v)
        }
        this._currentVariantId = String(payload.product.currentVariantId)

        this._render()
        this._bindDropdownInteractions()
        this._bindCartSync()
        this._bindVariantChange()
      }

      disconnectedCallback() {
        this._teardownCountdown()
        if (Array.isArray(this._cartUnsubs)) {
          for (const off of this._cartUnsubs) {
            try {
              off()
            } catch (_) {
              /* listener already gone */
            }
          }
          this._cartUnsubs = null
        }
        // Close any open popup we own + restore body overflow if we set it.
        if (typeof this._closeOpenPopup === 'function') this._closeOpenPopup()
      }

      setAnalytics(track, emit) {
        this._track = typeof track === 'function' ? safe(track) : noop
        this._emit = typeof emit === 'function' ? safe(emit) : noop
      }

      onVariantChange(variantId) {
        if (!variantId) return
        const next = this._variantsById.get(String(variantId))
        if (!next) return
        const previousVariantId = this._currentVariantId
        this._currentVariantId = String(variantId)
        // Variant-scoped discounts override product-level when present.
        if (next.discounts) {
          this._state.discounts = this._extractDiscounts(next.discounts)
        }
        this._state.product.price = next.price
        this._state.product.compareAtPrice = next.compareAtPrice
        this._render()
        const evaluated = this._lastEvaluated
        this._track(`${getFeatureSlug(this)}:variant_change`, {
          variant_id: String(variantId),
          previous_variant_id: previousVariantId,
          headline_discount_id: evaluated?.best?.d?.id ?? null,
          discount_count: this._state.discounts.length,
        })
      }

      _readPayload() {
        const node = this.querySelector('script[type="application/json"][data-sai-payload]')
        if (!node) return null
        try {
          return JSON.parse(node.textContent || '{}')
        } catch (err) {
          console.warn('[bkodjs1e] failed to parse payload:', err)
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
        const evaluated = evaluate(this._state)
        this._lastEvaluated = evaluated

        // Hide widget entirely when there is no headline AND no alternative.
        // Per the PDP refactor brief: "when no bestprice alternative is
        // available drop the widget for all."
        const hasContent = !!evaluated.best || evaluated.alternatives.length > 0
        if (!hasContent) {
          this.hidden = true
          this._teardownCountdown()
          return
        }
        this.hidden = false

        const calloutLabel = this.querySelector('[data-sai-callout-label]')
        if (calloutLabel) {
          calloutLabel.textContent = this._buildCalloutText(evaluated)
        }
        this._setupCountdown(evaluated)
      }

      _buildCalloutText(evaluated) {
        if (!evaluated.best) return this._state.labels.bestPricePrefix || 'Best offer'
        const money = this._moneyFn()
        const productPrice = centsToDecimal(this._state.product.price)
        const finalPrice = discountedPrice(evaluated.best.d, productPrice)
        return `Get it at ${money(finalPrice)}`
      }

      _bindDropdownInteractions() {
        const triggerBtn = this.querySelector('[data-sai-popup-trigger]')
        if (!triggerBtn) return
        triggerBtn.addEventListener('click', () => {
          this._openDropdownPopup(this._lastEvaluated || evaluate(this._state))
        })
      }

      _openDropdownPopup(evaluated) {
        if (!evaluated || (!evaluated.best && evaluated.alternatives.length === 0)) return
        const money = this._moneyFn()
        const productPrice = centsToDecimal(this._state.product.price)
        const labels = this._state.labels

        const previouslyFocused =
          document.activeElement instanceof HTMLElement ? document.activeElement : null

        // Mobile = bottom-anchored drawer, desktop = centered modal.
        // matchMedia evaluated per-open so a resized window picks the right
        // surface every time.
        const isMobile = !window.matchMedia('(min-width: 768px)').matches

        const root = document.createElement('div')
        root.className = 'sai-bkodjs1e-popup'
        root.setAttribute('role', 'dialog')
        root.setAttribute('aria-modal', 'true')
        root.setAttribute('aria-labelledby', 'sai-bkodjs1e-popup-title')
        root.setAttribute('data-state', 'closed')
        root.setAttribute('data-surface', isMobile ? 'drawer' : 'modal')

        const TAG_SVG =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><circle cx="9.5" cy="9.5" r=".75" fill="currentColor"/><circle cx="14.5" cy="14.5" r=".75" fill="currentColor"/></svg>'

        const panelClass = `sai-bkodjs1e-popup__panel sai-bkodjs1e-popup__panel--${isMobile ? 'drawer' : 'modal'}`
        const handleHtml = isMobile
          ? '<div class="sai-bkodjs1e-popup__handle" aria-hidden="true"></div>'
          : ''
        const highlightText = evaluated.best
          ? this._buildCalloutText(evaluated)
          : labels.bestPricePrefix || 'Best offers'

        root.innerHTML = `
          <div class="sai-bkodjs1e-popup__backdrop" data-sai-popup-dismiss></div>
          <div class="${panelClass}" data-sai-popup-panel>
            ${handleHtml}
            <div class="sai-bkodjs1e-popup__header">
              <span class="sai-bkodjs1e-popup__title" id="sai-bkodjs1e-popup-title">${String(labels.heading || 'Best offers').toUpperCase()}</span>
              <button type="button" class="sai-bkodjs1e-popup__close" aria-label="Close" data-sai-popup-dismiss>&times;</button>
            </div>
            <div class="sai-bkodjs1e-popup__highlight">
              <span class="sai-bkodjs1e__callout-icon">${TAG_SVG.replace('<svg ', '<svg class="sai-bkodjs1e__callout-icon" ')}</span>
              <span>${highlightText}</span>
            </div>
            <div class="sai-bkodjs1e-popup__body" data-sai-popup-body></div>
          </div>
        `

        const body = root.querySelector('[data-sai-popup-body]')
        if (evaluated.best) {
          body.appendChild(
            this._buildPopupSection(evaluated.best.d, productPrice, money, /* primary */ true),
          )
        }

        if (this._state.config.showAlternatives && evaluated.alternatives.length > 0) {
          const divider = document.createElement('div')
          divider.className = 'sai-bkodjs1e-popup__divider'
          divider.innerHTML = `<span class="sai-bkodjs1e-popup__divider-icon">${TAG_SVG.replace('<svg ', '<svg class="sai-bkodjs1e-popup__divider-icon" ')}</span><span>Other Offers</span>`
          body.appendChild(divider)
          for (const item of evaluated.alternatives.slice(
            0,
            this._state.config.dropdownMaxItems || 5,
          )) {
            body.appendChild(this._buildPopupSection(item.d, productPrice, money, false))
          }
        }

        // Mount popup as a child of the instance host so per-instance baked
        // styles can still reach it, and so disconnectedCallback can tear
        // it down by detaching the host subtree.
        this.appendChild(root)
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        // matchMedia change listener — rotation between viewport sizes
        // mid-open swaps drawer ↔ modal surface.
        const mq = window.matchMedia('(min-width: 768px)')
        const onMq = () => {
          const nowMobile = !mq.matches
          root.setAttribute('data-surface', nowMobile ? 'drawer' : 'modal')
          const panel = root.querySelector('[data-sai-popup-panel]')
          if (panel) {
            panel.className = `sai-bkodjs1e-popup__panel sai-bkodjs1e-popup__panel--${nowMobile ? 'drawer' : 'modal'}`
          }
        }
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq)
        else mq.addListener(onMq)

        const close = () => {
          if (root.getAttribute('data-state') === 'closed') return
          root.setAttribute('data-state', 'closed')
          const cleanup = () => {
            document.removeEventListener('keydown', onKey, true)
            if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onMq)
            else mq.removeListener(onMq)
            if (root.parentNode) root.parentNode.removeChild(root)
            document.body.style.overflow = prevOverflow
            if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus()
            if (this._closeOpenPopup === close) this._closeOpenPopup = null
          }
          const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          if (reduced) cleanup()
          else setTimeout(cleanup, 240)
        }
        this._closeOpenPopup = close

        // Focus trap — Tab cycles between focusable nodes inside the panel.
        const onKey = (e) => {
          if (e.key === 'Escape') {
            close()
            return
          }
          if (e.key !== 'Tab') return
          const focusables = root.querySelectorAll(
            'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), [role="button"]',
          )
          if (focusables.length === 0) {
            e.preventDefault()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement
          if (e.shiftKey && active === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && active === last) {
            e.preventDefault()
            first.focus()
          }
        }
        root.addEventListener('click', (e) => {
          const t = e.target
          if (t instanceof Element && t.closest('[data-sai-popup-dismiss]')) {
            e.preventDefault()
            close()
          }
        })
        document.addEventListener('keydown', onKey, true)

        // Wire copy chips inside the popup. The whole code-row is a
        // role="button" — click + Enter/Space activate. Swap the clipboard
        // icon to a checkmark on success for ~1.5s.
        const featureSlug = getFeatureSlug(this)
        const track = this._track
        async function doCopy(btn) {
          const code = btn.getAttribute('data-sai-popup-copy') || ''
          if (!code) return
          let ok = false
          try {
            await navigator.clipboard.writeText(code)
            ok = true
          } catch (_) {
            try {
              const tmp = document.createElement('textarea')
              tmp.value = code
              tmp.style.position = 'absolute'
              tmp.style.left = '-9999px'
              document.body.appendChild(tmp)
              tmp.select()
              ok = document.execCommand('copy')
              document.body.removeChild(tmp)
            } catch (__) {
              /* swallow */
            }
          }
          track(`${featureSlug}:copy_code`, { discount_code: code, copied: ok })
          if (!ok) return
          btn.setAttribute('aria-pressed', 'true')
          const copyIcon = btn.querySelector('.sai-bkodjs1e-popup__copy-icon--copy')
          const okIcon = btn.querySelector('.sai-bkodjs1e-popup__copy-icon--ok')
          if (copyIcon) copyIcon.style.display = 'none'
          if (okIcon) okIcon.style.display = ''
          setTimeout(() => {
            btn.setAttribute('aria-pressed', 'false')
            if (copyIcon) copyIcon.style.display = ''
            if (okIcon) okIcon.style.display = 'none'
          }, 1500)
        }
        root.addEventListener('click', (e) => {
          const t = e.target
          if (!(t instanceof Element)) return
          const btn = t.closest('[data-sai-popup-copy]')
          if (!btn) return
          doCopy(btn)
        })
        root.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          const t = e.target
          if (!(t instanceof Element)) return
          const btn = t.closest('[data-sai-popup-copy]')
          if (!btn) return
          e.preventDefault()
          doCopy(btn)
        })

        // Force reflow + double rAF so the transition has a clean from-state.
        void root.offsetHeight
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            root.setAttribute('data-state', 'open')
            const firstFocusable = root.querySelector(
              'button, [href], [tabindex]:not([tabindex="-1"])',
            )
            if (firstFocusable instanceof HTMLElement) firstFocusable.focus()
          }),
        )

        const headlineCode = evaluated.best ? extractCode(evaluated.best.d) : null
        this._track(`${featureSlug}:popup_opened`, {
          surface: isMobile ? 'drawer' : 'modal',
          discount_id: evaluated.best?.d?.id || null,
          discount_code: headlineCode,
          alternatives_count: evaluated.alternatives.length,
        })
      }

      _buildPopupSection(d, productPrice, money, isPrimary) {
        const section = document.createElement('div')
        section.className = `sai-bkodjs1e-popup__section${isPrimary ? ' sai-bkodjs1e-popup__section--primary' : ''}`

        const config = this._state.config
        const labels = this._state.labels

        // Discount name (configurable). The prefix is rendered inline so the
        // line reads "with WELCOME50" when the merchant sets it.
        if (config.showDiscountName) {
          const name = d?.shortSummary || d?.title
          if (name) {
            const p = document.createElement('p')
            p.className = 'sai-bkodjs1e-popup__name'
            const prefix = labels.discountNamePrefix
            p.textContent = prefix ? `${prefix} ${name}` : name
            section.appendChild(p)
          }
        }

        // Summary description — split on " • " separator that Shopify uses
        // to cram multiple facts onto one line.
        if (d.summary || d.shortSummary) {
          const raw = d.summary || d.shortSummary
          const parts = String(raw)
            .split(/\s*•\s*/)
            .map((s) => s.trim())
            .filter(Boolean)
          if (parts.length > 1) {
            const ul = document.createElement('ul')
            ul.className = 'sai-bkodjs1e-popup__desc-list'
            for (const part of parts) {
              const li = document.createElement('li')
              li.className = 'sai-bkodjs1e-popup__desc-item'
              li.textContent = part
              ul.appendChild(li)
            }
            section.appendChild(ul)
          } else {
            const p = document.createElement('p')
            p.className = 'sai-bkodjs1e-popup__desc'
            p.textContent = raw
            section.appendChild(p)
          }
        }

        // Unlock message — for potential discounts, show "Spend X more to
        // unlock". For current ones, show "Applicable on: …".
        if (config.showUnlockMessage) {
          const isCurrent = applicability(d) === 'current'
          const vars = {
            amount: this._formatRemainingMoney(d, money),
            quantity: this._formatRemainingQty(d),
            discount_name: d?.shortSummary || d?.title || '',
            description: d?.summary || '',
          }
          const tpl = isCurrent ? labels.applicableTemplate : labels.unlockTemplate
          const text = fillTemplate(tpl, vars)
          if (text) {
            const p = document.createElement('p')
            p.className = 'sai-bkodjs1e-popup__unlock'
            p.textContent = text
            section.appendChild(p)
          }
        }

        // Savings delta — only when the discount actually saves money at
        // qty 1. Format respects the merchant's chosen mode.
        if (config.showSavingsDelta) {
          const saving = savingsAtQty1(d, productPrice)
          if (saving && saving.absolute > 0) {
            const pct = Math.round(saving.percentage)
            const p = document.createElement('p')
            p.className = 'sai-bkodjs1e-popup__saving'
            let valueHtml
            if (config.savingsDeltaFormat === 'percentage') {
              valueHtml = `<span class="sai-bkodjs1e-popup__saving-amount">${pct}% off</span>`
            } else if (config.savingsDeltaFormat === 'absolute') {
              valueHtml = `<span class="sai-bkodjs1e-popup__saving-amount">${money(saving.absolute)}</span>`
            } else {
              valueHtml = `<span class="sai-bkodjs1e-popup__saving-amount">${money(saving.absolute)} (${pct}% off)</span>`
            }
            p.innerHTML = `You Save ${valueHtml}`
            section.appendChild(p)
          }
        }

        const code = extractCode(d)
        if (code) {
          // Coupon "tear line" — dashed horizontal perforation above the
          // code chip.
          const perf = document.createElement('div')
          perf.className = 'sai-bkodjs1e-popup__perforation'
          perf.setAttribute('aria-hidden', 'true')
          section.appendChild(perf)

          const row = document.createElement('div')
          row.className = 'sai-bkodjs1e-popup__code-row'
          row.setAttribute('data-sai-popup-copy', code)
          row.setAttribute('role', 'button')
          row.setAttribute('tabindex', '0')
          row.setAttribute('aria-label', `Copy code ${code}`)
          row.setAttribute('aria-pressed', 'false')
          row.innerHTML = `
            <span class="sai-bkodjs1e-popup__code">${code}</span>
            <span class="sai-bkodjs1e-popup__copy" aria-hidden="true">
              <svg class="sai-bkodjs1e-popup__copy-icon sai-bkodjs1e-popup__copy-icon--copy" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="4" y="4" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
                <path d="M3 11.5V3.5A1.5 1.5 0 0 1 4.5 2H11" fill="none" stroke="currentColor" stroke-width="1.4"/>
              </svg>
              <svg class="sai-bkodjs1e-popup__copy-icon sai-bkodjs1e-popup__copy-icon--ok" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="display:none">
                <path d="m3 8 3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
          `
          section.appendChild(row)
        }
        return section
      }

      _formatRemainingMoney(d, money) {
        const q = d?.qualification
        if (!q) return ''
        const metric = q.progressMetric
        const remaining = Number(q.remainingValue)
        if (!Number.isFinite(remaining)) return ''
        if (metric === 'cart_value' || metric === 'subtotal') return money(remaining)
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

      _bindCartSync() {
        const handler = debounce(() => {
          fetchCartTotal().then((cart) => {
            if (!cart) return
            const previousCart = this._state.cart
            this._state.cart = cart
            // Snapshot applicability before the local recompute so we can
            // detect flips and emit cart_change with the diff.
            const flips = []
            // Synthesize a currentValue update on every potential discount
            // so re-evaluation reflects the new cart total. Per
            // StorefrontDiscount: progressMetric / currentValue /
            // remainingValue are server-computed; we approximate locally on
            // cart change for immediate feedback. The next product-sync
            // reconciles.
            for (const d of this._state.discounts) {
              const q = d?.qualification
              if (!q) continue
              const before = q.applicability
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
              if (before !== q.applicability) {
                flips.push({ discount_id: d?.id ?? null, from: before, to: q.applicability })
              }
            }
            this._render()
            this._track(`${getFeatureSlug(this)}:cart_change`, {
              cart_subtotal: cart.total,
              previous_cart_subtotal: previousCart?.total ?? null,
              item_count: cart.itemCount,
              applicability_flips: flips,
            })
          })
        }, CART_SYNC_DEBOUNCE_MS)

        this._cartUnsubs = []

        try {
          const evs = window.Spectrum?.events
          if (evs && typeof evs.on === 'function') {
            for (const name of [
              'cart:added',
              'cart:updated',
              'cart:removed',
              'cart:refresh',
              'cart:change',
            ]) {
              const off = evs.on(name, handler)
              if (typeof off === 'function') this._cartUnsubs.push(off)
            }
          }
        } catch (err) {
          console.warn('[bkodjs1e] Spectrum.events subscribe failed:', err)
        }

        // Theme-emitted DOM events (Dawn / Horizon / custom themes).
        const docEvents = ['cart:updated', 'cart:refresh', 'cart:change', 'cart:item-added']
        for (const evt of docEvents) {
          document.addEventListener(evt, handler)
          this._cartUnsubs.push(() => document.removeEventListener(evt, handler))
        }
      }

      _bindVariantChange() {
        const handler = (event) => {
          const variantId =
            event?.detail?.variant?.id ?? event?.detail?.variantId ?? event?.detail?.id
          if (variantId) this.onVariantChange(variantId)
        }
        document.addEventListener('variant:change', handler)
        document.addEventListener('product:variant-change', handler)
        this._cartUnsubs?.push(() => document.removeEventListener('variant:change', handler))
        this._cartUnsubs?.push(() =>
          document.removeEventListener('product:variant-change', handler),
        )

        const popstate = () => {
          try {
            const params = new URLSearchParams(window.location.search)
            const variantId = params.get('variant')
            if (variantId) this.onVariantChange(variantId)
          } catch (_) {
            /* malformed URL */
          }
        }
        window.addEventListener('popstate', popstate)
        this._cartUnsubs?.push(() => window.removeEventListener('popstate', popstate))
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
        this._track(`${getFeatureSlug(this)}:countdown_expired`, {
          discount_id: expiredDiscount?.id || null,
          behavior,
        })
        switch (behavior) {
          case 'hide_widget':
            this.hidden = true
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

  function extractCode(d) {
    if (!d || !Array.isArray(d.codes) || d.codes.length === 0) return null
    const first = d.codes[0]
    if (typeof first === 'string') return first
    return first?.code || null
  }

  // ── Bind to Spectrum analytics envelope ─────────────────────────────────
  function bindContainer(node) {
    const api = window.__spectrumAi?.snippet
    const root = node.querySelector(TAG)
    if (!root) return
    if (api?.bind) {
      const handles = api.bind(node, ({ currentVariantId } = {}) => {
        if (currentVariantId && typeof root.onVariantChange === 'function') {
          root.onVariantChange(currentVariantId)
        }
      })
      if (handles && typeof root.setAnalytics === 'function') {
        root.setAnalytics(handles.track, handles.emit)
      }
    }
  }

  // Snippet library JS contract: read data-spectrum-vis before any meaningful
  // work. Live wrappers SSR with vis="off" — bootstrap flips to "on" only
  // when the owning experience wins targeting + conflict resolution. Draft
  // (editor preview) wrappers SSR with vis="on".
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
