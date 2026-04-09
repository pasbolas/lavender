(function () {
  const STORAGE_KEY = "guardEnabled";
  const WRAP_CLASS = "lavendar-guard-wrap";
  const COVER_CLASS = "lavendar-guard-cover";
  const REASON_CLASS = "lavendar-guard-reason";
  const WARNING_PATTERN = /\b(flash|flashing|strobe|blink|blinking|flicker|rapid|fast|intense)\b/i;
  const SAFE_PATTERN = /\b(calm|calmer|slow|static|normal|safe|control)\b/i;
  const SCAN_SELECTOR = [
    "img",
    "video",
    "iframe",
    "[class*='flash' i]",
    "[class*='blink' i]",
    "[class*='flicker' i]",
    "[class*='strobe' i]",
    "[aria-label*='flash' i]",
    "[aria-label*='blink' i]",
    "[aria-label*='flicker' i]",
    "[id*='flash' i]",
    "[id*='blink' i]"
  ].join(", ");

  const flaggedNodes = new WeakMap();
  const videoStates = new WeakMap();
  const trackedVideoStates = new Set();
  let extensionEnabled = true;
  let scanQueued = false;
  let booted = false;
  let pageObserver = null;
  let scanIntervalId = 0;

  function initialize() {
    chrome.storage.onChanged.addListener(handleStorageChange);
    readEnabledState((enabled) => {
      setExtensionEnabled(enabled);
    });
  }

  function readEnabledState(callback) {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      if (chrome.runtime.lastError) {
        callback(true);
        return;
      }

      callback(result[STORAGE_KEY] !== false);
    });
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    setExtensionEnabled(changes[STORAGE_KEY].newValue !== false);
  }

  function setExtensionEnabled(nextEnabled) {
    extensionEnabled = nextEnabled;

    if (extensionEnabled) {
      activateGuard();
      return;
    }

    deactivateGuard();
  }

  function activateGuard() {
    if (booted) {
      scanDocument();
      return;
    }

    booted = true;
    scanDocument();
    watchPage();
    window.addEventListener("resize", scheduleScan);
    window.addEventListener("scroll", scheduleScan, { passive: true });
    scanIntervalId = window.setInterval(scanDocument, 2500);
  }

  function deactivateGuard() {
    if (!booted) {
      removeAllCovers();
      return;
    }

    booted = false;
    scanQueued = false;

    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }

    window.removeEventListener("resize", scheduleScan);
    window.removeEventListener("scroll", scheduleScan);

    if (scanIntervalId) {
      window.clearInterval(scanIntervalId);
      scanIntervalId = 0;
    }

    for (const state of trackedVideoStates) {
      if (state.intervalId) {
        window.clearInterval(state.intervalId);
        state.intervalId = 0;
      }

      state.started = false;
      state.reason = "";
      state.level = "";
      state.recentSamples = [];
      state.previousPixels = null;
      state.previousBrightness = 0;
      state.previousSaturation = 0;
      state.lastSampleAt = 0;
    }

    removeAllCovers();
  }

  function watchPage() {
    pageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          scheduleScan();
          return;
        }

        if (mutation.type === "attributes") {
          scheduleScan();
          return;
        }
      }
    });

    pageObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "src", "srcset", "title", "alt", "aria-label"]
    });
  }

  function scheduleScan() {
    if (!extensionEnabled || scanQueued) {
      return;
    }

    scanQueued = true;
    window.requestAnimationFrame(() => {
      scanQueued = false;

      if (!extensionEnabled) {
        return;
      }

      scanDocument();
    });
  }

  function scanDocument() {
    if (!extensionEnabled) {
      return;
    }

    const candidates = new Set(document.querySelectorAll(SCAN_SELECTOR));

    for (const node of candidates) {
      if (!(node instanceof Element) || isExtensionUi(node) || !isVisiblyRendered(node)) {
        continue;
      }

      const reason = getWarningReason(node);
      if (reason) {
        applyCover(node, reason);
      } else if (flaggedNodes.get(node)) {
        removeCover(node);
      }
    }
  }

  function isExtensionUi(node) {
    return node.classList.contains(WRAP_CLASS) || node.classList.contains(COVER_CLASS);
  }

  function isVisiblyRendered(node) {
    if (!node.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return true;
  }

  function getWarningReason(node) {
    const context = describeNode(node);

    if (node instanceof HTMLVideoElement) {
      return inspectVideo(node, context);
    }

    if (node instanceof HTMLImageElement) {
      return inspectImage(node, context) || inspectAnimation(node, context);
    }

    if (node instanceof HTMLIFrameElement) {
      return inspectIframe(node, context);
    }

    return inspectAnimation(node, context) || inspectNamedElement(context);
  }

  function inspectVideo(video, context) {
    const state = ensureVideoState(video);

    if (context.warning && video.autoplay && video.loop) {
      return "Autoplaying video with strong flashing or motion cues.";
    }

    if (context.safe) {
      return state.reason.startsWith("Rapid flashing") ? state.reason : "";
    }

    return state.reason;
  }

  function inspectImage(image, context) {
    if (!isAnimatedImage(image)) {
      return "";
    }

    if (context.safe) {
      return "";
    }

    if (context.warning) {
      return "Animated image with flashing cues.";
    }

    return "";
  }

  function inspectIframe(frame, context) {
    const source = frame.src.toLowerCase();
    if (!source.includes("giphy.com/embed")) {
      return "";
    }

    if (context.safe) {
      return "";
    }

    if (context.warning) {
      return "Embedded animation with flashing cues.";
    }

    return "";
  }

  function inspectAnimation(node, context) {
    if (!(node instanceof Element)) {
      return "";
    }

    if (context.safe) {
      return "";
    }

    const style = window.getComputedStyle(node);
    const animationName = (style.animationName || "").toLowerCase();
    const duration = getShortestDuration(style.animationDuration || "");
    const iterationCount = firstValue(style.animationIterationCount || "");
    const timingFunction = (style.animationTimingFunction || "").toLowerCase();
    const infiniteLoop = iterationCount === "infinite";
    const abruptTiming = timingFunction.includes("steps") || WARNING_PATTERN.test(animationName);

    if (!duration || animationName === "none") {
      return "";
    }

    if (infiniteLoop && duration <= 0.45) {
      return "Rapid looping animation detected.";
    }

    if (abruptTiming && duration <= 0.7) {
      return "Abrupt flashing animation detected.";
    }

    if (context.warning && duration <= 0.8) {
      return "Fast animated content with flashing cues.";
    }

    return "";
  }

  function inspectNamedElement(context) {
    if (context.safe) {
      return "";
    }

    if (context.warning) {
      return "Flashing content cues detected.";
    }

    return "";
  }

  function describeNode(node) {
    const heading = findHeading(node);
    const warningText = [
      node.id,
      node.getAttribute("class"),
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("alt"),
      node.getAttribute("data-testid"),
      node instanceof HTMLImageElement ? node.currentSrc || node.src : "",
      node instanceof HTMLIFrameElement ? node.src : "",
      heading
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const safeText = [
      node.id,
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("alt"),
      node.getAttribute("data-testid"),
      heading
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return {
      text: warningText,
      safe: SAFE_PATTERN.test(safeText),
      warning: WARNING_PATTERN.test(warningText)
    };
  }

  function findHeading(node) {
    const container = node.closest(".card, .feed-item, article, section, figure");
    if (!container) {
      return "";
    }

    const heading = container.querySelector("h1, h2, h3, h4, h5, h6");
    return heading ? heading.textContent.trim() : "";
  }

  function isAnimatedImage(image) {
    const source = (image.currentSrc || image.src || "").toLowerCase();
    return /\.(gif|apng|webp)(\?|#|$)/.test(source) || source.includes("/giphy.gif");
  }

  function getShortestDuration(rawValue) {
    const values = rawValue
      .split(",")
      .map((value) => parseDuration(value.trim()))
      .filter((value) => value > 0);

    if (values.length === 0) {
      return 0;
    }

    return Math.min(...values);
  }

  function parseDuration(rawValue) {
    if (!rawValue) {
      return 0;
    }

    const amount = Number.parseFloat(rawValue);
    if (Number.isNaN(amount)) {
      return 0;
    }

    if (rawValue.endsWith("ms")) {
      return amount / 1000;
    }

    return amount;
  }

  function firstValue(rawValue) {
    return rawValue.split(",")[0].trim().toLowerCase();
  }

  function ensureVideoState(video) {
    let state = videoStates.get(video);

    if (state) {
      return state;
    }

    state = {
      canvas: document.createElement("canvas"),
      context: null,
      previousPixels: null,
      previousBrightness: 0,
      previousSaturation: 0,
      recentSamples: [],
      reason: "",
      level: "",
      started: false,
      lastSampleAt: 0,
      intervalId: 0
    };
    state.context = state.canvas.getContext("2d", { willReadFrequently: true });
    videoStates.set(video, state);
    trackedVideoStates.add(state);

    const start = () => startVideoSampling(video, state);
    if (video.readyState >= 2) {
      start();
    } else {
      video.addEventListener("loadeddata", start, { once: true });
    }
    video.addEventListener("play", start);

    return state;
  }

  function startVideoSampling(video, state) {
    if (!extensionEnabled || state.started || !state.context) {
      return;
    }

    state.started = true;

    if (typeof video.requestVideoFrameCallback === "function") {
      const sampleFrame = () => {
        if (!extensionEnabled || !video.isConnected) {
          state.started = false;
          return;
        }

        sampleVideo(video, state);
        video.requestVideoFrameCallback(sampleFrame);
      };

      video.requestVideoFrameCallback(sampleFrame);
      return;
    }

    state.intervalId = window.setInterval(() => {
      if (!extensionEnabled || !video.isConnected) {
        window.clearInterval(state.intervalId);
        state.intervalId = 0;
        state.started = false;
        return;
      }

      sampleVideo(video, state);
    }, 180);
  }

  function sampleVideo(video, state) {
    if (!state.context || video.videoWidth < 16 || video.videoHeight < 16) {
      return;
    }

    const now = performance.now();
    if (now - state.lastSampleAt < 160) {
      return;
    }

    state.lastSampleAt = now;

    const sampleWidth = 48;
    const sampleHeight = Math.max(27, Math.round((sampleWidth * video.videoHeight) / video.videoWidth));
    state.canvas.width = sampleWidth;
    state.canvas.height = sampleHeight;

    try {
      state.context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    } catch (error) {
      return;
    }

    const imageData = state.context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const stats = measureVideoSample(imageData, state.previousPixels, state.previousBrightness, state.previousSaturation);

    state.previousPixels = new Uint8ClampedArray(imageData);
    state.previousBrightness = stats.brightness;
    state.previousSaturation = stats.saturation;

    if (!stats.hasBaseline) {
      return;
    }

    state.recentSamples.push(stats);
    if (state.recentSamples.length > 8) {
      state.recentSamples.shift();
    }

    const nextRisk = classifyVideoRisk(state.recentSamples);
    if (nextRisk.reason !== state.reason || nextRisk.level !== state.level) {
      state.reason = nextRisk.reason;
      state.level = nextRisk.level;
      scheduleScan();
    }
  }

  function measureVideoSample(imageData, previousPixels, previousBrightness, previousSaturation) {
    let brightnessTotal = 0;
    let saturationTotal = 0;
    let diffTotal = 0;
    let peakPixelDelta = 0;
    let pixelCount = 0;

    for (let index = 0; index < imageData.length; index += 4) {
      const red = imageData[index];
      const green = imageData[index + 1];
      const blue = imageData[index + 2];
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const brightness = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      const saturation = (maxChannel - minChannel) / 255;

      brightnessTotal += brightness;
      saturationTotal += saturation;
      pixelCount += 1;

      if (previousPixels) {
        const previousRed = previousPixels[index];
        const previousGreen = previousPixels[index + 1];
        const previousBlue = previousPixels[index + 2];
        const pixelDelta =
          (Math.abs(red - previousRed) + Math.abs(green - previousGreen) + Math.abs(blue - previousBlue)) /
          (3 * 255);

        diffTotal += pixelDelta;
        if (pixelDelta > peakPixelDelta) {
          peakPixelDelta = pixelDelta;
        }
      }
    }

    const brightness = pixelCount ? brightnessTotal / pixelCount : 0;
    const saturation = pixelCount ? saturationTotal / pixelCount : 0;
    const motion = previousPixels && pixelCount ? diffTotal / pixelCount : 0;
    const brightnessDelta = previousPixels ? Math.abs(brightness - previousBrightness) : 0;
    const saturationDelta = previousPixels ? Math.abs(saturation - previousSaturation) : 0;
    const composite = (motion * 0.88) + (brightnessDelta * 0.78) + (saturationDelta * 0.54) + (peakPixelDelta * 0.2);

    return {
      brightness,
      saturation,
      motion,
      brightnessDelta,
      saturationDelta,
      composite,
      hasBaseline: Boolean(previousPixels)
    };
  }

  function classifyVideoRisk(samples) {
    if (samples.length < 3) {
      return { reason: "", level: "" };
    }

    const strongHits = samples.filter((sample) => {
      return sample.motion >= 0.16 || sample.brightnessDelta >= 0.17 || sample.composite >= 0.19;
    }).length;

    const mediumHits = samples.filter((sample) => {
      return sample.motion >= 0.11 || sample.brightnessDelta >= 0.11 || sample.composite >= 0.14;
    }).length;

    const flashingHits = samples.filter((sample) => sample.brightnessDelta >= 0.14 || sample.saturationDelta >= 0.16).length;

    if (strongHits >= 2 || flashingHits >= 3) {
      return {
        reason: flashingHits >= 3 ? "Rapid flashing video detected." : "High-intensity motion video detected.",
        level: "strong"
      };
    }

    if (mediumHits >= 4) {
      return {
        reason: "Intense motion video detected.",
        level: "moderate"
      };
    }

    return { reason: "", level: "" };
  }

  function applyCover(node, reason) {
    const wrapper = ensureWrapped(node);
    syncWrapperLayout(node, wrapper);
    let cover = wrapper.querySelector(`:scope > .${COVER_CLASS}`);

    if (!cover) {
      cover = document.createElement("div");
      cover.className = COVER_CLASS;
      cover.innerHTML = `<p class="${REASON_CLASS}" data-role="reason"></p>`;
      wrapper.appendChild(cover);
    }

    const reasonNode = cover.querySelector("[data-role='reason']");
    if (reasonNode) {
      reasonNode.textContent = reason;
    }

    flaggedNodes.set(node, reason);
  }

  function removeCover(node) {
    const wrapper = node.parentElement;
    if (!wrapper || !wrapper.classList.contains(WRAP_CLASS)) {
      flaggedNodes.delete(node);
      return;
    }

    const cover = wrapper.querySelector(`:scope > .${COVER_CLASS}`);
    if (cover) {
      cover.remove();
    }

    flaggedNodes.delete(node);

    if (wrapper.childElementCount === 1 && wrapper.firstElementChild === node) {
      unwrapNode(node, wrapper);
    }
  }

  function removeAllCovers() {
    const wrappers = Array.from(document.querySelectorAll(`.${WRAP_CLASS}`));
    for (const wrapper of wrappers) {
      const node = wrapper.firstElementChild;
      const cover = wrapper.querySelector(`:scope > .${COVER_CLASS}`);

      if (cover) {
        cover.remove();
      }

      if (node && wrapper.childElementCount === 1) {
        unwrapNode(node, wrapper);
      }
    }
  }

  function ensureWrapped(node) {
    const parent = node.parentElement;
    if (parent && parent.classList.contains(WRAP_CLASS)) {
      return parent;
    }

    const wrapper = document.createElement("div");
    wrapper.className = WRAP_CLASS;
    syncWrapperLayout(node, wrapper);

    if (parent) {
      parent.insertBefore(wrapper, node);
    }

    wrapper.appendChild(node);
    return wrapper;
  }

  function unwrapNode(node, wrapper) {
    const parent = wrapper.parentElement;
    if (!parent) {
      return;
    }

    parent.insertBefore(node, wrapper);
    wrapper.remove();
  }

  function syncWrapperLayout(node, wrapper) {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const isBlockLike = ["block", "flex", "grid", "table", "list-item"].includes(style.display);

    wrapper.style.display = isBlockLike ? "block" : "inline-block";
    wrapper.style.verticalAlign = style.verticalAlign;

    if (rect.width > 0) {
      wrapper.style.width = `${Math.round(rect.width)}px`;
    }

    wrapper.style.borderRadius = style.borderRadius && style.borderRadius !== "0px" ? style.borderRadius : "18px";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
