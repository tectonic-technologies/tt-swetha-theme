/* =============================================================================
 * PDP Promotion List (c1mzmpkz) — runtime.
 *
 * Reads the server-emitted JSON payload (data-sai-payload), partitions
 * discounts into "applicable" (current / satisfied) and "potential", renders
 * the 11-zone coupon card, wires Copy-code clipboard, overflow expand /
 * popup, dropdown toggle, description expand, and the T&C modal (desktop) /
 * bottom-sheet drawer (mobile).
 *
 * Container-scoped self-guard via data-mutation-handle. Reads
 * data-spectrum-vis before doing meaningful work (vis-gate contract per
 * snippet-library/CLAUDE.md line 77).
 * ============================================================================= */

;(() => {
  const SNIPPET_ID = 'c1mzmpkz'
  const TAG = 'sai-c1mzmpkz'

  function moneyFormatter(currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode || 'USD' })
    } catch (_) {
      return { format: (n) => `${currencyCode || '$'}${Number(n).toFixed(2)}` }
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

  function formatRemaining(d, templates, currency) {
    const q = d.qualification || {}
    if (q.isSatisfied) return null
    const metric = q.progressMetric
    const remaining = q.remainingValue
    if (remaining == null) return null
    if (metric === 'subtotal') {
      const fmt = moneyFormatter(currency)
      return templates.remainingSubtotalTemplate.replace('{remaining}', fmt.format(remaining))
    }
    if (metric === 'quantity') {
      return templates.remainingQuantityTemplate.replace('{remaining}', String(remaining))
    }
    return null
  }

  function formatMinOrder(d, template, currency) {
    const q = d.qualification || {}
    if (q.progressMetric !== 'subtotal') return null
    if (q.requiredValue == null) return null
    const fmt = moneyFormatter(currency)
    return template.replace('{amount}', fmt.format(q.requiredValue))
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
    return template
      .replace('{summary}', d.summary || d.shortSummary || '')
      .replace('{min_order}', minOrder || '—')
      .replace('{code}', code || '—')
      .replace('{stacking_note}', stackingNote)
  }

  // Cart-aware qualification recompute. The seeded metafield is a per-variant
  // snapshot computed against the variant price alone (no cart context). At
  // render time we know the actual cart subtotal — use the larger of (variant
  // price, cart subtotal) as the effective progress baseline for any
  // subtotal-thresholded discount.
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

  // Live cart subscription. Themes vary widely in how they signal cart changes —
  // some emit custom events (cart:updated, cart:refresh, etc), most don't.
  // The portable approach is to hook fetch + XHR and detect any request to the
  // Shopify cart-mutation endpoints (add/change/update/clear). Triggers a single
  // debounced callback after each mutation completes.
  function subscribeToCartChanges(callback) {
    const MUTATION_PATHS = [
      '/cart/add',
      '/cart/add.js',
      '/cart/change',
      '/cart/change.js',
      '/cart/update',
      '/cart/update.js',
      '/cart/clear',
      '/cart/clear.js',
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

    // Hook fetch
    const origFetch = window.fetch
    if (origFetch && !window.__saiC1Patched) {
      window.__saiC1Patched = true
      window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url)
        const result = origFetch.apply(this, arguments)
        if (isCartMutation(url)) {
          result.then(debouncedFire, debouncedFire)
        }
        return result
      }
    }

    // Hook XHR
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

    // Listen for common theme-emitted events as a belt-and-braces backup.
    const evtNames = ['cart:updated', 'cart:refresh', 'cart:change', 'cart:added', 'cart:removed', 'shopify:cart:update']
    evtNames.forEach((name) => document.addEventListener(name, debouncedFire))
  }

  function buildCard(d, ctx) {
    const { config, labels } = ctx
    const isAutomatic = d.applicationType === 'automatic'
    const code = (d.codes && d.codes[0]) || null
    const card = el('article', 'sai-c1mzmpkz__card', {
      'data-discount-id': d.id || '',
      'data-applicability': (d.qualification && d.qualification.applicability) || '',
    })

    // Zone 3 — Discount Type Label
    card.appendChild(el('h3', 'sai-c1mzmpkz__type-label', { text: formatTypeLabel(d, config.currencyCode) }))

    // Zone 5 — Savings Callout (configurable)
    if (config.showSavingsCallout) {
      const savings = formatSavings(d, config.savingsDisplayMode, config.currencyCode)
      if (savings) card.appendChild(el('span', 'sai-c1mzmpkz__savings', { text: savings }))
    }

    // Zone 4 — Description
    if (d.summary || d.shortSummary) {
      const desc = el('p', 'sai-c1mzmpkz__description', { text: d.summary || d.shortSummary })
      card.appendChild(desc)
      // "Read more" toggle attached on init pass once we can measure scrollHeight
    }

    // Zone 11 — Min order line
    if (config.showMinOrderThreshold) {
      const minOrderText = formatMinOrder(d, labels.minOrderTemplate, config.currencyCode)
      if (minOrderText) card.appendChild(el('p', 'sai-c1mzmpkz__min-order', { text: minOrderText }))
    }

    // Zone 6 — Remaining-to-unlock
    const remaining = formatRemaining(d, labels, config.currencyCode)
    if (remaining) card.appendChild(el('p', 'sai-c1mzmpkz__remaining', { text: remaining }))

    // Progress bar (potential-only, opt-in)
    if (config.showRemainingProgress && d.qualification && d.qualification.applicability === 'potential' && !d.qualification.isSatisfied) {
      const bar = el('div', 'sai-c1mzmpkz__progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' })
      const pct = progressPct(d)
      bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)))
      const fill = el('div', 'sai-c1mzmpkz__progress-fill')
      fill.style.transform = `scaleX(${pct})`
      bar.appendChild(fill)
      card.appendChild(bar)
    }

    // Zones 1 + 2 — Code chip + Copy button
    if (!isAutomatic && code) {
      const row = el('div', 'sai-c1mzmpkz__code-row')
      row.appendChild(el('span', 'sai-c1mzmpkz__code-label', { text: labels.codeLabel }))
      row.appendChild(el('span', 'sai-c1mzmpkz__code-chip', { text: code }))
      const copyBtn = el('button', 'sai-c1mzmpkz__copy-btn', {
        type: 'button',
        'data-sai-copy': code,
        'aria-pressed': 'false',
        'aria-label': `${labels.copyCtaLabel} ${code}`,
        text: labels.copyCtaLabel,
      })
      row.appendChild(copyBtn)
      card.appendChild(row)
    }

    // Zone 8 — CTA / automatic pill
    if (isAutomatic) {
      card.appendChild(el('span', 'sai-c1mzmpkz__card-cta', { text: labels.automaticPillLabel }))
    }

    // Zone 9 — Terms trigger
    if (config.showTerms) {
      const tcBtn = el('button', 'sai-c1mzmpkz__terms-toggle', {
        type: 'button',
        'data-sai-tc-trigger': '',
        'data-discount-id': d.id || '',
        text: labels.termsLabel,
      })
      card.appendChild(tcBtn)
    }

    return card
  }

  function buildPromoBlock(block) {
    const wrap = el('div', 'sai-c1mzmpkz__promo-block')
    if (block.imageUrl) {
      wrap.appendChild(el('img', 'sai-c1mzmpkz__promo-image', { src: block.imageUrl, alt: block.imageAlt || '', loading: 'lazy' }))
    }
    if (block.headline) wrap.appendChild(el('h4', 'sai-c1mzmpkz__promo-headline', { text: block.headline }))
    if (block.body) wrap.appendChild(el('p', 'sai-c1mzmpkz__promo-body', { text: block.body }))
    if (block.link) wrap.appendChild(el('a', 'sai-c1mzmpkz__promo-link', { href: block.link, text: 'Learn more' }))
    return wrap
  }

  function buildSectionList(title, discounts, ctx, kind) {
    const group = el('section', `sai-c1mzmpkz__group sai-c1mzmpkz__group--${kind}`)
    if (ctx.config.showSectionTitles && title) {
      group.appendChild(el('h3', 'sai-c1mzmpkz__group-title', { text: title }))
    }
    const list = el('div', 'sai-c1mzmpkz__list')
    for (const d of discounts) list.appendChild(buildCard(d, ctx))
    group.appendChild(list)
    return group
  }

  function applyOverflow(host, ctx) {
    if (ctx.config.overflowBehavior !== 'expand_inline') return
    const threshold = Math.max(1, Number(ctx.config.overflowThreshold) || 3)
    const allCards = host.querySelectorAll('.sai-c1mzmpkz__card')
    if (allCards.length <= threshold) return
    for (let i = threshold; i < allCards.length; i++) {
      allCards[i].setAttribute('data-sai-overflow', 'hidden')
    }
    const cta = el('button', 'sai-c1mzmpkz__overflow-cta', {
      type: 'button',
      'data-sai-overflow-expand': '',
      text: ctx.labels.overflowCtaLabel,
    })
    host.appendChild(cta)
  }

  function attachOverflowExpand(host) {
    host.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.matches('[data-sai-overflow-expand]')) return
      const hidden = host.querySelectorAll('.sai-c1mzmpkz__card[data-sai-overflow="hidden"]')
      hidden.forEach((c) => c.removeAttribute('data-sai-overflow'))
      target.remove()
    })
  }

  function attachCopy(host, labels) {
    host.addEventListener('click', async (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const btn = target.closest('[data-sai-copy]')
      if (!btn) return
      const code = btn.getAttribute('data-sai-copy') || ''
      if (!code) return
      try {
        await navigator.clipboard.writeText(code)
      } catch (_) {
        // Fallback: select+execCommand for old browsers.
        const tmp = document.createElement('textarea')
        tmp.value = code
        tmp.setAttribute('readonly', '')
        tmp.style.position = 'absolute'
        tmp.style.left = '-9999px'
        document.body.appendChild(tmp)
        tmp.select()
        try { document.execCommand('copy') } catch (_) {}
        document.body.removeChild(tmp)
      }
      const originalLabel = btn.textContent
      btn.textContent = labels.copySuccessLabel
      btn.setAttribute('aria-pressed', 'true')
      setTimeout(() => {
        btn.textContent = originalLabel
        btn.setAttribute('aria-pressed', 'false')
      }, 1500)
    })
  }

  function attachDescriptionExpand(host) {
    // Toggle line-clamp on any description that overflows.
    const descs = host.querySelectorAll('.sai-c1mzmpkz__description')
    descs.forEach((desc) => {
      if (desc.scrollHeight - desc.clientHeight < 2) return
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

  function attachDropdown(host) {
    const trigger = host.querySelector('[data-sai-dropdown-trigger]')
    const panel = host.querySelector('.sai-c1mzmpkz__dropdown-panel')
    if (!trigger || !panel) return
    trigger.addEventListener('click', () => {
      const expanded = trigger.getAttribute('aria-expanded') === 'true'
      trigger.setAttribute('aria-expanded', expanded ? 'false' : 'true')
      if (expanded) panel.setAttribute('hidden', '')
      else panel.removeAttribute('hidden')
    })
  }

  function setDropdownCount(host, count, template) {
    const labelEl = host.querySelector('[data-sai-dropdown-label]')
    if (!labelEl) return
    labelEl.textContent = (template || '{count} offers available').replace('{count}', String(count))
  }

  // ── T&C modal / drawer ──────────────────────────────────────────────────

  function findDiscount(discounts, id) {
    return discounts.find((d) => d && d.id === id) || null
  }

  function trapFocus(container, event) {
    if (event.key !== 'Tab') return
    const focusables = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      last.focus()
      event.preventDefault()
    } else if (!event.shiftKey && document.activeElement === last) {
      first.focus()
      event.preventDefault()
    }
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
    const closeBtn = el('button', 'sai-c1mzmpkz-tc__close', {
      type: 'button',
      'aria-label': 'Close',
      'data-sai-tc-dismiss': '',
      html: '&times;',
    })
    header.appendChild(closeBtn)
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
      if (reduced) {
        cleanup()
      } else {
        setTimeout(cleanup, 240)
      }
    }

    function onClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-sai-tc-dismiss]')) {
        event.preventDefault()
        close()
        return
      }
      // Allow Copy CTA inside the modal to bubble — body click handler also handles copy globally.
    }
    function onKey(event) {
      if (event.key === 'Escape') close()
    }
    function onTrap(event) {
      trapFocus(root, event)
    }

    root.addEventListener('click', onClick)
    root.addEventListener('keydown', onTrap, true)
    document.addEventListener('keydown', onKey, true)

    // Wire copy inside the TC root using the same handler the snippet host uses.
    attachCopy(root, labels)

    // Trigger animation on next frame so transitions run from closed → open.
    requestAnimationFrame(() => {
      root.setAttribute('data-state', 'open')
      const firstFocusable = panel.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (firstFocusable instanceof HTMLElement) firstFocusable.focus()
    })
  }

  function attachTermsTriggers(host, discounts, ctx) {
    host.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const trigger = target.closest('[data-sai-tc-trigger]')
      if (!trigger) return
      const id = trigger.getAttribute('data-discount-id') || ''
      const d = findDiscount(discounts, id)
      if (!d) return
      openTermsSurface(d, ctx)
    })
  }

  // ── Init ────────────────────────────────────────────────────────────────

  function initHost(host) {
    if (host.dataset.saiInitialized === '1') return
    host.dataset.saiInitialized = '1'

    const payloadEl = host.querySelector('script[data-sai-payload]')
    const payload = safeParsePayload(payloadEl)
    if (!payload || !payload.config) return

    const config = payload.config
    const labels = payload.labels || {}
    const baseDiscounts = (payload.discounts && payload.discounts.discounts) || []
    const promoBlocks = payload.promoBlocks || []
    const ctx = { config, labels }

    const body = host.querySelector('[data-sai-body]')
    if (!body) return

    function render(discounts) {
      body.innerHTML = ''

      const { applicable, potential } = partition(discounts)
      const totalCount = applicable.length + potential.length

      if (totalCount === 0) {
        const empty = el('div', 'sai-c1mzmpkz__empty')
        empty.appendChild(el('p', 'sai-c1mzmpkz__empty-heading', { text: labels.emptyStateHeading || 'No active offers' }))
        empty.appendChild(el('p', 'sai-c1mzmpkz__empty-body', { text: labels.emptyStateBody || '' }))
        body.appendChild(empty)
        setDropdownCount(host, 0, labels.dropdownTriggerLabel)
        return
      }

      function appendPromoBlocksAt(position) {
        for (const block of promoBlocks) {
          if (block && block.position === position && (block.headline || block.body || block.imageUrl)) {
            body.appendChild(buildPromoBlock(block))
          }
        }
      }

      if (config.showSectionTitles) {
        // Grouped mode: separate Applicable / Potential sections with sub-headings.
        appendPromoBlocksAt('before_applicable')
        if (applicable.length > 0) {
          body.appendChild(buildSectionList(labels.applicableSectionTitle, applicable, ctx, 'applicable'))
        }
        appendPromoBlocksAt('between_sections')
        if (potential.length > 0) {
          body.appendChild(buildSectionList(labels.potentialSectionTitle, potential, ctx, 'potential'))
        }
        appendPromoBlocksAt('after_potential')
      } else {
        // Combined mode: single list, applicable first then potential.
        appendPromoBlocksAt('before_applicable')
        const combined = applicable.concat(potential)
        body.appendChild(buildSectionList(null, combined, ctx, 'combined'))
        appendPromoBlocksAt('after_potential')
      }

      applyOverflow(body, ctx)
      setDropdownCount(host, totalCount, labels.dropdownTriggerLabel)
      attachTermsTriggers(host, discounts, ctx)

      requestAnimationFrame(() => attachDescriptionExpand(body))
    }

    // Initial render from per-variant snapshot.
    render(baseDiscounts)

    // Listeners attached once on the host root — survive subsequent re-renders.
    attachOverflowExpand(body)
    attachCopy(host, labels)
    attachDropdown(host)

    // Cart-aware re-render — runs on initial load AND whenever the cart mutates.
    let lastRendered = baseDiscounts
    function syncFromCart() {
      fetchCartSubtotal().then((cartSubtotal) => {
        const updated = recomputeForCart(baseDiscounts, cartSubtotal, config.variantPrice)
        // Cheap shallow compare against last rendered set — skip DOM churn if nothing flipped.
        const changed = updated.some((d, i) => {
          const before = lastRendered[i] && lastRendered[i].qualification
          const after = d && d.qualification
          if (!before || !after) return true
          return before.isSatisfied !== after.isSatisfied
            || before.applicability !== after.applicability
            || before.progressPercent !== after.progressPercent
        })
        if (!changed) return
        lastRendered = updated
        render(updated)
      })
    }

    // Initial cart-aware pass (no-op if cart endpoint unreachable or empty).
    syncFromCart()

    // Live subscription: re-sync whenever any cart-mutation request completes.
    subscribeToCartChanges(syncFromCart)
  }

  function waitForVis(host) {
    const root = host.closest('[data-spectrum-lq-snippet]') || host
    if (!root || root.getAttribute('data-spectrum-vis') === 'on' || !root.hasAttribute('data-spectrum-vis')) {
      // No vis attribute at all (legacy / dev) or already on — init immediately.
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
