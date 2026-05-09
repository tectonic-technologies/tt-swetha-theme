/**
 * Shoppable Videos snippet-author runtime.
 *
 * Loaded via async <script src> from each render of the snippet's main
 * .liquid. Duplicate requests on multi-instance pages
 * are cache-coalesced; the IIFE is guarded against multi-execution.
 *
 * Responsibilities:
 *   1. Define and register the <sai-svmk8tqx> custom-element class.
 *      Class owns its inner DOM; applyVariant(content, pool) re-renders.
 *   2. Bind each [data-spectrum-instance-id][data-spectrum-snippet-id="svmk8tqx"]
 *      container via __spectrumAi.snippet.bind(node, callback). Bind callback
 *      reads the snippet's bespoke pool and feeds the custom element.
 *
 * Full DOM rebuild on every variant resolution — heading, subheading, preset
 * class, and the entire cards grid + dialog slides + product strips. Pool is
 * the sibling <script type="application/json" data-spectrum-snippet-pool>
 * emitted by the snippet's main .liquid (NOT the wrapper's envelope pool,
 * which is vestigial for this snippet — see plan §15#3 / §15#8).
 *
 * Test surface: when globalThis.__SAI_TEST_HARNESS__ === true, the IIFE
 * exposes globalThis.__saiSvmk8tqx with DOM string-builders + helpers for
 * unit tests. Production never sets the flag.
 */
