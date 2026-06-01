/**
 * Hero Banner snippet-author runtime.
 *
 * Owns, per rendered instance:
 *   - count-up stat numbers (0 → target) triggered on viewport entry
 *   - entrance animation (fade / zoom) via an `is-in` class flip
 *   - parallax background translate on scroll
 *   - countdown ticking with hide / show-zeros / message end behavior
 *   - analytics + live-preview variants through __spectrumAi.snippet.bind
 *
 * Visual behavior is decoupled from the analytics SDK: count-up, entrance,
 * parallax, and countdown initialize on their own from the SSR DOM, so they
 * work even when __spectrumAi is absent. The SDK bind only adds CTA analytics
 * and Studio live-preview (applyVariant).
 *
 * Container-scoped: every read/write goes through the instance root, so
 * multi-render pages never collide. Visibility is enforced upstream by the
 * wrapper's display:none gate — a hidden instance never intersects, so its
 * count-up/entrance simply never fire.
 *
 * Test surface: when globalThis.__SAI_TEST_HARNESS__ === true the IIFE exposes
 * globalThis.__saiH9k3pdtz with the pure helpers for unit tests. Production
 * never sets the flag, so production never carries the global.
 */
;(() => {
  const SNIPPET_ID = 'h9k3pdtz'
  const ROOT_SELECTOR = `.sai-${SNIPPET_ID}`
  const INIT_FLAG = 'saiH9Init'

  const prefersReducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ────────── Count-up helpers ────────── */

  /**
   * Parse a merchant-authored stat string into its animatable parts.
   * "92%" → { prefix:'', value:92, suffix:'%', decimals:0, grouped:false }
   * "25,000+" → { prefix:'', value:25000, suffix:'+', decimals:0, grouped:true }
   * "$1,299.50" → { prefix:'$', value:1299.5, suffix:'', decimals:2, grouped:true }
   * Non-numeric input → value:null (caller renders it verbatim).
   */
  function parseCountTarget(raw) {
    const str = String(raw == null ? '' : raw)
    const match = str.match(/^(\D*?)([\d.,]+)(.*)$/)
    if (!match) return { prefix: '', value: null, suffix: str, decimals: 0, grouped: false }
    const [, prefix, numeric, suffix] = match
    const grouped = numeric.includes(',')
    const cleaned = numeric.replace(/,/g, '')
    const value = Number(cleaned)
    if (!Number.isFinite(value)) {
      return { prefix: '', value: null, suffix: str, decimals: 0, grouped: false }
    }
    const dot = cleaned.indexOf('.')
    const decimals = dot === -1 ? 0 : cleaned.length - dot - 1
    return { prefix, value, suffix, decimals, grouped }
  }

  /** Format a count tween value for display, honoring number_format. */
  function formatCountValue(n, format, decimals, grouped) {
    if (format === 'abbreviated') {
      const abs = Math.abs(n)
      if (abs >= 1e6) return `${trimZeros(n / 1e6, 1)}M`
      if (abs >= 1e3) return `${trimZeros(n / 1e3, 1)}K`
      return String(Math.round(n))
    }
    const fixed = format === 'integer' ? Math.round(n).toFixed(0) : n.toFixed(decimals)
    if (format === 'integer' || grouped) return groupThousands(fixed)
    return fixed
  }

  function trimZeros(n, maxDecimals) {
    return Number(n.toFixed(maxDecimals)).toString()
  }

  function groupThousands(fixedStr) {
    const [intPart, fracPart] = fixedStr.split('.')
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return fracPart ? `${grouped}.${fracPart}` : grouped
  }

  const easeOutCubic = (t) => 1 - (1 - t) ** 3

  function runCountUp(el, durationMs) {
    const raw = el.getAttribute('data-sai-count-target')
    const parsed = parseCountTarget(raw)
    const format = el.getAttribute('data-sai-count-format') || 'auto'
    if (parsed.value === null) return
    // 'auto' lands on the merchant's exact string so the animated result is
    // byte-identical to the server-rendered value (no end-of-count reformat
    // snap). 'integer' / 'abbreviated' are explicit reformat requests, so they
    // settle on the reformatted value.
    const finalText =
      format === 'auto'
        ? raw
        : parsed.prefix +
          formatCountValue(parsed.value, format, parsed.decimals, parsed.grouped) +
          parsed.suffix
    if (prefersReducedMotion() || !durationMs || durationMs <= 0) {
      el.textContent = finalText
      return
    }
    const start = performance.now()
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / durationMs)
      const current = parsed.value * easeOutCubic(progress)
      el.textContent =
        parsed.prefix +
        formatCountValue(current, format, parsed.decimals, parsed.grouped) +
        parsed.suffix
      if (progress < 1) requestAnimationFrame(tick)
      else el.textContent = finalText
    }
    requestAnimationFrame(tick)
  }

  /* ────────── Countdown helpers ────────── */

  /** Milliseconds remaining, clamped at zero, broken into d/h/m/s. */
  function computeRemaining(targetMs, nowMs) {
    const total = Math.max(0, targetMs - nowMs)
    const seconds = Math.floor(total / 1000)
    return {
      total,
      days: Math.floor(seconds / 86400),
      hours: Math.floor((seconds % 86400) / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
      seconds: seconds % 60,
    }
  }

  const pad2 = (n) => String(n).padStart(2, '0')

  function renderCountdown(root, parts) {
    for (const unit of ['days', 'hours', 'minutes', 'seconds']) {
      const cell = root.querySelector(`[data-cd="${unit}"]`)
      if (cell) cell.textContent = pad2(parts[unit])
    }
  }

  function setupCountdown(root) {
    const el = root.querySelector('[data-sai-countdown]')
    if (!el) return
    const targetMs = Date.parse(el.getAttribute('data-target'))
    if (!Number.isFinite(targetMs)) return
    const endBehavior = el.getAttribute('data-end-behavior') || 'hide'
    const endMessage = el.getAttribute('data-end-message') || ''

    const tick = () => {
      const parts = computeRemaining(targetMs, Date.now())
      renderCountdown(el, parts)
      if (parts.total <= 0) {
        clearInterval(timer)
        if (endBehavior === 'hide') el.style.display = 'none'
        else if (endBehavior === 'message') {
          // Drop the unit-cell layout so the message renders as a plain line
          // instead of inheriting the number/divider styling of the cells.
          el.classList.add('sai-h9k3pdtz__countdown--ended')
          el.textContent = endMessage
        }
      }
    }
    // Bind the interval before the first synchronous tick so an already-expired
    // target can clearInterval(timer) without reading it in its TDZ.
    const timer = setInterval(tick, 1000)
    tick()
  }

  /* ────────── Per-instance visual init ────────── */

  function setupCountUp(root) {
    const numbers = root.querySelectorAll('.sai-h9k3pdtz__stat-number')
    if (numbers.length === 0) return
    const animate = root.getAttribute('data-counter-animate') !== 'false'
    const duration = Number(root.getAttribute('data-counter-duration')) || 2000
    if (!animate) return
    // Reset each number to its zero-start so the count visibly runs 0 → target
    // (SSR renders the final value for the no-JS / no-IO case).
    for (const el of numbers) {
      if (!prefersReducedMotion()) el.textContent = zeroStart(el)
    }
    if (typeof IntersectionObserver === 'undefined') {
      for (const el of numbers) runCountUp(el, duration)
      return
    }
    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          runCountUp(entry.target, duration)
          obs.unobserve(entry.target)
        }
      },
      { threshold: 0.4 },
    )
    for (const el of numbers) io.observe(el)
  }

  function zeroStart(el) {
    const parsed = parseCountTarget(el.getAttribute('data-sai-count-target'))
    if (parsed.value === null) return el.textContent
    const format = el.getAttribute('data-sai-count-format') || 'auto'
    return (
      parsed.prefix + formatCountValue(0, format, parsed.decimals, parsed.grouped) + parsed.suffix
    )
  }

  function setupEntrance(root) {
    const entrance = root.getAttribute('data-entrance') || 'none'
    if (entrance === 'none' || prefersReducedMotion()) {
      root.classList.add('is-in')
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      root.classList.add('is-in')
      return
    }
    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-in')
          obs.unobserve(entry.target)
        }
      },
      { threshold: 0.2 },
    )
    io.observe(root)
  }

  function setupParallax(root) {
    if (root.getAttribute('data-entrance') !== 'parallax' || prefersReducedMotion()) return
    const bg = root.querySelector('.sai-h9k3pdtz__bg')
    if (!bg) return
    let ticking = false
    const update = () => {
      ticking = false
      const rect = root.getBoundingClientRect()
      const viewportH = window.innerHeight || document.documentElement.clientHeight
      if (rect.bottom < 0 || rect.top > viewportH) return
      const progress = (viewportH - rect.top) / (viewportH + rect.height)
      const shift = (progress - 0.5) * 80
      bg.style.transform = `translateY(${shift.toFixed(1)}px)`
    }
    const onScroll = () => {
      // Self-detach once the hero leaves the DOM (theme-editor section
      // re-render / SPA nav) so orphaned roots don't accumulate scroll work.
      if (!root.isConnected) {
        window.removeEventListener('scroll', onScroll)
        return
      }
      if (ticking) return
      ticking = true
      requestAnimationFrame(update)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    update()
  }

  function initRoot(root) {
    if (root.dataset[INIT_FLAG] === 'true') return
    root.dataset[INIT_FLAG] = 'true'
    // Mark JS as active. The entrance opacity:0 gate is scoped to this class so
    // that if the script never loads/runs, content and stats stay visible
    // instead of being stuck hidden.
    root.classList.add('sai-h9k3pdtz--js')
    setupCountUp(root)
    setupEntrance(root)
    setupParallax(root)
    setupCountdown(root)
  }

  /* ────────── applyVariant — live preview (Studio) ────────── */

  function applyVariant(node, content) {
    if (content == null || typeof content !== 'object') return
    const root = node.querySelector(ROOT_SELECTOR)
    if (!root) return

    root.classList.toggle('sai-h9k3pdtz--reverse', content.content_reverse === true)
    root.classList.toggle('sai-h9k3pdtz--cols-reverse', content.columns_reverse === true)

    // Alignment (desktop + mobile override). The SSR markup sets these classes;
    // re-apply them here so Studio live edits to either dropdown reflect without
    // a reload. The mobile class only takes effect under the mobile media query.
    for (const a of ['left', 'center', 'right']) {
      root.classList.remove(`sai-h9k3pdtz--align-${a}`, `sai-h9k3pdtz--align-m-${a}`)
    }
    const alignH = content.content_align_h || 'left'
    root.classList.add(`sai-h9k3pdtz--align-${alignH}`)
    const alignM = content.content_align_h_mobile
    if (alignM && alignM !== 'inherit') {
      root.classList.add(`sai-h9k3pdtz--align-m-${alignM}`)
    }

    setText(root, '.sai-h9k3pdtz__subtitle', content.subtitle)
    setText(root, '.sai-h9k3pdtz__title-accent', content.title_accent)
    setText(root, '.sai-h9k3pdtz__badge span', content.badge_text)

    const primary = root.querySelector('.sai-h9k3pdtz__cta--primary')
    if (primary && typeof content.primary_cta_text === 'string')
      primary.textContent = content.primary_cta_text
    if (primary && typeof content.primary_cta_url === 'string')
      primary.setAttribute('href', content.primary_cta_url)
    const secondary = root.querySelector('.sai-h9k3pdtz__cta--secondary')
    if (secondary && typeof content.secondary_cta_text === 'string')
      secondary.textContent = content.secondary_cta_text
    if (secondary && typeof content.secondary_cta_url === 'string')
      secondary.setAttribute('href', content.secondary_cta_url)
  }

  function setText(root, selector, value) {
    if (typeof value !== 'string') return
    const el = root.querySelector(selector)
    if (el) el.textContent = value
  }

  /* ────────── Test surface ────────── */

  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiH9k3pdtz = {
      parseCountTarget,
      formatCountValue,
      groupThousands,
      easeOutCubic,
      computeRemaining,
      applyVariant,
    }
  }

  /* ────────── Boot ────────── */

  function boot() {
    const roots = document.querySelectorAll(ROOT_SELECTOR)
    for (const root of roots) initRoot(root)

    const snippetApi = window.__spectrumAi?.snippet
    if (!snippetApi || typeof snippetApi.bind !== 'function') return
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )
    for (const node of containers) {
      const handle = snippetApi.bind(node, ({ variants, currentVariantId }) => {
        const variant = variants.find((v) => v.variantId === currentVariantId)
        if (variant?.content) applyVariant(node, variant.content)
      })
      wireCtas(node, handle)
    }
  }

  function wireCtas(node, handle) {
    if (!handle || typeof handle.track !== 'function') return
    for (const cta of node.querySelectorAll('[data-sai-cta]')) {
      cta.addEventListener('click', () => {
        handle.track(`hero_banner:${cta.getAttribute('data-sai-cta')}_cta_click`, {
          cta_url: cta.getAttribute('href') || '',
          cta_text: (cta.textContent || '').trim(),
        })
      })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
