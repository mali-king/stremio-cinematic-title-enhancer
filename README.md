<div align="center">
  <h1>🍿 Cinematic Title Enhancer</h1>
  <p><strong>A custom Stremio plugin I built to make the details page look much better.</strong></p>
</div>

---

## 🌟 Overview

I created the **Cinematic Title Enhancer** because I wanted Stremio's title pages to feel a bit more premium, kind of like Plex or Apple TV. This script pulls extra data using the TMDB and OMDb APIs and injects a bunch of new UI elements right into the app—like dynamic blurred backdrops, better rating bars, horizontally scrolling cast lists, and photo galleries.

## ✨ Features

*   **🎬 Better Backdrops**
    It grabs high-res fanart and applies a nice multi-layered CSS blur and vignette to create a theater-like background.
*   **📊 Unified Ratings Bar**
    I got tired of seeing just one rating, so I built a pill-styled bar that shows:
    *   **TMDB Score** with rings and vote counts.
    *   **Audience Rating** with "Fresh" (🍅) or "Rotten" (💧) icons.
    *   **Box Office** info showing budget vs worldwide gross (for movies).
*   **👥 Cast & Crew Carousels**
    Instead of boring lists, you get a horizontal scrolling row for the cast with character names and actor photos. It also cleanly highlights the main crew members like Director and Writer.
*   **🔍 Extra Meta Info**
    *   **Where to Watch:** Shows streaming providers based on your region.
    *   **Recommendations:** Adds rows like "Because You're Watching" or "More By This Director".
    *   **Media Galleries:** View extra photos and trailers directly on the details page.

## 🚀 Installation

1. Find your Stremio installation's `plugins/` folder (e.g., `Application Support/stremio-enhanced/plugins`).
2. Drop the `data-enrichment.plugin.js` file into that directory.
3. Restart Stremio. The plugin will load automatically.
4. You can enter your TMDB and OMDb API keys right inside the Stremio settings menu, where I added a custom settings panel.
5. You can also toggle specific features on or off directly from those settings.

## 🤝 Contributing
Feel free to open issues or pull requests if you want to help improve the script!

## 📜 License
MIT

---
<div align="center">
  <i>Built by elmarco</i>
</div>
