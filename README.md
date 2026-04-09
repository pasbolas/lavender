# lavendar

Simple Chrome extension that watches page content in real time and adds a warning banner over media that may be risky for people with photosensitive epilepsy.

## Files

- `chrome-extension/manifest.json` - Chrome Manifest V3 entry point
- `chrome-extension/content.js` - live DOM watcher + simple risk heuristics
- `chrome-extension/content.css` - banner and outline styles

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-extension` folder from this repo

## What it checks

- autoplaying or looping videos
- animated image formats like GIF/APNG/WEBP
- very fast CSS animations
- media or elements with names that suggest flashing or strobing content

This is intentionally lightweight and heuristic-based, so it will not catch every harmful case and it may flag some safe content too.
