/* =============================================================================
 * View All Offers (z0q31ww1) — cart entry CTA + Apply Coupon full-page view.
 *
 * Container-scoped via data-mutation-handle. Reads the JSON payload emitted
 * by the Liquid shell, evaluates qualifications against the live cart subtotal,
 * partitions discounts into Applied / Applicable / Potentially Applicable,
 * and renders the page on demand into <body>.
 * ============================================================================= */

;(() => {
  const SNIPPET_ID = 'z0q31ww1'
  const TAG = 'sai-z0q31ww1'
  const FEATURE_SLUG = 'view_all_offers'

  // ── Analytics ────────────────────────────────────────────────────────
  function noop() {}
  function safeFn(fn) {
    return (name, payload) => {
      try {
        fn(name, payload)
      } catch (_) {
        /* analytics is best-effort */
      }
    }
  }

  // ── Icons ────────────────────────────────────────────────────────────
  const ENTRY_ICONS = {
    percent:
      '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 0c1.4 1.9 3.6 1.1 5.6 1.5.4 2 1.9 3.5 4 3.7-.4 2 1 3.8 2.7 5-1 1.8-.5 4 1 5.3-1.5 1.3-2 3.5-1 5.3-1.7 1.2-3.1 3-2.7 5-2.1.2-3.6 1.7-4 3.7-2-.4-4.2.4-5.6 2.3-1.4-1.9-3.6-2.7-5.6-2.3-.4-2-1.9-3.5-4-3.7.4-2-1-3.8-2.7-5 1-1.8.5-4-1-5.3 1.5-1.3 2-3.5 1-5.3 1.7-1.2 3.1-3 2.7-5 2.1-.2 3.6-1.7 4-3.7 2 .4 4.2-.4 5.6-2.3z"/><circle cx="12" cy="12" r="1.7" fill="#fff"/><circle cx="20" cy="20" r="1.7" fill="#fff"/><path d="M21 11 11 21" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    tag: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12V3h9l9 9-9 9zM7.5 8.5h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gift: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13M8 8c-2 0-3-2-1-3s4 1 5 3M16 8c2 0 3-2 1-3s-4 1-5 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron_right:
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  }
  const BACK_ARROW =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const X_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

  // ── Helpers ──────────────────────────────────────────────────────────
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

  function moneyFormatter(code) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code || 'USD',
        currencyDisplay: 'narrowSymbol',
      })
    } catch (_) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code || 'USD' })
      } catch (__) {
        return { format: (n) => `${code || '$'}${Number(n).toFixed(2)}` }
      }
    }
  }

  function fillTemplate(tpl, vars) {
    if (!tpl) return ''
    let out = String(tpl)
    for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]))
    return out
  }

  function parseDiscountsBlob(value) {
    if (!value) return []
    let parsed = value
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch (_) {
        return []
      }
    }
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.discounts)) return parsed.discounts
    return []
  }

  function collectDiscounts(discountsByVariant) {
    const byKey = new Map()
    if (!discountsByVariant || typeof discountsByVariant !== 'object') return []
    for (const variantId of Object.keys(discountsByVariant)) {
      const list = parseDiscountsBlob(discountsByVariant[variantId])
      for (const d of list) {
        const key =
          (d.id != null ? `id:${d.id}` : '') ||
          (Array.isArray(d.codes) && d.codes[0] ? `code:${d.codes[0]}` : null) ||
          `t:${d.title || d.shortSummary || ''}`
        if (!byKey.has(key)) byKey.set(key, d)
      }
    }
    return Array.from(byKey.values())
  }

  function isApplicable(d) {
    const q = d?.qualification
    return !!q && (q.isSatisfied === true || q.applicability === 'current')
  }

  function isPotential(d) {
    const q = d?.qualification
    return !!q && q.applicability === 'potential' && q.isSatisfied !== true
  }

  function getCode(d) {
    if (!d || !Array.isArray(d.codes) || d.codes.length === 0) return null
    const raw = d.codes[0]
    return typeof raw === 'string' ? raw : raw?.code || null
  }

  function isApplied(d, appliedCodes) {
    if (!appliedCodes || appliedCodes.length === 0) return false
    const c = getCode(d)
    return !!c && appliedCodes.includes(String(c).toUpperCase())
  }

  // A discount is "user-specific" when the resolver tagged it as targeting the
  // signed-in customer (tags / segment / personally-issued). The widget reads
  // any of the markers the discounts pipeline may emit so the section lights
  // up whenever such data is present; otherwise the section simply renders 0.
  function isUserSpecific(d) {
    if (!d) return false
    return (
      d.userSpecific === true ||
      d.isUserSpecific === true ||
      d.audience === 'customer' ||
      d.audience === 'user' ||
      d.sessionGenerated === true
    )
  }

  function isSessionGenerated(d) {
    return !!d && d.sessionGenerated === true
  }

  // Recompute qualification against the live cart subtotal — sometimes the
  // server-baked qualification reflects the variant-level scope rather than
  // the cart total. For subtotal-keyed metrics, override.
  function recompute(d, subtotal) {
    if (!d || !d.qualification) return d
    if (d.qualification.progressMetric !== 'subtotal') return d
    const required = Number(d.qualification.requiredValue)
    if (!Number.isFinite(required)) return d
    const isSatisfied = Number(subtotal) >= required
    return {
      ...d,
      qualification: {
        ...d.qualification,
        isSatisfied,
        currentValue: subtotal,
        remainingValue: Math.max(0, required - Number(subtotal)),
        matchedSubtotalAmount: subtotal,
        applicability: isSatisfied ? 'current' : 'potential',
      },
    }
  }

  function savingsAt(d, subtotal) {
    const dv = d?.discountValue
    if (!dv) return 0
    switch (dv.type) {
      case 'PERCENTAGE': {
        const pct = Number(dv.percentage)
        return Number.isFinite(pct) && Number.isFinite(subtotal) ? (subtotal * pct) / 100 : 0
      }
      case 'FIXED': {
        const amt = Number(dv.amount)
        return Number.isFinite(amt) ? Math.min(amt, Number(subtotal) || amt) : 0
      }
      case 'FREE_SHIPPING':
        return 0
      default:
        return 0
    }
  }

  function discountPercent(d, subtotal) {
    const dv = d?.discountValue
    if (!dv) return null
    if (dv.type === 'PERCENTAGE' && Number.isFinite(Number(dv.percentage)))
      return Math.round(Number(dv.percentage))
    if (dv.type === 'FIXED') {
      const abs = savingsAt(d, subtotal)
      if (Number.isFinite(subtotal) && subtotal > 0 && abs > 0)
        return Math.round((abs / subtotal) * 100)
    }
    return null
  }

  function discountTypeLabel(d) {
    const t = d && d.discountValue && d.discountValue.type
    if (t === 'PERCENTAGE') return '% off'
    if (t === 'FIXED') return 'Amount off'
    if (t === 'FREE_SHIPPING') return 'Free shipping'
    return ''
  }

  // Expiry text. 'date' = absolute; 'relative'/'countdown' = time remaining
  // (countdown adds finer units); 'hidden' = nothing. Computed at render time.
  function formatExpiry(d, fmt) {
    if (fmt === 'hidden') return ''
    const end = Date.parse((d && d.endsAt) || '')
    if (!Number.isFinite(end)) return ''
    if (fmt === 'date') {
      try {
        return `Ends ${new Date(end).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      } catch (_) {
        return ''
      }
    }
    const ms = end - Date.now()
    if (ms <= 0) return 'Expired'
    const days = Math.floor(ms / 86400000)
    const hours = Math.floor((ms % 86400000) / 3600000)
    if (days >= 1) return `Ends in ${days}d${fmt === 'countdown' && hours ? ` ${hours}h` : ''}`
    const mins = Math.floor((ms % 3600000) / 60000)
    return `Ends in ${hours}h${fmt === 'countdown' ? ` ${mins}m` : ''}`
  }

  // ── Sorting ──────────────────────────────────────────────────────────
  function sortDiscounts(list, mode, subtotal) {
    const c = list.slice()
    switch (mode) {
      case 'recent_first':
        return c
      case 'highest_savings':
        return c.sort((a, b) => savingsAt(b, subtotal) - savingsAt(a, subtotal))
      case 'expiry_soonest':
        return c.sort(
          (a, b) =>
            (Date.parse(a.endsAt || '') || Number.POSITIVE_INFINITY) -
            (Date.parse(b.endsAt || '') || Number.POSITIVE_INFINITY),
        )
      case 'alphabetical':
        return c.sort((a, b) => String(getCode(a) || '').localeCompare(String(getCode(b) || '')))
      case 'closest_to_qualify':
        return c.sort(
          (a, b) =>
            (Number(a.qualification?.remainingValue) || Number.POSITIVE_INFINITY) -
            (Number(b.qualification?.remainingValue) || Number.POSITIVE_INFINITY),
        )
      case 'highest_potential_savings':
        return c.sort(
          (a, b) =>
            savingsAt(b, subtotal + (Number(a.qualification?.remainingValue) || 0)) -
            savingsAt(a, subtotal + (Number(b.qualification?.remainingValue) || 0)),
        )
      default:
        return c
    }
  }

  // ── Entry CTA ────────────────────────────────────────────────────────
  function setEntryIcon(host, iconName) {
    const slot = host.querySelector('[data-sai-entry-icon]')
    if (!slot) return
    slot.innerHTML = ENTRY_ICONS[iconName] || ENTRY_ICONS.percent
  }

  // Replace both {{token}} and {token} forms so a merchant can write either.
  function interpolateTokens(tpl, vars) {
    if (!tpl) return ''
    let out = String(tpl)
    for (const k of Object.keys(vars)) {
      out = out.split(`{{${k}}}`).join(String(vars[k]))
      out = out.split(`{${k}}`).join(String(vars[k]))
    }
    return out
  }

  function updateEntryMeta(host, ctx) {
    const { config, applicable, applied, autoApplied, subtotal } = ctx
    const total = applicable.length + applied.length + autoApplied.length
    const best = applicable
      .concat(applied)
      .reduce((max, d) => Math.max(max, savingsAt(d, subtotal)), 0)
    const maxSavingsLabel = best > 0 ? ctx.money.format(best) : ''

    // CTA label supports {{count}} / {{max_savings}} placeholders.
    const label = host.querySelector('[data-sai-entry-label]')
    if (label && config.entryCtaText) {
      label.textContent = interpolateTokens(config.entryCtaText, {
        count: total,
        max_savings: maxSavingsLabel,
      })
    }

    const meta = host.querySelector('[data-sai-entry-meta]')
    if (!meta) return
    const parts = []
    if (config.entryCtaShowCount && total > 0) parts.push(`${total} offer${total === 1 ? '' : 's'}`)
    if (config.entryCtaShowMaxSavings && best > 0) parts.push(`Save up to ${maxSavingsLabel}`)
    if (parts.length === 0) {
      meta.hidden = true
    } else {
      meta.hidden = false
      meta.textContent = parts.join(' · ')
    }
  }

  function maybeHideEntry(host, ctx) {
    // Always show the entry CTA — count-based hiding was unreliable once we
    // moved variant-discount hydration to the client, because /products/x.js
    // does not expose metafields on all themes.
    host.classList.remove(`${TAG}--hidden`)
  }

  // ── Page ─────────────────────────────────────────────────────────────
  function discountApplyUrl(code) {
    const safe = encodeURIComponent(String(code || '').toUpperCase())
    return `/discount/${safe}?redirect=/cart`
  }

  function buildCard(d, state, ctx) {
    const { config, money, subtotal } = ctx
    const session = isSessionGenerated(d)
    const card = el(
      'div',
      `${TAG}-card${session && config.sessionCouponHighlight ? ` ${TAG}-card--session` : ''}`,
      {
        'data-state': state,
      },
    )
    if (d && d.id != null) card.setAttribute('data-discount-id', String(d.id))

    // Vertical % OFF bar.
    if (config.showCouponAsset) {
      const pct = discountPercent(d, subtotal)
      const label =
        pct != null
          ? `${pct}% OFF`
          : d.discountValue && d.discountValue.type === 'FREE_SHIPPING'
            ? 'FREE SHIP'
            : ''
      const bar = el('div', `${TAG}-card__bar`, { text: label })
      card.appendChild(bar)
    } else {
      card.appendChild(el('div', `${TAG}-card__bar`))
    }

    // Body.
    const body = el('div', `${TAG}-card__body`)
    const code = getCode(d)
    if (config.showCodeChip && code) {
      const codeRow = el('div', `${TAG}-card__code-row`)
      codeRow.appendChild(el('div', `${TAG}-card__code`, { text: code }))
      if (config.showCopyCodeButton) {
        const copyBtn = el('button', `${TAG}-card__copy`, {
          type: 'button',
          'aria-label': `Copy ${code}`,
          text: 'Copy',
        })
        copyBtn.addEventListener('click', () => {
          try {
            navigator.clipboard?.writeText(code)
            copyBtn.textContent = 'Copied'
            window.setTimeout(() => {
              copyBtn.textContent = 'Copy'
            }, 1500)
          } catch (_) {
            /* clipboard blocked */
          }
        })
        codeRow.appendChild(copyBtn)
      }
      body.appendChild(codeRow)
    } else {
      body.appendChild(el('div', `${TAG}-card__code`, { text: d.title || d.shortSummary || '' }))
    }

    if (session && config.sessionCouponLabel) {
      body.appendChild(el('div', `${TAG}-card__session-label`, { text: config.sessionCouponLabel }))
    }

    if (state === 'applicable' || state === 'applied') {
      const abs = savingsAt(d, subtotal)
      if (config.showSavingsCallout && abs > 0) {
        const pct = discountPercent(d, subtotal)
        let savingsVal = money.format(abs)
        if (config.savingsFormat === 'percentage' && pct != null) savingsVal = `${pct}%`
        else if (config.savingsFormat === 'both' && pct != null)
          savingsVal = `${money.format(abs)} (${pct}%)`
        body.appendChild(
          el('div', `${TAG}-card__savings`, {
            text:
              state === 'applied'
                ? `Saved ${savingsVal} on this order`
                : `Save ${savingsVal} on this order`,
          }),
        )
      }
    } else if (state === 'potential' && config.showRemainingAmount) {
      const remaining = Number(d.qualification?.remainingValue)
      if (Number.isFinite(remaining) && remaining > 0) {
        body.appendChild(
          el('div', `${TAG}-card__remaining`, {
            text: fillTemplate(config.remainingAmountTemplate || 'Add {remaining} more to unlock', {
              remaining: money.format(remaining),
            }),
          }),
        )
      }
    }

    if (config.showDescription && (d.summary || d.shortSummary)) {
      const desc = el('div', `${TAG}-card__description`, { text: d.summary || d.shortSummary })
      desc.style.setProperty('--sai-z0q31ww1-desc-lines', String(config.descriptionMaxLines || 2))
      body.appendChild(desc)
      if (config.descriptionExpandable) {
        const descToggle = el('button', `${TAG}-card__desc-toggle`, { type: 'button', text: 'More' })
        descToggle.addEventListener('click', () => {
          const expanded = desc.classList.toggle(`${TAG}-card__description--expanded`)
          descToggle.textContent = expanded ? 'Less' : 'More'
        })
        body.appendChild(descToggle)
      }
    }

    // Config-gated meta line (discount type / min order / expiry) + terms.
    const metaBits = []
    if (config.showDiscountTypeLabel) {
      const tl = discountTypeLabel(d)
      if (tl) metaBits.push(tl)
    }
    if (config.showMinOrderThreshold) {
      const req = Number(d.qualification && d.qualification.requiredValue)
      if (Number.isFinite(req) && req > 0) metaBits.push(`Min order ${money.format(req)}`)
    }
    if (config.showExpiryDisplay) {
      const ex = formatExpiry(d, config.expiryFormat || 'relative')
      if (ex) metaBits.push(ex)
    }
    if (metaBits.length) body.appendChild(el('div', `${TAG}-card__meta`, { text: metaBits.join(' · ') }))

    if (config.showTerms && config.termsLabel) {
      const termsUrl = d.termsUrl || d.terms_url
      body.appendChild(
        termsUrl
          ? el('a', `${TAG}-card__terms`, {
              href: termsUrl,
              text: config.termsLabel,
              target: '_blank',
              rel: 'noopener',
            })
          : el('span', `${TAG}-card__terms`, { text: config.termsLabel }),
      )
    }
    card.appendChild(body)

    // Trailing CTA.
    const trailing = el('div', `${TAG}-card__trailing`)
    if (state === 'applied') {
      trailing.appendChild(
        el('span', `${TAG}-card__cta ${TAG}-card__cta--applied`, {
          text: config.removeLinkText || 'APPLIED',
        }),
      )
    } else if (state === 'applicable' && code) {
      const btn = el('button', `${TAG}-card__cta`, {
        type: 'button',
        'data-sai-apply': code,
        text: config.applyButtonText || 'APPLY',
      })
      trailing.appendChild(btn)
    }
    card.appendChild(trailing)

    return card
  }

  function buildSection(title, count, list, state, ctx, opts) {
    const { config } = ctx
    const badgeText = opts?.badgeText
    const wrap = el('section', `${TAG}-page__section`)
    const header = el('div', `${TAG}-page__section-header`)
    // The user-specific section is never collapsible — it's the priority slot.
    const collapsible = !!config.enableCollapsibleSections && state !== 'user'
    const defaultCollapsed =
      (state === 'applied' && config.defaultCollapsedApplied) ||
      (state === 'applicable' && config.defaultCollapsedApplicable) ||
      (state === 'potential' && config.defaultCollapsedPotential)

    const titleWrap = el('div', `${TAG}-page__section-title-wrap`)
    if (collapsible) {
      const toggle = el('button', `${TAG}-page__section-toggle`, { type: 'button' })
      toggle.appendChild(document.createTextNode(title))
      const ind = el('span', `${TAG}-page__section-indicator`, {
        text: defaultCollapsed
          ? config.collapseIndicator === 'plus_minus'
            ? '+'
            : '▾'
          : config.collapseIndicator === 'plus_minus'
            ? '−'
            : '▴',
      })
      toggle.appendChild(ind)
      titleWrap.appendChild(toggle)
      header.appendChild(titleWrap)
    } else {
      titleWrap.appendChild(document.createTextNode(title))
      header.appendChild(titleWrap)
    }

    if (config.showSectionCountBadge && count > 0) {
      header.appendChild(el('span', `${TAG}-page__section-count`, { text: String(count) }))
    }
    if (badgeText) {
      header.appendChild(el('span', `${TAG}-page__section-badge`, { text: badgeText }))
    }
    wrap.appendChild(header)

    const body = el('div', `${TAG}-page__section-body`)
    if (collapsible && defaultCollapsed) body.setAttribute('data-collapsed', 'true')

    const maxVisible =
      state === 'applied'
        ? Number(config.appliedMaxVisible)
        : state === 'applicable'
          ? Number(config.applicableMaxVisible)
          : Number(config.potentialMaxVisible)
    const cap = Number.isFinite(maxVisible) ? Math.max(0, maxVisible) : Number.POSITIVE_INFINITY

    list.forEach((d, i) => {
      const card = buildCard(d, state, ctx)
      if (i >= cap) card.setAttribute('data-hidden', 'true')
      body.appendChild(card)
    })

    if (list.length > cap) {
      const showMore = el('button', `${TAG}-page__show-more`, {
        type: 'button',
        text: `Show all ${list.length} →`,
      })
      let expanded = false
      showMore.addEventListener('click', () => {
        expanded = !expanded
        for (const card of body.querySelectorAll('[data-hidden]')) {
          if (card instanceof HTMLElement) card.style.display = expanded ? '' : 'none'
        }
        showMore.textContent = expanded ? 'Show less' : `Show all ${list.length} →`
      })
      // Initial hide.
      for (const c of body.querySelectorAll('[data-hidden]')) {
        if (c instanceof HTMLElement) c.style.display = 'none'
      }
      body.appendChild(showMore)
    }

    // Collapsible toggle wiring.
    if (collapsible) {
      const toggle = header.querySelector(`.${TAG}-page__section-toggle`)
      const ind = header.querySelector(`.${TAG}-page__section-indicator`)
      if (toggle) {
        toggle.addEventListener('click', () => {
          const collapsed = body.getAttribute('data-collapsed') === 'true'
          body.setAttribute('data-collapsed', collapsed ? 'false' : 'true')
          if (ind)
            ind.textContent = !collapsed
              ? config.collapseIndicator === 'plus_minus'
                ? '+'
                : '▾'
              : config.collapseIndicator === 'plus_minus'
                ? '−'
                : '▴'
        })
      }
    }

    wrap.appendChild(body)
    return wrap
  }

  // ── Promotional blocks ───────────────────────────────────────────────
  function promoDismissKey(host, block, idx) {
    const handle = host.getAttribute('data-mutation-handle') || SNIPPET_ID
    return `sai-z0q31ww1-promo:${handle}:${idx}:${block.headline || block.type}`
  }

  function promoDismissed(host, block, idx) {
    if (!block.dismissible) return false
    const key = promoDismissKey(host, block, idx)
    try {
      const store =
        block.dismissPersistence === 'permanent' ? window.localStorage : window.sessionStorage
      return store.getItem(key) === '1'
    } catch (_) {
      return false
    }
  }

  function rememberPromoDismiss(host, block, idx) {
    const key = promoDismissKey(host, block, idx)
    try {
      const store =
        block.dismissPersistence === 'permanent' ? window.localStorage : window.sessionStorage
      store.setItem(key, '1')
    } catch (_) {
      /* storage unavailable — dismiss is then session-only in memory */
    }
  }

  // Block is shown when not dismissed and the visibility audience matches the
  // shopper's auth state.
  function promoVisible(host, block, idx, ctx) {
    if (!block) return false
    if (block.visibility === 'logged_in' && !ctx.config.customerLoggedIn) return false
    if (block.visibility === 'guest' && ctx.config.customerLoggedIn) return false
    if (promoDismissed(host, block, idx)) return false
    // A labeled divider is pure chrome — render even with no copy. Other types
    // need at least a headline, body, or image to be worth showing.
    if (block.type === 'labeled_divider') return !!block.headline
    return !!(block.headline || block.body || block.imageUrl)
  }

  function buildPromoBlock(host, block, idx, ctx) {
    const wrap = el('div', `${TAG}-page__promo ${TAG}-page__promo--${block.type}`)

    if (block.type === 'labeled_divider') {
      wrap.appendChild(document.createTextNode(block.headline || ''))
      return wrap
    }

    if ((block.type === 'image_banner' || block.type === 'text_image') && block.imageUrl) {
      wrap.appendChild(
        el('img', null, { src: block.imageUrl, alt: block.headline || '', loading: 'lazy' }),
      )
    }

    // image_banner is image-only; the others carry text.
    if (block.type !== 'image_banner') {
      const textWrap = el('div', `${TAG}-page__promo-text`)
      if (block.headline)
        textWrap.appendChild(el('p', `${TAG}-page__promo-headline`, { text: block.headline }))
      if (block.body) textWrap.appendChild(el('p', `${TAG}-page__promo-body`, { text: block.body }))

      // CTA: link (anchor), copy_code (button copies block.link), dismiss (button).
      if (block.ctaAction === 'link' && block.link) {
        textWrap.appendChild(
          el('a', `${TAG}-page__promo-cta`, { href: block.link, text: block.ctaLabel || 'Learn more' }),
        )
      } else if (block.ctaAction === 'copy_code' && block.link) {
        const btn = el('button', `${TAG}-page__promo-cta`, {
          type: 'button',
          text: `Copy ${block.link}`,
        })
        btn.addEventListener('click', () => {
          try {
            navigator.clipboard?.writeText(String(block.link))
            btn.textContent = 'Copied!'
            ctx.track(`${FEATURE_SLUG}:promo_copy_code`, { code: block.link })
          } catch (_) {
            /* clipboard blocked */
          }
        })
        textWrap.appendChild(btn)
      } else if (block.ctaAction === 'dismiss') {
        const btn = el('button', `${TAG}-page__promo-cta`, { type: 'button', text: 'Dismiss' })
        btn.addEventListener('click', () => {
          rememberPromoDismiss(host, block, idx)
          wrap.remove()
        })
        textWrap.appendChild(btn)
      }
      wrap.appendChild(textWrap)
    }

    // Dismiss affordance (X) when the block opted in.
    if (block.dismissible) {
      const x = el('button', `${TAG}-page__promo-dismiss`, {
        type: 'button',
        'aria-label': 'Dismiss',
        text: '×',
      })
      x.addEventListener('click', () => {
        rememberPromoDismiss(host, block, idx)
        wrap.remove()
        ctx.track(`${FEATURE_SLUG}:promo_dismiss`, { position: block.position })
      })
      wrap.appendChild(x)
    }

    return wrap
  }

  function openPage(host, ctx) {
    const { config } = ctx
    if (host._pageOpen) return
    host._pageOpen = true
    ctx.track(`${FEATURE_SLUG}:page_opened`, {
      coupons_count: ctx.applicable.length + ctx.applied.length + ctx.autoApplied.length,
    })

    const page = el('div', `${TAG}-page ${TAG}-page--enter-${config.pageEntryAnimation}`)
    const backdrop = el('div', `${TAG}-page__backdrop`, { 'data-sai-backdrop': '' })
    page.appendChild(backdrop)
    const panel = el('div', `${TAG}-page__panel`)

    // Header.
    const header = el(
      'header',
      `${TAG}-page__header${config.pageHeaderSticky ? ` ${TAG}-page__header--sticky` : ''}`,
    )
    const close = el('button', `${TAG}-page__close`, {
      type: 'button',
      'aria-label': 'Close',
    })
    if (config.pageCloseStyle === 'x_icon') close.innerHTML = X_ICON
    else if (config.pageCloseStyle === 'text_link')
      close.innerHTML = '<span style="font-weight:600;font-size:.875rem;">Close</span>'
    else close.innerHTML = BACK_ARROW
    header.appendChild(close)
    header.appendChild(el('h2', `${TAG}-page__title`, { text: config.pageTitle || 'Apply Coupon' }))
    panel.appendChild(header)

    // Scroll body.
    const scroll = el('div', `${TAG}-page__scroll`)

    // Input form (top or bottom).
    function inputForm() {
      const form = el('form', `${TAG}-page__input-form`, { 'data-sai-input-form': '' })
      const input = el('input', `${TAG}-page__input`, {
        type: 'text',
        placeholder: config.inputPlaceholder || 'Enter your coupon code',
        maxlength: config.inputMaxLength || 32,
      })
      if (config.inputAutoUppercase) input.style.textTransform = 'uppercase'
      const apply = el('button', `${TAG}-page__input-apply`, {
        type: 'submit',
        text: config.inputApplyLabel || 'Apply',
      })
      form.appendChild(input)
      form.appendChild(apply)

      const feedback = el('div', `${TAG}-page__feedback`, { hidden: true })

      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const raw = (input.value || '').trim()
        if (!raw) return
        const code = config.inputAutoUppercase ? raw.toUpperCase() : raw
        const all = ctx.applicable.concat(ctx.applied)
        const match = all.find((d) => {
          const c = getCode(d)
          return c && c.toUpperCase() === code.toUpperCase()
        })
        if (match && isApplicable(match)) {
          feedback.className = `${TAG}-page__feedback ${TAG}-page__feedback--success`
          feedback.textContent = 'Coupon applied'
          feedback.hidden = false
          apply.disabled = true
          apply.textContent = config.applyLoadingText || 'Applying…'
          ctx.track(`${FEATURE_SLUG}:manual_apply`, { discount_code: code, valid: true })
          window.location.href = discountApplyUrl(code)
        } else {
          feedback.className = `${TAG}-page__feedback ${TAG}-page__feedback--error`
          feedback.textContent = 'Invalid or not applicable coupon code'
          feedback.hidden = false
          ctx.track(`${FEATURE_SLUG}:manual_apply`, { discount_code: code, valid: false })
        }
      })

      const container = el('div')
      container.appendChild(form)
      container.appendChild(feedback)
      return container
    }

    if (config.showInputForm && config.inputPosition !== 'bottom') scroll.appendChild(inputForm())

    // Promo blocks — build the visible ones once, emit them at their position.
    const promoBlocks =
      config.enablePromoBlocks && Array.isArray(config.promoBlocks) ? config.promoBlocks : []
    // Promo blocks count as content: a drawer with only promo blocks (and no
    // discount sections) must not fall through to the empty state.
    const anyPromoVisible = promoBlocks.some((block, idx) => promoVisible(host, block, idx, ctx))
    function emitPromos(position) {
      promoBlocks.forEach((block, idx) => {
        if (block.position === position && promoVisible(host, block, idx, ctx)) {
          scroll.appendChild(buildPromoBlock(host, block, idx, ctx))
        }
      })
    }

    emitPromos('top')

    // User-specific section sits above the store coupons. Everything peeled
    // into this bucket at the partition step MUST render here — the peel is the
    // only gate. Do not guard this render on a position-equality check without a
    // matching branch for every position value, or peeled coupons get dropped
    // (removed from the store buckets but never shown).
    const userSorted = sortDiscounts(ctx.userSpecific, config.applicableSort, ctx.subtotal)
    if (userSorted.length > 0) {
      scroll.appendChild(
        buildSection(
          config.userSectionHeaderText || 'For You',
          userSorted.length,
          userSorted,
          'user',
          ctx,
          { badgeText: config.userSectionBadgeText },
        ),
      )
    }

    // Sections.
    const appliedSorted = sortDiscounts(ctx.applied, config.appliedSort, ctx.subtotal)
    const applicableSorted = sortDiscounts(ctx.applicable, config.applicableSort, ctx.subtotal)
    const potentialSorted = sortDiscounts(ctx.potential, config.potentialSort, ctx.subtotal)

    const sectionsOrder =
      config.sectionDisplayOrder === 'applied_first'
        ? ['applied', 'applicable', 'potential']
        : ['applicable', 'applied', 'potential']

    const sectionMap = {
      applied: () =>
        appliedSorted.length > 0
          ? buildSection(
              config.appliedHeaderText || 'Applied',
              appliedSorted.length,
              appliedSorted,
              'applied',
              ctx,
            )
          : null,
      applicable: () =>
        applicableSorted.length > 0
          ? buildSection(
              config.applicableHeaderText || 'Best Coupon',
              applicableSorted.length,
              applicableSorted,
              'applicable',
              ctx,
            )
          : null,
      potential: () =>
        potentialSorted.length > 0
          ? buildSection(
              config.potentialHeaderText || 'More Offers',
              potentialSorted.length,
              potentialSorted,
              'potential',
              ctx,
            )
          : null,
    }
    let renderedAny = userSorted.length > 0
    for (let i = 0; i < sectionsOrder.length; i += 1) {
      const key = sectionsOrder[i]
      const node = sectionMap[key]()
      if (node) {
        scroll.appendChild(node)
        renderedAny = true
        // Position-anchored promos fire right after their reference section.
        if (key === 'applied') emitPromos('after_applied')
        else if (key === 'applicable') emitPromos('after_applicable')
      }
      // "Between sections" promos go after every section except the last.
      if (i < sectionsOrder.length - 1) emitPromos('between_sections')
    }
    if (!renderedAny && !anyPromoVisible)
      scroll.appendChild(
        el('div', `${TAG}-page__empty`, { text: 'No offers available right now.' }),
      )

    emitPromos('bottom')

    if (config.showInputForm && config.inputPosition === 'bottom') scroll.appendChild(inputForm())

    panel.appendChild(scroll)
    page.appendChild(panel)

    // Append + scroll lock + animate via Web Animations API. WAAPI is more
    // reliable than CSS transitions on dynamically-portalled elements
    // because it doesn't depend on initial-state CSS being applied before
    // the change class is added.
    document.body.appendChild(page)
    // Hide "More" toggles where the description isn't actually clamped.
    for (const t of page.querySelectorAll(`.${TAG}-card__desc-toggle`)) {
      const prev = t.previousElementSibling
      if (prev instanceof HTMLElement && prev.scrollHeight <= prev.clientHeight + 1) {
        t.style.display = 'none'
      }
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    page.classList.add(`${TAG}-page--open`)
    const slideKf =
      config.pageEntryAnimation === 'slide_up'
        ? [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }]
        : config.pageEntryAnimation === 'fade'
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }]
    const easing = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
    const duration = config.pageEntryAnimation === 'fade' ? 200 : 280
    try {
      panel.animate(slideKf, { duration, easing, fill: 'both' })
      backdrop.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 220,
        easing: 'ease-out',
        fill: 'both',
      })
    } catch (_) {
      /* WAAPI unsupported, fall back to instant open */
    }

    // Card-level Apply.
    scroll.addEventListener('click', (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const apply = t.closest('[data-sai-apply]')
      if (apply) {
        e.preventDefault()
        const code = apply.getAttribute('data-sai-apply')
        if (!code) return
        if (apply instanceof HTMLButtonElement) {
          apply.disabled = true
          apply.textContent = config.applyLoadingText || 'Applying…'
        }
        ctx.track(`${FEATURE_SLUG}:apply_clicked`, { discount_code: code })
        window.location.href = discountApplyUrl(code)
      }
    })

    function closePage() {
      if (!host._pageOpen || host._pageClosing) return
      host._pageClosing = true
      document.removeEventListener('keydown', onEsc)
      ctx.track(`${FEATURE_SLUG}:page_closed`, {})
      page.style.pointerEvents = 'none'
      const exitKf =
        config.pageEntryAnimation === 'slide_up'
          ? [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }]
          : config.pageEntryAnimation === 'fade'
            ? [{ opacity: 1 }, { opacity: 0 }]
            : [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }]
      const easing = 'cubic-bezier(0.4, 0, 1, 1)'
      const duration = config.pageEntryAnimation === 'fade' ? 200 : 280
      let panelAnim = null
      try {
        panelAnim = panel.animate(exitKf, { duration, easing, fill: 'forwards' })
        backdrop.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 220,
          easing: 'ease-in',
          fill: 'forwards',
        })
      } catch (_) {
        /* WAAPI unsupported */
      }
      let unmounted = false
      const unmount = () => {
        if (unmounted) return
        unmounted = true
        host._pageOpen = false
        host._pageClosing = false
        document.body.style.overflow = prevOverflow
        page.remove()
      }
      if (panelAnim) {
        panelAnim.onfinish = unmount
        // Belt-and-braces in case onfinish doesn't fire.
        window.setTimeout(unmount, duration + 60)
      } else {
        window.setTimeout(unmount, duration + 60)
      }
    }
    function onEsc(e) {
      if (e.key === 'Escape') closePage()
    }
    document.addEventListener('keydown', onEsc)
    close.addEventListener('click', closePage)
    backdrop.addEventListener('click', closePage)
  }

  // ── Bootstrap ────────────────────────────────────────────────────────
  async function fetchCart() {
    try {
      const r = await fetch('/cart.js', { headers: { Accept: 'application/json' } })
      if (!r.ok) return { items: [], total_price: 0, discount_codes: [] }
      return await r.json()
    } catch (_) {
      return { items: [], total_price: 0, discount_codes: [] }
    }
  }

  // Per-variant spectrum.discounts metafield isn't exposed by /cart.js, so
  // we fetch each item's product JSON and read variant metafields if the
  // theme exposes them. Falls back to /products/{handle}.js which most
  // themes serve from Online Store 2.0.
  async function fetchVariantDiscounts(items) {
    const byVariant = {}
    const handles = new Set(items.map((it) => it?.handle).filter(Boolean))
    await Promise.all(
      Array.from(handles).map(async (handle) => {
        try {
          const r = await fetch(`/products/${handle}.js`, {
            headers: { Accept: 'application/json' },
          })
          if (!r.ok) return
          const product = await r.json()
          for (const v of product.variants || []) {
            if (v?.metafields?.spectrum?.discounts) {
              byVariant[String(v.id)] = v.metafields.spectrum.discounts
            }
          }
        } catch (_) {
          /* skip */
        }
      }),
    )
    return byVariant
  }

  async function bootHost(host) {
    if (host._booted) return
    host._booted = true

    const payloadScript = host.querySelector('[data-sai-payload]')
    if (!payloadScript) return
    let payload
    try {
      payload = JSON.parse(payloadScript.textContent || '{}')
    } catch (_) {
      return
    }

    const config = payload.config || {}
    // Hydrate cart from /cart.js. Use items_subtotal_price (pre-discount
    // subtotal) for threshold comparison — that's what Shopify itself uses
    // to qualify discount codes. Using total_price would shrink the
    // effective subtotal whenever any coupon is already applied and
    // misclassify other coupons as out-of-reach. Shopify's discount_codes
    // list includes every code the shopper has tried; filter on
    // applicable=true so stale rejected codes don't render as APPLIED.
    const liveCart = await fetchCart()
    const subtotalSource = Number(liveCart.items_subtotal_price)
    const subtotal =
      Number.isFinite(subtotalSource) && subtotalSource > 0
        ? subtotalSource / 100
        : Number(liveCart.total_price) / 100 || 0
    const appliedCodes = (liveCart.discount_codes || [])
      .filter((d) => d && d.applicable === true)
      .map((d) => String(d.code).toUpperCase())
      .filter(Boolean)

    // Read cart-discounts data emitted inline by the host section. Shopify's
    // Section Rendering API returned empty bytes for a dedicated cart-data
    // section on this theme, so the section that hosts the CTA also emits
    // a hidden <div data-sai-cart-data> alongside the snippet render. The
    // JS reads it directly from the page DOM, avoiding any extra fetch.
    let discountsByVariant = {}
    const dataDiv = document.querySelector('[data-sai-cart-data]')
    if (dataDiv) {
      try {
        const cd = JSON.parse(dataDiv.textContent || '{}')
        discountsByVariant = cd.discountsByVariant || {}
        if (cd.cart && Array.isArray(cd.cart.appliedCodes)) {
          for (const c of cd.cart.appliedCodes) {
            const up = String(c).toUpperCase()
            if (!appliedCodes.includes(up)) appliedCodes.push(up)
          }
        }
      } catch (_) {
        /* fall through with empty data */
      }
    }

    const raw = collectDiscounts(discountsByVariant)
    const recomputed = raw.map((d) => recompute(d, subtotal))

    const applied = []
    const autoApplied = []
    const applicable = []
    const potential = []
    const userSpecific = []
    for (const d of recomputed) {
      // User-specific coupons render in their own section above the store
      // coupons. Only peel them off when the merchant enabled the section and
      // the shopper is signed in — otherwise they fall through to the normal
      // store buckets so nothing is lost.
      if (config.enableUserSpecificCoupons && config.customerLoggedIn && isUserSpecific(d)) {
        userSpecific.push(d)
        continue
      }
      if (isApplied(d, appliedCodes)) applied.push(d)
      else if (d.applicationType === 'automatic' && isApplicable(d)) autoApplied.push(d)
      else if (isApplicable(d)) applicable.push(d)
      else if (isPotential(d)) potential.push(d)
    }

    let track = noop
    let emit = noop
    try {
      const ai = window.__spectrumAi
      if (ai?.snippet && typeof ai.snippet.bind === 'function') {
        const handles = ai.snippet.bind(host, () => {})
        if (handles && typeof handles.track === 'function') track = safeFn(handles.track)
        if (handles && typeof handles.emit === 'function') emit = safeFn(handles.emit)
      }
    } catch (_) {
      /* SDK absent */
    }

    const ctx = {
      config,
      money: moneyFormatter(config.currencyCode),
      applied,
      autoApplied,
      applicable,
      potential,
      userSpecific,
      subtotal,
      track,
      emit,
    }

    setEntryIcon(host, config.entryCtaIcon || 'percent')
    updateEntryMeta(host, ctx)
    maybeHideEntry(host, ctx)

    const entry = host.querySelector('[data-sai-entry]')
    if (entry) entry.addEventListener('click', () => openPage(host, ctx))

    // Cross-snippet trigger: cbpwlx29 (Best Applicable Coupons) emits
    // 'spectrum:view-all-offers:open' from its View all coupons link.
    // Listen on the window so any source can open the drawer.
    window.addEventListener('spectrum:view-all-offers:open', (e) => {
      try {
        e.preventDefault?.()
      } catch (_) {
        /* event already consumed */
      }
      openPage(host, ctx)
    })
  }

  function waitForVis(host) {
    const ready = () => {
      const vis = host.getAttribute('data-spectrum-vis')
      if (vis === 'on' || vis === null) bootHost(host)
    }
    ready()
    const observer = new MutationObserver(() => {
      if (host.getAttribute('data-spectrum-vis') === 'on') {
        observer.disconnect()
        ready()
      }
    })
    observer.observe(host, { attributes: true, attributeFilter: ['data-spectrum-vis'] })
  }

  function bootAll() {
    const hosts = document.querySelectorAll(TAG)
    for (const host of hosts) waitForVis(host)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll)
  } else {
    bootAll()
  }
})()
