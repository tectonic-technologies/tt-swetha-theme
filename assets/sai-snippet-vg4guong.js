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

  function eligibleTotal(cart, cfg) {
    if (!cart) return 0
    if (cfg.excludeDiscounted) {
      // Sum only lines selling at full price; cart-level codes still reduce
      // total_price, so per-line comparison is the discounted-item signal.
      return (cart.items || []).reduce((sum, item) => {
        const lineTotal = item.final_line_price != null ? item.final_line_price : item.line_price
        const original = item.original_line_price != null ? item.original_line_price : lineTotal
        return lineTotal >= original ? sum + lineTotal : sum
      }, 0)
    }
    return cart.total_price || 0
  }

  // Message HTML: templates + labels come from merchant config/metaobjects
  // (server-rendered through Liquid), so interpolation is trusted per the
  // library's no-client-escaping rule. {reward} renders bold per design.
  function buildMessage(cfg, milestones, total, currency) {
    const reached = milestones.filter((m) => total >= m.threshold)
    const next = milestones.find((m) => total < m.threshold)
    let template
    const tokens = {}
    if (!next) {
      template = cfg.completeMessage
      tokens.reward = milestones[milestones.length - 1].label
    } else if (reached.length === 0) {
      template = cfg.preGoalTemplate
      tokens.remaining = money(next.threshold - total, currency)
      tokens.reward = next.label
    } else {
      template = cfg.midProgressTemplate
      tokens.remaining = money(next.threshold - total, currency)
      tokens.reward = next.label
      tokens.unlocked_reward = reached[reached.length - 1].label
    }
    return (template || '')
      .replace(/\{remaining_amount\}/g, tokens.remaining || '')
      .replace(/\{remaining\}/g, tokens.remaining || '')
      .replace(/\{unlocked_reward\}/g, tokens.unlocked_reward || '')
      .replace(/\{reward\}/g, tokens.reward ? `<strong>${tokens.reward}</strong>` : '')
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

    async function refresh() {
      let cart
      try {
        cart = await getCart()
      } catch {
        return
      }
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

      if (msgEl) msgEl.innerHTML = buildMessage(cfg, milestones, total, currency) || '&nbsp;'

      // First render establishes the baseline; only later crossings count as
      // unlock events (page loads with milestones already met stay silent).
      if (lastReachedCount !== null && reachedCount > lastReachedCount) {
        const newly = milestones.filter((m) => total >= m.threshold).slice(lastReachedCount)
        newly.forEach((m) => {
          track('cart_progress:milestone_unlocked', {
            threshold: m.threshold,
            reward_type: m.type,
            reward_label: m.label,
          })
        })
        nodeEls.forEach((el) => {
          const threshold = Number(el.getAttribute('data-sai-threshold')) || 0
          if (total >= threshold && newly.some((m) => m.threshold === threshold)) {
            el.classList.add('sai-vg4guong__node-wrap--pulse')
            setTimeout(() => el.classList.remove('sai-vg4guong__node-wrap--pulse'), 600)
            if (cfg.showConfetti) burstConfetti(el)
          }
        })
      }
      lastReachedCount = reachedCount
    }

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
      if (cartEventPending) return
      cartEventPending = true
      setTimeout(() => {
        cartEventPending = false
        refresh()
      }, 0)
    }
    const CART_EVENTS = ['spectrum:cart:updated', 'cart:updated', 'cart:refresh', 'cart:item-added', 'cart:build']
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

  // The Spectrum SDK enriches (cart API + analytics bind) but isn't required:
  // /cart.js fetch covers data, so init proceeds after a short SDK grace poll.
  let tries = 0
  function ready() {
    if ((window.Spectrum && window.__spectrumAi) || tries >= 40) {
      init()
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
