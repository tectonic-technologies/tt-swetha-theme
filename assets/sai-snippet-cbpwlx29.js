/* =============================================================================
 * Best Applicable Coupons Widget (cbpwlx29) — cart drawer + cart page runtime.
 *
 * Reads the SSR JSON payload (data-sai-payload): union of every cart line
 * item's spectrum.discounts metafield plus live cart total / applied codes.
 * Recomputes qualification against the live cart, applies the fixed state
 * hierarchy Applied > Applicable > Potentially Applicable, sorts within tier,
 * then renders either a single best coupon or a stack of up to N.
 *
 * Cart-aware: patches window.fetch + XMLHttpRequest once per page so cart
 * mutations trigger a re-read of /cart.js and a re-render.
 *
 * Apply / Remove: uses Shopify's /discount/{code} navigation. Apply navigates
 * to /discount/{code}?redirect=/cart; remove navigates to /discount/?redirect=/cart.
 * Auto-apply runs once per session (session-storage guard).
 *
 * Visibility scope: cart_drawer_only / cart_page_only / both. Page detection
 * via data-template-name; drawer detection via DOM ancestor lookup.
 * ============================================================================= */

;(() => {
  if (window.__sai_cbpwlx29_initialized__) return
  window.__sai_cbpwlx29_initialized__ = true

  const SNIPPET_ID = 'cbpwlx29'
  const TAG = 'sai-cbpwlx29'
  const FEATURE_SLUG = 'cart_coupons'
  const CART_SYNC_DEBOUNCE_MS = 120
  const CART_MUTATION_PATHS = ['/cart/add', '/cart/change', '/cart/update', '/cart/clear']
  const CART_SYNC_EVENT = '__sai_cbpwlx29_cart_changed__'
  const AUTO_APPLY_SESSION_KEY = '__sai_cbpwlx29_auto_apply__'
  const SESSION_TIMER_KEY = '__sai_cbpwlx29_session_timer__'

  function noop() {}
  function safeFn(fn) {
    return (name, payload) => {
      try { fn(name, payload) } catch (_) { /* analytics best-effort */ }
    }
  }

  function debounce(fn, ms) {
    let t = null
    return (...args) => {
      if (t) clearTimeout(t)
      t = setTimeout(() => fn(...args), ms)
    }
  }

  // ── Currency formatting ───────────────────────────────────────────────
  function moneyFormatter(currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode || 'USD',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 2,
      })
    } catch (_) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode || 'USD' })
      } catch (_) {
        return { format: (n) => `${currencyCode || '$'}${Number(n).toFixed(2)}` }
      }
    }
  }

  // ── Template interpolation ────────────────────────────────────────────
  function fillTemplate(tpl, vars) {
    if (!tpl) return ''
    let out = String(tpl)
    for (const k of Object.keys(vars)) {
      out = out.split(`{${k}}`).join(vars[k] == null ? '' : String(vars[k]))
    }
    return out
  }

  // ── DOM helpers ───────────────────────────────────────────────────────
  function el(tag, className, attrs) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k]
        if (v === null || v === undefined || v === false) continue
        if (k === 'text') node.textContent = v
        else if (v === true) node.setAttribute(k, '')
        else node.setAttribute(k, String(v))
      }
    }
    return node
  }

  // ── Discount evaluation ───────────────────────────────────────────────
  function isApplied(d, appliedCodes) {
    if (!d || !appliedCodes || appliedCodes.length === 0) return false
    const codes = Array.isArray(d.codes) ? d.codes : []
    for (const raw of codes) {
      const code = typeof raw === 'string' ? raw : raw && raw.code
      if (code && appliedCodes.includes(String(code).toUpperCase())) return true
    }
    return false
  }

  function applicability(d) {
    return (d && d.qualification && d.qualification.applicability) || 'never'
  }

  function isApplicable(d) {
    const q = (d && d.qualification) || {}
    return q.isSatisfied === true || q.applicability === 'current'
  }

  function isPotential(d) {
    return !isApplicable(d) && applicability(d) === 'potential'
  }

  // Automatic discounts (free shipping, auto-merchant promos) attach at
  // checkout without a code. Treat them as "applied" once qualified so the
  // widget shows a ✓ Applied tick instead of an Apply / Remove control.
  function isAutoApplied(d) {
    return d && d.applicationType === 'automatic' && isApplicable(d)
  }

  function getCode(d) {
    if (!d || !Array.isArray(d.codes) || d.codes.length === 0) return null
    const raw = d.codes[0]
    return typeof raw === 'string' ? raw : (raw && raw.code) || null
  }

  function endsAtMs(d) {
    const vc = d && d.visibilityConfig
    const raw = (vc && (vc.endsAt || vc.endDate)) || (d && d.endsAt)
    if (!raw) return null
    const t = typeof raw === 'number' ? raw : Date.parse(raw)
    return Number.isFinite(t) ? t : null
  }

  // Savings at the live cart subtotal. Always projected from discountValue —
  // matchedSubtotalAmount is the cart subtotal the discount qualified against,
  // not the savings amount, so it can't be used here.
  function savingsAtCart(d, cartTotal) {
    if (!d) return 0
    const dv = d.discountValue
    if (!dv) return 0
    switch (dv.type) {
      case 'PERCENTAGE': {
        const pct = Number(dv.percentage)
        if (!Number.isFinite(pct) || !Number.isFinite(cartTotal)) return 0
        return (cartTotal * pct) / 100
      }
      case 'FIXED': {
        const amt = Number(dv.amount)
        if (!Number.isFinite(amt)) return 0
        return Math.min(amt, Number(cartTotal) || amt)
      }
      case 'FREE_SHIPPING':
        return 0
      default:
        return 0
    }
  }

  function savingsPct(d, cartTotal, abs) {
    const dv = d && d.discountValue
    if (dv && dv.type === 'PERCENTAGE' && Number.isFinite(Number(dv.percentage))) return Number(dv.percentage)
    if (!Number.isFinite(cartTotal) || cartTotal <= 0) return 0
    return (abs / cartTotal) * 100
  }

  function thresholdGap(d) {
    const q = d && d.qualification
    if (!q) return null
    const r = Number(q.remainingValue)
    return Number.isFinite(r) ? r : null
  }

  function thresholdRequired(d) {
    const q = d && d.qualification
    if (!q) return null
    const r = Number(q.requiredValue)
    return Number.isFinite(r) ? r : null
  }

  function recomputeAgainstCart(d, cart) {
    const q = d && d.qualification
    if (!q) return d
    const out = Object.assign({}, d, { qualification: Object.assign({}, q) })
    const oq = out.qualification
    const metric = oq.progressMetric
    if (metric === 'cart_value' && Number.isFinite(cart.totalPrice)) {
      oq.currentValue = cart.totalPrice
      if (Number.isFinite(Number(oq.requiredValue))) {
        oq.remainingValue = Math.max(0, oq.requiredValue - cart.totalPrice)
        oq.progressPercent = oq.requiredValue > 0
          ? Math.min(100, (cart.totalPrice / oq.requiredValue) * 100)
          : 100
        oq.isSatisfied = cart.totalPrice >= oq.requiredValue
        oq.applicability = oq.isSatisfied ? 'current' : 'potential'
      }
    } else if (metric === 'quantity' && Number.isFinite(cart.itemCount)) {
      oq.currentValue = cart.itemCount
      if (Number.isFinite(Number(oq.requiredValue))) {
        oq.remainingValue = Math.max(0, oq.requiredValue - cart.itemCount)
        oq.progressPercent = oq.requiredValue > 0
          ? Math.min(100, (cart.itemCount / oq.requiredValue) * 100)
          : 100
        oq.isSatisfied = cart.itemCount >= oq.requiredValue
        oq.applicability = oq.isSatisfied ? 'current' : 'potential'
      }
    }
    return out
  }

  // ── Within-tier sort ──────────────────────────────────────────────────
  function withinTierComparator(sort, cartTotal) {
    switch (sort) {
      case 'expiry_soonest':
        return (a, b) => {
          const ax = endsAtMs(a) || Number.POSITIVE_INFINITY
          const bx = endsAtMs(b) || Number.POSITIVE_INFINITY
          return ax - bx
        }
      case 'alphabetical':
        return (a, b) => String(getCode(a) || '').localeCompare(String(getCode(b) || ''))
      default:
        return (a, b) => savingsAtCart(b, cartTotal) - savingsAtCart(a, cartTotal)
    }
  }

  // ── State hierarchy ───────────────────────────────────────────────────
  // Fixed: Applied > Applicable > Potentially applicable. Sort within each
  // tier per config.withinTierSort. `current` is the broad applicability bin;
  // we narrow to applied/applicable by intersecting with cart.appliedDiscountCodes.
  function buildOrderedList(discounts, appliedCodes, cartTotal, sort) {
    const cmp = withinTierComparator(sort, cartTotal)
    const applied = []
    const applicable = []
    const potential = []
    for (const d of discounts) {
      if (isApplied(d, appliedCodes)) applied.push(d)
      else if (isApplicable(d)) applicable.push(d)
      else if (isPotential(d)) potential.push(d)
    }
    applied.sort(cmp)
    applicable.sort(cmp)
    potential.sort(cmp)
    return [...applied, ...applicable, ...potential]
  }

  // ── Dedupe by discount id (union across cart line items) ──────────────
  function dedupeDiscounts(byVariant) {
    const seen = new Map()
    for (const variantId of Object.keys(byVariant)) {
      const blob = byVariant[variantId]
      const list = Array.isArray(blob) ? blob : (blob && Array.isArray(blob.discounts) ? blob.discounts : [])
      for (const d of list) {
        if (!d || !d.id) continue
        if (!seen.has(d.id)) seen.set(d.id, d)
      }
    }
    return Array.from(seen.values())
  }

  // ── Visibility scope ──────────────────────────────────────────────────
  function isCartPage(templateName) {
    return typeof templateName === 'string' && templateName.indexOf('cart') === 0
  }

  function isInCartDrawer(host) {
    let node = host.parentElement
    let depth = 0
    while (node && depth < 12) {
      const cls = node.className || ''
      const id = node.id || ''
      const tag = node.tagName ? node.tagName.toLowerCase() : ''
      if (
        tag === 'cart-drawer' ||
        tag === 'cart-notification' ||
        id.toLowerCase().indexOf('cart-drawer') !== -1 ||
        (typeof cls === 'string' && (
          cls.indexOf('cart-drawer') !== -1 ||
          cls.indexOf('drawer') !== -1 ||
          cls.indexOf('mini-cart') !== -1
        ))
      ) return true
      node = node.parentElement
      depth++
    }
    return false
  }

  function passesVisibilityScope(host, templateName, scope) {
    const onCartPage = isCartPage(templateName)
    const inDrawer = isInCartDrawer(host)
    if (scope === 'cart_page_only') return onCartPage && !inDrawer
    if (scope === 'cart_drawer_only') return inDrawer
    return onCartPage || inDrawer
  }

  // ── Apply / Remove via /discount nav ─────────────────────────────────
  function discountApplyUrl(code, redirect) {
    const r = redirect || (window.location.pathname.indexOf('/cart') === 0 ? '/cart' : window.location.pathname)
    return `/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(r)}`
  }

  // No standard Shopify GET route for "clear discount" — `/discount/` 404s on
  // most themes. The reliable cross-theme path is POST /cart/update.js with
  // `discount: ''`, then full-reload /cart so the SSR'd cart re-renders
  // without the applied code.
  async function clearDiscount() {
    try {
      await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ discount: '' }),
        credentials: 'same-origin',
      })
    } catch (_) { /* swallow — reload still happens */ }
    window.location.href = '/cart'
  }

  // ── Countdown ────────────────────────────────────────────────────────
  function pad2(n) { return n < 10 ? `0${n}` : String(n) }

  function formatCountdown(remainingMs, showSeconds) {
    if (remainingMs <= 0) return '0s'
    const total = Math.floor(remainingMs / 1000)
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    if (days > 0) {
      return showSeconds
        ? `${days}d ${pad2(hours)}h : ${pad2(minutes)}m : ${pad2(seconds)}s`
        : `${days}d ${pad2(hours)}h : ${pad2(minutes)}m`
    }
    if (hours > 0) {
      return showSeconds
        ? `${pad2(hours)}h : ${pad2(minutes)}m : ${pad2(seconds)}s`
        : `${pad2(hours)}h : ${pad2(minutes)}m`
    }
    return showSeconds ? `${minutes}m : ${pad2(seconds)}s` : `${minutes}m`
  }

  // Session-window timer: persists start time in sessionStorage so a refresh
  // doesn't reset the urgency clock.
  function sessionWindowEndsAt(durationMinutes) {
    try {
      const existing = window.sessionStorage.getItem(SESSION_TIMER_KEY)
      const now = Date.now()
      const durationMs = Math.max(0, Number(durationMinutes) || 0) * 60 * 1000
      if (existing) {
        const ends = Number(existing)
        if (Number.isFinite(ends) && ends > now) return ends
      }
      const ends = now + durationMs
      window.sessionStorage.setItem(SESSION_TIMER_KEY, String(ends))
      return ends
    } catch (_) {
      return Date.now() + (Number(durationMinutes) || 0) * 60 * 1000
    }
  }

  // ── Cart-live-sync (shared global patch) ─────────────────────────────
  function installGlobalCartSync() {
    if (window.__sai_cbpwlx29_cart_patched__) return
    window.__sai_cbpwlx29_cart_patched__ = true

    const fire = debounce(() => {
      window.dispatchEvent(new CustomEvent(CART_SYNC_EVENT))
    }, CART_SYNC_DEBOUNCE_MS)

    const origFetch = window.fetch
    if (typeof origFetch === 'function') {
      window.fetch = function patched(input, ...rest) {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const isMutation = CART_MUTATION_PATHS.some((p) => url.indexOf(p) !== -1)
        const result = origFetch.call(this, input, ...rest)
        if (isMutation) result.then(() => fire()).catch(() => {})
        return result
      }
    }

    if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
      const origOpen = XMLHttpRequest.prototype.open
      const origSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
        this.__saiCbpwlx29Url = url
        return origOpen.call(this, method, url, ...rest)
      }
      XMLHttpRequest.prototype.send = function patchedSend(...rest) {
        const url = this.__saiCbpwlx29Url || ''
        const isMutation = CART_MUTATION_PATHS.some((p) => String(url).indexOf(p) !== -1)
        if (isMutation) this.addEventListener('load', () => fire())
        return origSend.call(this, ...rest)
      }
    }

    const events = ['cart:updated', 'cart:refresh', 'cart:change', 'cart:item-added']
    for (const evt of events) document.addEventListener(evt, fire)
  }

  async function fetchCart() {
    try {
      const res = await fetch('/cart.js', { credentials: 'same-origin' })
      if (!res.ok) return null
      const data = await res.json()
      return {
        totalPrice: typeof data.total_price === 'number' ? data.total_price / 100 : 0,
        itemCount: typeof data.item_count === 'number' ? data.item_count : 0,
        appliedDiscountCodes: (Array.isArray(data.discount_codes) ? data.discount_codes : [])
          .filter((d) => d && d.applicable)
          .map((d) => String(d.code).toUpperCase()),
      }
    } catch (_) {
      return null
    }
  }

  // ── Icon SVGs ────────────────────────────────────────────────────────
  // Scalloped coupon badge: 12-bump circular outline filled with currentColor,
  // with a centered white % glyph. % uses two filled circles + a diagonal
  // stroke so it reads cleanly at small sizes.
  const DISCOUNT_BADGE_SVG = [
    '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">',
    '<path fill="currentColor" d="M16 0c1.4 1.9 3.6 1.1 5.6 1.5.4 2 1.9 3.5 4 3.7-.4 2 1 3.8 2.7 5-1 1.8-.5 4 1 5.3-1.5 1.3-2 3.5-1 5.3-1.7 1.2-3.1 3-2.7 5-2.1.2-3.6 1.7-4 3.7-2-.4-4.2.4-5.6 2.3-1.4-1.9-3.6-2.7-5.6-2.3-.4-2-1.9-3.5-4-3.7.4-2-1-3.8-2.7-5 1-1.8.5-4-1-5.3 1.5-1.3 2-3.5 1-5.3 1.7-1.2 3.1-3 2.7-5 2.1-.2 3.6-1.7 4-3.7 2 .4 4.2-.4 5.6-2.3z"/>',
    '<circle cx="12" cy="12" r="1.7" fill="#ffffff"/>',
    '<circle cx="20" cy="20" r="1.7" fill="#ffffff"/>',
    '<path d="M21 11 11 21" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>',
    '</svg>',
  ].join('')
  const SHIPPING_TRUCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7zM7 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  const CHECKMARK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  // ── Render ──────────────────────────────────────────────────────────
  function renderEmpty(slot, labels) {
    slot.hidden = false
    slot.innerHTML = ''
    const empty = el('div', 'sai-cbpwlx29__empty')
    empty.appendChild(el('p', 'sai-cbpwlx29__empty-heading', { text: labels.emptyStateHeading || 'No coupons available' }))
    empty.appendChild(el('p', 'sai-cbpwlx29__empty-body', { text: labels.emptyStateBody || '' }))
    slot.appendChild(empty)
  }

  function renderManualEntry(parent, labels, ctx) {
    const wrap = el('div', 'sai-cbpwlx29__manual')
    const row = el('div', 'sai-cbpwlx29__manual-row')
    const input = el('input', 'sai-cbpwlx29__manual-input', {
      type: 'text',
      placeholder: labels.manualInputPlaceholder || 'Enter coupon code',
      'data-sai-manual-input': '',
      'aria-label': labels.manualInputPlaceholder || 'Enter coupon code',
    })
    const btn = el('button', 'sai-cbpwlx29__manual-button', {
      type: 'button',
      'data-sai-manual-submit': '',
      text: labels.manualApplyButtonText || 'Apply',
    })
    row.appendChild(input)
    row.appendChild(btn)
    wrap.appendChild(row)
    const fb = el('p', 'sai-cbpwlx29__manual-feedback', { 'data-sai-manual-feedback': '', hidden: true })
    wrap.appendChild(fb)
    parent.appendChild(wrap)

    function submit() {
      const code = (input.value || '').trim().toUpperCase()
      if (!code) return
      const known = ctx.discountByCode.get(code)
      if (known && isApplicable(known)) {
        fb.className = 'sai-cbpwlx29__manual-feedback sai-cbpwlx29__manual-feedback--success'
        fb.textContent = labels.manualSuccessMessage || 'Coupon applied'
        fb.hidden = false
        ctx.track(`${FEATURE_SLUG}:manual_entry_submit`, { discount_code: code, valid: true })
        window.location.href = discountApplyUrl(code)
      } else {
        fb.className = 'sai-cbpwlx29__manual-feedback sai-cbpwlx29__manual-feedback--error'
        fb.textContent = labels.manualErrorMessage || 'Invalid coupon code'
        fb.hidden = false
        ctx.track(`${FEATURE_SLUG}:manual_entry_submit`, { discount_code: code, valid: false })
      }
    }
    btn.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit() }
    })
  }

  function describeSavings(d, cartTotal, format, money) {
    const abs = savingsAtCart(d, cartTotal)
    const pct = savingsPct(d, cartTotal, abs)
    if (format === 'percentage' && pct > 0) return `${Math.round(pct)}% off`
    if (format === 'both' && abs > 0) return `${money.format(abs)} (${Math.round(pct)}% off)`
    if (abs > 0) return money.format(abs)
    if (pct > 0) return `${Math.round(pct)}% off`
    return ''
  }

  function formatRemainingValue(d, money) {
    const q = d && d.qualification
    if (!q) return ''
    const r = Number(q.remainingValue)
    if (!Number.isFinite(r)) return ''
    if (q.progressMetric === 'cart_value') return money.format(r)
    return String(r)
  }

  function formatCurrentValue(d, cart, money) {
    const q = d && d.qualification
    if (!q) return ''
    if (q.progressMetric === 'cart_value') return money.format(Number.isFinite(cart.totalPrice) ? cart.totalPrice : 0)
    if (q.progressMetric === 'quantity') return String(cart.itemCount || 0)
    return ''
  }

  function formatThresholdValue(d, money) {
    const q = d && d.qualification
    if (!q) return ''
    const r = Number(q.requiredValue)
    if (!Number.isFinite(r)) return ''
    if (q.progressMetric === 'cart_value') return money.format(r)
    return String(r)
  }

  function expiryDisplay(d, format) {
    const ends = endsAtMs(d)
    if (!ends || format === 'hidden') return ''
    if (format === 'date') {
      try { return new Date(ends).toLocaleDateString() } catch (_) { return '' }
    }
    if (format === 'countdown' || format === 'relative') {
      const diff = ends - Date.now()
      if (diff <= 0) return 'Expired'
      const days = Math.floor(diff / 86400000)
      if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`
      const hours = Math.floor(diff / 3600000)
      if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`
      const minutes = Math.max(1, Math.floor(diff / 60000))
      return `${minutes} minute${minutes === 1 ? '' : 's'} left`
    }
    return ''
  }

  function buildAppliedMessage(d, cartTotal, config, labels, money) {
    const code = getCode(d)
    const abs = savingsAtCart(d, cartTotal)
    const pct = Math.round(savingsPct(d, cartTotal, abs))
    const tpl = labels.appliedStateMessageTemplate || "Saved {amount} with '{code}'"
    return fillTemplate(tpl, {
      amount: money.format(abs),
      percentage: `${pct}%`,
      code: code || '',
      discount_name: d.shortSummary || d.title || '',
    })
  }

  function buildApplicableMessage(d, cartTotal, config, labels, money) {
    const code = getCode(d)
    const abs = savingsAtCart(d, cartTotal)
    const pct = Math.round(savingsPct(d, cartTotal, abs))
    const tpl = labels.applicableStateMessageTemplate || "Save {amount} with '{code}'"
    return fillTemplate(tpl, {
      amount: money.format(abs),
      percentage: `${pct}%`,
      code: code || '',
      discount_name: d.shortSummary || d.title || '',
    })
  }

  // Builds an interpolated message and emits it as DOM nodes so the code
  // gets wrapped in a span we can style. Keyed on '{code}' substring.
  function buildMessageNode(text, code) {
    const span = el('span', 'sai-cbpwlx29__message')
    if (!code || text.indexOf(code) === -1) {
      span.textContent = text
      return span
    }
    const parts = text.split(code)
    parts.forEach((part, i) => {
      if (part) span.appendChild(document.createTextNode(part))
      if (i < parts.length - 1) {
        const codeSpan = el('span', 'sai-cbpwlx29__message-code', { text: code })
        span.appendChild(codeSpan)
      }
    })
    return span
  }

  // Renders one coupon card. Mode 'applied' shows REMOVE; 'applicable' shows
  // APPLY; 'potential' shows progress bar + remaining; 'expired' shows the
  // expired-message in place of the countdown.
  function buildCard(d, mode, ctx, opts) {
    const { config, labels, cart, money } = ctx
    const isBestOffer = !!(opts && opts.bestOffer)
    // Only the highlighted best-offer applicable card carries the full chrome
    // (countdown header, code chip, description, terms, etc.). Plain
    // applicable rows below it render compact (icon + savings + Apply).
    const isFullCard = (mode === 'applicable' && isBestOffer) || mode === 'potential' || mode === 'expired'
    const card = el('div', 'sai-cbpwlx29__card', { 'data-sai-card-state': mode })
    if (d && d.id != null) card.setAttribute('data-discount-id', String(d.id))
    if (isBestOffer) card.setAttribute('data-best-offer', 'true')

    // Countdown header only on the full (applicable / potential / expired) card.
    // Applied + auto-applied rows are compact and inherit the widget-level timer.
    if (isFullCard) {
      if (config.showCountdownTimer && mode !== 'expired') {
        const headerWrap = el('div', 'sai-cbpwlx29__countdown-header')
        const text = el('span', 'sai-cbpwlx29__countdown-text')
        text.appendChild(document.createTextNode(''))
        text.setAttribute('data-sai-countdown-text', '')
        headerWrap.appendChild(text)
        card.appendChild(headerWrap)
      } else if (mode === 'expired') {
        const headerWrap = el('div', 'sai-cbpwlx29__countdown-header')
        headerWrap.textContent = labels.countdownExpiredMessage || 'This offer has ended'
        card.appendChild(headerWrap)
      }
    }

    const body = el('div', 'sai-cbpwlx29__body')

    // Discount type label (compact, above message) — full card only.
    if (config.showDiscountTypeLabel && isFullCard) {
      const label = describeType(d)
      if (label) body.appendChild(el('p', 'sai-cbpwlx29__type-label', { text: label }))
    }

    // Primary row: icon + message + trailing CTA.
    const row = el('div', 'sai-cbpwlx29__row')
    const main = el('div', 'sai-cbpwlx29__row-main')
    if (config.showCouponIcon) {
      const icon = el('span', 'sai-cbpwlx29__icon')
      // Free shipping uses a truck glyph; everything else uses the percent badge.
      const isShipping = d && d.discountValue && d.discountValue.type === 'FREE_SHIPPING'
      icon.innerHTML = isShipping ? SHIPPING_TRUCK_SVG : DISCOUNT_BADGE_SVG
      if (isShipping) icon.classList.add('sai-cbpwlx29__icon--shipping')
      main.appendChild(icon)
    }

    const code = getCode(d)
    const abs = savingsAtCart(d, cart.totalPrice)
    // Discounts with no monetary savings (e.g. free shipping) or no code
    // can't use the "Saved $X with 'CODE'" / "Save $X with 'CODE'" templates
    // — they'd render as "Saved $0.00 with ''". Fall back to the discount's
    // own title / shortSummary in that case.
    const hasMonetary = abs > 0 && code
    let messageText = ''
    if ((mode === 'applied' || mode === 'auto-applied') && hasMonetary) {
      messageText = buildAppliedMessage(d, cart.totalPrice, config, labels, money)
    } else if (mode === 'applicable' && hasMonetary) {
      messageText = buildApplicableMessage(d, cart.totalPrice, config, labels, money)
    } else {
      messageText = d.title || d.shortSummary || ''
    }
    if (config.showSavingsCallout || mode === 'applied' || mode === 'auto-applied') {
      main.appendChild(buildMessageNode(messageText, code))
    } else {
      const fallback = el('span', 'sai-cbpwlx29__message', { text: d.shortSummary || d.title || '' })
      main.appendChild(fallback)
    }
    row.appendChild(main)

    const trailing = el('div', 'sai-cbpwlx29__row-trailing')
    if (mode === 'applied') {
      const removeBtn = el('button', 'sai-cbpwlx29__remove', {
        type: 'button',
        'data-sai-remove': code || '',
        text: labels.removeLinkText || 'Remove',
      })
      trailing.appendChild(removeBtn)
    } else if (mode === 'auto-applied') {
      const applied = el('span', 'sai-cbpwlx29__applied-tick')
      applied.innerHTML = `${CHECKMARK_SVG}<span>${labels.autoAppliedLabel || 'Applied'}</span>`
      trailing.appendChild(applied)
    } else if (mode === 'applicable' && code) {
      const applyBtn = el('button', 'sai-cbpwlx29__apply', {
        type: 'button',
        'data-sai-apply': code,
        text: labels.applyButtonText || 'Apply',
      })
      trailing.appendChild(applyBtn)
    }
    row.appendChild(trailing)
    body.appendChild(row)

    // "Best Offer For You" pill under the message on the highlighted card.
    if (isBestOffer && mode === 'applicable' && code) {
      const subrow = el('div', 'sai-cbpwlx29__subrow')
      subrow.appendChild(el('span', 'sai-cbpwlx29__code-inline', { text: code }))
      subrow.appendChild(el('span', 'sai-cbpwlx29__pill', {
        text: labels.bestOfferPillLabel || 'Best Offer For You',
      }))
      body.appendChild(subrow)
    }

    // Code chip + copy button (off by default — only full applicable cards
    // when NOT the best-offer card, since the best-offer subrow already
    // shows the code next to the pill).
    if (config.showCodeChip && code && isFullCard && !isBestOffer) {
      const chipRow = el('div', 'sai-cbpwlx29__row')
      const chip = el('span', 'sai-cbpwlx29__code-chip', { text: code })
      chipRow.appendChild(chip)
      if (config.showCopyCodeButton) {
        const copyBtn = el('button', 'sai-cbpwlx29__copy-btn', {
          type: 'button',
          'data-sai-copy': code,
          'aria-pressed': 'false',
          text: labels.copyCtaLabel || 'Copy',
        })
        chipRow.appendChild(copyBtn)
      }
      body.appendChild(chipRow)
    }

    // Description (optional, line-clamped, expandable) — full card only.
    if (config.showDescription && isFullCard && (d.summary || d.shortSummary)) {
      const desc = el('p', 'sai-cbpwlx29__description', { text: d.summary || d.shortSummary })
      body.appendChild(desc)
      if (config.descriptionExpandable) {
        const toggle = el('button', 'sai-cbpwlx29__description-toggle', { type: 'button', text: 'Read more' })
        toggle.addEventListener('click', () => {
          const expanded = desc.classList.toggle('sai-cbpwlx29__description--expanded')
          toggle.textContent = expanded ? 'Show less' : 'Read more'
        })
        body.appendChild(toggle)
      }
    }

    // Progress bar — only for potential (not-yet-eligible) coupons.
    // Applied + applicable coupons don't need a progress bar; their state
    // is already obvious from the message + CTA.
    if (config.showProgressBar && mode === 'potential') {
      const progressNode = buildProgress(d, ctx, mode)
      if (progressNode) body.appendChild(progressNode)
    }

    // Remaining amount (only for potential).
    if (mode === 'potential' && config.showRemainingAmount) {
      const tpl = labels.remainingAmountTemplate || 'Add {remaining} more to unlock'
      const text = fillTemplate(tpl, {
        remaining: formatRemainingValue(d, money),
        threshold: formatThresholdValue(d, money),
        current: formatCurrentValue(d, cart, money),
      })
      if (text) body.appendChild(el('p', 'sai-cbpwlx29__remaining', { text }))
    }

    // Min order threshold (separate from progress bar) — full card only.
    if (config.showMinOrderThreshold && isFullCard) {
      const req = thresholdRequired(d)
      if (req != null) {
        body.appendChild(el('p', 'sai-cbpwlx29__min-order', { text: `Min order ${money.format(req)}` }))
      }
    }

    // Expiry display on card — full card only.
    if (config.showExpiryDisplay && isFullCard) {
      const t = expiryDisplay(d, config.expiryFormat)
      if (t) body.appendChild(el('p', 'sai-cbpwlx29__expiry', { text: t }))
    }

    // Terms link — full card only.
    if (config.showTerms && isFullCard) {
      const termsBtn = el('button', 'sai-cbpwlx29__terms-toggle', {
        type: 'button',
        'data-sai-terms': '1',
        text: labels.termsLabel || 'Terms & Conditions',
      })
      termsBtn.addEventListener('click', () => {
        ctx.track(`${FEATURE_SLUG}:terms_opened`, {
          discount_id: d && d.id ? String(d.id) : null,
          discount_code: code,
        })
        openTermsModal(d, ctx)
      })
      body.appendChild(termsBtn)
    }

    card.appendChild(body)
    return card
  }

  function describeType(d) {
    const dv = d && d.discountValue
    if (!dv) return ''
    switch (dv.type) {
      case 'PERCENTAGE':
        return Number.isFinite(Number(dv.percentage)) ? `${Math.round(Number(dv.percentage))}% Off` : 'Percentage Off'
      case 'FIXED':
        return 'Amount Off'
      case 'FREE_SHIPPING':
        return 'Free Shipping'
      default:
        return ''
    }
  }

  // Next-coupon row — a card-style summary for each alternative in the
  // potentially-applicable list. Includes a mini progress bar for
  // threshold-based coupons so shoppers can see how close they are to
  // unlocking them, and an inline APPLY chip when applicable.
  function buildNextCouponRow(d, ctx) {
    const { config, labels, cart, money } = ctx
    const row = el('div', 'sai-cbpwlx29__next-coupon')
    const head = el('div', 'sai-cbpwlx29__next-coupon-head')
    head.appendChild(el('span', 'sai-cbpwlx29__next-coupon-name', { text: d.shortSummary || d.title || '' }))
    const code = getCode(d)
    if (isApplicable(d) && code) {
      head.appendChild(el('button', 'sai-cbpwlx29__next-coupon-apply', {
        type: 'button', 'data-sai-apply': code, text: labels.applyButtonText || 'APPLY',
      }))
    }
    row.appendChild(head)

    if (isPotential(d)) {
      const q = d.qualification || {}
      const required = Number(q.requiredValue)
      // Use the server-recomputed currentValue (set by recomputeAgainstCart)
      // rather than raw cart.totalPrice — keeps quantity-metric coupons honest
      // when the qualification context isn't the cart subtotal.
      const current = Number.isFinite(Number(q.currentValue))
        ? Number(q.currentValue)
        : (q.progressMetric === 'quantity' ? cart.itemCount : cart.totalPrice)
      const remaining = Number(q.remainingValue)
      row.appendChild(el('div', 'sai-cbpwlx29__next-coupon-meta', {
        text: Number.isFinite(remaining) && remaining > 0
          ? fillTemplate(labels.remainingAmountTemplate || 'Add {remaining} more to unlock', {
              remaining: formatRemainingValue(d, money),
              threshold: formatThresholdValue(d, money),
              current: formatCurrentValue(d, cart, money),
            })
          : '',
      }))

      // Progress bar only when there's genuine progress to show (cart hasn't
      // already met the threshold) — a 100%-filled bar on a potential coupon
      // is misleading, so we hard-cap pct < 1 when remaining > 0.
      if (config.showProgressBar && Number.isFinite(required) && required > 0
        && Number.isFinite(remaining) && remaining > 0) {
        const pctRaw = current / required
        const pct = Math.max(0, Math.min(0.95, pctRaw))
        const track = el('div', 'sai-cbpwlx29__next-coupon-track')
        const fill = el('div', 'sai-cbpwlx29__next-coupon-fill')
        fill.style.setProperty('--sai-cbpwlx29-progress-pct', String(pct))
        track.appendChild(fill)
        row.appendChild(track)
      }
    }
    // Applicable + applied alternatives don't get a progress bar — the
    // inline APPLY chip already communicates state.
    return row
  }

  function buildProgress(d, ctx, mode) {
    const { config, labels, cart, money } = ctx
    const q = d && d.qualification
    if (!q) return null
    const required = Number(q.requiredValue)
    if (!Number.isFinite(required) || required <= 0) return null
    const current = q.progressMetric === 'quantity' ? cart.itemCount : cart.totalPrice
    const pct = Math.max(0, Math.min(1, current / required))

    const wrap = el('div', 'sai-cbpwlx29__progress')
    const track = el('div', 'sai-cbpwlx29__progress-track')
    const fill = el('div', 'sai-cbpwlx29__progress-fill')
    fill.style.setProperty('--sai-cbpwlx29-progress-pct', String(pct))
    track.appendChild(fill)
    wrap.appendChild(track)

    if (mode === 'potential') {
      const msg = el('p', 'sai-cbpwlx29__remaining', {
        text: fillTemplate(labels.thresholdMessageTemplate || 'Add {remaining} more to unlock', {
          remaining: formatRemainingValue(d, money),
          threshold: formatThresholdValue(d, money),
          current: formatCurrentValue(d, cart, money),
        }),
      })
      wrap.appendChild(msg)
    } else if (mode === 'applicable') {
      const msg = el('p', 'sai-cbpwlx29__remaining', {
        text: labels.thresholdMetMessage || 'Eligible — applies at checkout',
      })
      wrap.appendChild(msg)
    }

    if (config.showAmountsOnBarEnds) {
      const ends = el('div', 'sai-cbpwlx29__progress-ends')
      ends.appendChild(el('span', 'sai-cbpwlx29__progress-end', { text: formatCurrentValue(d, cart, money) }))
      ends.appendChild(el('span', 'sai-cbpwlx29__progress-end', { text: formatThresholdValue(d, money) }))
      wrap.appendChild(ends)
    }
    return wrap
  }

  // ── T&C modal (desktop) / drawer (mobile) ────────────────────────────
  function openTermsModal(d, ctx) {
    const { labels } = ctx
    const isMobile = !window.matchMedia('(min-width: 768px)').matches
    const root = document.createElement('div')
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;background:rgba(0,0,0,0.45)'
    const panel = document.createElement('div')
    panel.style.cssText = isMobile
      ? 'margin-top:auto;width:100%;background:#fff;border-radius:1rem 1rem 0 0;padding:1rem;max-height:70vh;overflow:auto'
      : 'margin:auto;background:#fff;border-radius:1rem;padding:1rem;max-width:28rem;width:calc(100% - 2rem);max-height:80vh;overflow:auto'
    const title = document.createElement('h3')
    title.textContent = labels.termsLabel || 'Terms & Conditions'
    title.style.cssText = 'margin:0 0 0.5rem 0;font-size:1rem;font-weight:700'
    panel.appendChild(title)
    const body = document.createElement('p')
    body.textContent = d.summary || d.shortSummary || 'See checkout for full terms.'
    body.style.cssText = 'margin:0;font-size:0.875rem;line-height:1.5'
    panel.appendChild(body)
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.style.cssText = 'margin-top:1rem;padding:0.5rem 1rem;border-radius:999px;background:#1a1a1a;color:#fff;border:0;font-weight:600;cursor:pointer'
    panel.appendChild(close)
    root.appendChild(panel)

    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true)
      if (root.parentNode) root.parentNode.removeChild(root)
    }
    const onKey = (e) => { if (e.key === 'Escape') cleanup() }
    root.addEventListener('click', (e) => { if (e.target === root) cleanup() })
    close.addEventListener('click', cleanup)
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(root)
  }

  // ── Copy CTA helper ──────────────────────────────────────────────────
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_) {
      try {
        const tmp = document.createElement('textarea')
        tmp.value = text
        tmp.style.position = 'absolute'
        tmp.style.left = '-9999px'
        document.body.appendChild(tmp)
        tmp.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(tmp)
        return ok
      } catch (__) { return false }
    }
  }

  // ── Main render ──────────────────────────────────────────────────────
  function render(ctx) {
    const { host, slot, config, labels, cart, money } = ctx
    const orderedAll = buildOrderedList(ctx.discounts, cart.appliedDiscountCodes, cart.totalPrice, config.withinTierSort)
    ctx.lastOrdered = orderedAll

    if (orderedAll.length === 0) {
      if (config.showEmptyState) {
        renderEmpty(slot, labels)
        if (config.showManualCodeEntry) renderManualEntry(slot, labels, ctx)
        return
      }
      host.classList.add('sai-cbpwlx29--hidden')
      slot.hidden = true
      slot.innerHTML = ''
      return
    }
    host.classList.remove('sai-cbpwlx29--hidden')
    slot.hidden = false
    slot.innerHTML = ''

    // Honor countdown_expired_behavior on the top card (expired countdown).
    const topRaw = orderedAll[0]
    const ends = endsAtMs(topRaw)
    let visible = orderedAll
    if (ends != null && ends <= Date.now()) {
      const behavior = config.countdownExpiredBehavior || 'show_next_coupon'
      if (behavior === 'hide_coupon') {
        visible = orderedAll.slice(1)
        if (visible.length === 0) {
          if (config.showEmptyState) { renderEmpty(slot, labels); return }
          host.classList.add('sai-cbpwlx29--hidden')
          slot.hidden = true
          return
        }
      } else if (behavior === 'show_next_coupon') {
        visible = orderedAll.slice(1).concat([orderedAll[0]])
      }
    }

    // Three-tier partition:
    //   applied  — manual codes currently in the cart (Remove)
    //   bestOffer — top-ranked applicable not yet applied (highlighted card)
    //   autoApplied — automatic discounts qualifying at the current cart total (✓ Applied)
    // The widget-level timer rides on the bestOffer card.
    const appliedList = []
    const autoAppliedList = []
    const applicableList = []
    for (const d of visible) {
      if (isApplied(d, cart.appliedDiscountCodes)) appliedList.push(d)
      else if (isAutoApplied(d)) autoAppliedList.push(d)
      else if (isApplicable(d)) applicableList.push(d)
    }
    // If any manual coupon is already applied, only surface "next" suggestions
    // that beat the *highest* applied savings — never pitch a smaller coupon
    // as the next-best offer when the shopper already has a bigger one on.
    let appliedTopSavings = 0
    for (const a of appliedList) {
      const s = savingsAtCart(a, cart.totalPrice)
      if (s > appliedTopSavings) appliedTopSavings = s
    }
    const upgradeApplicable = appliedTopSavings > 0
      ? applicableList.filter((d) => savingsAtCart(d, cart.totalPrice) > appliedTopSavings)
      : applicableList
    // Cap applicable suggestions at max_coupons_displayed (default 3) —
    // 1st renders as highlighted best-offer card, the rest as compact rows
    // with an Apply CTA. Same cap regardless of display_mode.
    const applicableCap = Math.max(1, Number(config.maxCouponsDisplayed) || 3)
    const cappedApplicable = upgradeApplicable.slice(0, applicableCap)
    const bestOffer = cappedApplicable[0] || null
    const restApplicable = cappedApplicable.slice(1)

    const rendered = []
    for (const d of appliedList) {
      const c = buildCard(d, 'applied', ctx)
      slot.appendChild(c)
      rendered.push({ d, mode: 'applied', el: c })
    }
    if (bestOffer) {
      const c = buildCard(bestOffer, 'applicable', ctx, { bestOffer: true })
      slot.appendChild(c)
      rendered.push({ d: bestOffer, mode: 'applicable', el: c })
    }
    for (const d of restApplicable) {
      const c = buildCard(d, 'applicable', ctx)
      slot.appendChild(c)
      rendered.push({ d, mode: 'applicable', el: c })
    }
    for (const d of autoAppliedList) {
      const c = buildCard(d, 'auto-applied', ctx)
      slot.appendChild(c)
      rendered.push({ d, mode: 'auto-applied', el: c })
    }

    // Manual code entry.
    if (config.showManualCodeEntry) renderManualEntry(slot, labels, ctx)

    // Countdown timer drives only the cards that emit a countdown header
    // (full applicable / potential / expired). buildCard skips the header
    // for compact rows, so the timer setup only attaches to bestOffer.
    setupCountdownTimers(ctx, bestOffer ? [bestOffer] : [])
    wireCardInteractions(ctx)
  }

  function wireCardInteractions(ctx) {
    const { host, slot, labels, config } = ctx
    if (ctx._wired) return
    ctx._wired = true

    slot.addEventListener('click', (e) => {
      const target = e.target
      if (!(target instanceof Element)) return

      const apply = target.closest('[data-sai-apply]')
      if (apply) {
        const code = apply.getAttribute('data-sai-apply')
        if (!code) return
        e.preventDefault()
        applyDiscount(code, apply, ctx)
        return
      }
      const remove = target.closest('[data-sai-remove]')
      if (remove) {
        const code = remove.getAttribute('data-sai-remove')
        e.preventDefault()
        removeDiscount(code, ctx)
        return
      }
      const copy = target.closest('[data-sai-copy]')
      if (copy) {
        const code = copy.getAttribute('data-sai-copy') || ''
        e.preventDefault()
        copyToClipboard(code).then((ok) => {
          ctx.track(`${FEATURE_SLUG}:copy_code`, { discount_code: code, copied: ok })
          if (!ok) return
          copy.setAttribute('aria-pressed', 'true')
          const prev = copy.textContent
          copy.textContent = labels.copySuccessLabel || 'Copied!'
          setTimeout(() => { copy.setAttribute('aria-pressed', 'false'); copy.textContent = prev }, 1500)
        })
        return
      }
    })
  }

  function applyDiscount(code, btn, ctx) {
    const labels = ctx.labels
    btn.setAttribute('disabled', '')
    const prev = btn.textContent
    btn.textContent = labels.applyLoadingText || 'Applying...'
    ctx.track(`${FEATURE_SLUG}:apply_clicked`, { discount_code: code })
    setTimeout(() => {
      window.location.href = discountApplyUrl(code)
      // If navigation is intercepted, restore button text after a beat.
      setTimeout(() => {
        if (btn.isConnected) { btn.removeAttribute('disabled'); btn.textContent = prev }
      }, 2000)
    }, 50)
  }

  function removeDiscount(code, ctx) {
    ctx.track(`${FEATURE_SLUG}:remove_clicked`, { discount_code: code || null })
    clearDiscount()
  }

  // ── Countdown wiring per card ────────────────────────────────────────
  function setupCountdownTimers(ctx, visibleDiscounts) {
    // Clear prior timers.
    if (ctx._timers) {
      for (const t of ctx._timers) clearInterval(t)
    }
    ctx._timers = []
    visibleDiscounts.forEach((d) => {
      // Match by data-discount-id so card order (applied / best-offer /
      // applicable / auto-applied) doesn't matter — index pairing breaks the
      // moment we render more than just the best-offer card.
      const card = d && d.id != null
        ? ctx.slot.querySelector(`.sai-cbpwlx29__card[data-discount-id="${CSS.escape(String(d.id))}"]`)
        : null
      if (!card) return
      const textEl = card.querySelector('[data-sai-countdown-text]')
      if (!textEl) return
      let endsMs = null
      if (ctx.config.timerSource === 'session_window') {
        endsMs = sessionWindowEndsAt(ctx.config.sessionWindowDurationMinutes)
      } else {
        endsMs = endsAtMs(d)
      }
      if (endsMs == null) { textEl.parentElement.parentElement && (textEl.closest('.sai-cbpwlx29__countdown-header').style.display = 'none'); return }
      const tick = () => {
        const remaining = endsMs - Date.now()
        if (remaining <= 0) {
          textEl.textContent = '0s'
          clearInterval(timer)
          ctx.track(`${FEATURE_SLUG}:countdown_expired`, {
            discount_id: d && d.id ? String(d.id) : null,
            timer_source: ctx.config.timerSource,
            behavior: ctx.config.countdownExpiredBehavior,
          })
          render(ctx)
          return
        }
        const tpl = ctx.labels.countdownFormatTemplate || 'Offer ends in {countdown}'
        textEl.textContent = fillTemplate(tpl, { countdown: formatCountdown(remaining, ctx.config.countdownShowSeconds) })
      }
      tick()
      const timer = setInterval(tick, 1000)
      ctx._timers.push(timer)
    })
  }

  // ── Auto-apply ───────────────────────────────────────────────────────
  function maybeAutoApply(ctx) {
    if (!ctx.config.enableAutoApply) return
    const ordered = ctx.lastOrdered || []
    if (ordered.length === 0) return
    const top = ordered[0]
    // If already applied, nothing to do.
    if (isApplied(top, ctx.cart.appliedDiscountCodes)) return
    if (!isApplicable(top)) return
    const code = getCode(top)
    if (!code) return
    // Trigger == threshold_met: only auto-apply when qualification.isSatisfied.
    if (ctx.config.autoApplyTrigger === 'threshold_met' && !(top.qualification && top.qualification.isSatisfied)) return
    // Session-storage guard to prevent reload loops.
    try {
      const key = `${AUTO_APPLY_SESSION_KEY}:${code}`
      if (window.sessionStorage.getItem(key) === '1') return
      window.sessionStorage.setItem(key, '1')
    } catch (_) { /* sessionStorage unavailable — skip auto-apply */ return }
    ctx.track(`${FEATURE_SLUG}:auto_apply`, { discount_code: code })
    window.location.href = discountApplyUrl(code)
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  function initHost(host) {
    if (host.dataset.saiInitialized === '1') return
    host.dataset.saiInitialized = '1'

    const payloadEl = host.querySelector('script[data-sai-payload]')
    if (!payloadEl) return
    let payload
    try { payload = JSON.parse(payloadEl.textContent || '{}') } catch (_) { return }
    if (!payload || !payload.config) return

    // Visibility scope check — bail with host hidden if mismatched.
    const templateName = host.getAttribute('data-template-name') || ''
    if (!passesVisibilityScope(host, templateName, payload.config.visibilityScope)) {
      host.classList.add('sai-cbpwlx29--hidden')
      return
    }

    const config = payload.config
    const labels = payload.labels || {}
    const slot = host.querySelector('[data-sai-body]')
    if (!slot) return

    const baseCart = payload.cart || {}
    const cart = {
      totalPrice: Number.isFinite(Number(baseCart.totalPrice)) ? Number(baseCart.totalPrice) : 0,
      itemCount: Number.isFinite(Number(baseCart.itemCount)) ? Number(baseCart.itemCount) : 0,
      currency: baseCart.currency || 'USD',
      // Dedupe: cart.discount_codes and cart.cart_level_discount_applications
      // overlap for code-based discounts. Set-based dedupe + uppercase
      // canonicalisation makes isApplied() match regardless of source.
      appliedDiscountCodes: Array.from(new Set(
        (Array.isArray(baseCart.appliedDiscountCodes) ? baseCart.appliedDiscountCodes : [])
          .map((c) => String(c).toUpperCase().trim())
          .filter(Boolean)
      )),
    }

    // Union + dedupe + recompute against live cart.
    const unioned = dedupeDiscounts(payload.discounts || {})
    const discounts = unioned.map((d) => recomputeAgainstCart(d, cart))

    // Build discountByCode lookup for manual entry.
    const discountByCode = new Map()
    for (const d of discounts) {
      const c = getCode(d)
      if (c) discountByCode.set(String(c).toUpperCase(), d)
    }

    // Analytics envelope via Spectrum SDK bind.
    const wrapper = host.closest('[data-spectrum-lq-snippet]') || host
    const api = window.__spectrumAi && window.__spectrumAi.snippet
    let trackFn = noop
    let emitFn = noop
    if (api && typeof api.bind === 'function') {
      try {
        const handles = api.bind(wrapper, () => { /* no variant resolution on cart */ })
        if (handles) {
          if (typeof handles.track === 'function') trackFn = safeFn(handles.track)
          if (typeof handles.emit === 'function') emitFn = safeFn(handles.emit)
        }
      } catch (_) { /* keep noop */ }
    }

    const ctx = {
      host, slot, config, labels, cart, discounts, discountByCode,
      money: moneyFormatter(cart.currency),
      track: trackFn, emit: emitFn,
      _timers: [],
    }

    render(ctx)

    // Impression (gated by impressionsEnabled — name ends in `_impression`).
    ctx.track(`${FEATURE_SLUG}:widget_impression`, {
      total_count: discounts.length,
      applied_count: cart.appliedDiscountCodes.length,
      applicable_count: discounts.filter((d) => isApplicable(d)).length,
      potential_count: discounts.filter((d) => isPotential(d)).length,
      display_mode: config.displayMode,
      visibility_scope: config.visibilityScope,
    })

    // Auto-apply after first render (so analytics fires for the resolved set).
    maybeAutoApply(ctx)

    // Cart-change re-render: re-fetch /cart.js, recompute, render.
    installGlobalCartSync()
    const cartListener = () => {
      fetchCart().then((next) => {
        if (!next) return
        ctx.cart.totalPrice = next.totalPrice
        ctx.cart.itemCount = next.itemCount
        ctx.cart.appliedDiscountCodes = next.appliedDiscountCodes
        ctx.discounts = unioned.map((d) => recomputeAgainstCart(d, ctx.cart))
        render(ctx)
        ctx.track(`${FEATURE_SLUG}:cart_refreshed`, {
          total_price: ctx.cart.totalPrice,
          item_count: ctx.cart.itemCount,
          applied_codes: ctx.cart.appliedDiscountCodes,
        })
      })
    }
    window.addEventListener(CART_SYNC_EVENT, cartListener)
  }

  // Snippet library JS contract: read data-spectrum-vis before any meaningful
  // work. Live wrappers SSR with vis="off"; bootstrap flips to "on" only when
  // the owning experience wins targeting + conflict resolution.
  function waitForVis(host) {
    const wrapper = host.closest('[data-spectrum-lq-snippet]') || host
    if (!wrapper || wrapper.getAttribute('data-spectrum-vis') === 'on' || !wrapper.hasAttribute('data-spectrum-vis')) {
      initHost(host)
      return
    }
    const observer = new MutationObserver(() => {
      if (wrapper.getAttribute('data-spectrum-vis') === 'on') {
        observer.disconnect()
        initHost(host)
      }
    })
    observer.observe(wrapper, { attributes: true, attributeFilter: ['data-spectrum-vis'] })
  }

  function bootAll() {
    const hosts = document.querySelectorAll(TAG)
    hosts.forEach((host) => waitForVis(host))
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll, { once: true })
  } else {
    bootAll()
  }
})()