;(() => {
  // Multi-execution guard: async <script src> tags emitted per-render mean
  // the IIFE may run multiple times on a page with multiple instances.
  // Custom-element re-define throws; bind iteration would double-register.
  if (window.__sai_svmk8tqx_initialized__) return
  window.__sai_svmk8tqx_initialized__ = true

  const SNIPPET_ID = 'svmk8tqx'
  const TAG = 'sai-svmk8tqx'
  const FEATURE_SLUG = 'shoppable_videos'

  // ── Pool reader ──
  // The snippet emits a sibling <script type="application/json"
  // data-spectrum-snippet-pool> next to the wrapper's envelope inside the
  // outer container. We iterate direct children explicitly (rather than a
  // `:scope > ...` querySelector) for cross-environment reliability —
  // JSDOM doesn't always honour `:scope >` correctly. Direct-child constraint
  // matters: in multi-instance pages, each instance has its own pool, and
  // a nested script (e.g. inside a <sai-svmk8tqx>) should not be picked up.
  function readSnippetPool(node) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (child.tagName === 'SCRIPT' && child.hasAttribute('data-spectrum-snippet-pool')) {
        const text = child.textContent
        if (!text) return {}
        try {
          return JSON.parse(text)
        } catch {
          return {}
        }
      }
    }
    return {}
  }

  // ── DOM string-builders ──
  // The wrapper Liquid only emits skeleton placeholders + the dialog
  // scaffold + the bespoke pool block (post-Option-3b cutover); these
  // string-builders are the single source of truth for cards, slides, and
  // product cards. Called from applyVariant on init AND on every targeting
  // swap. template-invariants.test.ts pins the few cross-surface
  // invariants that remain (pool shape, async script tag, etc.).

  function buildPlaySvg() {
    return (
      '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">' +
      '<path d="M5.5 3.5L14.5 9L5.5 14.5V3.5Z" fill="#111111"/>' +
      '</svg>'
    )
  }

  function buildCard(handle, video, index) {
    if (!video || !video.video_url) return ''
    const title = video.title || 'Video'
    let mediaMarkup
    if (video.poster_url) {
      mediaMarkup = `<img src="${video.poster_url}" alt="${title}" loading="lazy" class="sai-svmk8tqx__card-poster">`
    } else {
      const cardSrc = video.preview_url || video.video_url
      mediaMarkup = `<spectrum-video data-src="${cardSrc}" data-autoplay="muted" data-loop data-load="viewport" class="sai-svmk8tqx__card-video"></spectrum-video>`
    }
    return `<button class="sai-svmk8tqx__card" type="button" role="listitem" data-handle="${handle}" data-index="${index}" aria-label="Play ${title}" aria-haspopup="dialog">${mediaMarkup}<div class="sai-svmk8tqx__play" aria-hidden="true"><span class="sai-svmk8tqx__play-btn">${buildPlaySvg()}</span></div></button>`
  }

  // Inert grid slot for refIds whose pool entry is missing or has no
  // video_url. Shares the __card class so width + aspect-ratio are
  // reserved → no CLS when the JS swaps an SSR placeholder to either a
  // real card or an unavailable indicator. CSS handles the visible
  // "Video unavailable" label via ::after.
  function buildUnavailable(handle) {
    return `<div class="sai-svmk8tqx__card sai-svmk8tqx__card--unavailable" data-handle="${handle}" aria-hidden="true"></div>`
  }

  function buildDialogSlide(handle, video, index) {
    if (!video || !video.video_url) return ''
    const posterAttr = video.poster_url ? ` data-poster="${video.poster_url}"` : ''
    const posterImg = video.poster_url
      ? `<img src="${video.poster_url}" alt="" loading="lazy">`
      : ''
    const products = (video.product_tags || []).map(buildProductCard).join('')
    const productsBlock = products
      ? `<div class="sai-svmk8tqx__dialog-products"><div class="sai-svmk8tqx__dialog-products-scroll">${products}</div></div>`
      : ''
    return `<div class="sai-svmk8tqx__dialog-slide" data-handle="${handle}" data-index="${index}" data-position="hidden"><spectrum-video data-src="${video.video_url}"${posterAttr} data-autoplay="muted" data-loop data-load="click" class="sai-svmk8tqx__dialog-video">${posterImg}</spectrum-video>${productsBlock}</div>`
  }

  function buildProductCard(t) {
    if (!t) return ''
    const thumbImg = t.thumb_url
      ? `<img class="sai-svmk8tqx__product-img" src="${t.thumb_url}"` +
        ` alt="${t.display_name}" width="60" height="60" loading="lazy">`
      : ''

    const priceMarkup = t.price_override
      ? t.price_override
      : (t.variant_price || t.product_price || '') +
        (t.show_compare && t.variant_compare_at_price
          ? ` <span class="sai-svmk8tqx__product-price--compare">${t.variant_compare_at_price}</span>`
          : '')

    // Analytics provenance attributes — read by the dialog click delegate
    // for product_click, by the per-product IO observer for product_impression,
    // and by the ATC handler for add_to_cart. Tag id and product id come
    // from the bespoke pool block (see _sai-snippet-svmk8tqx.liquid).
    const tagIdAttr = t.tag_id != null ? ` data-tag-id="${t.tag_id}"` : ''
    const productIdAttr = t.product_id != null ? ` data-product-id="${t.product_id}"` : ''

    let actionMarkup
    if (t.cta_url) {
      actionMarkup = `<a href="${t.cta_url}" class="sai-svmk8tqx__product-btn" data-action="product-click">${t.cta_text}</a>`
    } else if (t.single_variant && t.variant_available) {
      actionMarkup = `<button class="sai-svmk8tqx__product-btn" type="button" data-action="atc" data-variant-id="${t.variant_id}"${tagIdAttr}${productIdAttr} data-state="idle" aria-label="Add ${t.display_name} to cart"><span class="sai-svmk8tqx__product-btn-label" data-role="label">${t.cta_text}</span><span class="sai-spinner sai-svmk8tqx__product-btn-spinner" data-role="spinner" aria-hidden="true"></span></button><a href="${t.cart_url}" class="sai-svmk8tqx__product-btn sai-svmk8tqx__product-btn--view-cart" data-role="view-cart" hidden>View cart</a>`
    } else if (t.variant_available === false) {
      actionMarkup = `<button class="sai-svmk8tqx__product-btn" type="button" disabled>Sold out</button>`
    } else {
      actionMarkup = `<a href="${t.product_url}" class="sai-svmk8tqx__product-btn" data-action="product-click">View</a>`
    }

    return `<div class="sai-svmk8tqx__product-card"${tagIdAttr}${productIdAttr}><a href="${t.product_url}" class="sai-svmk8tqx__product-img-wrap" tabindex="-1" aria-hidden="true" data-action="product-click">${thumbImg}</a><div class="sai-svmk8tqx__product-info"><a href="${t.product_url}" class="sai-svmk8tqx__product-title" data-action="product-click">${t.display_name}</a><p class="sai-svmk8tqx__product-price">${priceMarkup}</p></div><div class="sai-svmk8tqx__product-action">${actionMarkup}</div></div>`
  }

  // ── Custom element ──
  if (!customElements.get(TAG)) {
    class SaiShoppableVideos extends HTMLElement {
      // Parser-inserted custom elements whose class is already registered get
      // upgraded at the start tag — before children are parsed. Wait for the
      // subtree before running setup that queries descendants. Anchor on the
      // dialog's close button: deep enough that its presence implies the rest
      // of the subtree is in place.
      connectedCallback() {
        if (this._initialized) return
        const ready = () => !!this.querySelector('.sai-svmk8tqx__dialog-close')
        if (ready()) {
          this._init()
          return
        }
        const obs = new MutationObserver(() => {
          if (ready()) {
            obs.disconnect()
            this._init()
          }
        })
        obs.observe(this, { childList: true, subtree: true })
      }

      _init() {
        this._initialized = true

        this.dialog = this.querySelector('.sai-svmk8tqx__dialog')
        this.slidesScroller = this.querySelector('.sai-svmk8tqx__dialog-slides')
        this.muteBtn = this.querySelector('.sai-svmk8tqx__dialog-mute')
        this.muteIconMuted = this.querySelector('.sai-svmk8tqx__mute-icon--muted')
        this.muteIconSound = this.querySelector('.sai-svmk8tqx__mute-icon--sound')
        this.prevBtn = this.querySelector('[data-action="prev"]')
        this.nextBtn = this.querySelector('[data-action="next"]')
        this.gridEl = this.querySelector('.sai-svmk8tqx__grid')
        this.desktopMQ = window.matchMedia('(min-width: 768px)')

        this.activeIndex = 0
        this.observer = null
        // Audio preference scoped to the open dialog. Resets on close so
        // every dialog open starts muted (autoplay-safe). `toggleMute` is
        // the only writer while the dialog is open.
        this.audioOn = false

        // ── Analytics state ──
        // Set later via setAnalytics(track, emit) by bindAllContainers. Until
        // then, _track/_emit are no-ops so the snippet works without the
        // bootstrap SDK loaded (e.g. local dev without analytics).
        this._track = noopTrack
        this._emit = noopEmit
        // `_analyticsReady` gates impression observers from running before
        // the real track/emit handles are installed. Without this gate, an
        // above-the-fold card visible at page-load could fire an IO callback
        // while track is still noopTrack — silently dropping the impression
        // AND adding the handle to _impressedCards, so the later real track
        // never gets a chance to fire it. See review issue #2.
        this._analyticsReady = false
        // Stashed by applyVariant for analytics payload lookups.
        this._pool = {}
        this._refIds = []
        this._listLayout = 'default'
        // One-shot impression guards — handle Sets so re-applying variant
        // (rebuild) doesn't re-fire impressions for cards already seen.
        this._impressedListFired = false
        this._impressedCards = new Set()
        // Per-dialog-session product-impression dedup (keyed by tag_id).
        // Reset in open(); see _setupProductImpressionsObserver.
        this._impressedProducts = new Set()
        this._cardsObserver = null
        this._productsObserver = null
        this._listObserver = null
        // View-duration state machine.
        // close()/pagehide are unified: pagehide sets _pendingExitReason and
        // calls close(); close() reads the flag (default 'close') so we never
        // double-fire. _viewSession is the active video's session record.
        this._viewSession = null
        this._pendingExitReason = undefined

        // Dialog-level delegated listener — survives applyVariant rebuilds
        // because the dialog scaffold (close/mute/nav buttons) is preserved.
        this.dialog.addEventListener('click', (e) => {
          if (e.target === this.dialog) return this.close()
          const actionEl = e.target.closest('[data-action]')
          if (!actionEl) return
          const action = actionEl.dataset.action
          if (action === 'close') this.close()
          else if (action === 'mute') this.toggleMute()
          else if (action === 'prev') this.go(-1)
          else if (action === 'next') this.go(+1)
          else if (action === 'atc') this.addToCart(actionEl)
          else if (action === 'product-click') this._fireProductClick(actionEl)
        })

        this.dialog.addEventListener('cancel', () => this.close())

        // List-level swipe scroll → `shoppable_videos:list_scroll`. Debounced
        // so a single discrete swipe gesture fires once. `scroll_direction`
        // is derived from `scrollLeft` delta vs the value at the start of
        // the gesture window.
        this._lastGridScrollLeft = 0
        this._gridScrollDebounceTimer = null
        if (this.gridEl) {
          this._lastGridScrollLeft = this.gridEl.scrollLeft
          this.gridEl.addEventListener('scroll', () => this._onGridScroll(), { passive: true })
        }

        // Close on navigation away (product link, View Cart, external links,
        // back/forward). `pagehide` fires before the page is hidden or put
        // into bfcache — closing here ensures a back-restore doesn't bring
        // the dialog back open.
        //
        // Analytics: route `view_duration` exit-reason through close() so the
        // single close path emits exactly once. See §5.5 of the brainstorming
        // doc — _pendingExitReason is the only place 'pagehide' is set.
        this._onPageHide = () => {
          if (this.dialog?.open) {
            this._pendingExitReason = 'pagehide'
            this.close()
          }
        }
        window.addEventListener('pagehide', this._onPageHide)

        // Initial DOM-ref capture for cards/slides/product-scrolls (these are
        // re-queried on every applyVariant rebuild).
        this._refresh()
      }

      /**
       * Receive the analytics handles from `__spectrumAi.snippet.bind(...)`.
       * Called once per page-load by `bindAllContainers`. After this:
       *  - `_analyticsReady` is set; impression observers can now fire.
       *  - List impression observer is set up (fires once at ≥50% viewport).
       *  - Per-card impression observer is set up (re-bound on every applyVariant
       *    rebuild via _refresh).
       */
      setAnalytics(track, emit) {
        this._track = typeof track === 'function' ? track : noopTrack
        this._emit = typeof emit === 'function' ? emit : noopEmit
        this._analyticsReady = true
        this._setupListImpressionObserver()
        // _refresh has already run (at _init / applyVariant); rerun the
        // per-card observer setup now that analytics is ready. Subsequent
        // applyVariant rebuilds re-call _refresh which re-binds the observer
        // (and at that point _analyticsReady is already true).
        this._setupCardImpressionsObserver()
      }

      // Re-query DOM refs that change on rebuild (cards, slides, product
      // scrollers) and re-attach card click handlers. Idempotent; called
      // from _init AND from applyVariant.
      //
      // Excludes placeholders and unavailable indicators — only real cards
      // (those backed by a pool entry with video_url) get listeners. Both
      // modifiers also have pointer-events:none, so this is belt-and-braces.
      _refresh() {
        this.slides = Array.from(this.querySelectorAll('.sai-svmk8tqx__dialog-slide'))
        this.cards = Array.from(
          this.querySelectorAll(
            '.sai-svmk8tqx__card:not(.sai-svmk8tqx__card--placeholder):not(.sai-svmk8tqx__card--unavailable)',
          ),
        )
        this.productScrolls = Array.from(
          this.querySelectorAll('.sai-svmk8tqx__dialog-products-scroll'),
        )

        // Cards have per-card click handlers (legacy pattern). Old cards are
        // removed via innerHTML replacement so their listeners GC; new cards
        // need fresh handlers. cards[i] index == slide index (real cards
        // and slides are emitted in lockstep by applyVariant).
        //
        // Analytics: fire `shoppable_videos:preview_click` (track + emit)
        // before opening the dialog. The DOM emit lets theme code react
        // to dialog opens (e.g. pause an autoplaying hero video).
        for (let i = 0; i < this.cards.length; i++) {
          const cardIndex = i
          const card = this.cards[i]
          card.addEventListener('click', () => {
            const handle = card.dataset.handle
            const payload = handle ? { video_id: handle } : {}
            this._track(`${FEATURE_SLUG}:preview_click`, payload)
            this._emit(`${FEATURE_SLUG}:preview_click`, payload)
            this.open(cardIndex)
          })
        }

        // Re-bind per-card impression observer for the rebuilt card set.
        this._setupCardImpressionsObserver()
      }

      disconnectedCallback() {
        this.observer?.disconnect()
        this._cardsObserver?.disconnect()
        this._productsObserver?.disconnect()
        this._listObserver?.disconnect()
        this._cardsObserver = null
        this._productsObserver = null
        this._listObserver = null
        if (this._gridScrollDebounceTimer) {
          clearTimeout(this._gridScrollDebounceTimer)
          this._gridScrollDebounceTimer = null
        }
        if (this._onPageHide) {
          window.removeEventListener('pagehide', this._onPageHide)
        }
        document.body.style.overflow = ''
      }

      // ── Variant resolution entry point (plan §15#8) ──
      // Re-renders the inner DOM from pool data. Called by the bind callback
      // on every $spectrum:variant_resolved event for this instance.
      applyVariant(presentation, slotContent, pool) {
        const content = presentation && typeof presentation === 'object' ? presentation : {}
        const resolvedSlotContent =
          slotContent && typeof slotContent === 'object' && pool !== undefined
            ? slotContent
            : content
        const resolvedPool =
          pool !== undefined
            ? pool
            : slotContent && typeof slotContent === 'object'
              ? slotContent
              : {}
        // Heading / subheading text swap.
        if (typeof content.heading === 'string') {
          const h = this.querySelector('.sai-svmk8tqx__heading')
          if (h) h.textContent = content.heading
        }
        if (typeof content.subheading === 'string') {
          const p = this.querySelector('.sai-svmk8tqx__subheading')
          if (p) p.textContent = content.subheading
        }

        // Preset BEM modifier swap on root.
        if (typeof content.preset === 'string') {
          for (const cls of Array.from(this.classList)) {
            if (cls.startsWith('sai-svmk8tqx--')) this.classList.remove(cls)
          }
          if (content.preset !== 'default') {
            this.classList.add(`sai-svmk8tqx--${content.preset}`)
          }
        }

        // Stash for analytics payload lookups (list_impression, preview_impression).
        const safePool = resolvedPool && typeof resolvedPool === 'object' ? resolvedPool : {}
        const refIds = Array.isArray(resolvedSlotContent.videoHandles)
          ? resolvedSlotContent.videoHandles
          : (content.videos?.refIds ?? [])
        this._pool = safePool
        this._refIds = refIds
        this._listLayout = typeof content.preset === 'string' ? content.preset : 'default'

        const cardItems = []
        const slideItems = []
        let slideIdx = 0
        for (const handle of refIds) {
          const video = safePool[handle]
          if (video?.video_url) {
            cardItems.push(buildCard(handle, video, slideIdx))
            slideItems.push(buildDialogSlide(handle, video, slideIdx))
            slideIdx += 1
          } else {
            cardItems.push(buildUnavailable(handle))
          }
        }

        // Close the dialog if open — we're about to replace the slides DOM
        // and any active observer/handlers reference stale nodes.
        if (this.dialog?.open) this.close()
        this.observer?.disconnect()
        this.observer = null
        this.activeIndex = 0

        const grid = this.querySelector('.sai-svmk8tqx__grid')
        if (grid) grid.innerHTML = cardItems.join('')
        if (this.slidesScroller) this.slidesScroller.innerHTML = slideItems.join('')

        // Toggle nav-button visibility based on real-video count (slideIdx).
        // SSR emits both buttons with `hidden`; CSS `__dialog-nav[hidden]`
        // override ensures hidden actually hides on tablet+.
        const showNav = slideIdx > 1
        if (this.prevBtn) this.prevBtn.hidden = !showNav
        if (this.nextBtn) this.nextBtn.hidden = !showNav

        // Re-query DOM refs for the rebuilt cards/slides/products.
        this._refresh()
      }

      isDesktop() {
        return this.desktopMQ.matches
      }

      getVideo(slide) {
        return slide.querySelector('spectrum-video')
      }

      getActiveVideo() {
        const slide = this.slides[this.activeIndex]
        return slide ? this.getVideo(slide) : null
      }

      neighborIndexes(index, includeSelf = false) {
        const result = []
        if (index - 1 >= 0) result.push(index - 1)
        if (includeSelf) result.push(index)
        if (index + 1 < this.slides.length) result.push(index + 1)
        return result
      }

      applyAudioPreference(video) {
        if (!video) return
        if (this.audioOn) video.unmute()
        else video.mute()
      }

      loadSlides(indexes) {
        for (const i of indexes) {
          const slide = this.slides[i]
          const vid = slide && this.getVideo(slide)
          if (vid) vid.load()
        }
      }

      updatePositions(index) {
        this.activeIndex = index
        for (let i = 0; i < this.slides.length; i++) {
          const slide = this.slides[i]
          const diff = i - index
          const pos = diff === 0 ? 'center' : diff === -1 ? 'left' : diff === 1 ? 'right' : 'hidden'
          slide.dataset.position = pos

          const vid = this.getVideo(slide)
          if (!vid) continue
          if (pos === 'center') {
            this.applyAudioPreference(vid)
            vid.play()
          } else if (pos === 'hidden') vid.unload()
          else vid.pause()
        }
      }

      updateMuteIcons() {
        const isMuted = !this.audioOn
        if (isMuted) {
          this.muteIconMuted.style.display = ''
          this.muteIconSound.style.display = 'none'
          this.muteBtn.setAttribute('aria-label', 'Unmute')
        } else {
          this.muteIconMuted.style.display = 'none'
          this.muteIconSound.style.display = ''
          this.muteBtn.setAttribute('aria-label', 'Mute')
        }
      }

      updateNavButtonsState() {
        if (this.prevBtn) this.prevBtn.disabled = this.activeIndex <= 0
        if (this.nextBtn) this.nextBtn.disabled = this.activeIndex >= this.slides.length - 1
      }

      toggleMute() {
        this.audioOn = !this.audioOn
        this.applyAudioPreference(this.getActiveVideo())
        this.updateMuteIcons()
      }

      resetAtcButtons() {
        const stuck = this.dialog.querySelectorAll('[data-action="atc"][data-state="loading"]')
        for (const btn of stuck) {
          btn.dataset.state = 'idle'
          btn.disabled = false
          btn.removeAttribute('aria-busy')
        }
      }

      setupMobileObserver() {
        if (this.observer) this.observer.disconnect()
        this.observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const vid = this.getVideo(entry.target)
              if (!vid) continue

              if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
                const idx = Number.parseInt(entry.target.dataset.index, 10) || 0
                if (idx !== this.activeIndex) {
                  // Mobile swipe analytics: derive direction from index delta.
                  const exitReason = idx > this.activeIndex ? 'next' : 'prev'
                  this._fireView(idx, exitReason)
                  this.activeIndex = idx
                  this.updateNavButtonsState()
                  this._setupProductImpressionsObserver()
                }
                this.applyAudioPreference(vid)
                vid.play()
              } else {
                vid.pause()
              }
            }
          },
          { root: this.slidesScroller, threshold: 0.6 },
        )

        for (const slide of this.slides) this.observer.observe(slide)
      }

      open(index) {
        this.activeIndex = index
        this.updateMuteIcons()
        this.updateNavButtonsState()
        // Reset per-dialog product-impression dedup. Each dialog session is
        // independent — re-opening the dialog re-fires product impressions.
        this._impressedProducts = new Set()
        // Fire `shoppable_videos:view` for the initial active video. Starts
        // the view session that pairs with view_duration on next/prev/close.
        this._fireView(index, null)

        if (this.isDesktop()) {
          this.slidesScroller.classList.add('sai-svmk8tqx__dialog-slides--snap')
          for (let i = 0; i < this.slides.length; i++) {
            const diff = i - index
            this.slides[i].dataset.position =
              diff === 0 ? 'center' : diff === -1 ? 'left' : diff === 1 ? 'right' : 'hidden'
          }
        }

        this.dialog.showModal()
        document.body.style.overflow = 'hidden'

        requestAnimationFrame(() => {
          for (const el of this.productScrolls) el.scrollLeft = 0

          if (this.isDesktop()) {
            void this.slidesScroller.offsetHeight
            this.slidesScroller.classList.remove('sai-svmk8tqx__dialog-slides--snap')

            this.loadSlides(this.neighborIndexes(index))
            this.updatePositions(index)
          } else {
            this.loadSlides(this.neighborIndexes(index, true))
            this.slidesScroller.scrollTop = index * this.slidesScroller.clientHeight
            this.setupMobileObserver()
            const active = this.getActiveVideo()
            if (active) active.play()
          }

          // Set up per-product-card IO observer for the active slide. Re-runs
          // on each open() because dialog sessions reset _impressedProducts.
          this._setupProductImpressionsObserver()
        })
      }

      close() {
        // Fire `view_duration` for the active video before tearing down.
        // _pendingExitReason is set by pagehide; otherwise this is 'close'.
        const exitReason = this._pendingExitReason ?? 'close'
        this._fireViewDuration(exitReason)
        this._pendingExitReason = undefined

        this.observer?.disconnect()
        this._productsObserver?.disconnect()
        this._productsObserver = null
        for (const slide of this.slides) {
          const vid = this.getVideo(slide)
          if (vid) vid.unload()
        }
        this.audioOn = false
        this.resetAtcButtons()
        this.dialog.close()
        document.body.style.overflow = ''
      }

      go(delta) {
        if (!this.isDesktop()) return
        const newIndex = this.activeIndex + delta
        if (newIndex < 0 || newIndex >= this.slides.length) return

        // Analytics: fire view_duration for outgoing video (with the swipe
        // direction as exit_reason), then view for the new active video.
        const exitReason = delta > 0 ? 'next' : 'prev'
        this._fireView(newIndex, exitReason)

        this.loadSlides(this.neighborIndexes(newIndex))
        this.updatePositions(newIndex)
        this.updateNavButtonsState()
        // Re-arm: observer is scoped to the active slide's product cards;
        // without this, products on slides reached via nav never fire impressions.
        this._setupProductImpressionsObserver()
      }

      async addToCart(btn) {
        const variantId = btn.dataset.variantId
        if (!variantId) return
        const action = btn.closest('.sai-svmk8tqx__product-action')
        const viewCart = action?.querySelector('[data-role="view-cart"]')

        // Build payload up front so the intent (`add_to_cart`) and confirmation
        // (`added_to_cart`) events carry an identical shape — the funnel
        // assumes 1:1 pairing keyed off the envelope.
        const payload = {
          video_id: this._activeVideoHandle(),
          tag_id: btn.dataset.tagId,
          product_id: btn.dataset.productId,
          variant_id: variantId,
          quantity: 1,
        }

        // Intent — fires on click, before the cart call. Mutually exclusive
        // with `product_click`. Fires regardless of cart-add outcome so an
        // `add_to_cart` without a matching `added_to_cart` reveals failures.
        this._track(`${FEATURE_SLUG}:add_to_cart`, payload)
        this._emit(`${FEATURE_SLUG}:add_to_cart`, payload)

        btn.dataset.state = 'loading'
        btn.disabled = true
        btn.setAttribute('aria-busy', 'true')

        try {
          // Note: cart.add() is called with NO `properties` — the analytics
          // convention is observational only. Attribution is via the
          // PostHog session funnel, not cart-line metadata.
          const res = await window.Spectrum.cart.add({ id: variantId, quantity: 1 })
          // Some SDK versions return { ok: boolean } wrappers, others return
          // the raw added item (Shopify AJAX Cart API shape). Treat only an
          // explicit ok:false as failure; any other non-throwing return is
          // success. Real failures from the SDK surface as thrown errors.
          if (res && res.ok === false) throw new Error(res.error?.message || 'ATC failed')

          // Confirmation — fires after cart-add succeeds, before the visual
          // swap. Track + paired DOM emit (Klaviyo / theme adapters subscribe
          // here for cart-line side effects).
          this._track(`${FEATURE_SLUG}:added_to_cart`, payload)
          this._emit(`${FEATURE_SLUG}:added_to_cart`, payload)

          const label = btn.querySelector('[data-role="label"]')
          const originalText = label ? label.textContent : ''
          btn.dataset.state = 'success'
          btn.disabled = true
          btn.removeAttribute('aria-busy')
          if (label) label.textContent = 'Added'
          setTimeout(() => {
            btn.dataset.state = 'idle'
            btn.disabled = false
            if (label) label.textContent = originalText
          }, 4000)

          document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }))
        } catch (e) {
          console.error('[sai-svmk8tqx] ATC failed', e)
          btn.dataset.state = 'idle'
          btn.disabled = false
          btn.removeAttribute('aria-busy')
        }
      }

      // ── Analytics helpers ──────────────────────────────────────────────

      /** Handle of the active dialog slide (used for view / view_duration / ATC). */
      _activeVideoHandle() {
        return this.slides[this.activeIndex]?.dataset.handle
      }

      /**
       * Fire `shoppable_videos:view` for a newly-active video. If a session
       * already exists for the previous active video, fire its `view_duration`
       * first with the supplied `exitReason`. Pair semantics:
       *   - on dialog open: exitReason=null (no prior session)
       *   - on go(±1): exitReason='next' | 'prev'
       *   - on mobile-IO swap: exitReason='next' | 'prev' (derived from delta)
       */
      _fireView(index, exitReason) {
        const handle = this.slides[index]?.dataset.handle
        if (!handle) return
        if (this._viewSession && exitReason) {
          this._fireViewDuration(exitReason)
        }
        // Start a new session — wall-clock time, looped flag toggled on
        // the active video's `ended` event.
        const video = this._slideVideo(index)
        const session = {
          videoId: handle,
          startedAt: Date.now(),
          looped: false,
          video: video || null,
          onEnded: null,
        }
        if (video) {
          session.onEnded = () => {
            session.looped = true
          }
          video.addEventListener('ended', session.onEnded)
        }
        this._viewSession = session
        this._track(`${FEATURE_SLUG}:view`, { video_id: handle })
      }

      /**
       * Fire `shoppable_videos:view_duration` for the active session and clear
       * it. No-op if no session is active. Idempotent across calls.
       */
      _fireViewDuration(exitReason) {
        const session = this._viewSession
        if (!session) return
        // Detach the ended listener so the next session starts clean.
        if (session.video && session.onEnded) {
          session.video.removeEventListener('ended', session.onEnded)
        }
        const payload = {
          video_id: session.videoId,
          duration_ms: Date.now() - session.startedAt,
          loop: session.looped === true,
          exit_reason: exitReason,
        }
        this._viewSession = null
        this._track(`${FEATURE_SLUG}:view_duration`, payload)
      }

      /** Look up the <spectrum-video> element for a given slide index. */
      _slideVideo(index) {
        const slide = this.slides[index]
        return slide ? this.getVideo(slide) : null
      }

      /**
       * Set up the list-level IntersectionObserver. Fires
       * `shoppable_videos:list_impression` once per page-load when the
       * `<sai-svmk8tqx>` host element hits ≥50% viewport. Idempotent —
       * setting up twice (e.g. on re-applyVariant) is safe.
       */
      _setupListImpressionObserver() {
        if (this._impressedListFired) return
        if (this._listObserver) return
        if (typeof IntersectionObserver === 'undefined') return
        this._listObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                this._fireListImpression()
                this._listObserver?.disconnect()
                this._listObserver = null
                return
              }
            }
          },
          { threshold: 0.5 },
        )
        this._listObserver.observe(this)
      }

      _fireListImpression() {
        if (this._impressedListFired) return
        this._impressedListFired = true
        const visibleVideoCount = this._countVisibleCards()
        this._track(`${FEATURE_SLUG}:list_impression`, {
          list_layout: this._listLayout,
          total_videos_in_list: this._refIds.length,
          visible_video_count: visibleVideoCount,
        })
      }

      /** Count cards currently visible (≥50% in viewport) via bounding-rect. */
      _countVisibleCards() {
        const viewportHeight = window.innerHeight || 0
        const viewportWidth = window.innerWidth || 0
        let count = 0
        for (const card of this.cards) {
          const rect = card.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          const visibleX = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0))
          const visibleY = Math.max(
            0,
            Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
          )
          const visibleArea = visibleX * visibleY
          const totalArea = rect.width * rect.height
          if (visibleArea / totalArea >= 0.5) count += 1
        }
        return count
      }

      /**
       * Per-card IntersectionObserver — fires
       * `shoppable_videos:preview_impression` once per card per page-load.
       * Re-bound on every applyVariant rebuild via _refresh; the
       * _impressedCards Set persists across rebuilds so previously-fired
       * cards don't re-fire when they re-enter view.
       */
      _setupCardImpressionsObserver() {
        if (typeof IntersectionObserver === 'undefined') return
        this._cardsObserver?.disconnect()
        this._cardsObserver = null
        // Race guard: don't set up the observer until analytics handles are
        // installed. Otherwise an above-the-fold card visible at page-load
        // could trigger the IO callback with `this._track === noopTrack`,
        // silently dropping the impression event AND polluting the dedup
        // set so the later real track never fires it.
        if (!this._analyticsReady) return
        if (!this.cards.length) return
        this._cardsObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue
              const card = entry.target
              const handle = card.dataset.handle
              if (!handle || this._impressedCards.has(handle)) continue
              this._impressedCards.add(handle)
              const poolEntry = this._pool[handle]
              const tagged_product_count = Array.isArray(poolEntry?.product_tags)
                ? poolEntry.product_tags.length
                : 0
              this._track(`${FEATURE_SLUG}:preview_impression`, {
                video_id: handle,
                tagged_product_count,
              })
              this._cardsObserver?.unobserve(card)
            }
          },
          { threshold: 0.5 },
        )
        for (const card of this.cards) {
          if (!this._impressedCards.has(card.dataset.handle || '')) {
            this._cardsObserver.observe(card)
          }
        }
      }

      /**
       * Per-product-card IntersectionObserver inside the active dialog slide.
       * Fires `shoppable_videos:product_impression` once per (video_id, tag_id)
       * per dialog session. The dedup set is reset in open().
       */
      _setupProductImpressionsObserver() {
        if (typeof IntersectionObserver === 'undefined') return
        this._productsObserver?.disconnect()
        this._productsObserver = null
        const activeSlide = this.slides[this.activeIndex]
        if (!activeSlide) return
        const productCards = activeSlide.querySelectorAll('.sai-svmk8tqx__product-card')
        if (!productCards.length) return
        const videoId = activeSlide.dataset.handle
        this._productsObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue
              const card = entry.target
              const tagId = card.dataset.tagId
              const productId = card.dataset.productId
              if (!tagId) continue
              const key = `${videoId}:${tagId}`
              if (this._impressedProducts.has(key)) continue
              this._impressedProducts.add(key)
              this._track(`${FEATURE_SLUG}:product_impression`, {
                video_id: videoId,
                tag_id: tagId,
                product_id: productId,
              })
              this._productsObserver?.unobserve(card)
            }
          },
          { threshold: 0.5 },
        )
        for (const card of productCards) {
          this._productsObserver.observe(card)
        }
      }

      /**
       * Fire `shoppable_videos:product_click` for a product-card child element
       * with `data-action="product-click"`. Resolves tag_id/product_id from
       * the closest .sai-svmk8tqx__product-card ancestor (anchors in the
       * card don't carry IDs themselves; the wrapping div does).
       */
      _fireProductClick(actionEl) {
        const card = actionEl.closest('.sai-svmk8tqx__product-card')
        if (!card) return
        const activeVideo = this.getActiveVideo()
        const payload = {
          video_id: this._activeVideoHandle(),
          tag_id: card.dataset.tagId,
          product_id: card.dataset.productId,
          video_progress_seconds: activeVideo?.currentTime ?? 0,
        }
        this._track(`${FEATURE_SLUG}:product_click`, payload)
      }

      /**
       * Debounced grid-scroll handler — fires `shoppable_videos:list_scroll`
       * once per discrete swipe gesture with `scroll_direction` derived from
       * the delta vs the gesture start position.
       */
      _onGridScroll() {
        if (!this.gridEl) return
        if (this._gridScrollDebounceTimer) {
          clearTimeout(this._gridScrollDebounceTimer)
        }
        this._gridScrollDebounceTimer = setTimeout(() => {
          if (!this.gridEl) return
          const current = this.gridEl.scrollLeft
          const delta = current - this._lastGridScrollLeft
          this._lastGridScrollLeft = current
          if (delta === 0) return
          this._track(`${FEATURE_SLUG}:list_scroll`, {
            scroll_direction: delta > 0 ? 'forward' : 'backward',
          })
        }, 250)
      }
    }
    customElements.define(TAG, SaiShoppableVideos)
  }

  // ── Analytics-handle defaults ──
  // Used until setAnalytics(track, emit) replaces them. Both no-op so the
  // snippet works in standalone contexts (local dev, tests without bind mock).
  function noopTrack(_name, _payload) {}
  function noopEmit(_name, _detail) {}

  // ── Test surface ──
  // Pure helpers only; applyVariant is a method on the custom-element class
  // and is tested via JSDOM <sai-svmk8tqx> instances directly.
  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiSvmk8tqx = {
      buildCard,
      buildDialogSlide,
      buildProductCard,
      buildUnavailable,
      readSnippetPool,
    }
  }

  // ── Bind iteration ──
  function bindAllContainers() {
    const snippetApi = window.__spectrumAi?.snippet
    if (!snippetApi || typeof snippetApi.bind !== 'function') return
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )
    for (const node of containers) {
      const handles = snippetApi.bind(
        node,
        ({ variant, entry, pools, variants, currentVariantId }) => {
          const resolvedVariant = variant ?? variants.find((v) => v.variantId === currentVariantId)
          if (!resolvedVariant?.content) return
          const sai = node.querySelector(TAG)
          if (!sai) return
          const pool = readSnippetPool(node)
          const shoppableVideosPool = pools?.shoppable_videos ?? pool.shoppable_videos ?? {}
          sai.applyVariant(resolvedVariant.content, entry?.content ?? {}, shoppableVideosPool)
        },
      )
      // Pass the analytics handles to the custom element so it can fire
      // events from user-action handlers. Bind() returns the same handles
      // synchronously even if the bind callback hasn't fired yet — the
      // element's handlers safely no-op until applyVariant has run.
      const sai = node.querySelector(TAG)
      if (sai && handles) sai.setAnalytics(handles.track, handles.emit)
    }
  }

  // async <script> may execute before body parse finishes — gate the bind
  // iteration on DOMContentLoaded so we don't miss late-parsed containers.
  // Custom-element registration above runs synchronously and is safe via
  // the upgrade path + connectedCallback's MutationObserver.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }
})()
