/**
 * Cart Progress Bar snippet-author runtime.
 *
 * Ships to the merchant theme as a deferred <script src>. The Liquid file
 * bakes the campaign's milestones (thresholds in cents, labels, types) into
 * the sibling JSON config at SSR — this script only does cart math and DOM
 * state updates: fill width, reached classes on nodes, and the templated
 * message. Re-runs on every cart-change event the Spectrum SDK emits.
 *
 * Browser-only (theme <script src>) — no environment guards beyond feature
 * detection. Container-scoped: every query is rooted at the instance node.
 *
 * Fill geometry contract: node i sits at (i+1)/(n+1) of the track width
 * (matches the SSR'd inline left%). The fill interpolates linearly between
 * adjacent node positions, NOT between raw amounts, so the visual pace is
 * uniform per segment regardless of threshold spacing. Keep SSR and JS in
 * sync if either side changes.
 */
;(() => {
  if (window.__sai_vg4guong_initialized__) return
  window.__sai_vg4guong_initialized__ = true

  const SNIPPET_ID = 'vg4guong'

  // Last cart payload across instances. When the theme morphs the cart
  // section (replacing our rendered DOM), the re-initialized instance paints
  // synchronously from this cache instead of flashing the empty SSR skeleton
  // for the duration of a /cart.js round trip; the async refresh reconciles.
  let lastCart = null

  function readConfig(node) {
    const script = node.querySelector('script[data-sai-progress-config]')
    if (!script) return null
    try {
      return JSON.parse(script.textContent || '{}')
    } catch {
      return null
    }
  }

  function money(cents, currency) {
    const amount = (Number(cents) || 0) / 100
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol' }).format(amount)
    } catch {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount)
      } catch {
        return amount.toFixed(2)
      }
    }
  }

  async function getCart() {
    if (window.Spectrum && window.Spectrum.cart && typeof window.Spectrum.cart.get === 'function') {
      return window.Spectrum.cart.get()
    }
    const res = await fetch('/cart.js', { headers: { Accept: 'application/json' } })
    return res.json()
  }

  // Broadcast after this snippet mutates the cart so sibling Spectrum
  // snippets (cart line, upsell) re-read it. Listeners coalesce, so the
  // self-delivered copy costs one no-op refresh, never a loop.
  function emitCartUpdated() {
    document.dispatchEvent(new CustomEvent('spectrum:cart:updated'))
  }

  // Theme JS (native steppers, recommendation adds, third-party apps) mutates
  // the cart without firing any event name we can rely on — theme event
  // vocabularies vary per theme. Watching the network layer is the only
  // theme-agnostic signal, so this is a deliberate exception to the
  // no-global-side-effects rule: installed once across all Spectrum snippets
  // (window guard), transparent pass-through, GET /cart.js reads don't match.
  function installCartWatch() {
    if (window.__saiCartWatch__) return
    window.__saiCartWatch__ = true
    const isCartMutation = (url) => /\/cart\/(add|change|update|clear)/.test(String(url || ''))
    const origFetch = window.fetch
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url
      const p = origFetch.apply(this, args)
      if (isCartMutation(url)) p.then(() => emitCartUpdated()).catch(() => {})
      return p
    }
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (isCartMutation(url)) this.addEventListener('load', () => emitCartUpdated())
      return origOpen.call(this, method, url, ...rest)
    }
  }

  async function cartAdd(variantId) {
    if (window.Spectrum && window.Spectrum.cart && typeof window.Spectrum.cart.add === 'function') {
      return window.Spectrum.cart.add([{ id: variantId, quantity: 1, properties: { _sai_progress_reward: '1' } }])
    }
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: variantId, quantity: 1, properties: { _sai_progress_reward: '1' } }] }),
    })
    if (!res.ok) throw new Error('cart add failed')
    return res.json()
  }

  async function cartSetQuantity(lineKey, quantity) {
    if (window.Spectrum && window.Spectrum.cart && typeof window.Spectrum.cart.change === 'function') {
      return window.Spectrum.cart.change({ id: lineKey, quantity })
    }
    const res = await fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: lineKey, quantity }),
    })
    if (!res.ok) throw new Error('cart change failed')
    return res.json()
  }

  // Sum of selling prices (final_line_price) excluding envelope-listed
  // product ids — must mirror the Liquid SSR computation exactly.
  function eligibleTotal(cart, cfg) {
    if (!cart) return 0
    const excluded = cfg.excludedProductIds || []
    return (cart.items || []).reduce((sum, item) => {
      if (excluded.indexOf(item.product_id) !== -1) return sum
      const lineTotal = item.final_line_price != null ? item.final_line_price : item.line_price
      return sum + (lineTotal || 0)
    }, 0)
  }

  // Message HTML: helper texts come from the portal-authored envelope
  // (server-rendered through Liquid), so interpolation is trusted per the
  // library's no-client-escaping rule. The next unreached milestone's
  // inactive helper shows until all milestones are reached, then the final
  // milestone's active helper. Blank helpers fall back to default copy so
  // the message line is never empty. Must mirror the Liquid SSR messaging.
  function buildMessage(milestones, total, currency) {
    const next = milestones.find((m) => total < m.threshold)
    let template
    let rewardTitle
    let remaining = ''
    if (!next) {
      const last = milestones[milestones.length - 1]
      template = last.activeHelper || "Congrats! You've unlocked {reward} 🎉"
      rewardTitle = last.title
    } else {
      template = next.inactiveHelper || 'Add {remaining} more to unlock {reward}'
      rewardTitle = next.title
      remaining = money(next.threshold - total, currency)
    }
    return (template || '')
      .replace(/\{remaining_amount\}/g, remaining)
      .replace(/\{remaining\}/g, remaining)
      .replace(/\{reward\}/g, rewardTitle ? `<strong>${rewardTitle}</strong>` : '')
  }

  function fillPercent(milestones, total) {
    const n = milestones.length
    if (!n) return 0
    const pos = (i) => ((i + 1) * 100) / (n + 1)
    if (total >= milestones[n - 1].threshold) return 100
    if (total <= 0) return 0
    let k = 0
    while (k < n && milestones[k].threshold <= total) k++
    const prevT = k === 0 ? 0 : milestones[k - 1].threshold
    const prevP = k === 0 ? 0 : pos(k - 1)
    const frac = (total - prevT) / (milestones[k].threshold - prevT)
    return prevP + frac * (pos(k) - prevP)
  }

  function burstConfetti(wrap) {
    const colors = ['#4b79dd', '#f5b942', '#e2574c', '#43b97f', '#8a63d2']
    for (let i = 0; i < 12; i++) {
      const piece = document.createElement('span')
      piece.className = 'sai-vg4guong__confetti'
      piece.style.background = colors[i % colors.length]
      piece.style.left = '50%'
      piece.style.top = '50%'
      // Deterministic spread per index — no layout reads, removed after the
      // animation so repeated bursts can't accumulate nodes.
      const angle = (i / 12) * Math.PI * 2
      piece.style.setProperty('--sai-vg4guong-cx', `${Math.cos(angle) * (30 + (i % 3) * 14)}px`)
      piece.style.setProperty('--sai-vg4guong-cy', `${Math.sin(angle) * (24 + (i % 4) * 12) - 30}px`)
      wrap.appendChild(piece)
      setTimeout(() => piece.remove(), 1000)
    }
  }

  function makeRenderer(node, cfg, track) {
    const milestones = (cfg.milestones || [])
      .slice()
      .sort((a, b) => a.threshold - b.threshold)
    const fillEl = node.querySelector('[data-sai-fill]')
    const msgEl = node.querySelector('[data-sai-msg]')
    const nodeEls = Array.prototype.slice.call(node.querySelectorAll('[data-sai-node]'))
    let lastReachedCount = null
    let reconciling = false

    // free_gift milestones with a linked variant get their reward product
    // added to the cart as a real line item when the threshold is crossed,
    // and removed when the total drops back below. Invariant reconcile (not
    // crossing-triggered) so a page load with the threshold already met still
    // converges. Gift lines are $0 so they never feed back into the total.
    async function reconcileGifts(cart, total) {
      if (reconciling) return false
      const gifts = milestones.filter((m) => m.giftVariantId)
      if (!gifts.length) return false
      reconciling = true
      let changed = false
      try {
        for (const m of gifts) {
          const line = (cart.items || []).find((i) => i.variant_id === m.giftVariantId)
          const reached = total >= m.threshold
          if (reached && !line) {
            await cartAdd(m.giftVariantId)
            track('cart_progress:reward_added', { threshold: m.threshold, milestone_title: m.title, variant_id: m.giftVariantId })
            changed = true
          } else if (reached && line && line.quantity > 1) {
            // Concurrent sessions can race the add (each reads the cart
            // before any add lands; Shopify merges them into one line) —
            // clamp back to exactly one reward per milestone.
            await cartSetQuantity(line.key, 1)
            changed = true
          } else if (!reached && line) {
            await cartSetQuantity(line.key, 0)
            track('cart_progress:reward_removed', { threshold: m.threshold, milestone_title: m.title, variant_id: m.giftVariantId })
            changed = true
          }
        }
      } catch {
        // Mutation failed (sold out, throttled) — leave the cart as-is; the
        // next cart event re-runs the reconcile.
      }
      reconciling = false
      return changed
    }

    function paint(cart) {
      const currency = (cart && cart.currency) || 'USD'
      const total = eligibleTotal(cart, cfg)

      if (fillEl) fillEl.style.width = `${fillPercent(milestones, total)}%`

      let reachedCount = 0
      nodeEls.forEach((el) => {
        const threshold = Number(el.getAttribute('data-sai-threshold')) || 0
        const reached = total >= threshold
        el.classList.toggle('sai-vg4guong__node-wrap--reached', reached)
        if (reached) reachedCount++
      })

      if (msgEl) msgEl.innerHTML = buildMessage(milestones, total, currency) || '&nbsp;'

      // First render establishes the baseline; only later crossings count as
      // unlock events (page loads with milestones already met stay silent).
      if (lastReachedCount !== null && reachedCount > lastReachedCount) {
        const newly = milestones.filter((m) => total >= m.threshold).slice(lastReachedCount)
        newly.forEach((m) => {
          track('cart_progress:milestone_unlocked', {
            threshold: m.threshold,
            milestone_title: m.title,
          })
        })
        nodeEls.forEach((el) => {
          const threshold = Number(el.getAttribute('data-sai-threshold')) || 0
          const crossed = newly.find((m) => m.threshold === threshold)
          if (total >= threshold && crossed) {
            el.classList.add('sai-vg4guong__node-wrap--pulse')
            setTimeout(() => el.classList.remove('sai-vg4guong__node-wrap--pulse'), 600)
            if (crossed.confetti) burstConfetti(el)
          }
        })
      }
      lastReachedCount = reachedCount
    }

    async function refresh(depth) {
      let cart
      try {
        cart = await getCart()
      } catch {
        return
      }
      lastCart = cart
      const total = eligibleTotal(cart, cfg)

      const giftsChanged = await reconcileGifts(cart, total)
      if (giftsChanged) {
        emitCartUpdated()
        if ((depth || 0) < 2) return refresh((depth || 0) + 1)
      }

      paint(cart)
    }

    // Replaced-root case: paint the cached state synchronously so the morph
    // gap is one frame, not a network round trip.
    if (lastCart) paint(lastCart)

    return refresh
  }

  function initNode(node) {
    if (node.__saiProgressBound) return
    const root = node.hasAttribute('data-sai-progress') ? node : node.querySelector('[data-sai-progress]')
    if (!root) return
    node.__saiProgressBound = true
    if (root !== node) root.__saiProgressBound = true
    const cfg = readConfig(root)
    if (!cfg || !Array.isArray(cfg.milestones) || cfg.milestones.length === 0) return

    let track = () => {}
    if (window.__spectrumAi && window.__spectrumAi.snippet) {
      const handles = window.__spectrumAi.snippet.bind(node, () => {})
      if (handles && typeof handles.track === 'function') track = handles.track
    }

    const refresh = makeRenderer(root, cfg, track)

    let cartEventPending = false
    function onCartEvent() {
      // Section swaps replace the instance root but document-level listeners
      // survive — a disconnected node's listeners must become no-ops or every
      // swap would add another fetch per cart event.
      if (!node.isConnected) return
      if (cartEventPending) return
      cartEventPending = true
      setTimeout(() => {
        cartEventPending = false
        if (!node.isConnected) return
        refresh()
      }, 0)
    }
    const CART_EVENTS = ['spectrum:cart:updated', 'cart:updated', 'cart:update', 'cart:refresh', 'cart:item-added', 'cart:add', 'cart:build']
    CART_EVENTS.forEach((name) => {
      document.addEventListener(name, onCartEvent)
      window.addEventListener(name, onCartEvent)
    })
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) refresh()
    })

    refresh()
  }

  function init() {
    document.querySelectorAll(`[data-spectrum-snippet-id="${SNIPPET_ID}"]`).forEach(initNode)
    document.querySelectorAll('[data-sai-progress]').forEach(initNode)
  }

  // Themes morph/replace the cart section's DOM after cart mutations
  // (Section Rendering API). That discards bound instance roots, so re-scan
  // on every subtree change — initNode is a no-op for already-bound nodes,
  // and fresh (replaced) roots get bound + rendered immediately.
  function watchDom() {
    if (typeof MutationObserver === 'undefined') return
    let pending = false
    const mo = new MutationObserver(() => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        init()
      }, 60)
    })
    mo.observe(document.body, { childList: true, subtree: true })
  }

  // The Spectrum SDK enriches (cart API + analytics bind) but isn't required:
  // /cart.js fetch covers data, so init proceeds after a short SDK grace poll.
  let tries = 0
  function ready() {
    if ((window.Spectrum && window.__spectrumAi) || tries >= 40) {
      installCartWatch()
      init()
      watchDom()
      return
    }
    tries++
    setTimeout(ready, 50)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready)
  } else {
    ready()
  }
})()
