function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) return resolve(element);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    const target = document.body || document.documentElement;
    observer.observe(target, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout: ${selector}`));
    }, timeout);
  });
}

/**
 * @name Cinematic Title Enhancer
 * @description I built this script to improve Stremio's details page. It pulls extra info from the TMDB API, adds blurred backdrops, cast carousels, and better ratings bars.
 * @version 1.0.0
 * @author elmarco
 *
 * @copyright 2026 elmarco. All rights reserved.
 */

/**
 * Main application class for the Cinematic Title Enhancer plugin.
 * Handles fetching metadata and injecting the new UI into Stremio.
 *
 * @class DataEnrichment
 */
class DataEnrichment {
  constructor() {
    this.config = this.loadConfig();
    this.cache = new Map(); // { imdbId → { data, ts } } TTL-aware
    this.observer = null;
    this.currentImdbId = null;
    this.lastEnrichmentTime = 0;
    this.isEnriching = false;
    this.checkDebounceTimer = null;
    this.backdropElement = null;
    this.backdropObserver = null;
    this.init();
  }

  loadConfig() {
    const saved = localStorage.getItem("dataEnrichmentConfig");
    const defaults = {
      tmdbApiKey: "",
      omdbApiKey: "",
      watchProviderRegion: "US",
      enhancedCast: true,
      description: true,
      maturityRating: true,
      similarTitles: true,
      showCollection: true,
      showRatingsOnPosters: true,
      showTrailers: true,
      showReviews: true,
      showWatchProviders: true,
      showKeywords: true,
      showPhotoGallery: true,
      showAwards: true,
      showBoxOffice: true,
      showSeasonExplorer: true,
      showRecommendations: true,
    };
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  }

  saveConfig() {
    localStorage.setItem("dataEnrichmentConfig", JSON.stringify(this.config));
  }

  init() {
    console.log("[CinematicTitleEnhancer] Plugin loaded v1.0.0");
    this.setupObserver();
    this.setupHashChangeListener();
    this.injectSettingsButton();
    waitForElement(".meta-details-container")
      .then(() => this.checkForDetailPage())
      .catch(() => setTimeout(() => this.checkForDetailPage(), 1000));
  }

  setupHashChangeListener() {
    this.lastHash = window.location.hash;
    const handleHashChange = () => {
      const newHash = window.location.hash;
      const oldImdbMatch = this.lastHash.match(/tt\d+/);
      const newImdbMatch = newHash.match(/tt\d+/);
      if (!newImdbMatch) {
        this.cleanup(true);
      } else if (
        oldImdbMatch &&
        newImdbMatch &&
        oldImdbMatch[0] !== newImdbMatch[0]
      ) {
        this.cleanup(true);
        waitForElement(".meta-details-container", 6000)
          .then(() => this.checkForDetailPage())
          .catch(() => this.checkForDetailPage());
      }
      this.lastHash = newHash;
    };
    window.addEventListener("hashchange", handleHashChange);
  }

  setupObserver() {
    this.observer = new MutationObserver(() => {
      if (this.isEnriching) return;
      if (this.checkDebounceTimer) clearTimeout(this.checkDebounceTimer);
      this.checkDebounceTimer = setTimeout(() => {
        this.checkForDetailPage();
        this.checkForPosters();
      }, 300);
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      this.checkForDetailPage();
      this.checkForPosters();
    }, 1000);
  }

  checkForDetailPage() {
    if (this.isEnriching) return;
    if (!window.location.hash.match(/tt\d+/)) return;
    const metaInfoContainer =
      document.querySelector(".meta-details-container") ||
      document.querySelector('[class*="meta-info-container"]');
    if (!metaInfoContainer) return;
    const imdbId = this.extractImdbId();
    if (!imdbId) {
      this.cleanup();
      return;
    }
    if (imdbId === this.currentImdbId) return;
    console.log("[CinematicTitleEnhancer] Found IMDB ID:", imdbId);
    this.currentImdbId = imdbId;
    this.enrichDetailPage(imdbId, metaInfoContainer);
  }

  cleanup(force = false) {
    if (!force) return;
    document.querySelector(".data-enrichment-container")?.remove();
    document.querySelector(".de-ratings-bar")?.remove();
    document.getElementById("de-cinematic-overlay")?.remove();
    document.getElementById("de-home-btn")?.remove();

    // Cancel any pending backdrop-image wait so it doesn't fire after navigation
    if (this.backdropObserver) {
      this.backdropObserver.disconnect();
      this.backdropObserver = null;
    }

    // Reset the exact element we mutated — never re-query the selector here,
    // because after several navigations Stremio may have a different element
    // matching that selector, leaving the blurred/darkened one accumulating.
    if (this.backdropElement) {
      this.backdropElement.style.filter = "";
      this.backdropElement.style.transform = "";
      this.backdropElement = null;
    }

    this.isEnriching = false;
    this.currentImdbId = null;
    console.log("[CinematicTitleEnhancer] Cleaned up");
  }

  extractImdbId() {
    const url = window.location.hash || window.location.href;
    const match = url.match(/tt\d+/);
    if (match) return match[0];
    const imdbLink = document.querySelector('a[href*="imdb.com/title/tt"]');
    if (imdbLink) {
      const m = imdbLink.href.match(/tt\d+/);
      if (m) return m[0];
    }
    const metaEls = document.querySelectorAll("[data-imdbid], [data-imdb-id]");
    for (const el of metaEls) {
      const id = el.dataset.imdbid || el.dataset.imdbId;
      if (id && id.match(/tt\d+/)) return id;
    }
    const allLinks = document.querySelectorAll('a[href*="imdb"]');
    for (const link of allLinks) {
      const m = link.href.match(/tt\d+/);
      if (m) return m[0];
    }
    return null;
  }

  // ─────────────────────────────────────────────
  //  MAIN ORCHESTRATOR
  // ─────────────────────────────────────────────
  async enrichDetailPage(imdbId, container) {
    if (!this.config.tmdbApiKey) return;
    this.isEnriching = true;

    try {
      this.injectPlexStyles();
      document.querySelector(".data-enrichment-container")?.remove();
      document.querySelector(".de-ratings-bar")?.remove();
      document.getElementById("de-cinematic-overlay")?.remove();

      const skelContainer = this.createEnrichmentContainer();
      if (skelContainer) {
        skelContainer.dataset.imdbId = imdbId;
        this.injectSkeletonLoaders(skelContainer);
      }

      const [data, omdbData] = await Promise.all([
        this.fetchTMDBData(imdbId),
        this.config.omdbApiKey && this.config.showAwards
          ? this.fetchOMDbData(imdbId)
          : Promise.resolve(null),
      ]);

      document.querySelector(".data-enrichment-container")?.remove();
      if (!data) {
        this.isEnriching = false;
        return;
      }

      const currentUrl = window.location.hash.match(/tt\d+/);
      if (!currentUrl || currentUrl[0] !== imdbId) {
        this.isEnriching = false;
        return;
      }

      this.currentImdbId = imdbId;
      const enrichmentContainer = this.createEnrichmentContainer();
      if (!enrichmentContainer) {
        this.isEnriching = false;
        return;
      }
      enrichmentContainer.dataset.imdbId = imdbId;

      this.injectCinematicBackdrop();
      this.injectHomeButton();

      // 1. HERO — tagline, overview, status badge, next episode
      if (
        data.overview ||
        data.tagline ||
        (data.media_type === "tv" && data.status)
      ) {
        this.injectHeroSection(data, enrichmentContainer);
      }

      // 2. RATINGS BAR — now inside enrichmentContainer, not native Stremio container
      this.injectRatingsBar(data, enrichmentContainer);

      // 3. WHERE TO WATCH + THEMES — side by side in a two-column row
      {
        const hasProviders = this.config.showWatchProviders;
        const hasKeywords = this.config.showKeywords && data.keywords;
        if (hasProviders || hasKeywords) {
          const metaRow = document.createElement("div");
          metaRow.className = "de-meta-row";
          if (hasProviders) this.injectWatchProviders(data, metaRow);
          if (hasKeywords) this.injectKeywords(data, metaRow);
          if (metaRow.children.length) enrichmentContainer.appendChild(metaRow);
        }
      }

      // 4. CREW STRIP + STUDIO LOGOS
      if (data.credits && data.credits.crew && data.credits.crew.length) {
        this.injectCrewStrip(
          data.credits.crew,
          data.production_companies,
          enrichmentContainer,
        );
      }

      // 5. CAST
      if (this.config.enhancedCast && data.credits) {
        this.injectEnhancedCast(data.credits, enrichmentContainer, data.id);
      }

      // 6. PHOTO GALLERY
      if (this.config.showPhotoGallery && data.images) {
        this.injectPhotoGallery(data, enrichmentContainer);
      }

      // 7. TRAILERS
      if (this.config.showTrailers && data.videos) {
        this.injectTrailers(data.videos, enrichmentContainer);
      }

      // 8. SEASON EXPLORER (TV only)
      if (
        this.config.showSeasonExplorer &&
        data.media_type === "tv" &&
        data.seasons &&
        data.seasons.length
      ) {
        this.injectSeasonExplorer(data, enrichmentContainer);
      }

      // 9. REVIEWS
      if (this.config.showReviews && data.reviews) {
        this.injectReviews(data.reviews, enrichmentContainer);
      }

      // 10. BECAUSE YOU'RE WATCHING (TMDB curated recommendations)
      if (this.config.showRecommendations && data.recommendations) {
        this.injectRecommendations(data, enrichmentContainer);
      }

      // 11. MORE BY DIRECTOR (person filmography)
      if (
        this.config.showRecommendations &&
        data.credits &&
        data.credits.crew
      ) {
        await this.injectMoreByDirector(data, enrichmentContainer);
      }

      // 12. MORE WITH LEAD ACTOR (person filmography)
      if (
        this.config.showRecommendations &&
        data.credits &&
        data.credits.cast
      ) {
        await this.injectMoreWithActor(data, enrichmentContainer);
      }

      // 13. AWARDS BANNER
      if (
        this.config.showAwards &&
        omdbData &&
        omdbData.Awards &&
        omdbData.Awards !== "N/A"
      ) {
        this.injectAwards(omdbData.Awards, enrichmentContainer);
      }

      // 14. COLLECTION
      if (this.config.showCollection && data.belongs_to_collection) {
        await this.injectCollection(
          data.belongs_to_collection,
          enrichmentContainer,
        );
      }

      this.setupScrollEntrances(enrichmentContainer);
      this.lastEnrichmentTime = Date.now();
      console.log("[CinematicTitleEnhancer] Enrichment complete v1.0");
    } catch (err) {
      console.error("[CinematicTitleEnhancer] Error:", err);
    } finally {
      this.isEnriching = false;
    }
  }

  createEnrichmentContainer() {
    document.querySelector(".data-enrichment-container")?.remove();
    const targets = [
      document.querySelector(".meta-details-container"),
      document.querySelector('[class*="meta-info-container"]'),
      (() => {
        const d = document.querySelector('[class*="description-container"]');
        return d && d.parentElement;
      })(),
      document.querySelector('[class*="menu-container"]'),
    ];
    for (const target of targets) {
      if (target) {
        const el = document.createElement("div");
        el.className = "data-enrichment-container";
        target.appendChild(el);
        return el;
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────
  //  FEATURE 1 — CINEMATIC BACKDROP
  // ─────────────────────────────────────────────
  injectCinematicBackdrop() {
    document.getElementById("de-cinematic-overlay")?.remove();

    // Disconnect any previous wait-observer so it doesn't fire on a stale element
    if (this.backdropObserver) {
      this.backdropObserver.disconnect();
      this.backdropObserver = null;
    }

    const backdrop = document.querySelector(
      '[class*="meta-preview-background"], [class*="background-image"], ' +
        '[class*="background-container"], [class*="meta-background"], ' +
        '[class*="background-preview"], [class*="backdrop"]',
    );
    if (!backdrop) return;

    // On hard-refresh Stremio mounts the backdrop element before setting its
    // background-image. Applying blur immediately would darken a blank element.
    // Wait until the element actually carries an image, then apply styles.
    const hasBg = () => {
      const v =
        backdrop.style.backgroundImage ||
        getComputedStyle(backdrop).backgroundImage;
      return v && v !== "none" && v !== "";
    };

    if (hasBg()) {
      this._applyBackdropStyles(backdrop);
    } else {
      this._waitForBackdropImage(backdrop);
    }
  }

  _waitForBackdropImage(backdrop) {
    // MutationObserver on style attribute catches Stremio setting background-image
    let resolved = false;
    const resolve = () => {
      if (resolved) return;
      resolved = true;
      if (this.backdropObserver) {
        this.backdropObserver.disconnect();
        this.backdropObserver = null;
      }
      // Guard: make sure the user hasn't navigated away
      const currentMatch = window.location.hash.match(/tt\d+/);
      if (!currentMatch || currentMatch[0] !== this.currentImdbId) return;
      this._applyBackdropStyles(backdrop);
    };

    this.backdropObserver = new MutationObserver(() => {
      const v =
        backdrop.style.backgroundImage ||
        getComputedStyle(backdrop).backgroundImage;
      if (v && v !== "none" && v !== "") resolve();
    });
    this.backdropObserver.observe(backdrop, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    // Also observe parent subtree in case the element is replaced wholesale
    if (backdrop.parentElement) {
      this.backdropObserver.observe(backdrop.parentElement, {
        childList: true,
        subtree: false,
      });
    }

    // Polling fallback — catches cases where the attribute change fires before
    // the observer is attached, or when a CSS class sets the background
    let ticks = 0;
    const poll = setInterval(() => {
      ticks++;
      const v =
        backdrop.style.backgroundImage ||
        getComputedStyle(backdrop).backgroundImage;
      if ((v && v !== "none" && v !== "") || ticks > 40) {
        // 40 × 150 ms = 6 s max
        clearInterval(poll);
        if (v && v !== "none" && v !== "") resolve();
      }
    }, 150);

    // Safety: always clean up the interval after 8 s regardless
    setTimeout(() => clearInterval(poll), 8000);
  }

  _applyBackdropStyles(backdrop) {
    // Safety: if we already applied styles to a different element, reset it first
    if (this.backdropElement && this.backdropElement !== backdrop) {
      this.backdropElement.style.filter = "";
      this.backdropElement.style.transform = "";
    }

    const parent = backdrop.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === "static")
      parent.style.position = "relative";

    // Pin the exact element we're mutating so cleanup() never re-queries
    this.backdropElement = backdrop;

    backdrop.style.filter = "blur(52px) saturate(0.62) brightness(0.55)";
    backdrop.style.transform = "scale(1.1)";
    backdrop.style.transition = "filter 0.9s ease, transform 0.9s ease";

    // Remove stale overlay in case this fires after a retry
    document.getElementById("de-cinematic-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "de-cinematic-overlay";
    overlay.style.cssText = `
            position:absolute; inset:0; pointer-events:none; z-index:2;
            background:
                linear-gradient(to bottom,
                    transparent 0%,
                    transparent 18%,
                    rgba(18,18,24,0.48) 46%,
                    rgba(18,18,24,0.84) 68%,
                    rgba(18,18,24,0.97) 84%,
                    rgb(18,18,24) 100%
                ),
                linear-gradient(to right,
                    rgba(18,18,24,0.70) 0%,
                    transparent 26%,
                    transparent 74%,
                    rgba(18,18,24,0.70) 100%
                );
        `;
    parent.appendChild(overlay);
  }

  // ─────────────────────────────────────────────
  //  HOME BUTTON — detail pages only
  // ─────────────────────────────────────────────
  injectHomeButton() {
    // Idempotent — only one button per page
    if (document.getElementById("de-home-btn")) return;

    const btn = document.createElement("button");
    btn.id = "de-home-btn";
    btn.setAttribute("aria-label", "Go to Homepage");
    btn.innerHTML = `
            <span class="de-home-glass-shine"></span>
            <span class="de-home-glass-shimmer"></span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" class="de-home-icon">
                <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5z"/>
                <polyline points="9 21 9 12 15 12 15 21"/>
            </svg>
            <span class="de-home-label">Go to Homepage</span>
            <span class="de-home-ripple"></span>
        `;
    btn.addEventListener("click", () => {
      const goHome = () => {
        if (
          window.location.hash === "#/" ||
          window.location.hash === "" ||
          window.location.hash === "#"
        )
          return;
        history.back();
        setTimeout(goHome, 80);
      };
      goHome();
    });
    document.body.appendChild(btn);
  }

  // ─────────────────────────────────────────────
  //  FEATURE 2 — MULTI-SOURCE RATINGS BAR
  // ─────────────────────────────────────────────
  injectRatingsBar(data, container) {
    document.querySelector(".de-ratings-bar")?.remove();

    const bar = document.createElement("div");
    bar.className = "de-ratings-bar";

    const pills = [];

    if (data.vote_average) {
      const score = data.vote_average.toFixed(1);
      const pct = Math.round((data.vote_average / 10) * 100);
      const votes =
        data.vote_count > 1000
          ? (data.vote_count / 1000).toFixed(1) + "k"
          : String(data.vote_count || "");
      pills.push(`
                <div class="de-rating-pill de-pill-tmdb">
                    <div class="de-pill-top">
                        <svg width="16" height="16" viewBox="0 0 185 133" xmlns="http://www.w3.org/2000/svg" style="border-radius:3px;flex-shrink:0">
                            <rect width="185" height="133" fill="#01b4e4"/>
                            <text x="92" y="100" font-family="Arial Black,sans-serif" font-size="84" fill="white" text-anchor="middle">T</text>
                        </svg>
                        <span class="de-pill-source">TMDB</span>
                    </div>
                    <div class="de-pill-score">${score}</div>
                    <div class="de-pill-bar-track"><div class="de-pill-bar-fill" style="width:${pct}%;background:#01b4e4"></div></div>
                    <div class="de-pill-sub">${votes} votes</div>
                </div>`);

      const fresh = pct >= 60;
      pills.push(`
                <div class="de-rating-pill ${fresh ? "de-pill-fresh" : "de-pill-rotten"}">
                    <div class="de-pill-top">
                        <span style="font-size:14px;line-height:1">${fresh ? "🍅" : "💧"}</span>
                        <span class="de-pill-source">Audience</span>
                    </div>
                    <div class="de-pill-score">${pct}%</div>
                    <div class="de-pill-bar-track"><div class="de-pill-bar-fill" style="width:${pct}%;background:${fresh ? "#34c759" : "#ff453a"}"></div></div>
                    <div class="de-pill-sub">${fresh ? "Fresh" : "Rotten"}</div>
                </div>`);
    }

    if (data.popularity) {
      const pop = Math.min(100, Math.round(data.popularity));
      pills.push(`
                <div class="de-rating-pill de-pill-pop">
                    <div class="de-pill-top">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e5a00d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                        </svg>
                        <span class="de-pill-source">Trending</span>
                    </div>
                    <div class="de-pill-score">${pop}</div>
                    <div class="de-pill-bar-track"><div class="de-pill-bar-fill" style="width:${pop}%;background:#e5a00d"></div></div>
                    <div class="de-pill-sub">popularity</div>
                </div>`);
    }

    const runtime =
      data.runtime || (data.episode_run_time && data.episode_run_time[0]);
    if (runtime) {
      const h = Math.floor(runtime / 60);
      const m = runtime % 60;
      const year = (data.release_date || data.first_air_date || "").slice(0, 4);
      pills.push(`
                <div class="de-rating-pill de-pill-meta">
                    <div class="de-pill-top">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2" stroke-linecap="round" style="flex-shrink:0">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        <span class="de-pill-source">Runtime</span>
                    </div>
                    <div class="de-pill-score" style="font-size:1.05rem">${h > 0 ? h + "h " : ""}${m}m</div>
                    <div class="de-pill-sub">${year}</div>
                </div>`);
    }

    // Maturity rating
    const maturity = this.getMaturityRating(data);
    if (maturity) {
      pills.push(`
                <div class="de-rating-pill de-pill-rating">
                    <div class="de-pill-top">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" stroke-width="2.2" stroke-linecap="round" style="flex-shrink:0">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                        <span class="de-pill-source">Rating</span>
                    </div>
                    <div class="de-pill-score" style="font-size:1.1rem">${maturity}</div>
                    <div class="de-pill-sub">maturity</div>
                </div>`);
    }

    // Box office (movies only)
    if (this.config.showBoxOffice && data.media_type === "movie") {
      if (data.budget && data.budget > 0) {
        const b = this.formatMoney(data.budget);
        pills.push(`
                    <div class="de-rating-pill de-pill-budget">
                        <div class="de-pill-top">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5c842" stroke-width="2.2" stroke-linecap="round" style="flex-shrink:0">
                                <circle cx="12" cy="12" r="10"/><path d="M12 6v12M9 9h4.5a1.5 1.5 0 010 3H10a1.5 1.5 0 000 3H15"/>
                            </svg>
                            <span class="de-pill-source">Budget</span>
                        </div>
                        <div class="de-pill-score" style="font-size:1.1rem">${b}</div>
                        <div class="de-pill-sub">production</div>
                    </div>`);
      }
      if (data.revenue && data.revenue > 0) {
        const r = this.formatMoney(data.revenue);
        const ratio =
          data.budget > 0
            ? Math.min(100, Math.round((data.revenue / data.budget) * 100))
            : 50;
        const profitColor =
          !data.budget || data.revenue >= data.budget ? "#34c759" : "#ff453a";
        pills.push(`
                    <div class="de-rating-pill de-pill-revenue">
                        <div class="de-pill-top">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="2.2" stroke-linecap="round" style="flex-shrink:0">
                                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
                            </svg>
                            <span class="de-pill-source">Gross</span>
                        </div>
                        <div class="de-pill-score" style="font-size:1.1rem">${r}</div>
                        <div class="de-pill-bar-track"><div class="de-pill-bar-fill" style="width:${ratio}%;background:${profitColor}"></div></div>
                        <div class="de-pill-sub">worldwide</div>
                    </div>`);
      }
    }

    bar.innerHTML = pills.join("");
    container.appendChild(bar);
  }

  getMaturityRating(data) {
    if (data.media_type === "movie") {
      const releases = (data.release_dates && data.release_dates.results) || [];
      const us = releases.find((r) => r.iso_3166_1 === "US");
      if (us && us.release_dates) {
        return (
          us.release_dates.map((d) => d.certification).filter(Boolean)[0] ||
          null
        );
      }
    } else {
      const ratings =
        (data.content_ratings && data.content_ratings.results) || [];
      const us = ratings.find((r) => r.iso_3166_1 === "US");
      if (us && us.rating) return us.rating;
    }
    return null;
  }

  formatMoney(n) {
    if (!n || n === 0) return null;
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return "$" + Math.round(n / 1e6) + "M";
    return "$" + n.toLocaleString();
  }

  // ─────────────────────────────────────────────
  //  FEATURE 3 — SKELETON LOADERS
  // ─────────────────────────────────────────────
  injectSkeletonLoaders(container) {
    const castSkel = document.createElement("div");
    castSkel.className = "plex-section";
    castSkel.innerHTML = `
            <div class="de-skel de-skel-title"></div>
            <div style="display:flex;gap:24px;overflow:hidden;padding-bottom:8px">
                ${Array.from(
                  { length: 8 },
                  () => `
                    <div style="flex:0 0 148px;display:flex;flex-direction:column;align-items:center;gap:12px">
                        <div class="de-skel" style="width:148px;height:148px;border-radius:50%"></div>
                        <div class="de-skel" style="width:108px;height:12px;border-radius:6px"></div>
                        <div class="de-skel" style="width:78px;height:10px;border-radius:6px;opacity:.6"></div>
                    </div>`,
                ).join("")}
            </div>`;

    const posterSkel = document.createElement("div");
    posterSkel.className = "plex-section";
    posterSkel.innerHTML = `
            <div class="de-skel de-skel-title"></div>
            <div style="display:flex;gap:20px;overflow:hidden;padding-bottom:8px">
                ${Array.from(
                  { length: 6 },
                  () => `
                    <div style="flex:0 0 186px;display:flex;flex-direction:column;gap:12px">
                        <div class="de-skel" style="width:186px;height:279px;border-radius:14px"></div>
                        <div class="de-skel" style="width:130px;height:12px;border-radius:6px;margin:0 auto"></div>
                    </div>`,
                ).join("")}
            </div>`;

    container.appendChild(castSkel);
    container.appendChild(posterSkel);
  }

  // ─────────────────────────────────────────────
  //  FEATURE 4 — CREW STRIP
  // ─────────────────────────────────────────────
  injectCrewStrip(crew, companies, container) {
    const roleMap = [
      { jobs: ["Director"], label: "Director", icon: "🎬" },
      {
        jobs: ["Screenplay", "Writer", "Story", "Author"],
        label: "Writer",
        icon: "✍️",
      },
      {
        jobs: ["Original Music Composer", "Music"],
        label: "Composer",
        icon: "🎵",
      },
      {
        jobs: ["Director of Photography", "Cinematography"],
        label: "Cinematography",
        icon: "📷",
      },
      {
        jobs: ["Producer", "Executive Producer"],
        label: "Producer",
        icon: "🎭",
      },
    ];

    const found = [];
    for (const role of roleMap) {
      const person = crew.find((c) => role.jobs.includes(c.job));
      if (person)
        found.push({ icon: role.icon, label: role.label, name: person.name });
      if (found.length >= 4) break;
    }
    if (!found.length) return;

    const logoCompanies = (companies || [])
      .filter((c) => c.logo_path)
      .slice(0, 5);
    const studiosHTML = logoCompanies.length
      ? `
            <div class="de-studios-row">
                <span class="de-studios-label">Studios</span>
                ${logoCompanies
                  .map(
                    (c) => `
                    <img class="de-studio-logo"
                         src="https://image.tmdb.org/t/p/w185${c.logo_path}"
                         alt="${c.name}" loading="lazy" title="${c.name}">`,
                  )
                  .join("")}
            </div>`
      : "";

    const strip = document.createElement("div");
    strip.className = "de-crew-strip";
    strip.innerHTML = `
            <div class="de-crew-cells">
                ${found
                  .map(
                    (f) => `
                    <div class="de-crew-cell">
                        <span class="de-crew-icon">${f.icon}</span>
                        <div class="de-crew-info">
                            <div class="de-crew-label">${f.label}</div>
                            <div class="de-crew-name">${f.name}</div>
                        </div>
                    </div>`,
                  )
                  .join("")}
            </div>
            ${studiosHTML}`;
    container.appendChild(strip);
  }

  // ─────────────────────────────────────────────
  //  FEATURE 5 — CAST + KNOWN-FOR LABELS
  // ─────────────────────────────────────────────
  injectEnhancedCast(credits, container, currentTmdbId) {
    const cast = (credits.cast || []).slice(0, 25);
    if (!cast.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Cast &amp; Crew</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${cast
                      .map(
                        (actor, i) => `
                        <div class="plex-cast-card" style="--i:${i}" data-pid="${actor.id}">
                            ${
                              actor.profile_path
                                ? `<img class="plex-cast-avatar" src="https://image.tmdb.org/t/p/w342${actor.profile_path}" alt="${actor.name}" loading="lazy">`
                                : this.buildAvatarPlaceholder(actor.name, 148)
                            }
                            <div class="plex-cast-name">${actor.name}</div>
                            <div class="plex-cast-char">${actor.character || ""}</div>
                            <div class="plex-cast-known" data-pid="${actor.id}"></div>
                        </div>`,
                      )
                      .join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);

    // Lazy Known-For for top 6
    cast.slice(0, 6).forEach(async (actor) => {
      const title = await this.fetchKnownFor(actor.id, currentTmdbId);
      if (!title) return;
      const el = section.querySelector(
        `.plex-cast-known[data-pid="${actor.id}"]`,
      );
      if (el) {
        el.textContent = "\u2605  " + title;
        el.classList.add("de-known-visible");
      }
    });
  }

  async fetchKnownFor(personId, excludeTmdbId) {
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/person/${personId}/combined_credits?api_key=${this.config.tmdbApiKey}`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      const work = (data.cast || [])
        .filter((w) => w.id !== excludeTmdbId && (w.vote_count || 0) > 150)
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
      return work ? work.title || work.name : null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  FEATURE 6 — SCROLL-TRIGGERED ENTRANCES
  // ─────────────────────────────────────────────
  setupScrollEntrances(container) {
    const sections = container.querySelectorAll(
      ".plex-section, .de-crew-strip, .plex-hero",
    );
    sections.forEach((s, i) => {
      s.style.opacity = "0";
      s.style.transform = "translateY(30px)";
      s.style.transition =
        `opacity 0.62s cubic-bezier(0.22,1,0.36,1) ${i * 0.08}s,` +
        `transform 0.62s cubic-bezier(0.22,1,0.36,1) ${i * 0.08}s`;
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.style.opacity = "1";
            entry.target.style.transform = "translateY(0)";
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.07, rootMargin: "0px 0px -32px 0px" },
    );

    sections.forEach((s) => io.observe(s));
  }

  // ─────────────────────────────────────────────
  //  TRAILERS
  // ─────────────────────────────────────────────
  injectTrailers(videos, container) {
    const vids = (videos.results || [])
      .filter(
        (v) =>
          v.site === "YouTube" &&
          ["Trailer", "Teaser", "Featurette"].includes(v.type),
      )
      .slice(0, 10);
    if (!vids.length) return;

    const playSVG = `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg" style="width:52px;height:52px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.6));transition:transform .35s cubic-bezier(.34,1.56,.64,1)"><circle cx="30" cy="30" r="29" stroke="rgba(255,255,255,.9)" stroke-width="1.5" fill="none"/><path d="M24 20L42 30L24 40Z" fill="white"/></svg>`;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Extras</div>
            <div class="plex-trailers-grid">
                ${vids
                  .map(
                    (vid, i) => `
                    <div class="plex-trailer-card" data-key="${vid.key}" style="--i:${i}">
                        <div class="plex-trailer-thumb">
                            <img src="https://img.youtube.com/vi/${vid.key}/mqdefault.jpg" alt="${vid.name}" loading="lazy">
                            <div class="plex-trailer-play-icon">${playSVG}</div>
                        </div>
                        <div class="plex-trailer-label">${vid.name}</div>
                    </div>`,
                  )
                  .join("")}
            </div>`;
    container.appendChild(section);

    section.querySelectorAll(".plex-trailer-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        e.preventDefault();
        this.openVideoPlayer(
          card.dataset.key,
          card.querySelector(".plex-trailer-label")?.textContent || "",
        );
      });
    });
  }

  openVideoPlayer(key, title) {
    document.getElementById("de-video-player-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "de-video-player-overlay";
    overlay.innerHTML = `
            <div class="de-vp-backdrop"></div>
            <div class="de-vp-shell">
                <div class="de-vp-topbar">
                    <button class="de-vp-back" aria-label="Back">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="15 18 9 12 15 6"/>
                        </svg>
                        <span>Back</span>
                    </button>
                    <div class="de-vp-title">${title}</div>
                    <div style="width:90px"></div>
                </div>
                <div class="de-vp-frame-wrap">
                    <iframe
                        src="https://www.youtube.com/embed/${key}?autoplay=1&rel=0&modestbranding=1"
                        allow="autoplay; fullscreen; encrypted-media"
                        allowfullscreen
                        frameborder="0"
                        class="de-vp-iframe">
                    </iframe>
                </div>
            </div>`;

    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.add("de-vp-closing");
      setTimeout(() => overlay.remove(), 280);
    };

    overlay.querySelector(".de-vp-back").addEventListener("click", close);
    overlay.querySelector(".de-vp-backdrop").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    });
  }

  // ─────────────────────────────────────────────
  //  REVIEWS
  // ─────────────────────────────────────────────
  injectReviews(reviews, container) {
    const results = (reviews.results || []).slice(0, 15);
    if (!results.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Ratings &amp; Reviews</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${results
                      .map((rev, i) => {
                        const stars =
                          rev.author_details && rev.author_details.rating
                            ? this.renderStars(rev.author_details.rating)
                            : "";
                        return `
                            <div class="plex-review-card" style="--i:${i}">
                                ${stars ? `<div class="plex-review-stars">${stars}</div>` : ""}
                                <div class="plex-review-author">${rev.author}</div>
                                <div class="plex-review-text">${rev.content}</div>
                            </div>`;
                      })
                      .join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
  }

  // ─────────────────────────────────────────────
  //  FEATURE 7 — SIMILAR TITLES (rating overlay)
  // ─────────────────────────────────────────────
  injectSimilarTitles(similar, container) {
    const titles = (similar.results || []).slice(0, 20);
    if (!titles.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Titles You Might Like</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${titles.map((item, i) => this.buildPosterCard(item, i)).join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
    this.setupPosterClickHandlers(section);
  }

  async injectCollection(collection, container) {
    const res = await fetch(
      `https://api.themoviedb.org/3/collection/${collection.id}?api_key=${this.config.tmdbApiKey}`,
    );
    const data = await res.json();
    const parts = (data.parts || []).sort(
      (a, b) => new Date(a.release_date || 0) - new Date(b.release_date || 0),
    );
    if (parts.length <= 1) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">${data.name}</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${parts.map((item, i) => this.buildPosterCard(item, i, "movie")).join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
    this.setupPosterClickHandlers(section);
  }

  buildPosterCard(item, index, forceMediaType) {
    const mediaType =
      forceMediaType ||
      item.media_type ||
      (item.first_air_date ? "tv" : "movie");
    const title = item.title || item.name || "";
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);
    const score = item.vote_average ? item.vote_average.toFixed(1) : null;
    const typeLabel = mediaType === "tv" ? "Series" : "Movie";

    return `
        <div class="plex-rec-card" style="--i:${index}" data-id="${item.id}" data-media-type="${mediaType}">
            <div class="plex-rec-poster-wrap">
                ${
                  item.poster_path
                    ? `<img class="plex-rec-poster" src="https://image.tmdb.org/t/p/w342${item.poster_path}" alt="${title}" loading="lazy">`
                    : `<div class="plex-rec-no-poster">${title}</div>`
                }
                <div class="plex-rec-overlay">
                    <div class="plex-rec-overlay-top">
                        <span class="plex-rec-type-badge">${typeLabel}</span>
                        ${year ? `<span class="plex-rec-year">${year}</span>` : ""}
                    </div>
                    ${score ? `<div class="plex-rec-score">&#9733; ${score}</div>` : ""}
                </div>
            </div>
            <div class="plex-rec-title">${title}</div>
        </div>`;
  }

  // ─────────────────────────────────────────────
  //  HERO
  // ─────────────────────────────────────────────
  injectHeroSection(data, container) {
    const section = document.createElement("div");
    section.className = "plex-hero";
    const genres = data.genres || [];
    const director =
      data.credits && data.credits.crew
        ? data.credits.crew.find((c) => c.job === "Director")
        : null;

    // TV status badge
    let statusBadge = "";
    if (data.media_type === "tv" && data.status) {
      const statusMap = {
        "Returning Series": {
          cls: "de-status-ongoing",
          dot: "●",
          label: "Ongoing",
        },
        Planned: { cls: "de-status-ongoing", dot: "●", label: "Planned" },
        Ended: { cls: "de-status-ended", dot: "◼", label: "Ended" },
        Canceled: { cls: "de-status-cancelled", dot: "✕", label: "Cancelled" },
        Cancelled: { cls: "de-status-cancelled", dot: "✕", label: "Cancelled" },
        "In Production": {
          cls: "de-status-production",
          dot: "⬡",
          label: "In Production",
        },
      };
      const s = statusMap[data.status];
      if (s)
        statusBadge = `<span class="de-status-badge ${s.cls}">${s.dot} ${s.label}</span>`;
    }

    // Next episode countdown
    let nextEpBanner = "";
    if (data.next_episode_to_air) {
      const ep = data.next_episode_to_air;
      const airDate = new Date(ep.air_date);
      const diffDays = Math.ceil((airDate - new Date()) / 86400000);
      const when =
        diffDays <= 0
          ? "today"
          : diffDays === 1
            ? "tomorrow"
            : `in ${diffDays} days`;
      nextEpBanner = `
                <div class="de-next-episode">
                    <span class="de-next-ep-label">🗓 Next Episode</span>
                    <span>S${ep.season_number}E${ep.episode_number} &ldquo;${ep.name || "TBA"}&rdquo; · airs ${when}</span>
                </div>`;
    }

    section.innerHTML = `
            ${statusBadge ? `<div class="de-hero-status-row">${statusBadge}</div>` : ""}
            ${data.tagline ? `<div class="plex-hero-tagline">&ldquo;${data.tagline}&rdquo;</div>` : ""}
            ${nextEpBanner}
            ${data.overview ? `<div class="plex-hero-overview">${data.overview}</div>` : ""}
            ${
              genres.length || director
                ? `
                <div class="plex-hero-meta">
                    ${genres.map((g) => `<span class="plex-hero-badge">${g.name}</span>`).join("")}
                    ${director ? `<span class="plex-hero-director"><em>Director</em> ${director.name}</span>` : ""}
                </div>`
                : ""
            }`;
    container.appendChild(section);
  }

  // ─────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────
  buildAvatarPlaceholder(name, size) {
    const initials = name
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase();
    const gradients = [
      "linear-gradient(135deg,#c0392b,#922b21)",
      "linear-gradient(135deg,#2980b9,#1a5276)",
      "linear-gradient(135deg,#27ae60,#1e8449)",
      "linear-gradient(135deg,#8e44ad,#6c3483)",
      "linear-gradient(135deg,#e67e22,#ca6f1e)",
      "linear-gradient(135deg,#16a085,#0e6655)",
    ];
    const grad = gradients[name.length % gradients.length];
    const fs = Math.round(size * 0.34);
    return `<div class="plex-cast-avatar" style="background:${grad};display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:700;color:rgba(255,255,255,.9);letter-spacing:1px">${initials}</div>`;
  }

  renderStars(rating10) {
    const filled = Math.round((rating10 / 10) * 5);
    return (
      "\u2605".repeat(Math.max(0, filled)) +
      "\u2606".repeat(Math.max(0, 5 - filled))
    );
  }

  setupPlexScrollButtons(section) {
    const scroller = section.querySelector(".plex-hscroll");
    const leftBtn = section.querySelector(".plex-scroll-left");
    const rightBtn = section.querySelector(".plex-scroll-right");
    if (!scroller || !leftBtn || !rightBtn) return;

    const amount = Math.min(800, window.innerWidth * 0.7);
    const update = () => {
      leftBtn.classList.toggle("can-scroll", scroller.scrollLeft > 10);
      rightBtn.classList.toggle(
        "can-scroll",
        scroller.scrollWidth > scroller.clientWidth &&
          scroller.scrollLeft <
            scroller.scrollWidth - scroller.clientWidth - 10,
      );
    };
    leftBtn.addEventListener("click", (e) => {
      e.preventDefault();
      scroller.scrollBy({ left: -amount, behavior: "smooth" });
    });
    rightBtn.addEventListener("click", (e) => {
      e.preventDefault();
      scroller.scrollBy({ left: amount, behavior: "smooth" });
    });
    scroller.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    setTimeout(update, 300);
  }

  setupPosterClickHandlers(section) {
    section.querySelectorAll(".plex-rec-card").forEach((item) => {
      item.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tmdbId = item.dataset.id;
        const mediaType = item.dataset.mediaType || "movie";
        if (!tmdbId) return;
        item.style.opacity = "0.6";
        item.style.pointerEvents = "none";
        try {
          const res = await fetch(
            `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${this.config.tmdbApiKey}`,
          );
          if (!res.ok) return;
          const ids = await res.json();
          if (ids.imdb_id) {
            window.location.hash = `#/detail/${mediaType === "tv" ? "series" : "movie"}/${ids.imdb_id}`;
          }
        } catch (err) {
          console.error("[DataEnrichment] Nav error:", err);
        } finally {
          item.style.opacity = "";
          item.style.pointerEvents = "";
        }
      });
    });
  }

  // ─────────────────────────────────────────────
  //  WATCH PROVIDERS
  // ─────────────────────────────────────────────
  injectWatchProviders(data, container) {
    const region = this.config.watchProviderRegion || "US";
    const wp = data["watch/providers"];
    if (!wp || !wp.results) return;
    const rd = wp.results[region];
    if (!rd) return;
    const flatrate = rd.flatrate || [];
    const rent = rd.rent || [];
    const buy = rd.buy || [];
    if (!flatrate.length && !rent.length && !buy.length) return;

    const buildRow = (label, items) =>
      !items.length
        ? ""
        : `
            <div class="de-providers-row">
                <span class="de-providers-row-label">${label}</span>
                ${items
                  .map(
                    (p) => `
                    <div class="de-provider-logo-wrap">
                        <img class="de-provider-logo"
                             src="https://image.tmdb.org/t/p/w92${p.logo_path}"
                             alt="${p.provider_name}" loading="lazy">
                        <span class="de-provider-tooltip">${p.provider_name}</span>
                    </div>`,
                  )
                  .join("")}
            </div>`;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Where to Watch</div>
            <div class="de-providers-card">
                <div class="de-providers-header">
                    <span class="de-providers-title">Streaming &amp; Purchase</span>
                    <span class="de-region-badge">🏄 ${region}</span>
                </div>
                <div class="de-providers-group">
                    ${buildRow("STREAM", flatrate)}
                    ${buildRow("RENT", rent)}
                    ${buildRow("BUY", buy)}
                </div>
            </div>`;
    container.appendChild(section);
  }

  // ─────────────────────────────────────────────
  //  KEYWORDS
  // ─────────────────────────────────────────────
  injectKeywords(data, container) {
    const keywords = [
      ...((data.keywords && data.keywords.keywords) || []),
      ...((data.keywords && data.keywords.results) || []),
    ].slice(0, 15);
    if (!keywords.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Themes</div>
            <div class="de-keyword-strip">
                ${keywords.map((k) => `<span class="de-keyword-pill">${k.name}</span>`).join("")}
            </div>`;
    container.appendChild(section);
  }

  // ─────────────────────────────────────────────
  //  PHOTO GALLERY
  // ─────────────────────────────────────────────
  injectPhotoGallery(data, container) {
    const backdrops = ((data.images && data.images.backdrops) || [])
      .filter((img) => !img.iso_639_1)
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 20);
    if (backdrops.length < 2) return;

    const expandIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Photo Gallery</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${backdrops
                      .map(
                        (img, i) => `
                        <div class="plex-still-card" style="--i:${i}"
                             data-src="https://image.tmdb.org/t/p/original${img.file_path}">
                            <div class="plex-still-wrap">
                                <img class="plex-still-img"
                                     src="https://image.tmdb.org/t/p/w780${img.file_path}"
                                     alt="Still ${i + 1}" loading="lazy">
                                <div class="plex-still-expand">${expandIcon}</div>
                            </div>
                        </div>`,
                      )
                      .join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
    section.querySelectorAll(".plex-still-card").forEach((card) => {
      card.addEventListener("click", () => this.openLightbox(card.dataset.src));
    });
  }

  openLightbox(src) {
    document.getElementById("de-lightbox")?.remove();
    const lb = document.createElement("div");
    lb.id = "de-lightbox";
    lb.innerHTML = `
            <div class="de-lightbox-backdrop"></div>
            <img class="de-lightbox-img" src="${src}" alt="Photo">
            <button class="de-lightbox-close" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>`;
    document.body.appendChild(lb);
    const close = () => {
      lb.style.opacity = "0";
      lb.style.transition = "opacity .2s";
      setTimeout(() => lb.remove(), 200);
    };
    lb.querySelector(".de-lightbox-backdrop").addEventListener("click", close);
    lb.querySelector(".de-lightbox-close").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    });
  }

  // ─────────────────────────────────────────────
  //  RECOMMENDATIONS
  // ─────────────────────────────────────────────
  injectRecommendations(data, container) {
    const titles = (
      (data.recommendations && data.recommendations.results) ||
      []
    ).slice(0, 20);
    if (!titles.length) return;
    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">Because You&rsquo;re Watching</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${titles.map((item, i) => this.buildPosterCard(item, i)).join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
    this.setupPosterClickHandlers(section);
  }

  // ─────────────────────────────────────────────
  //  MORE BY DIRECTOR
  // ─────────────────────────────────────────────
  async injectMoreByDirector(data, container) {
    const crew = (data.credits && data.credits.crew) || [];
    const director = crew.find((c) => c.job === "Director");
    if (!director) return;

    const credits = await this.fetchPersonCredits(director.id);
    if (!credits) return;

    const titles = (credits.crew || [])
      .filter(
        (c) =>
          c.job === "Director" &&
          c.id !== data.id &&
          c.poster_path &&
          c.vote_average > 0,
      )
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 20);
    if (!titles.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">More Directed by ${director.name}</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${titles.map((item, i) => this.buildPosterCard(item, i)).join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
    this.setupPosterClickHandlers(section);
  }

  // ─────────────────────────────────────────────
  //  MORE WITH LEAD ACTOR
  // ─────────────────────────────────────────────
  async injectMoreWithActor(data, container) {
    const cast = (data.credits && data.credits.cast) || [];
    const actor = cast[0];
    if (!actor) return;

    const credits = await this.fetchPersonCredits(actor.id);
    if (!credits) return;

    const titles = (credits.cast || [])
      .filter((c) => c.id !== data.id && c.poster_path && c.vote_average > 0)
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 20);
    if (!titles.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="plex-section-title">More with ${actor.name}</div>
            <div class="plex-carousel-wrapper">
                <button class="plex-scroll-btn plex-scroll-left" aria-label="Scroll left">&#8249;</button>
                <div class="plex-hscroll">
                    ${titles.map((item, i) => this.buildPosterCard(item, i)).join("")}
                </div>
                <button class="plex-scroll-btn plex-scroll-right" aria-label="Scroll right">&#8250;</button>
            </div>`;
    container.appendChild(section);
    this.setupPlexScrollButtons(section);
    this.setupPosterClickHandlers(section);
  }

  async fetchPersonCredits(personId) {
    const key = `person_${personId}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return cached.data;
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/person/${personId}/combined_credits?api_key=${this.config.tmdbApiKey}`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      this.cache.set(key, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  AWARDS (OMDb)
  // ─────────────────────────────────────────────
  injectAwards(awards, container) {
    if (!awards || awards === "N/A") return;
    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `
            <div class="de-awards-banner">
                <span class="de-awards-icon">🏆</span>
                <span class="de-awards-text">${awards}</span>
            </div>`;
    container.appendChild(section);
  }

  // ─────────────────────────────────────────────
  //  SEASON EXPLORER
  // ─────────────────────────────────────────────
  injectSeasonExplorer(data, container) {
    const mainSeasons = (data.seasons || []).filter((s) => s.season_number > 0);
    const specialsSeason = (data.seasons || []).filter(
      (s) => s.season_number === 0,
    );
    const seasons = [...mainSeasons, ...specialsSeason];
    if (seasons.length <= 1 && !specialsSeason.length) return;

    const section = document.createElement("div");
    section.className = "plex-section";
    section.innerHTML = `<div class="plex-section-title">Season Explorer</div>`;

    const list = document.createElement("div");
    list.className = "de-season-list";

    for (const season of seasons) {
      const year = (season.air_date || "").slice(0, 4);
      const details = document.createElement("details");
      details.className = "de-season-item";

      const posterHTML = season.poster_path
        ? `<img class="de-season-poster" src="https://image.tmdb.org/t/p/w154${season.poster_path}" alt="${season.name}" loading="lazy">`
        : `<div class="de-season-poster de-season-poster-placeholder"></div>`;

      const summary = document.createElement("summary");
      summary.className = "de-season-summary";
      summary.innerHTML = `
                <svg class="de-season-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
                ${posterHTML}
                <div class="de-season-info">
                    <div class="de-season-name">${season.name}</div>
                    <div class="de-season-meta">${year || "TBA"}</div>
                </div>
                <div class="de-season-ep-count">${season.episode_count} ep${season.episode_count !== 1 ? "s" : ""}</div>`;

      const body = document.createElement("div");
      body.className = "de-season-episodes";

      let loaded = false;
      details.addEventListener("toggle", async () => {
        if (!details.open || loaded) return;
        loaded = true;
        body.innerHTML = `<div class="de-ep-grid">${Array.from(
          { length: 4 },
          () =>
            `<div class="de-episode-card">
                        <div class="de-skel" style="aspect-ratio:16/9;width:100%"></div>
                        <div style="padding:11px 13px">
                            <div class="de-skel" style="height:11px;width:80%;border-radius:5px"></div>
                            <div class="de-skel" style="height:9px;width:50%;border-radius:5px;margin-top:7px;opacity:.6"></div>
                        </div>
                    </div>`,
        ).join("")}</div>`;

        const episodes = await this.fetchSeasonEpisodes(
          data.id,
          season.season_number,
        );
        if (!episodes) {
          body.innerHTML = `<p style="padding:14px 0;color:rgba(255,255,255,.3);font-size:.85rem">Could not load episodes.</p>`;
          return;
        }
        body.innerHTML = `<div class="de-ep-grid">${episodes
          .map(
            (ep) => `
                    <div class="de-episode-card">
                        <div class="de-episode-still-wrap">
                            ${
                              ep.still_path
                                ? `<img class="de-episode-still" src="https://image.tmdb.org/t/p/w300${ep.still_path}" alt="${ep.name}" loading="lazy">`
                                : `<div class="de-episode-still" style="background:linear-gradient(135deg,#1a1a2e,#16213e)"></div>`
                            }
                            <span class="de-episode-num">E${ep.episode_number}</span>
                        </div>
                        <div class="de-episode-body">
                            <div class="de-episode-title">${ep.name || "TBA"}</div>
                            <div class="de-episode-air">${ep.air_date ? new Date(ep.air_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "TBA"}</div>
                        </div>
                    </div>`,
          )
          .join("")}</div>`;
      });

      details.appendChild(summary);
      details.appendChild(body);
      list.appendChild(details);
    }

    section.appendChild(list);
    container.appendChild(section);
  }

  async fetchSeasonEpisodes(tmdbId, seasonNumber) {
    const key = `season_${tmdbId}_${seasonNumber}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < 86400000) return cached.data;
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${this.config.tmdbApiKey}`,
      );
      if (!res.ok) return null;
      const json = await res.json();
      const episodes = json.episodes || [];
      this.cache.set(key, { data: episodes, ts: Date.now() });
      return episodes;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  TMDB FETCH (TTL-aware)
  // ─────────────────────────────────────────────
  async fetchTMDBData(imdbId) {
    const TTL = 1800000; // 30 minutes
    const cached = this.cache.get(imdbId);
    if (cached && cached.ts && Date.now() - cached.ts < TTL) return cached.data;
    const apiKey = this.config.tmdbApiKey;
    if (!apiKey) return null;
    try {
      const findRes = await fetch(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`,
      );
      if (!findRes.ok) return null;
      const found = await findRes.json();

      let tmdbId, mediaType;
      if (found.movie_results && found.movie_results.length) {
        tmdbId = found.movie_results[0].id;
        mediaType = "movie";
      } else if (found.tv_results && found.tv_results.length) {
        tmdbId = found.tv_results[0].id;
        mediaType = "tv";
      } else return null;

      const detailRes = await fetch(
        `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}` +
          `&append_to_response=credits,similar,recommendations,external_ids,content_ratings,` +
          `release_dates,videos,reviews,keywords,images,watch%2Fproviders` +
          `&include_image_language=en,null`,
      );
      if (!detailRes.ok) return null;
      const data = await detailRes.json();
      data.media_type = mediaType;
      this.cache.set(imdbId, { data, ts: Date.now() });
      return data;
    } catch (err) {
      console.error("[DataEnrichment] Fetch error:", err);
      return null;
    }
  }

  async fetchOMDbData(imdbId) {
    const key = `omdb_${imdbId}`;
    const cached = this.cache.get(key);
    if (cached && cached.ts && Date.now() - cached.ts < 86400000)
      return cached.data;
    try {
      const res = await fetch(
        `https://www.omdbapi.com/?i=${imdbId}&apikey=${this.config.omdbApiKey}`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (data.Response === "False") return null;
      this.cache.set(key, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  checkForPosters() {
    if (!this.config.showRatingsOnPosters || !this.config.tmdbApiKey) return;
    document
      .querySelectorAll('[class*="meta-item-container"]:not([data-enriched])')
      .forEach((p) => {
        p.setAttribute("data-enriched", "true");
      });
  }

  // ─────────────────────────────────────────────
  //  ALL STYLES
  // ─────────────────────────────────────────────
  injectPlexStyles() {
    if (document.getElementById("plex-enrichment-styles")) return;

    if (!document.getElementById("de-font-import")) {
      const link = document.createElement("link");
      link.id = "de-font-import";
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Serif+Display:ital@0;1&display=swap";
      document.head.appendChild(link);
    }

    const style = document.createElement("style");
    style.id = "plex-enrichment-styles";
    style.textContent = `

/* BASE */
.data-enrichment-container {
    margin-top: 40px;
    padding-bottom: 80px;
    margin-right: -40px;
    padding-right: 40px;
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 44px;
}
.data-enrichment-container * { box-sizing: border-box; }
.data-enrichment-container img { display: block; }

/* TWO-COLUMN META ROW (Where to Watch + Themes) */
.de-meta-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    align-items: start;
}
.de-meta-row > .plex-section:only-child {
    grid-column: 1 / -1;
}
@media (max-width: 900px) {
    .de-meta-row { grid-template-columns: 1fr; }
}

/* KEYFRAMES */
@keyframes de-shimmer {
    0%   { background-position: -600px 0; }
    100% { background-position:  600px 0; }
}
@keyframes de-fade-up {
    from { opacity: 0; transform: translateY(20px) scale(.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* SECTION TITLES */
.plex-section { display: flex; flex-direction: column; }
.plex-section-title {
    font-size: 1.45rem; font-weight: 700; margin-bottom: 28px;
    color: #fff; letter-spacing: -.4px;
    display: flex; align-items: center; gap: 12px;
}
.plex-section-title::before {
    content: ''; display: block; width: 4px; height: 1.2em;
    background: linear-gradient(180deg,#e5a00d 0%,#ff6b35 100%);
    border-radius: 3px; flex-shrink: 0;
}

/* FEATURE 3 — SKELETON LOADERS */
.de-skel {
    background: linear-gradient(90deg,
        rgba(255,255,255,.04) 0px,
        rgba(255,255,255,.11) 40px,
        rgba(255,255,255,.04) 80px);
    background-size: 600px 100%;
    animation: de-shimmer 1.6s infinite linear;
}
.de-skel-title { width: 180px; height: 18px; border-radius: 7px; margin-bottom: 24px; }

/* FEATURE 2 — RATINGS BAR */
.de-ratings-bar { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 16px; }
.de-rating-pill {
    display: flex; flex-direction: column; gap: 5px;
    padding: 13px 18px 11px; border-radius: 16px;
    border: 1px solid rgba(255,255,255,.08);
    background: rgba(255,255,255,.04);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    min-width: 96px; cursor: default;
    transition: transform .35s cubic-bezier(.34,1.3,.64,1), box-shadow .3s, background .25s;
}
.de-rating-pill:hover { transform: translateY(-4px); box-shadow: 0 12px 32px rgba(0,0,0,.45); background: rgba(255,255,255,.08); }
.de-pill-tmdb   { border-color: rgba(1,180,228,.28);  background: rgba(1,180,228,.07); }
.de-pill-fresh  { border-color: rgba(52,199,89,.28);  background: rgba(52,199,89,.07); }
.de-pill-rotten { border-color: rgba(255,69,58,.28);  background: rgba(255,69,58,.07); }
.de-pill-pop    { border-color: rgba(229,160,13,.28); background: rgba(229,160,13,.07); }
.de-pill-meta   { border-color: rgba(255,255,255,.08); }
.de-pill-top    { display: flex; align-items: center; gap: 6px; }
.de-pill-source { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .9px; color: rgba(255,255,255,.4); }
.de-pill-score  { font-size: 1.35rem; font-weight: 700; color: #fff; line-height: 1; letter-spacing: -.5px; }
.de-pill-bar-track { height: 3px; background: rgba(255,255,255,.1); border-radius: 2px; overflow: hidden; }
.de-pill-bar-fill  { height: 100%; border-radius: 2px; transition: width .8s cubic-bezier(.22,1,.36,1); }
.de-pill-sub    { font-size: .7rem; color: rgba(255,255,255,.35); }

/* FEATURE 4 — CREW STRIP */
.de-crew-strip {
    display: flex; flex-direction: column;
    border: 1px solid rgba(255,255,255,.07); border-radius: 18px; overflow: hidden;
    background: rgba(255,255,255,.03); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
.de-crew-cells { display: flex; flex-wrap: wrap; }
.de-crew-cell {
    display: flex; align-items: center; gap: 12px;
    padding: 17px 22px; flex: 1; min-width: 150px;
    border-right: 1px solid rgba(255,255,255,.05);
    transition: background .25s;
}
.de-crew-cell:last-child { border-right: none; }
.de-crew-cell:hover { background: rgba(255,255,255,.05); }
.de-crew-icon  { font-size: 1.2rem; flex-shrink: 0; }
.de-crew-label { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .9px; color: rgba(255,255,255,.38); margin-bottom: 3px; }
.de-crew-name  { font-size: .93rem; font-weight: 600; color: rgba(255,255,255,.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* CAROUSEL */
.plex-carousel-wrapper { position: relative; margin: 0 -32px 0 -20px; padding: 0 32px 0 20px; }
.plex-hscroll {
    display: flex; gap: 24px; overflow-x: auto; padding-bottom: 20px;
    scrollbar-width: none; scroll-behavior: smooth; -webkit-overflow-scrolling: touch; align-items: stretch;
}
.plex-hscroll::-webkit-scrollbar { display: none; }

/* FEATURE 5 — CAST CARDS + KNOWN-FOR */
.plex-cast-card {
    flex: 0 0 148px; text-align: center; cursor: default;
    display: flex; flex-direction: column; align-items: center;
    animation: de-fade-up .5s cubic-bezier(.34,1.3,.64,1) both;
    animation-delay: calc(var(--i,0) * .045s);
    transition: transform .4s cubic-bezier(.34,1.3,.64,1);
}
.plex-cast-card:hover { transform: translateY(-8px); }
.plex-cast-avatar {
    width: 148px; height: 148px; border-radius: 50%;
    object-fit: cover; object-position: center 15%;
    background: linear-gradient(135deg,#1e1e2e,#2a2a3a);
    margin: 0 auto 16px;
    border: 2.5px solid rgba(255,255,255,.07);
    transition: border-color .35s, box-shadow .35s, transform .4s cubic-bezier(.34,1.3,.64,1);
    box-shadow: 0 8px 24px rgba(0,0,0,.55);
    flex-shrink: 0; display: block;
}
.plex-cast-card:hover .plex-cast-avatar {
    border-color: rgba(229,160,13,.75);
    box-shadow: 0 0 0 5px rgba(229,160,13,.12), 0 16px 36px rgba(0,0,0,.6);
    transform: scale(1.06);
}
.plex-cast-name  { font-size: .9rem; font-weight: 600; color: #f0f0f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; padding: 0 6px; letter-spacing: -.1px; }
.plex-cast-char  { font-size: .78rem; color: rgba(255,255,255,.42); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; padding: 0 6px; font-weight: 400; }
.plex-cast-known { font-size: .7rem; color: #e5a00d; margin-top: 5px; opacity: 0; transition: opacity .5s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; padding: 0 6px; font-weight: 600; }
.plex-cast-known.de-known-visible { opacity: 1; }

/* TRAILERS */
.plex-trailers-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(290px,1fr)); gap: 22px; padding-bottom: 12px; }
.plex-trailer-card { cursor: pointer; display: flex; flex-direction: column; gap: 13px; animation: de-fade-up .5s cubic-bezier(.22,1,.36,1) both; animation-delay: calc(var(--i,0)*.06s); }
.plex-trailer-thumb { position: relative; border-radius: 14px; overflow: hidden; aspect-ratio: 16/9; background: #111; box-shadow: 0 6px 20px rgba(0,0,0,.5); transition: transform .4s cubic-bezier(.34,1.2,.64,1), box-shadow .4s; }
.plex-trailer-card:hover .plex-trailer-thumb { transform: scale(1.03) translateY(-3px); box-shadow: 0 16px 40px rgba(0,0,0,.65); }
.plex-trailer-thumb img { width: 100%; height: 100%; object-fit: cover; }
.plex-trailer-play-icon { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.38); backdrop-filter: blur(2px); transition: background .3s; }
.plex-trailer-card:hover .plex-trailer-play-icon { background: rgba(229,160,13,.25); }
.plex-trailer-card:hover .plex-trailer-play-icon svg { transform: scale(1.14); }
.plex-trailer-label { font-size: .95rem; color: rgba(255,255,255,.72); font-weight: 500; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* REVIEWS */
.plex-review-card {
    flex: 0 0 390px; background: rgba(255,255,255,.04); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border-radius: 20px; padding: 26px 28px; border: 1px solid rgba(255,255,255,.07);
    transition: transform .4s cubic-bezier(.34,1.2,.64,1), border-color .3s, box-shadow .4s, background .3s;
    box-shadow: 0 6px 24px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.06);
    display: flex; flex-direction: column; min-height: 200px;
    animation: de-fade-up .5s cubic-bezier(.22,1,.36,1) both; animation-delay: calc(var(--i,0)*.06s);
}
.plex-review-card:hover { transform: translateY(-6px); border-color: rgba(255,255,255,.13); box-shadow: 0 20px 48px rgba(0,0,0,.52), inset 0 1px 0 rgba(255,255,255,.1); background: rgba(255,255,255,.07); }
.plex-review-stars  { color: #e5a00d; font-size: 1rem; margin-bottom: 12px; letter-spacing: 2px; }
.plex-review-author { font-size: .97rem; font-weight: 600; color: #f0f0f0; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
.plex-review-author::before { content: ''; width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg,rgba(229,160,13,.35),rgba(255,107,53,.35)); border: 1px solid rgba(229,160,13,.25); flex-shrink: 0; }
.plex-review-text   { font-size: .875rem; color: rgba(255,255,255,.48); line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; flex-grow: 1; font-weight: 300; }

/* FEATURE 7 — POSTER CARDS + HOVER OVERLAY */
.plex-rec-card {
    flex: 0 0 186px; cursor: pointer; display: flex; flex-direction: column; gap: 13px;
    animation: de-fade-up .5s cubic-bezier(.34,1.2,.64,1) both; animation-delay: calc(var(--i,0)*.05s);
}
.plex-rec-poster-wrap {
    position: relative; width: 186px; height: 279px;
    border-radius: 14px; overflow: hidden; flex-shrink: 0;
    box-shadow: 0 8px 24px rgba(0,0,0,.45);
    transition: transform .4s cubic-bezier(.34,1.2,.64,1), box-shadow .4s;
}
.plex-rec-card:hover .plex-rec-poster-wrap { transform: translateY(-8px) scale(1.03); box-shadow: 0 20px 48px rgba(0,0,0,.65); }
.plex-rec-poster   { width: 100%; height: 100%; object-fit: cover; display: block; }
.plex-rec-no-poster {
    width: 100%; height: 100%;
    background: linear-gradient(135deg,#1a1a2e,#16213e);
    display: flex; align-items: center; justify-content: center;
    text-align: center; color: rgba(255,255,255,.35); font-size: .9rem; padding: 14px;
    border: 1px solid rgba(255,255,255,.06);
}
.plex-rec-overlay {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; justify-content: space-between; padding: 11px;
    background: linear-gradient(to bottom, rgba(0,0,0,.58) 0%, transparent 36%, transparent 55%, rgba(0,0,0,.88) 100%);
    opacity: 0; transform: translateY(8px);
    transition: opacity .32s ease, transform .38s cubic-bezier(.34,1.2,.64,1);
}
.plex-rec-card:hover .plex-rec-overlay { opacity: 1; transform: translateY(0); }
.plex-rec-overlay-top { display: flex; align-items: center; justify-content: space-between; }
.plex-rec-type-badge  { font-size: .65rem; font-weight: 800; text-transform: uppercase; letter-spacing: .7px; background: rgba(229,160,13,.92); color: #000; padding: 3px 8px; border-radius: 5px; }
.plex-rec-year        { font-size: .76rem; font-weight: 600; color: rgba(255,255,255,.82); }
.plex-rec-score       { font-size: .92rem; font-weight: 700; color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,.8); }
.plex-rec-title {
    font-size: .9rem; font-weight: 500; color: rgba(255,255,255,.68);
    text-align: center; line-height: 1.4; overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    padding: 0 4px; transition: color .25s;
}
.plex-rec-card:hover .plex-rec-title { color: rgba(255,255,255,.95); }

/* SCROLL BUTTONS */
.plex-scroll-btn {
    position: absolute; top: calc(50% - 24px); transform: translateY(-50%);
    width: 54px; height: 54px; background: rgba(12,12,18,.88);
    border: 1px solid rgba(255,255,255,.1); border-radius: 50%;
    color: #fff; display: flex; align-items: center; justify-content: center;
    cursor: pointer; z-index: 10; opacity: 0; pointer-events: none;
    font-size: 22px; font-weight: 300;
    box-shadow: 0 6px 24px rgba(0,0,0,.65);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    transition: opacity .3s, background .3s, transform .35s cubic-bezier(.34,1.56,.64,1), border-color .3s, box-shadow .3s;
}
.plex-scroll-btn:hover { background: rgba(229,160,13,.95); border-color: rgba(229,160,13,.6); transform: translateY(-50%) scale(1.1); box-shadow: 0 8px 32px rgba(229,160,13,.35); }
.plex-scroll-left  { left:  0; }
.plex-scroll-right { right: 0; }
.plex-carousel-wrapper:hover .plex-scroll-btn.can-scroll { opacity: 1; pointer-events: auto; }

/* HERO */
.plex-hero  { display: flex; flex-direction: column; gap: 16px; position: relative; z-index: 5; margin-bottom: 4px; }
.plex-hero-tagline { font-family: 'DM Serif Display', Georgia, serif; font-size: 1.45rem; font-style: italic; color: #e5a00d; letter-spacing: .2px; line-height: 1.35; opacity: .92; }
.plex-hero-overview { font-size: 1.05rem; line-height: 1.75; color: rgba(255,255,255,.76); max-width: 93%; font-weight: 300; letter-spacing: .1px; }
.plex-hero-meta { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin-top: 4px; }
.plex-hero-badge { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.11); border-radius: 30px; padding: 6px 16px; font-size: .85rem; font-weight: 500; color: rgba(255,255,255,.82); backdrop-filter: blur(12px); letter-spacing: .3px; transition: background .25s, border-color .25s; }
.plex-hero-badge:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.2); }
.plex-hero-director { display: flex; align-items: center; gap: 7px; font-size: .88rem; font-weight: 600; color: rgba(255,255,255,.88); background: rgba(229,160,13,.1); padding: 6px 16px; border-radius: 30px; border: 1px solid rgba(229,160,13,.2); }
.plex-hero-director em { color: #e5a00d; font-style: normal; font-weight: 400; font-size: .82rem; }


/* ═══════════════════════════════════════════════════════
   HOME BUTTON — Liquid Glass / Glassmorphism
   sits in the top-right toolbar, left of native icons
═══════════════════════════════════════════════════════ */

@keyframes de-home-btn-in {
    0%   { opacity: 0; transform: translateY(-12px) scale(0.88); filter: blur(4px); }
    60%  { opacity: 1; filter: blur(0px); }
    100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0px); }
}
@keyframes de-home-shimmer {
    0%   { transform: translateX(-120%) skewX(-18deg); }
    100% { transform: translateX(320%)  skewX(-18deg); }
}
@keyframes de-home-ripple-out {
    0%   { transform: translate(-50%, -50%) scale(0); opacity: 0.55; }
    100% { transform: translate(-50%, -50%) scale(3.5); opacity: 0; }
}

#de-home-btn {
    /* ── Position ── */
    position: fixed;
    top: 20px;
    right: 140px;
    z-index: 99990;

    /* ── Layout ── */
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 20px 9px 14px;
    white-space: nowrap;
    overflow: hidden;

    /* ── Liquid glass base ── */
    background:
        linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.18) 0%,
            rgba(255, 255, 255, 0.06) 40%,
            rgba(255, 255, 255, 0.10) 70%,
            rgba(255, 255, 255, 0.04) 100%
        );
    border-radius: 50px;

    /* ── Glass edge — top-bright, sides & bottom subtle ── */
    border-top:    1px solid rgba(255, 255, 255, 0.55);
    border-left:   1px solid rgba(255, 255, 255, 0.22);
    border-right:  1px solid rgba(255, 255, 255, 0.10);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);

    /* ── Text ── */
    color: rgba(255, 255, 255, 0.92);
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.9rem;
    font-weight: 600;
    letter-spacing: 0.015em;
    cursor: pointer;

    /* ── Frosted blur ── */
    backdrop-filter: blur(28px) saturate(1.6) brightness(1.15);
    -webkit-backdrop-filter: blur(28px) saturate(1.6) brightness(1.15);

    /* ── Depth shadows ── */
    box-shadow:
        0 2px 0 0 rgba(255,255,255,0.28) inset,   /* top specular lip  */
        0 -1px 0 0 rgba(0,0,0,0.18) inset,         /* bottom inner edge */
        0 8px 24px rgba(0, 0, 0, 0.38),
        0 2px 6px  rgba(0, 0, 0, 0.22),
        0 0 0 0.5px rgba(255,255,255,0.12);

    /* ── Transitions ── */
    transition:
        background    0.38s ease,
        box-shadow    0.38s ease,
        border-color  0.38s ease,
        color         0.32s ease,
        transform     0.42s cubic-bezier(0.34, 1.4, 0.64, 1),
        filter        0.38s ease;

    /* ── Entrance ── */
    animation: de-home-btn-in 0.55s cubic-bezier(0.34, 1.3, 0.64, 1) both;
}

/* ── Specular shine layer (static highlight arc) ── */
.de-home-glass-shine {
    pointer-events: none;
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(
        170deg,
        rgba(255,255,255,0.28) 0%,
        rgba(255,255,255,0.10) 28%,
        transparent 52%
    );
    opacity: 1;
    transition: opacity 0.38s ease;
}

/* ── Iridescent shimmer sweep (plays on hover) ── */
.de-home-glass-shimmer {
    pointer-events: none;
    position: absolute;
    top: 0; left: 0;
    width: 40%;
    height: 100%;
    background: linear-gradient(
        100deg,
        transparent 0%,
        rgba(255,255,255,0.0)  20%,
        rgba(200,220,255,0.22) 45%,
        rgba(255,200,240,0.18) 55%,
        rgba(255,255,255,0.0)  80%,
        transparent 100%
    );
    transform: translateX(-120%) skewX(-18deg);
    opacity: 0;
    transition: opacity 0.2s;
}

/* ── Ripple element ── */
.de-home-ripple {
    pointer-events: none;
    position: absolute;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: rgba(255,255,255,0.25);
    left: 50%; top: 50%;
    transform: translate(-50%, -50%) scale(0);
    opacity: 0;
}

/* ── Label ── */
.de-home-label {
    position: relative;
    z-index: 1;
}

/* ── Icon ── */
.de-home-icon {
    width: 17px;
    height: 17px;
    flex-shrink: 0;
    position: relative;
    z-index: 1;
    transition: transform 0.42s cubic-bezier(0.34, 1.6, 0.64, 1),
                filter 0.32s ease;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
}

/* ══ HOVER STATE ══════════════════════════════════════ */
#de-home-btn:hover {
    background:
        linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.26) 0%,
            rgba(200, 220, 255, 0.14) 35%,
            rgba(255, 200, 240, 0.10) 65%,
            rgba(255, 255, 255, 0.08) 100%
        );

    border-top:    1px solid rgba(255, 255, 255, 0.72);
    border-left:   1px solid rgba(255, 255, 255, 0.35);
    border-right:  1px solid rgba(255, 255, 255, 0.18);
    border-bottom: 1px solid rgba(255, 255, 255, 0.14);

    color: #fff;

    box-shadow:
        0 2px 0 0 rgba(255,255,255,0.45) inset,
        0 -1px 0 0 rgba(0,0,0,0.22) inset,
        0 12px 36px rgba(0, 0, 0, 0.48),
        0 4px 12px  rgba(0, 0, 0, 0.28),
        0 0 0 0.5px rgba(255,255,255,0.22),
        0 0 28px    rgba(180, 210, 255, 0.12);

    transform: translateY(-2px) scale(1.02);
    filter: brightness(1.08);
}

#de-home-btn:hover .de-home-glass-shine {
    opacity: 0.7;
}

#de-home-btn:hover .de-home-glass-shimmer {
    opacity: 1;
    animation: de-home-shimmer 0.65s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

#de-home-btn:hover .de-home-icon {
    transform: scale(1.2) translateY(-1px);
    filter: drop-shadow(0 0 6px rgba(200,220,255,0.6)) drop-shadow(0 2px 4px rgba(0,0,0,0.4));
}

/* ══ ACTIVE / CLICK ══════════════════════════════════ */
#de-home-btn:active {
    transform: translateY(0) scale(0.96);
    box-shadow:
        0 1px 0 0 rgba(255,255,255,0.25) inset,
        0 4px 12px rgba(0, 0, 0, 0.35),
        0 0 0 0.5px rgba(255,255,255,0.12);
    filter: brightness(0.95);
    transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
}

#de-home-btn:active .de-home-ripple {
    animation: de-home-ripple-out 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

/* RESPONSIVE */
@media (max-width: 900px) {
    .data-enrichment-container { margin-top: 24px; gap: 32px; padding-bottom: 40px; }
    .plex-section-title { font-size: 1.2rem; margin-bottom: 18px; }
    .plex-hscroll { gap: 16px; }
    .plex-cast-card { flex: 0 0 110px; }
    .plex-cast-avatar { width: 110px; height: 110px; }
    .plex-rec-card { flex: 0 0 136px; }
    .plex-rec-poster-wrap { width: 136px; height: 204px; border-radius: 10px; }
    .plex-trailers-grid { grid-template-columns: repeat(auto-fill,minmax(230px,1fr)); gap: 16px; }
    .plex-review-card { flex: 0 0 300px; padding: 18px 20px; }
    .plex-scroll-btn { display: none; }
    .de-crew-cell { min-width: 140px; padding: 14px 16px; }
}

/* HIDE NATIVE STREMIO DUPLICATES */
[class*="description-text"],[class*="description-container"],
[class*="cast-list"],[class*="director-list"],
[class*="genres-list"],[class*="genres-container"],
[class*="meta-tags"] { display: none !important; }

/* VIDEO PLAYER OVERLAY */
#de-video-player-overlay {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    animation: de-fade-up .28s cubic-bezier(.22,1,.36,1) both;
}
#de-video-player-overlay.de-vp-closing {
    animation: de-vp-out .28s cubic-bezier(.55,0,1,.45) both;
}
@keyframes de-vp-out {
    to { opacity: 0; transform: scale(.97); }
}
.de-vp-backdrop {
    position: absolute; inset: 0;
    background: rgba(0,0,0,.88);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
}
.de-vp-shell {
    position: relative; z-index: 1;
    display: flex; flex-direction: column;
    width: min(96vw, 1280px);
    gap: 14px;
}
.de-vp-topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 4px;
}
.de-vp-back {
    display: flex; align-items: center; gap: 6px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.13);
    color: rgba(255,255,255,.9);
    padding: 7px 18px 7px 12px;
    border-radius: 50px;
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    font-size: .9rem; font-weight: 600;
    letter-spacing: .01em;
    transition: background .22s, border-color .22s, color .22s, transform .22s;
}
.de-vp-back:hover {
    background: rgba(229,160,13,.18);
    border-color: rgba(229,160,13,.5);
    color: #e5a00d;
    transform: translateX(-2px);
}
.de-vp-back svg { width: 18px; height: 18px; }
.de-vp-title {
    font-family: 'DM Sans', sans-serif;
    font-size: 1rem; font-weight: 600;
    color: rgba(255,255,255,.8);
    text-align: center;
    flex: 1; padding: 0 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.de-vp-frame-wrap {
    border-radius: 16px; overflow: hidden;
    aspect-ratio: 16/9;
    box-shadow: 0 24px 80px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.06);
    background: #000;
}
.de-vp-iframe { width: 100%; height: 100%; display: block; border: none; }

/* PRODUCTION STUDIOS */
.de-studios-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 20px;
    padding: 14px 22px; border-top: 1px solid rgba(255,255,255,.05);
}
.de-studios-label {
    font-size: .62rem; font-weight: 800; text-transform: uppercase;
    letter-spacing: .9px; color: rgba(255,255,255,.25); flex-shrink: 0;
}
.de-studio-logo {
    height: 26px; width: auto; max-width: 80px; object-fit: contain;
    filter: brightness(.6) grayscale(.5);
    transition: filter .3s, transform .3s cubic-bezier(.34,1.3,.64,1);
}
.de-studio-logo:hover { filter: brightness(1) grayscale(0); transform: scale(1.1); }

/* STATUS BADGE + NEXT EPISODE */
.de-hero-status-row { margin-bottom: 10px; }
.de-status-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 14px; border-radius: 20px;
    font-size: .78rem; font-weight: 700; letter-spacing: .3px; border: 1px solid;
}
.de-status-ongoing    { color: #34c759; border-color: rgba(52,199,89,.35);   background: rgba(52,199,89,.1); }
.de-status-ended      { color: rgba(255,255,255,.45); border-color: rgba(255,255,255,.15); background: rgba(255,255,255,.05); }
.de-status-cancelled  { color: #ff453a; border-color: rgba(255,69,58,.35);   background: rgba(255,69,58,.08); }
.de-status-production { color: #007aff; border-color: rgba(0,122,255,.35);   background: rgba(0,122,255,.08); }
.de-next-episode {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 11px 16px; margin: 4px 0;
    background: rgba(229,160,13,.07); border: 1px solid rgba(229,160,13,.2);
    border-radius: 12px; font-size: .88rem; color: rgba(255,255,255,.65); line-height: 1.5;
}
.de-next-ep-label { color: #e5a00d; font-weight: 700; flex-shrink: 0; }

/* MATURITY + BOX OFFICE PILLS */
.de-pill-rating  { border-color: rgba(255,107,107,.28); background: rgba(255,107,107,.07); }
.de-pill-budget  { border-color: rgba(245,200,66,.28);  background: rgba(245,200,66,.07); }
.de-pill-revenue { border-color: rgba(52,199,89,.28);   background: rgba(52,199,89,.07); }

/* WATCH PROVIDERS */
.de-providers-card {
    background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
    border-radius: 20px; padding: 22px 24px;
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
.de-providers-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.de-providers-title { font-size: .68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 1.1px; color: rgba(255,255,255,.32); }
.de-region-badge {
    font-size: .72rem; font-weight: 700; color: rgba(255,255,255,.5);
    background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
    padding: 4px 10px; border-radius: 20px;
}
.de-providers-group { display: flex; flex-direction: column; gap: 14px; }
.de-providers-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.de-providers-row-label {
    font-size: .62rem; font-weight: 800; text-transform: uppercase; letter-spacing: .9px;
    color: rgba(255,255,255,.28); min-width: 46px; flex-shrink: 0;
}
.de-provider-logo-wrap { position: relative; }
.de-provider-logo {
    width: 46px; height: 46px; border-radius: 12px; object-fit: cover;
    border: 1px solid rgba(255,255,255,.1); cursor: default;
    transition: transform .3s cubic-bezier(.34,1.3,.64,1), box-shadow .3s, border-color .3s;
    box-shadow: 0 4px 12px rgba(0,0,0,.4);
}
.de-provider-logo:hover { transform: scale(1.14) translateY(-2px); box-shadow: 0 10px 28px rgba(0,0,0,.6); border-color: rgba(255,255,255,.25); }
.de-provider-tooltip {
    position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%);
    background: rgba(12,12,18,.95); border: 1px solid rgba(255,255,255,.1);
    color: rgba(255,255,255,.85); font-size: .68rem; font-weight: 600;
    padding: 4px 10px; border-radius: 8px; white-space: nowrap;
    pointer-events: none; opacity: 0; transition: opacity .2s;
    backdrop-filter: blur(12px); z-index: 20;
}
.de-provider-logo-wrap:hover .de-provider-tooltip { opacity: 1; }

/* KEYWORDS */
.de-keyword-strip { display: flex; flex-wrap: wrap; gap: 8px; }
.de-keyword-pill {
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09);
    border-radius: 20px; padding: 5px 14px;
    font-size: .78rem; font-weight: 500; color: rgba(255,255,255,.6);
    backdrop-filter: blur(10px); cursor: default;
    transition: background .2s, border-color .2s, color .2s;
}
.de-keyword-pill:hover { background: rgba(229,160,13,.08); border-color: rgba(229,160,13,.3); color: rgba(255,255,255,.9); }

/* PHOTO GALLERY */
.plex-still-card {
    flex: 0 0 360px; cursor: pointer;
    animation: de-fade-up .5s cubic-bezier(.22,1,.36,1) both;
    animation-delay: calc(var(--i,0)*.05s);
}
.plex-still-wrap {
    position: relative; aspect-ratio: 16/9; border-radius: 14px; overflow: hidden;
    box-shadow: 0 8px 24px rgba(0,0,0,.45);
    transition: transform .4s cubic-bezier(.34,1.2,.64,1), box-shadow .4s;
}
.plex-still-card:hover .plex-still-wrap { transform: scale(1.03) translateY(-4px); box-shadow: 0 20px 48px rgba(0,0,0,.65); }
.plex-still-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.plex-still-expand {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.35); opacity: 0; transition: opacity .28s;
    color: #fff;
}
.plex-still-card:hover .plex-still-expand { opacity: 1; }

/* LIGHTBOX */
#de-lightbox {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
}
.de-lightbox-backdrop {
    position: absolute; inset: 0;
    background: rgba(0,0,0,.92); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
}
.de-lightbox-img {
    position: relative; z-index: 1;
    max-width: 96vw; max-height: 90vh; object-fit: contain;
    border-radius: 14px; box-shadow: 0 32px 100px rgba(0,0,0,.9);
    animation: de-fade-up .25s cubic-bezier(.22,1,.36,1) both;
}
.de-lightbox-close {
    position: absolute; top: 20px; right: 20px; z-index: 2;
    width: 44px; height: 44px; border-radius: 50%;
    background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.15);
    color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background .2s, transform .3s; backdrop-filter: blur(12px);
}
.de-lightbox-close:hover { background: rgba(255,255,255,.2); transform: scale(1.12); }

/* AWARDS */
.de-awards-banner {
    display: flex; align-items: center; gap: 14px;
    padding: 16px 22px;
    background: rgba(229,160,13,.06); border: 1px solid rgba(229,160,13,.2);
    border-left: 3px solid #e5a00d; border-radius: 14px;
    backdrop-filter: blur(12px);
}
.de-awards-icon { font-size: 1.3rem; flex-shrink: 0; }
.de-awards-text { font-size: .92rem; color: rgba(255,255,255,.8); line-height: 1.55; }

/* SEASON EXPLORER */
.de-season-list { display: flex; flex-direction: column; gap: 10px; }
.de-season-item {
    background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
    border-radius: 14px; overflow: hidden; transition: border-color .25s;
}
.de-season-item:hover { border-color: rgba(255,255,255,.13); }
.de-season-summary {
    display: flex; align-items: center; gap: 14px; padding: 14px 18px;
    cursor: pointer; list-style: none; user-select: none;
    transition: background .2s;
}
.de-season-summary::-webkit-details-marker { display: none; }
.de-season-summary:hover { background: rgba(255,255,255,.03); }
.de-season-chevron {
    width: 18px; height: 18px; flex-shrink: 0; color: rgba(255,255,255,.35);
    transition: transform .35s cubic-bezier(.34,1.3,.64,1), color .2s;
}
details[open] .de-season-chevron { transform: rotate(90deg); color: #e5a00d; }
.de-season-poster {
    width: 40px; height: 60px; border-radius: 6px; object-fit: cover; flex-shrink: 0;
    background: rgba(255,255,255,.06);
}
.de-season-poster-placeholder { background: linear-gradient(135deg,#1a1a2e,#16213e); }
.de-season-info { flex: 1; min-width: 0; }
.de-season-name { font-size: .95rem; font-weight: 600; color: rgba(255,255,255,.88); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.de-season-meta { font-size: .75rem; color: rgba(255,255,255,.35); margin-top: 3px; }
.de-season-ep-count {
    font-size: .7rem; font-weight: 700; color: rgba(255,255,255,.3);
    background: rgba(255,255,255,.06); padding: 3px 10px; border-radius: 20px;
    white-space: nowrap; flex-shrink: 0;
}
.de-season-episodes { padding: 0 16px 16px; }
.de-ep-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.de-episode-card {
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06);
    border-radius: 12px; overflow: hidden;
    transition: border-color .2s, background .2s, transform .3s cubic-bezier(.34,1.2,.64,1);
}
.de-episode-card:hover { border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.07); transform: translateY(-2px); }
.de-episode-still-wrap { position: relative; aspect-ratio: 16/9; background: rgba(0,0,0,.3); }
.de-episode-still { width: 100%; height: 100%; object-fit: cover; display: block; }
.de-episode-num {
    position: absolute; top: 7px; left: 7px;
    background: rgba(0,0,0,.72); color: rgba(255,255,255,.75);
    font-size: .62rem; font-weight: 700; padding: 2px 6px; border-radius: 5px;
    backdrop-filter: blur(6px);
}
.de-episode-body { padding: 10px 12px; }
.de-episode-title {
    font-size: .83rem; font-weight: 600; color: rgba(255,255,255,.82); line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.de-episode-air { font-size: .7rem; color: rgba(255,255,255,.3); margin-top: 4px; }
@media (max-width: 900px) { .de-ep-grid { grid-template-columns: 1fr; } .plex-still-card { flex: 0 0 280px; } }

        `;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────
  //  SETTINGS INTEGRATION
  // ─────────────────────────────────────────────
  injectSettingsButton() {
    this.settingsRetryCount = 0;
    this.settingsObserver = new MutationObserver(() => this.handleMutation());
    this.settingsObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    this.handleMutation();

    // Start a fallback timer (3 seconds)
    setTimeout(() => this.checkSettingsLoaded(), 3000);
  }

  handleMutation() {
    if (!window.location.hash.toLowerCase().includes("settings")) return;
    this.injectSettingsToPluginRow();
  }

  checkSettingsLoaded() {
    if (!window.location.hash.toLowerCase().includes("settings")) return;
    if (
      !document.querySelector(".de-gear-btn") &&
      !document.querySelector(".de-fallback-container")
    ) {
      console.warn(
        "[DataEnrichment] Plugin row not found, triggering standalone fallback...",
      );
      this.injectFallbackSettings();
    }
  }

  findPluginCard() {
    const els = Array.from(document.querySelectorAll("*"));
    // Find the deepest element containing "Cinematic Title" or "Data Enrichment"
    const titleEls = els.filter(
      (el) =>
        el.textContent &&
        (el.textContent.trim().startsWith("Cinematic Title") ||
          el.textContent.trim().startsWith("Data Enrichment")),
    );
    if (titleEls.length === 0) return null;

    const titleNode = titleEls[titleEls.length - 1];

    // Traverse upwards to find the true plugin card container
    let parent = titleNode.parentElement;
    while (parent && parent !== document.body) {
      const className = (parent.className || "").toString().toLowerCase();

      // 1. Safe Class Match: Stremio plugin cards typically have 'plugin-item' or 'card' in their class hash.
      // We DO NOT match 'container' here to avoid accidentally grabbing inner text wrappers.
      if (
        className.includes("plugin-item") ||
        className.includes("pluginitem") ||
        className === "card"
      ) {
        return parent;
      }

      // 2. Structural Match (Bulletproof fallback):
      // The true card is the direct child of the plugins list. The list has multiple plugin siblings.
      if (parent.parentElement && parent.parentElement.children.length >= 3) {
        // Confirm it's the actual card by verifying it holds both the descriptive text and some form of toggle/action
        const hasToggleOrAction = parent.querySelector(
          'input, button, svg, [role="switch"]',
        );
        const hasDesc =
          parent.innerText && parent.innerText.includes("elmarco");
        if (hasToggleOrAction && hasDesc) {
          return parent;
        }
      }

      parent = parent.parentElement;
    }
    return null;
  }

  injectSettingsToPluginRow() {
    if (document.querySelector(".de-gear-btn")) return;
    const targetRow = this.findPluginCard();
    if (!targetRow) return;

    // Make card a positioning context for the gear
    targetRow.style.position = "relative";

    const gearBtn = document.createElement("div");
    gearBtn.className = "de-gear-btn";
    gearBtn.title = "Configure Cinematic Title View Enhancer";
    gearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2 2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

    targetRow.appendChild(gearBtn);

    const panel = this.createSettingsPanel();
    targetRow.appendChild(panel);

    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("de-collapsed");
      gearBtn.classList.toggle("active");
    });

    this.injectSettingsStyles();
  }

  injectFallbackSettings() {
    if (document.querySelector(".de-fallback-container")) return;

    const settingsTab = document.querySelector(
      '.settings-container-X_A_Z, [class*="settings-container"], #settings-page, [class*="Enhanced"]',
    );
    if (!settingsTab) return;

    const fallback = document.createElement("div");
    fallback.className = "de-fallback-container";
    fallback.innerHTML = `
            <div class="de-fallback-header">
                <h3 style="margin:0;font-size:18px;">Cinematic Title View Enhancer Settings</h3>
                <span class="de-fallback-badge">Fallback Mode</span>
            </div>
        `;
    fallback.appendChild(this.createSettingsPanel(true));

    settingsTab.prepend(fallback);
    this.injectSettingsStyles();
  }

  createSettingsPanel(forceExpanded = false) {
    const panel = document.createElement("div");
    panel.className = `de-panel-wrapper ${forceExpanded ? "" : "de-collapsed"}`;

    const toggleMap = [
      { key: "enhancedCast", lbl: "Enhanced Cast", icon: "🎭" },
      { key: "showTrailers", lbl: "Trailers & Teasers", icon: "🎬" },
      { key: "showReviews", lbl: "Ratings & Reviews", icon: "⭐️" },
      { key: "similarTitles", lbl: "Similar Titles", icon: "📂" },
      { key: "showCollection", lbl: "Show Collection", icon: "🎞️" },
      { key: "showRatingsOnPosters", lbl: "Ratings on Posters", icon: "🏷️" },
      { key: "showWatchProviders", lbl: "Watch Providers", icon: "📺" },
      { key: "showKeywords", lbl: "Keyword Themes", icon: "🔖" },
      { key: "showPhotoGallery", lbl: "Photo Gallery", icon: "🖼️" },
      { key: "showAwards", lbl: "Awards Badge", icon: "🏆" },
      { key: "showBoxOffice", lbl: "Box Office", icon: "💰" },
      { key: "showSeasonExplorer", lbl: "Season Explorer", icon: "🗂️" },
      { key: "showRecommendations", lbl: "Recommendations", icon: "✨" },
    ];

    const REGIONS = [
      "US",
      "GB",
      "CA",
      "AU",
      "DE",
      "FR",
      "ES",
      "IT",
      "JP",
      "KR",
      "BR",
      "MX",
      "IN",
      "NL",
      "SE",
    ];

    panel.innerHTML = `
            <div class="de-panel-content">
                <div class="de-opt-group">
                    <div class="de-opt-label">
                        <span>TMDB API Key</span>
                        <div class="de-status-dot ${this.config.tmdbApiKey ? "active" : ""}"></div>
                    </div>
                    <div class="de-api-row">
                        <input type="password" class="de-api-input de-tmdb-input" value="${this.config.tmdbApiKey}" placeholder="Paste TMDB API key here...">
                        <button class="de-api-save de-tmdb-save">Save</button>
                    </div>
                </div>

                <div class="de-opt-group">
                    <div class="de-opt-label"><span>OMDb API Key <em style="font-weight:400;color:rgba(255,255,255,.35);text-transform:none;letter-spacing:0">(optional — for Awards)</em></span></div>
                    <div class="de-api-row">
                        <input type="password" class="de-api-input de-omdb-input" value="${this.config.omdbApiKey}" placeholder="Paste free OMDb key (omdbapi.com)...">
                        <button class="de-api-save de-omdb-save">Save</button>
                    </div>
                </div>

                <div class="de-opt-group">
                    <div class="de-opt-label"><span>Watch Provider Region</span></div>
                    <select class="de-region-select">
                        ${REGIONS.map((r) => `<option value="${r}" ${this.config.watchProviderRegion === r ? "selected" : ""}>${r}</option>`).join("")}
                    </select>
                </div>

                <div class="de-toggles-grid">
                    ${toggleMap
                      .map(
                        (opt, i) => `
                        <div class="de-toggle-item" style="--i: ${i}">
                            <div class="de-toggle-info">
                                <span class="de-toggle-icon">${opt.icon}</span>
                                <span class="de-toggle-text">${opt.lbl}</span>
                            </div>
                            <label class="de-switch">
                                <input type="checkbox" class="de-check-${opt.key}" ${this.config[opt.key] ? "checked" : ""}>
                                <span class="de-slider"></span>
                            </label>
                        </div>
                    `,
                      )
                      .join("")}
                </div>
            </div>
        `;

    // TMDB key save
    const tmdbInput = panel.querySelector(".de-tmdb-input");
    const tmdbSave = panel.querySelector(".de-tmdb-save");
    const dot = panel.querySelector(".de-status-dot");
    tmdbSave.addEventListener("click", (e) => {
      e.stopPropagation();
      this.config.tmdbApiKey = tmdbInput.value.trim();
      this.saveConfig();
      this.cache.clear();
      dot.classList.toggle("active", !!this.config.tmdbApiKey);
      tmdbSave.textContent = "Saved!";
      tmdbSave.classList.add("success");
      setTimeout(() => {
        tmdbSave.textContent = "Save";
        tmdbSave.classList.remove("success");
      }, 2000);
    });

    // OMDb key save
    const omdbInput = panel.querySelector(".de-omdb-input");
    const omdbSave = panel.querySelector(".de-omdb-save");
    omdbSave.addEventListener("click", (e) => {
      e.stopPropagation();
      this.config.omdbApiKey = omdbInput.value.trim();
      this.saveConfig();
      this.cache.clear();
      omdbSave.textContent = "Saved!";
      omdbSave.classList.add("success");
      setTimeout(() => {
        omdbSave.textContent = "Save";
        omdbSave.classList.remove("success");
      }, 2000);
    });

    // Region select
    panel.querySelector(".de-region-select").addEventListener("change", (e) => {
      this.config.watchProviderRegion = e.target.value;
      this.saveConfig();
      this.cache.clear();
    });

    toggleMap.forEach((opt) => {
      const cb = panel.querySelector(`.de-check-${opt.key}`);
      cb.addEventListener("change", (e) => {
        this.config[opt.key] = e.target.checked;
        this.saveConfig();
      });
    });

    return panel;
  }

  injectSettingsStyles() {
    if (document.getElementById("de-settings-styles")) return;
    const style = document.createElement("style");
    style.id = "de-settings-styles";
    style.textContent = `
            /* GEAR BUTTON */
            .de-gear-btn {
                width: 30px; height: 30px;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; border-radius: 50%;
                /* Match the panel's glass background style */
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(229,160,13,0.35);
                color: #e5a00d;
                /* Same easing used across the plugin */
                transition: background 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                            border-color 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                            box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                            transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                /* Same blur depth as the fallback container */
                backdrop-filter: blur(40px) saturate(1.8);
                z-index: 100; flex-shrink: 0;
                /* JS sets top/right via elementFromPoint measurement */
                /* Positioned precisely next to the native Stremio green toggle */
                position: absolute;
                top: 24px;
                right: 80px;
                /* Glow-only pulse — no transform, only box-shadow changes */
                animation: dePulseGear 3.5s infinite ease-in-out;
            }
            @keyframes dePulseGear {
                0%   { box-shadow: 0 0 6px rgba(229,160,13,0.12), 0 2px 8px rgba(0,0,0,0.3); }
                50%  { box-shadow: 0 0 18px rgba(229,160,13,0.35), 0 2px 8px rgba(0,0,0,0.3); }
                100% { box-shadow: 0 0 6px rgba(229,160,13,0.12), 0 2px 8px rgba(0,0,0,0.3); }
            }
            .de-gear-btn svg {
                width: 16px; height: 16px;
                transition: transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
            }
            .de-gear-btn:hover {
                background: rgba(229,160,13,0.15);
                border-color: #e5a00d;
                color: #ffb82b;
                box-shadow: 0 0 22px rgba(229,160,13,0.4), 0 2px 12px rgba(0,0,0,0.4);
            }
            .de-gear-btn:hover svg { transform: rotate(180deg) scale(1.1); }
            /* Active: filled amber — pops crisply */
            .de-gear-btn.active {
                background: rgba(229,160,13,0.35);
                border-color: #e5a00d;
                color: #fff;
                box-shadow: 0 0 28px rgba(229,160,13,0.5), 0 0 12px rgba(255,255,255,0.2) inset;
            }
            .de-gear-btn.active svg { transform: rotate(180deg) scale(1.1); }

            /* PANEL WRAPPER */
            .de-panel-wrapper { 
                width: 100%; transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
                overflow: hidden; max-height: 800px; opacity: 1; margin-top: 15px;
            }
            .de-panel-wrapper.de-collapsed { max-height: 0; opacity: 0; margin-top: 0; pointer-events: none; }

            /* FALLBACK CONTAINER */
            .de-fallback-container {
                margin: 20px 10px; padding: 24px;
                background: linear-gradient(135deg, rgba(25,25,30,0.8) 0%, rgba(15,15,20,0.6) 100%);
                border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(40px) saturate(1.8);
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                animation: deSlideDown 0.5s cubic-bezier(0.22, 1, 0.36, 1);
            }
            @keyframes deSlideDown { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            
            .de-fallback-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 15px; }
            .de-fallback-badge { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: #e5a00d; border: 1px solid rgba(229,160,13,0.5); padding: 4px 10px; border-radius: 6px; background: rgba(229,160,13,0.05); }

            /* COMMON CONTENT */
            .de-panel-content {
                background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
                border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 24px;
            }
            .de-opt-group { margin-bottom: 5px; }
            .de-opt-label { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; }

            .de-api-row { display: flex; gap: 12px; margin-top: 10px; }
            .de-api-input {
                flex: 1; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1);
                color: #fff; padding: 12px 16px; border-radius: 10px; font-size: 14px; outline: none; transition: all 0.3s;
            }
            .de-api-input:focus { border-color: #e5a00d; background: rgba(0,0,0,0.5); box-shadow: 0 0 0 3px rgba(229,160,13,0.1); }
            .de-api-save {
                background: #e5a00d; color: #000; border: none; padding: 0 24px;
                border-radius: 10px; font-weight: 700; cursor: pointer; transition: all 0.3s;
            }
            .de-api-save:hover { transform: translateY(-1px); box-shadow: 0 5px 15px rgba(229,160,13,0.3); }
            .de-api-save.success { background: #32d74b; color: #fff; }

            .de-region-select {
                background: rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,.1);
                color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 14px;
                outline: none; transition: all 0.3s; cursor: pointer;
                margin-top: 8px; width: 100%;
            }
            .de-region-select:focus { border-color: #e5a00d; box-shadow: 0 0 0 3px rgba(229,160,13,.1); }
            .de-region-select option { background: #1a1a2a; color: #fff; }

            .de-toggles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
            .de-toggle-item {
                background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.05);
                border-radius: 12px; padding: 15px; display: flex; align-items: center; justify-content: space-between;
                animation: deFadeUp 0.5s ease forwards; animation-delay: calc(var(--i) * 0.05s); opacity: 0;
            }
            @keyframes deFadeUp { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
            
            .de-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff4444; box-shadow: 0 0 10px rgba(255,68,68,0.5); }
            .de-status-dot.active { background: #00ff88; box-shadow: 0 0 10px rgba(0,255,136,0.5); }
            
            .de-toggle-info { display: flex; align-items: center; gap: 12px; }
            .de-toggle-icon { font-size: 18px; filter: drop-shadow(0 0 5px rgba(255,255,255,0.2)); }
            .de-toggle-text { font-size: 14px; font-weight: 500; color: rgba(255,255,255,0.9); }

            /* SWITCH */
            .de-switch { position: relative; width: 44px; height: 24px; }
            .de-switch input { opacity: 0; width: 0; height: 0; }
            .de-slider { position: absolute; cursor: pointer; inset: 0; background: rgba(255,255,255,0.1); border-radius: 24px; transition: .4s; }
            .de-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: .4s; }
            .de-switch input:checked + .de-slider { background: #e5a00d; }
            .de-switch input:checked + .de-slider:before { transform: translateX(20px); }
        `;
    document.head.appendChild(style);
  }

  destroy() {
    if (this.observer) this.observer.disconnect();
    if (this.settingsObserver) this.settingsObserver.disconnect();
  }
}

// Initialize
if (document.body) {
  new DataEnrichment();
} else {
  const wait = () =>
    document.body ? new DataEnrichment() : setTimeout(wait, 50);
  wait();
}
