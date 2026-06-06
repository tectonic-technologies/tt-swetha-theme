/**
 * Banner Lists - Carousel — snippet-author runtime.
 *
 * Owns, per rendered instance:
 *   - scroll-snap carousel: arrow + dot navigation, current-index detection,
 *     optional loop wrap, optional autoplay (paused off-screen / on hover-focus)
 *   - per-card video: play the active card's video, pause the rest; tap-to-play
 *     button when native controls are off
 *   - entrance animation (fade / zoom) via an `is-in` class flip
 *   - analytics + Studio live-preview through __spectrumAi.snippet.bind
 *
 * Visual behaviour is decoupled from the analytics SDK: the carousel and video
 * control initialise from the SSR DOM and work even when __spectrumAi is absent.
 * The SDK bind only adds analytics + live-preview (applyVariant).
 *
 * Container-scoped: every read/write goes through the instance root, so
 * multi-render pages never collide.
 *
 * Test surface: when globalThis.__SAI_TEST_HARNESS__ === true the IIFE exposes
 * globalThis.__saiObeect95 with the pure helpers for unit tests.
 */
;(() => {
  const SNIPPET_ID = 'obeect95'
  const FEATURE_SLUG = 'banner_lists_carousel'
  const ROOT_SELECTOR = `.sai-${SNIPPET_ID}`
  const TRACK_SELECTOR = `.sai-${SNIPPET_ID}__track`
  const CARD_SELECTOR = `.sai-${SNIPPET_ID}__card`
  const DOT_SELECTOR = '[data-spectrum-dot]'
  const ARROW_PREV_SELECTOR = '[data-spectrum-arrow="prev"]'
  const ARROW_NEXT_SELECTOR = '[data-spectrum-arrow="next"]'
  const INIT_FLAG = 'saiObInit'

  const prefersReducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  function noopTrack() {}

  // Telemetry is observational — a malformed payload or downstream throw must
  // never break scroll / nav. Surface it in DevTools and keep going.
  function safeTrack(track) {
    return (name, payload) => {
      try {
        track(name, payload)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[${FEATURE_SLUG}] analytics dispatch failed`, name, err)
      }
    }
  }

  // Clamp (loop off) or wrap (loop on) an index into [0, total).
  function clampIndex(i, total, loop) {
    if (total <= 0) return 0
    if (loop) return ((i % total) + total) % total
    return Math.max(0, Math.min(total - 1, i))
  }

  // Index of the card whose center is closest to the track's horizontal center.
  // Reference is the TRACK box (the cards scroll inside it), so this is correct
  // regardless of page-level scroll. Returns 0 when there are no cards.
  function currentIndex(track, cards) {
    if (!track || !cards || cards.length === 0) return 0
    const box = track.getBoundingClientRect()
    const center = box.left + box.width / 2
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      const c = r.left + r.width / 2
      const d = Math.abs(c - center)
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = i
      }
    }
    return bestIndex
  }

  function setupEntrance(root) {
    const entrance = root.getAttribute('data-entrance') || 'none'
    if (
      entrance === 'none' ||
      prefersReducedMotion() ||
      typeof IntersectionObserver === 'undefined'
    ) {
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

  function initCarousel(root, track) {
    if (root.dataset[INIT_FLAG] === 'true') return
    root.dataset[INIT_FLAG] = 'true'
    // Mark JS active so the entrance opacity:0 gate only applies when the script
    // runs — content stays visible if the script never loads.
    root.classList.add(`sai-${SNIPPET_ID}--js`)
    setupEntrance(root)

    const trackEl = root.querySelector(TRACK_SELECTOR)
    if (!trackEl) return
    const cards = Array.from(trackEl.querySelectorAll(`:scope > li > ${CARD_SELECTOR}`))
    if (cards.length === 0) return
    const total = cards.length

    // Force flex/overflow with inline `!important` — strongest layer against
    // themes whose `ul` rules win the cascade and would collapse the scroller.
    trackEl.style.setProperty('display', 'flex', 'important')
    trackEl.style.setProperty('overflow-x', 'auto', 'important')
    trackEl.style.setProperty('overflow-y', 'hidden', 'important')

    const loop = root.dataset.loop === 'true'
    const dots = Array.from(root.querySelectorAll(DOT_SELECTOR))
    const fills = Array.from(root.querySelectorAll(`.sai-${SNIPPET_ID}__bar-fill`))
    const prevBtn = root.querySelector(ARROW_PREV_SELECTOR)
    const nextBtn = root.querySelector(ARROW_NEXT_SELECTOR)
    const pauseBtn = root.querySelector('[data-spectrum-pause]')

    const autoplayOn = root.dataset.autoplay === 'true' && total > 1
    let currentIdx = 0
    let suppressScrollSync = false
    // Authoritative play/paused state for the whole carousel (slideshow advance +
    // active video). The play/pause buttons own it; there is intentionally NO
    // hover/focus auto-pause — an explicit control must win.
    let userPaused = false
    let inView = true
    // Restarts the autoplay/progress rAF loop after it self-stops on a guard
    // (paused / off-screen / reduced-motion). Reassigned when that loop is wired
    // up below; a no-op until then so the pause + visibility paths can call it
    // unconditionally.
    let kickAutoplay = () => {}
    // Active-segment fill ratio for the progress bars: 1 (static) when autoplay
    // is off; driven 0→1 by the autoplay rAF when on. `slideElapsed` accumulates
    // play time for the current slide (ms), reset on every slide change.
    let fillRatio = autoplayOn ? 0 : 1
    let slideElapsed = 0
    // Video cards play once under autoplay (so the slide advances on `ended`);
    // ambient/looping only when autoplay is off.
    for (const card of cards) {
      const v = card.querySelector('video[data-sai-video]')
      if (v && autoplayOn) v.loop = false
    }

    function paintBars() {
      for (let i = 0; i < fills.length; i++) {
        const v = i < currentIdx ? 1 : i === currentIdx ? fillRatio : 0
        fills[i].style.transform = `scaleX(${v})`
      }
    }

    function paint() {
      for (let i = 0; i < dots.length; i++) {
        const active = i === currentIdx
        dots[i].classList.toggle('is-active', active)
        dots[i].setAttribute('aria-selected', active ? 'true' : 'false')
      }
      paintBars()
      // Arrow disabled state only when looping is off.
      if (!loop) {
        if (prevBtn) prevBtn.disabled = currentIdx === 0
        if (nextBtn) nextBtn.disabled = currentIdx === total - 1
      }
      root.dataset.activeIndex = String(currentIdx)
      syncVideos()
    }

    function scrollToCurrent(instant) {
      const card = cards[currentIdx]
      if (!card) return
      // Scroll the TRACK only — never use scrollIntoView, which scrolls every
      // scrollable ancestor (incl. the page vertically) and causes a visible
      // jump. Compute the exact left offset that centers the card in the track.
      const cardRect = card.getBoundingClientRect()
      const trackRect = trackEl.getBoundingClientRect()
      const delta = cardRect.left - trackRect.left - (trackRect.width - cardRect.width) / 2
      const left = trackEl.scrollLeft + delta
      suppressScrollSync = true
      if (typeof trackEl.scrollTo === 'function') {
        trackEl.scrollTo({ left, behavior: instant ? 'auto' : 'smooth' })
      } else {
        trackEl.scrollLeft = left
      }
      window.setTimeout(
        () => {
          suppressScrollSync = false
        },
        instant ? 120 : 650,
      )
    }

    function setIndex(next, source) {
      const resolved = clampIndex(next, total, loop)
      if (resolved === currentIdx && source !== 'init') return
      currentIdx = resolved
      // Restart the per-slide progress on every change so the active bar fills
      // from empty for the newly-shown slide.
      slideElapsed = 0
      fillRatio = autoplayOn ? 0 : 1
      paint()
      if (track && source !== 'init') {
        const card = cards[currentIdx]
        track(`${FEATURE_SLUG}:slide_change`, {
          banner_index: currentIdx,
          title: card?.querySelector(`.sai-${SNIPPET_ID}__title`)?.textContent?.trim() || '',
        })
      }
    }

    /* ── Per-card video control + play/pause ── */
    function activeVideo() {
      const v = cards[currentIdx]?.querySelector('video[data-sai-video]')
      return v && !v.hasAttribute('controls') ? v : null
    }

    function syncVideos() {
      for (let i = 0; i < cards.length; i++) {
        const video = cards[i].querySelector('video[data-sai-video]')
        if (!video || video.hasAttribute('controls')) continue
        const shouldPlay = i === currentIdx && !userPaused && inView && !prefersReducedMotion()
        if (shouldPlay) {
          const p = video.play()
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } else {
          video.pause()
        }
      }
    }

    // Single source of truth for play/paused — both the centered video button
    // and the bottom autoplay button call this. No hover/focus auto-pause.
    function setPaused(next) {
      userPaused = next
      root.classList.toggle(`sai-${SNIPPET_ID}--paused`, next)
      if (pauseBtn) pauseBtn.setAttribute('aria-label', next ? 'Play' : 'Pause')
      syncVideos()
      kickAutoplay()
    }

    // Centered overlay on video cards: controls THIS card, not the whole
    // carousel. Tapping a non-active (peek) card's button brings it into focus
    // and plays it; tapping the active card's button toggles play/pause. The
    // icon + aria-label mirror the video's real state via media events, so each
    // card's overlay is independently correct.
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      const playBtn = card.querySelector('[data-sai-play]')
      const video = card.querySelector('video[data-sai-video]')
      if (!playBtn || !video) continue
      const relabel = () => {
        playBtn.setAttribute('aria-label', video.paused ? 'Play video' : 'Pause video')
      }
      playBtn.addEventListener('click', () => {
        if (i !== currentIdx) {
          // Focus the tapped card, then ensure the carousel is playing so its
          // (now-active) video starts.
          setIndex(i, 'play')
          scrollToCurrent(false)
          setPaused(false)
        } else {
          setPaused(!userPaused)
        }
      })
      video.addEventListener('play', () => {
        playBtn.classList.remove('is-paused')
        relabel()
      })
      video.addEventListener('pause', () => {
        playBtn.classList.add('is-paused')
        relabel()
      })
      relabel()
    }
    pauseBtn?.addEventListener('click', () => setPaused(!userPaused))

    /* ── Navigation ── */
    prevBtn?.addEventListener('click', () => {
      const wrapping = loop && currentIdx === 0
      setIndex(currentIdx - 1, 'arrow')
      scrollToCurrent(wrapping)
    })
    nextBtn?.addEventListener('click', () => {
      const wrapping = loop && currentIdx === total - 1
      setIndex(currentIdx + 1, 'arrow')
      scrollToCurrent(wrapping)
    })
    for (const dot of dots) {
      dot.addEventListener('click', () => {
        setIndex(Number(dot.dataset.spectrumDot || '0'), 'dot')
        scrollToCurrent(false)
      })
    }

    /* ── Scroll → index sync ── */
    let rafId = 0
    const recompute = () => {
      if (suppressScrollSync || rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const idx = currentIndex(trackEl, cards)
        if (idx !== currentIdx) setIndex(idx, 'observer')
      })
    }
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver(recompute, {
        threshold: [0, 0.25, 0.5, 0.75, 1],
        root: trackEl,
      })
      for (const card of cards) io.observe(card)
    }
    trackEl.addEventListener('scroll', recompute, { passive: true })

    /* ── Card-click + CTA-click analytics ── */
    if (track) {
      for (let i = 0; i < cards.length; i++) {
        const title = () =>
          cards[i].querySelector(`.sai-${SNIPPET_ID}__title`)?.textContent?.trim() || ''
        cards[i].addEventListener('click', () => {
          track(`${FEATURE_SLUG}:card_click`, { banner_index: i, title: title() })
        })
        // CTA clicks are a distinct signal; they also bubble to card_click above
        // (both are intentional — overall card engagement vs. the specific CTA).
        for (const cta of cards[i].querySelectorAll('[data-sai-cta]')) {
          cta.addEventListener('click', () => {
            track(`${FEATURE_SLUG}:cta_click`, {
              banner_index: i,
              cta: cta.getAttribute('data-sai-cta') || 'primary',
              label: cta.textContent?.trim() || '',
              href: cta.getAttribute('href') || '',
              title: title(),
            })
          })
        }
      }
    }

    /* ── Slide impression (gated by the *_impression kill-switch) ── */
    if (track && typeof IntersectionObserver !== 'undefined') {
      const seen = new Set()
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            const idx = Number(e.target.dataset.spectrumBannerIndex || '0')
            if (seen.has(idx)) continue
            seen.add(idx)
            track(`${FEATURE_SLUG}:slide_impression`, { banner_index: idx })
          }
        },
        { threshold: 0.5, root: trackEl },
      )
      for (const card of cards) io.observe(card)
    }

    /* ── Autoplay + progress ──
       One rAF loop fills the active progress bar and (when autoplay is on)
       advances the slide. A video card's bar tracks the VIDEO's real progress
       and advances when it ends; image cards fill over the interval. The loop
       runs whenever autoplay is on OR any card is a video — so a single video
       banner still shows live progress even with autoplay off. */
    const anyVideo = cards.some((c) => {
      const v = c.querySelector('video[data-sai-video]')
      return v && !v.hasAttribute('controls')
    })
    if (autoplayOn || anyVideo) {
      const interval = Math.max(2000, Math.min(15000, Number(root.dataset.autoplayMs) || 5000))
      let lastTs = 0

      const advance = () => {
        if (!loop && currentIdx === total - 1) return
        const wrapping = loop && currentIdx === total - 1
        setIndex(currentIdx + 1, 'autoplay')
        scrollToCurrent(wrapping)
      }

      // `rafAnimId` is the live loop handle / running flag (0 = stopped). The
      // loop self-stops when nothing needs animating (paused / off-screen /
      // reduced motion) instead of spinning a 60fps no-op; `kickAutoplay`
      // restarts it when those conditions clear (see setPaused + the
      // IntersectionObserver below).
      let rafAnimId = 0
      const frame = (ts) => {
        rafAnimId = 0
        // Orphan guard: if Studio swapped this root out (live-preview re-render),
        // let the detached instance's loop die instead of running forever.
        if (!root.isConnected) return
        if (userPaused || !inView || prefersReducedMotion()) {
          lastTs = ts
          return
        }
        rafAnimId = requestAnimationFrame(frame)
        const vid = activeVideo()
        if (vid) {
          // Active card is a video: the bar tracks the video's real progress and
          // (under autoplay) the slide advances only when the video ENDS — never
          // on the image timer. A still-buffering video (readyState < 2) just
          // holds the slide so it's never skipped before it plays.
          if (Number.isFinite(vid.duration) && vid.duration > 0 && vid.readyState >= 2) {
            fillRatio = vid.currentTime / vid.duration
            if (fillRatio > 1) fillRatio = 1
            paintBars()
            lastTs = ts
            if (autoplayOn && (vid.ended || vid.currentTime >= vid.duration - 0.1)) advance()
          } else {
            lastTs = ts
          }
        } else if (autoplayOn) {
          // Image card — fill over the interval, then advance.
          if (!lastTs) lastTs = ts
          slideElapsed += ts - lastTs
          lastTs = ts
          fillRatio = Math.min(1, slideElapsed / interval)
          paintBars()
          if (slideElapsed >= interval) advance()
        } else {
          lastTs = ts
        }
      }
      // Reset `lastTs` so the first frame after a restart measures a 0ms delta
      // (no stale-timestamp jump in the image-card fill).
      kickAutoplay = () => {
        if (rafAnimId || !root.isConnected) return
        lastTs = 0
        rafAnimId = requestAnimationFrame(frame)
      }
      kickAutoplay()

      if (typeof IntersectionObserver !== 'undefined') {
        const vio = new IntersectionObserver(
          (entries) => {
            inView = entries[0]?.isIntersecting === true
            syncVideos()
            kickAutoplay()
          },
          { threshold: 0.25 },
        )
        vio.observe(root)
      }
    }

    setIndex(0, 'init')
  }

  /* ── applyVariant — Studio live preview ── */
  function applyVariant(node, content) {
    if (content == null || typeof content !== 'object') return
    const root = node.querySelector(ROOT_SELECTOR)
    if (!root) return
    setText(root, `.sai-${SNIPPET_ID}__eyebrow-text`, content.section_title)
    setText(root, `.sai-${SNIPPET_ID}__heading`, content.section_description)

    for (const a of ['left', 'center', 'right']) {
      root.classList.remove(`sai-${SNIPPET_ID}--head-${a}`)
    }
    root.classList.add(`sai-${SNIPPET_ID}--head-${content.section_align || 'center'}`)

    for (const a of ['left', 'center', 'right']) {
      root.classList.remove(`sai-${SNIPPET_ID}--dots-${a}`, `sai-${SNIPPET_ID}--dots-m-${a}`)
    }
    root.classList.add(`sai-${SNIPPET_ID}--dots-${content.dots_placement || 'center'}`)
    const dotsM = content.dots_placement_mobile
    if (dotsM && dotsM !== 'inherit') root.classList.add(`sai-${SNIPPET_ID}--dots-m-${dotsM}`)
  }

  function setText(root, selector, value) {
    if (typeof value !== 'string') return
    const el = root.querySelector(selector)
    if (el) el.textContent = value
  }

  /* ── Test surface ── */
  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiObeect95 = { currentIndex, clampIndex, safeTrack, applyVariant }
  }

  /* ── Boot ── */
  function boot() {
    const inited = new Set()
    const snippetApi = window.__spectrumAi?.snippet
    if (snippetApi && typeof snippetApi.bind === 'function') {
      const containers = document.querySelectorAll(
        `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
      )
      for (const node of containers) {
        const handle = snippetApi.bind(node, ({ variants, currentVariantId }) => {
          const variant = variants.find((v) => v.variantId === currentVariantId)
          if (variant?.content) applyVariant(node, variant.content)
        })
        const track = handle?.track ? safeTrack(handle.track) : noopTrack
        const root = node.querySelector(ROOT_SELECTOR)
        if (root) {
          initCarousel(root, track)
          inited.add(root)
        }
      }
    }
    // Any root not bound above (no SDK present) still gets its carousel.
    for (const root of document.querySelectorAll(ROOT_SELECTOR)) {
      if (!inited.has(root)) initCarousel(root, noopTrack)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
