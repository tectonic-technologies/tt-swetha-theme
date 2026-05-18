/* =============================================================================
 * PDP Promotion List (c1mzmpkz) — runtime.
 *
 * Reads the server-emitted JSON payload (data-sai-payload), recomputes
 * qualifications against the live cart subtotal, sorts each section, renders
 * the 11-zone coupon card, wires Copy clipboard, overflow expand-inline /
 * popup, dropdown, carousel autoplay/arrows/dots, T&C modal (desktop) /
 * drawer (mobile), and live cart subscription.
 *
 * Container-scoped self-guard via data-mutation-handle. Reads
 * data-spectrum-vis before doing meaningful work.
 * ============================================================================= */

;(() => {
  // Default coupon-ticket SVG — shown on cards when `show_coupon_icon` is
  // on but no `coupon_icon_url` is supplied. Matches the Vaaree-style
  // pink/percent ticket from the reference design.
  const DEFAULT_COUPON_SVG = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs><linearGradient id="sai-c1mzmpkz-coupon-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FDE7EF"/><stop offset="100%" stop-color="#F8C8DC"/></linearGradient></defs><path d="M6 16a6 6 0 0 1 6-6h40a6 6 0 0 1 6 6v6a4 4 0 0 0 0 8v6a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6v-6a4 4 0 0 0 0-8v-6Z" fill="url(#sai-c1mzmpkz-coupon-bg)" stroke="#2A2A2A" stroke-width="2"/><line x1="30" y1="14" x2="30" y2="42" stroke="#2A2A2A" stroke-width="1.5" stroke-dasharray="3 3"/><circle cx="48" cy="28" r="8" fill="#E4377F"/><path d="M44 32l8-8M45 25.5h.01M50.5 30.5h.01" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round"/></svg>'

  const SNIPPET_ID = 'c1mzmpkz'
  const TAG = 'sai-c1mzmpkz'
  const FEATURE_SLUG = 'pdp_promotions'

  // ── Analytics helpers ─────────────────────────────────────────────────
  // Snippet authoring guide: use __spectrumAi.snippet.bind(node, cb) to get
  // { track, emit }. SDK auto-attaches the standard envelope and the $spectrum:
  // prefix. Events ending in `_impression` are gated by the brand-level
  // impressionsEnabled toggle. snake_case property keys.

  function noop() {}
  function safeFn(fn) {
    return (name, payload) => {
      try { fn(name, payload) } catch (_) { /* analytics is best-effort */ }
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  function moneyFormatter(currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode || 'USD',
        currencyDisplay: 'narrowSymbol',
      })
    } catch (_) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode || 'USD' })
      } catch (_) {
        return { format: (n) => `${currencyCode || '$'}${Number(n).toFixed(2)}` }
      }
    }
  }

  function el(tag, className, attrs) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k]
        if (v === null || v === undefined || v === false) continue
        if (k === 'text') node.textContent = v
        else if (k === 'html') node.innerHTML = v
        else if (v === true) node.setAttribute(k, '')
        else node.setAttribute(k, String(v))
      }
    }
    return node
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n))
  }

  function safeParsePayload(scriptEl) {
    if (!scriptEl) return null
    try {
      return JSON.parse(scriptEl.textContent || '{}')
    } catch (_) {
      return null
    }
  }

  function interpolate(template, vars) {
    if (!template) return ''
    let out = String(template)
    for (const k of Object.keys(vars)) {
      out = out.split(`{${k}}`).join(String(vars[k]))
    }
    return out
  }

  // ── Discount classification + sorting ──────────────────────────────────

  function isApplicable(d) {
    const q = d.qualification || {}
    return q.isSatisfied === true || q.applicability === 'current'
  }

  function isPotential(d) {
    const q = d.qualification || {}
    return !isApplicable(d) && q.applicability === 'potential'
  }

  function partition(discounts) {
    const applicable = []
    const potential = []
    for (const d of discounts || []) {
      if (!d || !d.qualification) continue
      if (d.qualification.applicability === 'never') continue
      if (isApplicable(d)) applicable.push(d)
      else if (isPotential(d)) potential.push(d)
    }
    return { applicable, potential }
  }

  function estimatedSavingsAmount(d) {
    const v = d.discountValue || {}
    if (v.type === 'FIXED' && typeof v.amount === 'number') return v.amount
    if (v.type === 'PERCENTAGE' && typeof v.percentage === 'number') {
      const q = d.qualification || {}
      const matched = q.matchedSubtotalAmount || q.currentValue || q.requiredValue || 0
      const pct = v.percentage <= 1 ? v.percentage : v.percentage / 100
      return matched * pct
    }
    if (v.type === 'FREE_SHIPPING') return 0
    return 0
  }

  function titleOf(d) {
    return (d.title || d.shortSummary || d.summary || '').toLowerCase()
  }

  function thresholdOf(d) {
    const q = d.qualification || {}
    return typeof q.requiredValue === 'number' ? q.requiredValue : Number.MAX_SAFE_INTEGER
  }

  function remainingOf(d) {
    const q = d.qualification || {}
    return typeof q.remainingValue === 'number' ? q.remainingValue : Number.MAX_SAFE_INTEGER
  }

  function expiryEpoch(d) {
    if (!d.endsAt) return Number.MAX_SAFE_INTEGER
    const t = Date.parse(d.endsAt)
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER
  }

  function applicableComparator(mode) {
    switch (mode) {
      case 'highest_savings':
        return (a, b) => estimatedSavingsAmount(b) - estimatedSavingsAmount(a)
      case 'expiry_soonest':
        return (a, b) => expiryEpoch(a) - expiryEpoch(b)
      case 'alphabetical':
        return (a, b) => titleOf(a).localeCompare(titleOf(b))
      case 'threshold_asc':
        return (a, b) => thresholdOf(a) - thresholdOf(b)
      case 'threshold_desc':
        return (a, b) => thresholdOf(b) - thresholdOf(a)
      default:
        return () => 0
    }
  }

  function potentialComparator(mode) {
    switch (mode) {
      case 'closest_to_qualify':
        return (a, b) => remainingOf(a) - remainingOf(b)
      case 'highest_potential_savings':
        return (a, b) => estimatedSavingsAmount(b) - estimatedSavingsAmount(a)
      case 'threshold_asc':
        return (a, b) => thresholdOf(a) - thresholdOf(b)
      case 'threshold_desc':
        return (a, b) => thresholdOf(b) - thresholdOf(a)
      default:
        return () => 0
    }
  }

  // ── Card content helpers ───────────────────────────────────────────────

  function formatTypeLabel(d, currency) {
    const v = d.discountValue || {}
    if (v.type === 'FREE_SHIPPING') return 'Free Shipping'
    if (v.type === 'PERCENTAGE') {
      const pct = typeof v.percentage === 'number' ? Math.round(v.percentage * (v.percentage <= 1 ? 100 : 1)) : null
      return pct != null ? `${pct}% Off` : 'Percentage off'
    }
    if (v.type === 'FIXED') {
      const fmt = moneyFormatter(v.currencyCode || currency)
      return v.amount != null ? `${fmt.format(v.amount)} Off` : 'Amount off'
    }
    if (v.type === 'DISCOUNTED_QUANTITY') return 'Buy more, save more'
    return d.shortSummary || d.title || 'Offer'
  }

  function formatSavings(d, mode, currency) {
    const v = d.discountValue || {}
    if (v.type === 'FREE_SHIPPING') return 'Save on shipping'
    const fmt = moneyFormatter(v.currencyCode || currency)
    const pct = typeof v.percentage === 'number' ? Math.round(v.percentage * (v.percentage <= 1 ? 100 : 1)) : null
    const abs = typeof v.amount === 'number' ? fmt.format(v.amount) : null
    if (mode === 'percentage' && pct != null) return `Save ${pct}%`
    if (mode === 'absolute' && abs) return `Save ${abs}`
    if (mode === 'both') {
      if (pct != null && abs) return `Save ${abs} (${pct}%)`
      if (pct != null) return `Save ${pct}%`
      if (abs) return `Save ${abs}`
    }
    if (abs) return `Save ${abs}`
    if (pct != null) return `Save ${pct}%`
    return null
  }

  function formatRemaining(d, template, currency) {
    const q = d.qualification || {}
    if (q.isSatisfied) return null
    const remaining = q.remainingValue
    if (remaining == null) return null
    if (q.progressMetric === 'subtotal') {
      const fmt = moneyFormatter(currency)
      return interpolate(template, { remaining: fmt.format(remaining) })
    }
    if (q.progressMetric === 'quantity') {
      return interpolate(template, { remaining: String(remaining) })
    }
    return null
  }

  function formatMinOrder(d, template, currency) {
    const q = d.qualification || {}
    if (q.progressMetric !== 'subtotal' || q.requiredValue == null) return null
    const fmt = moneyFormatter(currency)
    return interpolate(template, { amount: fmt.format(q.requiredValue) })
  }

  function formatExpiry(d, fmtMode) {
    if (!d.endsAt) return null
    const t = Date.parse(d.endsAt)
    if (!Number.isFinite(t)) return null
    const now = Date.now()
    const diffMs = t - now
    if (fmtMode === 'date') {
      try { return `Expires ${new Date(t).toLocaleDateString()}` } catch (_) { return null }
    }
    if (fmtMode === 'countdown' || fmtMode === 'relative') {
      if (diffMs <= 0) return 'Expired'
      const days = Math.floor(diffMs / 86400000)
      const hours = Math.floor((diffMs % 86400000) / 3600000)
      if (days > 0) return `Expires in ${days}d ${hours}h`
      if (hours > 0) return `Expires in ${hours}h`
      const minutes = Math.floor((diffMs % 3600000) / 60000)
      return `Expires in ${minutes}m`
    }
    return null
  }

  function progressPct(d) {
    const q = d.qualification || {}
    if (typeof q.progressPercent !== 'number') return 0
    return clamp(q.progressPercent / 100, 0, 1)
  }

  function interpolateTerms(template, d, currency) {
    const fmt = moneyFormatter(currency)
    const q = d.qualification || {}
    const code = (d.codes && d.codes[0]) || (d.applicationType === 'automatic' ? 'no code needed' : '')
    const minOrder = q.progressMetric === 'subtotal' && q.requiredValue != null ? fmt.format(q.requiredValue) : ''
    const stack = d.stackConfig || {}
    const stackingNote = stack.orderDiscounts || stack.productDiscounts || stack.shippingDiscounts
      ? 'Stackable with other discounts'
      : 'Cannot be combined with other discounts unless stated'
    return interpolate(template, {
      summary: d.summary || d.shortSummary || '',
      min_order: minOrder || '—',
      code: code || '—',
      stacking_note: stackingNote,
    })
  }

  // ── Cart-aware recompute ──────────────────────────────────────────────

  function recomputeForCart(discounts, cartSubtotal, variantPrice) {
    if (cartSubtotal == null && variantPrice == null) return discounts
    const baseline = Math.max(Number(cartSubtotal) || 0, Number(variantPrice) || 0)
    if (baseline <= 0) return discounts
    return discounts.map((d) => {
      const q = d && d.qualification
      if (!q || q.progressMetric !== 'subtotal' || q.requiredValue == null) return d
      const required = Number(q.requiredValue)
      if (!(required > 0)) return d
      if (baseline >= required) {
        return Object.assign({}, d, {
          qualification: Object.assign({}, q, {
            isSatisfied: true,
            applicability: 'current',
            progressPercent: 100,
            currentValue: baseline,
            remainingValue: 0,
            matchedSubtotalAmount: baseline,
          }),
        })
      }
      const remaining = Math.round((required - baseline) * 100) / 100
      const pct = Math.round((baseline / required) * 100)
      return Object.assign({}, d, {
        qualification: Object.assign({}, q, {
          isSatisfied: false,
          applicability: 'potential',
          progressPercent: pct,
          currentValue: baseline,
          remainingValue: remaining,
          matchedSubtotalAmount: baseline,
        }),
      })
    })
  }

  async function fetchCartSubtotal() {
    try {
      const res = await fetch('/cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      if (!res.ok) return null
      const cart = await res.json()
      if (cart && cart.total_price != null) return Number(cart.total_price) / 100
      if (cart && cart.items_subtotal_price != null) return Number(cart.items_subtotal_price) / 100
      return null
    } catch (_) {
      return null
    }
  }

  // ── Live cart change subscription ─────────────────────────────────────

  function subscribeToCartChanges(callback) {
    const MUTATION_PATHS = [
      '/cart/add', '/cart/add.js',
      '/cart/change', '/cart/change.js',
      '/cart/update', '/cart/update.js',
      '/cart/clear', '/cart/clear.js',
    ]

    function isCartMutation(url) {
      if (typeof url !== 'string') return false
      try {
        const u = new URL(url, window.location.origin)
        return MUTATION_PATHS.some((p) => u.pathname === p)
      } catch (_) {
        return MUTATION_PATHS.some((p) => url.indexOf(p) !== -1)
      }
    }

    let pending
    function debouncedFire() {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        try { callback() } catch (_) {}
      }, 120)
    }

    const origFetch = window.fetch
    if (origFetch && !window.__saiC1Patched) {
      window.__saiC1Patched = true
      window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url)
        const result = origFetch.apply(this, arguments)
        if (isCartMutation(url)) result.then(debouncedFire, debouncedFire)
        return result
      }
    }

    const OrigXHR = window.XMLHttpRequest
    if (OrigXHR && !window.__saiC1XHRPatched) {
      window.__saiC1XHRPatched = true
      const origOpen = OrigXHR.prototype.open
      const origSend = OrigXHR.prototype.send
      OrigXHR.prototype.open = function (method, url) {
        this.__saiC1Url = url
        return origOpen.apply(this, arguments)
      }
      OrigXHR.prototype.send = function () {
        if (isCartMutation(this.__saiC1Url)) {
          this.addEventListener('loadend', debouncedFire)
        }
        return origSend.apply(this, arguments)
      }
    }

    const evtNames = ['cart:updated', 'cart:refresh', 'cart:change', 'cart:added', 'cart:removed', 'shopify:cart:update']
    evtNames.forEach((name) => document.addEventListener(name, debouncedFire))
  }

  // ── Lock icon SVGs ────────────────────────────────────────────────────

  function lockIconSvg(style) {
    if (style === 'info_circle') {
      return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    }
    if (style === 'lock_open') {
      return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>'
    }
    return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
  }

  // ── Card builder ──────────────────────────────────────────────────────

  function buildCard(d, ctx) {
    const { config, labels } = ctx
    const isAutomatic = d.applicationType === 'automatic'
    const code = (d.codes && d.codes[0]) || null
    const isCurrent = isApplicable(d)
    const allowCopy = code && !isAutomatic && (isCurrent || config.enableCopyOnPotential)

    const treatmentClass = !isCurrent
      ? ` sai-c1mzmpkz__card--potential sai-c1mzmpkz__card--treatment-${config.potentialVisualTreatment || 'subtle'}`
      : ''

    // Image-leading layout (Vaaree-style): big image on the left, content
    // in a right column. Triggered when card_icon_position is 'left' AND
    // show_coupon_icon is on. If no URL provided, a built-in SVG coupon
    // ticket renders as the default visual.
    const iconPosition = config.cardIconPosition || 'top_right'
    const useImageLeading = iconPosition === 'left' && config.showCouponIcon

    const card = el('article', `sai-c1mzmpkz__card${treatmentClass}${useImageLeading ? ' sai-c1mzmpkz__card--image-leading' : ''}`, {
      'data-discount-id': d.id || '',
      'data-applicability': (d.qualification && d.qualification.applicability) || '',
    })

    let body = card
    if (useImageLeading) {
      const imgCol = el('div', 'sai-c1mzmpkz__card-image-col')
      if (config.couponIconUrl) {
        imgCol.appendChild(el('img', 'sai-c1mzmpkz__card-image', {
          src: config.couponIconUrl,
          alt: '',
          loading: 'lazy',
        }))
      } else {
        const fallback = el('span', 'sai-c1mzmpkz__card-image-fallback', { 'aria-hidden': 'true' })
        fallback.innerHTML = DEFAULT_COUPON_SVG
        imgCol.appendChild(fallback)
      }
      card.appendChild(imgCol)
      body = el('div', 'sai-c1mzmpkz__card-body')
      card.appendChild(body)
    } else if (config.showCouponIcon && config.couponIconUrl && iconPosition !== 'none') {
      // Legacy top-right icon.
      card.appendChild(el('img', 'sai-c1mzmpkz__icon', {
        src: config.couponIconUrl,
        alt: '',
        loading: 'lazy',
      }))
    } else if (!isCurrent && config.potentialVisualTreatment === 'locked') {
      const lock = el('span', 'sai-c1mzmpkz__lock', { 'aria-hidden': 'true' })
      lock.innerHTML = lockIconSvg(config.lockIconStyle || 'lock')
      card.appendChild(lock)
    }

    // Status badge
    if (config.showStatusBadge) {
      const badgeLabel = isCurrent
        ? (labels.applicableStatusLabel || 'Available now')
        : (labels.potentialStatusLabel || 'Almost there')
      body.appendChild(el('span', `sai-c1mzmpkz__status-badge sai-c1mzmpkz__status-badge--${isCurrent ? 'current' : 'potential'}`, {
        text: badgeLabel,
      }))
    }

    // Near-miss as badge under headline (alternative position)
    let remainingText = null
    if (config.showRemainingAmount && !isCurrent) {
      remainingText = formatRemaining(d, config.remainingAmountTemplate, config.currencyCode)
    }
    if (remainingText && config.nearMissPosition === 'badge') {
      body.appendChild(el('span', 'sai-c1mzmpkz__remaining sai-c1mzmpkz__remaining--badge', { text: remainingText }))
    }

    // Discount type label
    if (config.showTypeLabel) {
      body.appendChild(el('h3', 'sai-c1mzmpkz__type-label', { text: formatTypeLabel(d, config.currencyCode) }))
    }

    // Savings callout
    if (config.showSavingsCallout) {
      const savings = formatSavings(d, config.savingsDisplayMode, config.currencyCode)
      if (savings) body.appendChild(el('span', 'sai-c1mzmpkz__savings', { text: savings }))
    }

    // Description — with optional inline "see details" link that opens the
    // T&C modal. On mobile the link sits inline at the end of the truncated
    // text (Vaaree-style "...see details"); on desktop it stays inline too,
    // and the standalone Terms button below is only shown when not using
    // inline mode.
    const wantsInlineTermsLink = config.showTerms
    if (config.showDescription && (d.summary || d.shortSummary)) {
      const descWrap = el('p', 'sai-c1mzmpkz__description')
      descWrap.appendChild(document.createTextNode(d.summary || d.shortSummary))
      if (wantsInlineTermsLink) {
        descWrap.appendChild(document.createTextNode(' '))
        descWrap.appendChild(el('button', 'sai-c1mzmpkz__description-link', {
          type: 'button',
          'data-sai-tc-trigger': '',
          'data-discount-id': d.id || '',
          text: labels.termsLabel || 'see details',
        }))
      }
      body.appendChild(descWrap)
    }

    // Min order line
    if (config.showMinOrderThreshold) {
      const minOrderText = formatMinOrder(d, labels.minOrderTemplate, config.currencyCode)
      if (minOrderText) body.appendChild(el('p', 'sai-c1mzmpkz__min-order', { text: minOrderText }))
    }

    // Expiry display
    if (config.showExpiry) {
      const expiryText = formatExpiry(d, config.expiryFormat)
      if (expiryText) body.appendChild(el('p', 'sai-c1mzmpkz__expiry', { text: expiryText }))
    }

    // Near-miss in flow (below description)
    if (remainingText && config.nearMissPosition === 'below_description') {
      body.appendChild(el('p', 'sai-c1mzmpkz__remaining', { text: remainingText }))
    }

    // Progress bar (potential only)
    if (config.showRemainingAmount && !isCurrent) {
      const bar = el('div', 'sai-c1mzmpkz__progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' })
      const pct = progressPct(d)
      bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)))
      const fill = el('div', 'sai-c1mzmpkz__progress-fill')
      fill.style.transform = `scaleX(${pct})`
      bar.appendChild(fill)
      body.appendChild(bar)
    }

    // Code chip + copy button row
    if (config.showCodeChip && code && !isAutomatic) {
      const row = el('div', 'sai-c1mzmpkz__code-row')
      row.appendChild(el('span', 'sai-c1mzmpkz__code-label', { text: labels.codeLabel }))
      row.appendChild(el('span', 'sai-c1mzmpkz__code-chip', { text: code }))
      if (config.showCopyButton && allowCopy) {
        row.appendChild(el('button', 'sai-c1mzmpkz__copy-btn', {
          type: 'button',
          'data-sai-copy': code,
          'aria-pressed': 'false',
          'aria-label': `${labels.copyCtaLabel} ${code}`,
          text: labels.copyCtaLabel,
        }))
      }
      body.appendChild(row)
    }

    // CTA — automatic pill OR near-miss-replace-cta
    if (isAutomatic) {
      body.appendChild(el('span', 'sai-c1mzmpkz__card-cta', { text: labels.automaticPillLabel }))
    } else if (remainingText && config.nearMissPosition === 'replace_cta') {
      body.appendChild(el('span', 'sai-c1mzmpkz__card-cta', { text: remainingText }))
    }

    // Standalone Terms toggle — only when description is hidden (and thus
    // no inline link surfaces it). When the description is visible we surface
    // T&C via the inline link instead of a duplicate button.
    if (config.showTerms && !config.showDescription) {
      body.appendChild(el('button', 'sai-c1mzmpkz__terms-toggle', {
        type: 'button',
        'data-sai-tc-trigger': '',
        'data-discount-id': d.id || '',
        text: labels.termsLabel,
      }))
    }

    return card
  }

  // ── Promo blocks ─────────────────────────────────────────────────────

  function buildPromoBlock(block) {
    const type = block.type || 'image_banner'
    const wrap = el('div', `sai-c1mzmpkz__promo-block sai-c1mzmpkz__promo-block--${type}`)
    if (type === 'labeled_divider') {
      if (block.headline) wrap.appendChild(el('span', 'sai-c1mzmpkz__promo-headline', { text: block.headline }))
      return wrap
    }
    if (block.imageUrl) {
      wrap.appendChild(el('img', 'sai-c1mzmpkz__promo-image', { src: block.imageUrl, alt: block.imageAlt || '', loading: 'lazy' }))
    }
    if (block.headline) wrap.appendChild(el('h4', 'sai-c1mzmpkz__promo-headline', { text: block.headline }))
    if (block.body) wrap.appendChild(el('p', 'sai-c1mzmpkz__promo-body', { text: block.body }))
    if (block.link) wrap.appendChild(el('a', 'sai-c1mzmpkz__promo-link', { href: block.link, text: 'Learn more' }))
    return wrap
  }

  // ── Section list builder + overflow ──────────────────────────────────

  function buildSectionList(discounts, ctx, kind, maxVisible) {
    const group = el('section', `sai-c1mzmpkz__group sai-c1mzmpkz__group--${kind}`)
    const list = el('div', 'sai-c1mzmpkz__list')
    discounts.forEach((d, i) => {
      const card = buildCard(d, ctx)
      if (typeof maxVisible === 'number' && i >= maxVisible) {
        card.setAttribute('data-sai-overflow', 'hidden')
      }
      list.appendChild(card)
    })
    if (ctx.config.listLayout === 'carousel') {
      const viewportCls = 'sai-c1mzmpkz__carousel-viewport' + (ctx.config.carouselShowArrows ? ' sai-c1mzmpkz__carousel-viewport--has-arrows' : '')
      const viewport = el('div', viewportCls)
      viewport.appendChild(list)
      if (ctx.config.carouselShowArrows) {
        viewport.appendChild(el('button', 'sai-c1mzmpkz__carousel-arrow sai-c1mzmpkz__carousel-arrow--prev', { type: 'button', 'aria-label': 'Previous', 'data-sai-carousel-prev': '' }))
        viewport.appendChild(el('button', 'sai-c1mzmpkz__carousel-arrow sai-c1mzmpkz__carousel-arrow--next', { type: 'button', 'aria-label': 'Next', 'data-sai-carousel-next': '' }))
      }
      group.appendChild(viewport)
      if (ctx.config.carouselShowDots) {
        const dots = el('div', 'sai-c1mzmpkz__dots', { 'data-sai-carousel-dots': '' })
        for (let i = 0; i < discounts.length; i++) {
          dots.appendChild(el('button', 'sai-c1mzmpkz__dot', { type: 'button', 'data-sai-dot-index': String(i), 'aria-label': `Go to offer ${i + 1}`, 'aria-current': i === 0 ? 'true' : 'false' }))
        }
        group.appendChild(dots)
      }
    } else {
      group.appendChild(list)
    }
    return group
  }

  function attachCarousel(group, ctx) {
    const list = group.querySelector('.sai-c1mzmpkz__list')
    if (!list) return
    const prev = group.querySelector('[data-sai-carousel-prev]')
    const next = group.querySelector('[data-sai-carousel-next]')
    const dots = group.querySelectorAll('[data-sai-dot-index]')

    function scrollByCards(delta) {
      const firstCard = list.querySelector('.sai-c1mzmpkz__card')
      if (!firstCard) return
      const step = firstCard.getBoundingClientRect().width + 12
      list.scrollBy({ left: step * delta, behavior: 'smooth' })
    }

    if (prev) prev.addEventListener('click', () => scrollByCards(-1))
    if (next) next.addEventListener('click', () => scrollByCards(1))

    dots.forEach((dot) => {
      dot.addEventListener('click', () => {
        const idx = Number(dot.getAttribute('data-sai-dot-index')) || 0
        const cards = list.querySelectorAll('.sai-c1mzmpkz__card')
        if (cards[idx]) cards[idx].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
      })
    })

    if (dots.length > 0) {
      function updateActiveDot() {
        const cards = list.querySelectorAll('.sai-c1mzmpkz__card')
        if (cards.length === 0) return
        // End-of-scroll guard: when the viewport has reached the rightmost edge,
        // force the last card's dot active. The nearest-to-left-edge heuristic
        // breaks here because the last card may never align to the list's left
        // edge when multiple cards fit in the viewport.
        const atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 2
        let nearest = atEnd ? cards.length - 1 : 0
        if (!atEnd) {
          let best = Number.POSITIVE_INFINITY
          const listLeft = list.getBoundingClientRect().left
          cards.forEach((c, i) => {
            const d = Math.abs(c.getBoundingClientRect().left - listLeft)
            if (d < best) { best = d; nearest = i }
          })
        }
        dots.forEach((dot, i) => dot.setAttribute('aria-current', i === nearest ? 'true' : 'false'))
      }
      list.addEventListener('scroll', updateActiveDot, { passive: true })
      // Also re-run on resize since clientWidth / scrollWidth change.
      window.addEventListener('resize', updateActiveDot)
    }

    if (ctx.config.carouselAutoplay) {
      const intervalMs = Math.max(1500, Number(ctx.config.carouselAutoplayIntervalMs) || 5000)
      let timer = setInterval(() => {
        const cards = list.querySelectorAll('.sai-c1mzmpkz__card')
        if (cards.length < 2) return
        const atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 4
        if (atEnd) list.scrollTo({ left: 0, behavior: 'smooth' })
        else scrollByCards(1)
      }, intervalMs)
      group.addEventListener('mouseenter', () => { clearInterval(timer); timer = null })
      group.addEventListener('mouseleave', () => {
        if (!timer) timer = setInterval(() => {
          const atEnd = list.scrollLeft + list.clientWidth >= list.scrollWidth - 4
          if (atEnd) list.scrollTo({ left: 0, behavior: 'smooth' })
          else scrollByCards(1)
        }, intervalMs)
      })
    }
  }

  function attachOverflowExpand(body, ctx) {
    body.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.matches('[data-sai-overflow-expand]')) return
      const groupSelector = target.getAttribute('data-sai-target-group')
      const hidden = groupSelector
        ? body.querySelectorAll(`.sai-c1mzmpkz__group--${groupSelector} .sai-c1mzmpkz__card[data-sai-overflow="hidden"]`)
        : body.querySelectorAll('.sai-c1mzmpkz__card[data-sai-overflow="hidden"]')

      ctx.track(`${FEATURE_SLUG}:overflow_expanded`, {
        mode: ctx.config.overflowBehavior,
        hidden_count: hidden.length,
      })

      if (ctx.config.overflowBehavior === 'open_popup') {
        openOverflowPopup(Array.from(hidden), ctx)
      } else {
        hidden.forEach((c) => c.removeAttribute('data-sai-overflow'))
        target.remove()
      }
    })
  }

  function openOverflowPopup(cards, ctx) {
    const root = el('div', 'sai-c1mzmpkz-popup', { role: 'dialog', 'aria-modal': 'true' })
    const backdrop = el('div', 'sai-c1mzmpkz-popup__backdrop', { 'data-sai-popup-dismiss': '' })
    const panel = el('div', 'sai-c1mzmpkz-popup__panel')
    panel.appendChild(el('button', 'sai-c1mzmpkz-popup__close', { type: 'button', 'aria-label': 'Close', 'data-sai-popup-dismiss': '', html: '&times;' }))
    cards.forEach((c) => {
      const clone = c.cloneNode(true)
      clone.removeAttribute('data-sai-overflow')
      panel.appendChild(clone)
    })
    root.appendChild(backdrop)
    root.appendChild(panel)
    document.body.appendChild(root)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function close() {
      root.remove()
      document.body.style.overflow = prevOverflow
    }
    root.addEventListener('click', (e) => {
      const t = e.target
      if (t instanceof Element && t.closest('[data-sai-popup-dismiss]')) close()
    })
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey, true) }
    }, true)
  }

  // ── Copy CTA + description expand + dropdown ─────────────────────────

  function attachCopy(host, labels, durationMs, track) {
    const fire = track || noop
    host.addEventListener('click', async (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const btn = target.closest('[data-sai-copy]')
      if (!btn) return
      const code = btn.getAttribute('data-sai-copy') || ''
      if (!code) return
      const card = btn.closest('[data-discount-id]')
      const discountId = card ? card.getAttribute('data-discount-id') : null
      const surface = btn.closest('.sai-c1mzmpkz-tc') ? 'terms_modal' : 'card'
      let copied = false
      try {
        await navigator.clipboard.writeText(code)
        copied = true
      } catch (_) {
        const tmp = document.createElement('textarea')
        tmp.value = code
        tmp.setAttribute('readonly', '')
        tmp.style.position = 'absolute'
        tmp.style.left = '-9999px'
        document.body.appendChild(tmp)
        tmp.select()
        try { copied = document.execCommand('copy') } catch (_) {}
        document.body.removeChild(tmp)
      }
      fire(`${FEATURE_SLUG}:copy_code`, {
        discount_id: discountId,
        discount_code: code,
        surface: surface,
        copied: copied,
      })
      const originalLabel = btn.textContent
      btn.textContent = labels.copySuccessLabel
      btn.setAttribute('aria-pressed', 'true')
      setTimeout(() => {
        btn.textContent = originalLabel
        btn.setAttribute('aria-pressed', 'false')
      }, durationMs || 1500)
    })
  }

  function attachDescriptionExpand(host, expandable) {
    if (!expandable) return
    const descs = host.querySelectorAll('.sai-c1mzmpkz__description')
    descs.forEach((desc) => {
      // Measure ONLY the description text, not the trailing inline T&C link.
      // The link adds to scrollHeight even on short descriptions, which
      // would always trigger the toggle. Temporarily detach the link for
      // measurement, then re-attach.
      const link = desc.querySelector('.sai-c1mzmpkz__description-link')
      let parked = null
      if (link) { parked = link.previousSibling; link.remove() }
      const overflowing = desc.scrollHeight - desc.clientHeight > 2
      if (link) {
        if (parked) parked.after(link)
        else desc.appendChild(link)
      }
      if (!overflowing) return
      const toggle = el('button', 'sai-c1mzmpkz__description-toggle', {
        type: 'button',
        text: 'Read more',
        'aria-expanded': 'false',
      })
      desc.insertAdjacentElement('afterend', toggle)
      toggle.addEventListener('click', () => {
        const expanded = desc.classList.toggle('sai-c1mzmpkz__description--expanded')
        toggle.textContent = expanded ? 'Show less' : 'Read more'
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      })
    })
  }

  function attachDropdown(host, track) {
    const fire = track || noop
    const trigger = host.querySelector('[data-sai-dropdown-trigger]')
    const panel = host.querySelector('.sai-c1mzmpkz__dropdown-panel')
    if (!trigger || !panel) return
    trigger.addEventListener('click', () => {
      const expanded = trigger.getAttribute('aria-expanded') === 'true'
      const nextOpen = !expanded
      trigger.setAttribute('aria-expanded', nextOpen ? 'true' : 'false')
      panel.setAttribute('data-open', nextOpen ? 'true' : 'false')
      fire(`${FEATURE_SLUG}:dropdown_toggled`, { open: nextOpen })
    })
  }

  function setDropdownLabel(host, count, maxSavingsStr, template) {
    const labelEl = host.querySelector('[data-sai-dropdown-label]')
    if (!labelEl) return
    labelEl.textContent = interpolate(template || '{count} offers available', {
      count: String(count),
      max_savings: maxSavingsStr || '',
    })
  }

  function maxSavingsString(discounts, currency) {
    if (!discounts.length) return ''
    let best = 0
    for (const d of discounts) {
      const s = estimatedSavingsAmount(d)
      if (s > best) best = s
    }
    if (best <= 0) return ''
    return moneyFormatter(currency).format(best)
  }

  // ── T&C modal / drawer ──────────────────────────────────────────────

  function findDiscount(discounts, id) {
    return discounts.find((d) => d && d.id === id) || null
  }

  function trapFocus(container, event) {
    if (event.key !== 'Tab') return
    const focusables = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    if (focusables.length === 0) { event.preventDefault(); return }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault() }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault() }
  }

  function openTermsSurface(d, ctx) {
    const { labels, config } = ctx
    const isMobile = !window.matchMedia('(min-width: 768px)').matches
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const root = el('div', 'sai-c1mzmpkz-tc', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': `sai-tc-title-${SNIPPET_ID}`,
      'data-state': 'closed',
    })
    const backdrop = el('div', 'sai-c1mzmpkz-tc__backdrop', { 'data-sai-tc-dismiss': '' })
    const panel = el('div', `sai-c1mzmpkz-tc__panel sai-c1mzmpkz-tc__panel--${isMobile ? 'drawer' : 'modal'}`)

    if (isMobile) panel.appendChild(el('div', 'sai-c1mzmpkz-tc__handle'))

    const header = el('div', 'sai-c1mzmpkz-tc__header')
    header.appendChild(el('h2', 'sai-c1mzmpkz-tc__title', {
      id: `sai-tc-title-${SNIPPET_ID}`,
      text: d.title || formatTypeLabel(d, config.currencyCode),
    }))
    header.appendChild(el('button', 'sai-c1mzmpkz-tc__close', { type: 'button', 'aria-label': 'Close', 'data-sai-tc-dismiss': '', html: '&times;' }))
    panel.appendChild(header)

    const body = el('div', 'sai-c1mzmpkz-tc__body')
    body.appendChild(el('p', null, { text: interpolateTerms(config.termsTemplate, d, config.currencyCode) }))
    panel.appendChild(body)

    const isAutomatic = d.applicationType === 'automatic'
    const code = (d.codes && d.codes[0]) || null
    const ctaBtn = el('button', 'sai-c1mzmpkz-tc__cta', { type: 'button' })
    if (isAutomatic || !code) {
      ctaBtn.textContent = 'Close'
      ctaBtn.setAttribute('data-sai-tc-dismiss', '')
    } else {
      ctaBtn.textContent = labels.copyCtaLabel + ' ' + code
      ctaBtn.setAttribute('data-sai-copy', code)
    }
    panel.appendChild(ctaBtn)

    root.appendChild(backdrop)
    root.appendChild(panel)
    document.body.appendChild(root)

    const prevBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function close() {
      root.setAttribute('data-state', 'closed')
      const cleanup = () => {
        document.removeEventListener('keydown', onKey, true)
        root.removeEventListener('click', onClick)
        root.removeEventListener('keydown', onTrap, true)
        if (root.parentNode) root.parentNode.removeChild(root)
        document.body.style.overflow = prevBodyOverflow
        if (previouslyFocused) previouslyFocused.focus()
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced) cleanup()
      else setTimeout(cleanup, 240)
    }

    function onClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-sai-tc-dismiss]')) { event.preventDefault(); close() }
    }
    function onKey(event) { if (event.key === 'Escape') close() }
    function onTrap(event) { trapFocus(root, event) }

    root.addEventListener('click', onClick)
    root.addEventListener('keydown', onTrap, true)
    document.addEventListener('keydown', onKey, true)

    attachCopy(root, labels, ctx.config.copySuccessDurationMs, ctx.track)

    // Force a reflow so the browser paints data-state="closed" first,
    // then double-rAF to ensure the transition has a clean from-state.
    // rAF alone isn't enough — the browser may coalesce the append + state
    // change into one paint and skip the transition.
    void root.offsetHeight
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        root.setAttribute('data-state', 'open')
        const firstFocusable = panel.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (firstFocusable instanceof HTMLElement) firstFocusable.focus()
      })
    })
  }

  // Attach T&C delegation ONCE per host. The listener reads the live
  // discounts list off `ctx.currentDiscounts` so subsequent cart-driven
  // re-renders don't need to rebind (and re-binding would stack listeners
  // → multiple drawers per click).
  function attachTermsTriggers(host, ctx) {
    if (host.dataset.saiTermsBound === '1') return
    host.dataset.saiTermsBound = '1'
    host.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const trigger = target.closest('[data-sai-tc-trigger]')
      if (!trigger) return
      const id = trigger.getAttribute('data-discount-id') || ''
      const d = findDiscount(ctx.currentDiscounts || [], id)
      if (!d) return
      ctx.track(`${FEATURE_SLUG}:terms_opened`, {
        discount_id: d.id || null,
        discount_code: (d.codes && d.codes[0]) || null,
        application_type: d.applicationType || null,
      })
      openTermsSurface(d, ctx)
    })
  }

  // ── Render ───────────────────────────────────────────────────────────

  function initHost(host) {
    if (host.dataset.saiInitialized === '1') return
    host.dataset.saiInitialized = '1'

    const payloadEl = host.querySelector('script[data-sai-payload]')
    const payload = safeParsePayload(payloadEl)
    if (!payload || !payload.config) return

    const config = payload.config
    const labels = payload.labels || {}
    const variantsById = payload.variants || {}
    let activeVariantId = payload.currentVariantId != null ? String(payload.currentVariantId) : null

    // Extract a variant's discounts blob into an array. Server emits either
    // `{ discounts: [...] }` or `null`; either form maps to `[]` on absence.
    function extractDiscounts(blob) {
      if (!blob) return []
      if (Array.isArray(blob)) return blob
      if (Array.isArray(blob.discounts)) return blob.discounts
      return []
    }
    function discountsForVariant(variantId) {
      if (variantId != null && variantsById[String(variantId)]) {
        return extractDiscounts(variantsById[String(variantId)].discounts)
      }
      return (payload.discounts && payload.discounts.discounts) || []
    }
    function priceForVariant(variantId) {
      if (variantId != null && variantsById[String(variantId)]) {
        const p = variantsById[String(variantId)].price
        if (p != null) return p
      }
      return config.variantPrice
    }

    let baseDiscounts = discountsForVariant(activeVariantId)
    const promoBlocks = payload.promoBlocks || []

    // Bind analytics. The Spectrum SDK auto-attaches the standard envelope
    // (snippet_id / instance_id / experience_handle / experience_variant_id /
    // page_context) and the $spectrum: prefix. No-bind fallback: if the SDK
    // isn't on the page (theme without app embed), analytics become a noop
    // and the widget still functions.
    const wrapper = host.closest('[data-spectrum-lq-snippet]') || host
    const api = window.__spectrumAi && window.__spectrumAi.snippet
    let trackFn = noop
    let emitFn = noop
    if (api && typeof api.bind === 'function') {
      try {
        const handles = api.bind(wrapper, ({ currentVariantId } = {}) => {
          // Variant resolution — swap the per-variant discount snapshot and
          // re-render. Cart-driven recompute (subscribeToCartChanges) still
          // mutates `baseDiscounts` between variant swaps; switching variant
          // resets back to the server snapshot for the new variant id.
          if (currentVariantId == null) return
          const nextId = String(currentVariantId)
          if (nextId === activeVariantId) return
          activeVariantId = nextId
          baseDiscounts = discountsForVariant(nextId)
          config.variantPrice = priceForVariant(nextId)
          lastRendered = baseDiscounts
          render(baseDiscounts)
        })
        if (handles) {
          if (typeof handles.track === 'function') trackFn = safeFn(handles.track)
          if (typeof handles.emit === 'function') emitFn = safeFn(handles.emit)
        }
      } catch (_) { /* keep noops */ }
    }
    const ctx = { config, labels, track: trackFn, emit: emitFn }

    const body = host.querySelector('[data-sai-body]')
    const headingEl = host.querySelector('[data-sai-heading]')
    if (!body) return

    function render(discounts) {
      body.innerHTML = ''

      const { applicable, potential } = partition(discounts)
      applicable.sort(applicableComparator(config.applicableSort))
      potential.sort(potentialComparator(config.potentialSort))

      const totalCount = applicable.length + potential.length

      // Heading interpolation ({count} placeholder)
      if (headingEl) {
        const baseHeading = headingEl.getAttribute('data-sai-heading-template') || headingEl.textContent
        headingEl.setAttribute('data-sai-heading-template', baseHeading)
        headingEl.textContent = interpolate(baseHeading, { count: String(totalCount) })
      }

      // Dropdown label
      const maxSavings = maxSavingsString(applicable.length ? applicable : discounts, config.currencyCode)
      setDropdownLabel(host, totalCount, maxSavings, config.dropdownCollapsedLabel || '{count} offers available')

      // Empty state
      if (totalCount === 0) {
        if (labels.emptyStateBehavior === 'hide_section') {
          // hide the whole snippet container
          host.style.display = 'none'
          return
        }
        host.style.display = ''
        const empty = el('div', 'sai-c1mzmpkz__empty')
        empty.appendChild(el('p', 'sai-c1mzmpkz__empty-heading', { text: labels.emptyStateHeading || 'No active offers' }))
        empty.appendChild(el('p', 'sai-c1mzmpkz__empty-body', { text: labels.emptyStateBody || '' }))
        body.appendChild(empty)
        return
      }
      host.style.display = ''

      function appendPromoBlocksAt(position) {
        if (!config.enablePromoBlocks) return
        for (const block of promoBlocks) {
          if (block && block.position === position && (block.headline || block.body || block.imageUrl)) {
            body.appendChild(buildPromoBlock(block))
          }
        }
      }

      appendPromoBlocksAt('top')

      const combined = applicable.concat(potential)

      // Decide max-visible per section. Combined render uses sum.
      const maxApplicable = Math.max(1, Number(config.maxVisibleApplicable) || 3)
      const maxPotential = Math.max(1, Number(config.maxVisiblePotential) || 3)

      // Build a single combined list (single-row by spec) — but apply per-section visibility separately
      // by tagging cards based on their source section.
      const list = el('section', 'sai-c1mzmpkz__group sai-c1mzmpkz__group--combined')
      const listInner = el('div', 'sai-c1mzmpkz__list')
      let aShown = 0
      let pShown = 0
      let aHidden = 0
      let pHidden = 0
      combined.forEach((d) => {
        const card = buildCard(d, ctx)
        if (isApplicable(d)) {
          if (aShown >= maxApplicable) { card.setAttribute('data-sai-overflow', 'hidden'); aHidden++ } else aShown++
        } else {
          if (pShown >= maxPotential) { card.setAttribute('data-sai-overflow', 'hidden'); pHidden++ } else pShown++
        }
        listInner.appendChild(card)
      })

      if (config.listLayout === 'carousel') {
        const viewportCls = 'sai-c1mzmpkz__carousel-viewport' + (config.carouselShowArrows ? ' sai-c1mzmpkz__carousel-viewport--has-arrows' : '')
        const viewport = el('div', viewportCls)
        viewport.appendChild(listInner)
        if (config.carouselShowArrows) {
          viewport.appendChild(el('button', 'sai-c1mzmpkz__carousel-arrow sai-c1mzmpkz__carousel-arrow--prev', { type: 'button', 'aria-label': 'Previous', 'data-sai-carousel-prev': '' }))
          viewport.appendChild(el('button', 'sai-c1mzmpkz__carousel-arrow sai-c1mzmpkz__carousel-arrow--next', { type: 'button', 'aria-label': 'Next', 'data-sai-carousel-next': '' }))
        }
        list.appendChild(viewport)
        if (config.carouselShowDots) {
          const dots = el('div', 'sai-c1mzmpkz__dots', { 'data-sai-carousel-dots': '' })
          for (let i = 0; i < combined.length; i++) {
            dots.appendChild(el('button', 'sai-c1mzmpkz__dot', { type: 'button', 'data-sai-dot-index': String(i), 'aria-label': `Go to offer ${i + 1}`, 'aria-current': i === 0 ? 'true' : 'false' }))
          }
          list.appendChild(dots)
        }
      } else {
        list.appendChild(listInner)
      }

      appendPromoBlocksAt('after_applicable')
      body.appendChild(list)

      // Overflow CTA
      const totalHidden = aHidden + pHidden
      if (totalHidden > 0) {
        const ctaText = interpolate(labels.overflowCtaLabel || 'View all ({count})', { count: String(totalHidden) })
        const cta = el('button', 'sai-c1mzmpkz__overflow-cta', {
          type: 'button',
          'data-sai-overflow-expand': '',
          text: ctaText,
        })
        body.appendChild(cta)
      }

      appendPromoBlocksAt('between_sections')
      appendPromoBlocksAt('bottom')

      // Carousel wiring (per render — fresh DOM)
      if (config.listLayout === 'carousel') {
        attachCarousel(list, ctx)
      }

      ctx.currentDiscounts = discounts
      requestAnimationFrame(() => attachDescriptionExpand(body, config.descriptionExpandable))
    }

    // Initial render with the per-variant snapshot.
    let lastRendered = baseDiscounts
    render(baseDiscounts)

    // Listeners attached once on host root.
    attachTermsTriggers(host, ctx)
    attachOverflowExpand(body, ctx)
    attachCopy(host, labels, config.copySuccessDurationMs, ctx.track)
    attachDropdown(host, ctx.track)

    // One-shot list_impression fired after first render. The `_impression`
    // suffix is load-bearing — the storefront SDK gates events with this
    // suffix behind the per-brand impressionsEnabled toggle.
    const partRender = partition(baseDiscounts)
    ctx.track(`${FEATURE_SLUG}:list_impression`, {
      applicable_count: partRender.applicable.length,
      potential_count: partRender.potential.length,
      total_count: partRender.applicable.length + partRender.potential.length,
      list_layout: config.listLayout,
    })

    // Cart-aware re-render.
    function syncFromCart() {
      fetchCartSubtotal().then((cartSubtotal) => {
        const updated = recomputeForCart(baseDiscounts, cartSubtotal, config.variantPrice)
        const changed = updated.some((d, i) => {
          const before = lastRendered[i] && lastRendered[i].qualification
          const after = d && d.qualification
          if (!before || !after) return true
          return before.isSatisfied !== after.isSatisfied
            || before.applicability !== after.applicability
            || before.progressPercent !== after.progressPercent
        })
        if (!changed) return
        const wasApplicableCount = partition(lastRendered).applicable.length
        const nowApplicableCount = partition(updated).applicable.length
        lastRendered = updated
        render(updated)
        if (nowApplicableCount !== wasApplicableCount) {
          ctx.track(`${FEATURE_SLUG}:cart_recomputed`, {
            applicable_count: nowApplicableCount,
            potential_count: partition(updated).potential.length,
            applicable_delta: nowApplicableCount - wasApplicableCount,
          })
        }
      })
    }

    syncFromCart()
    subscribeToCartChanges(syncFromCart)
  }

  function waitForVis(host) {
    const root = host.closest('[data-spectrum-lq-snippet]') || host
    if (!root || root.getAttribute('data-spectrum-vis') === 'on' || !root.hasAttribute('data-spectrum-vis')) {
      initHost(host)
      return
    }
    const observer = new MutationObserver(() => {
      if (root.getAttribute('data-spectrum-vis') === 'on') {
        observer.disconnect()
        initHost(host)
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-spectrum-vis'] })
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
