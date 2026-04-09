(function () {
  const WRAP_CLASS = "lavendar-epilepsy-wrap";
  const BANNER_CLASS = "lavendar-epilepsy-banner";
  const OUTLINE_CLASS = "lavendar-epilepsy-outline";
  const flaggedNodes = new WeakMap();

  function boot() {
    scanDocument();
    watchPage();
    window.addEventListener("scroll", scheduleScan, { passive: true });
    window.addEventListener("resize", scheduleScan);
    setInterval(scanDocument, 4000);
  }

  let scanQueued = false;

  function scheduleScan() {
    if (scanQueued) {
      return;
    }

    scanQueued = true;
    window.requestAnimationFrame(() => {
      scanQueued = false;
      scanDocument();
    });
  }

  function watchPage() {
    const observer = new MutationObserver((mutations) => {
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

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", "class", "autoplay", "loop"]
    });
  }

  function scanDocument() {
    const candidates = document.querySelectorAll("img, video, canvas, svg, [style*='animation'], [class*='flash'], [class*='blink']");

    for (const node of candidates) {
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
        continue;
      }

      if (isInsideExtensionUi(node)) {
        continue;
      }

      const warning = getWarningReason(node);
      const knownWarning = flaggedNodes.get(node);

      if (warning) {
        if (knownWarning !== warning) {
          addBanner(node, warning);
        }
      } else if (knownWarning) {
        removeBanner(node);
      }
    }
  }

  function isInsideExtensionUi(node) {
    const parent = node.parentElement;
    return Boolean(
      node.classList?.contains(BANNER_CLASS) ||
      node.classList?.contains(WRAP_CLASS) ||
      parent?.classList?.contains(WRAP_CLASS)
    );
  }

  function getWarningReason(node) {
    if (node instanceof HTMLVideoElement) {
      return inspectVideo(node);
    }

    if (node instanceof HTMLImageElement) {
      return inspectImage(node) || inspectAnimation(node);
    }

    if (node instanceof HTMLCanvasElement || node instanceof SVGElement) {
      return inspectAnimation(node) || inspectByName(node);
    }

    return inspectAnimation(node) || inspectByName(node);
  }

  function inspectVideo(video) {
    const hints = [];

    if (video.autoplay) {
      hints.push("autoplay video");
    }

    if (video.loop) {
      hints.push("looping playback");
    }

    if (!video.paused && video.playbackRate > 1.25) {
      hints.push("fast playback");
    }

    const nameHint = inspectByName(video);
    if (nameHint) {
      hints.push(nameHint);
    }

    if (hints.length === 0) {
      return "";
    }

    return `Possible trigger detected: ${hints.join(", ")}.`;
  }

  function inspectImage(image) {
    const src = [image.currentSrc, image.src, image.alt].join(" ").toLowerCase();

    if (/\.(gif|apng|webp)(\?|$)/.test(src)) {
      return "Possible trigger detected: animated image.";
    }

    if (/(flash|strobe|blink|flicker|rapid)/.test(src)) {
      return "Possible trigger detected: flashing image cue.";
    }

    return "";
  }

  function inspectAnimation(node) {
    if (!(node instanceof Element)) {
      return "";
    }

    const style = window.getComputedStyle(node);
    const animationName = style.animationName || "";
    const animationDuration = parseTimeValue(style.animationDuration);
    const iterationCount = style.animationIterationCount || "";

    if (animationName !== "none" && animationDuration > 0) {
      const infiniteLoop = iterationCount === "infinite";
      const rapidLoop = animationDuration <= 1.2;

      if (infiniteLoop && rapidLoop) {
        return "Possible trigger detected: rapid looping animation.";
      }

      if (rapidLoop) {
        return "Possible trigger detected: fast animation.";
      }
    }

    return "";
  }

  function inspectByName(node) {
    const text = [
      node.id,
      node.className,
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("data-testid")
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (/(flash|strobe|blink|flicker|rapid)/.test(text)) {
      return "flashing content cue";
    }

    return "";
  }

  function parseTimeValue(rawValue) {
    if (!rawValue) {
      return 0;
    }

    const firstValue = rawValue.split(",")[0].trim();
    const amount = Number.parseFloat(firstValue);

    if (Number.isNaN(amount)) {
      return 0;
    }

    if (firstValue.endsWith("ms")) {
      return amount / 1000;
    }

    return amount;
  }

  function addBanner(node, warning) {
    removeBanner(node);

    const wrapper = ensureWrapped(node);
    const banner = document.createElement("div");
    banner.className = BANNER_CLASS;
    banner.innerHTML = `<strong>Epilepsy warning</strong>${escapeHtml(warning)}`;

    wrapper.classList.add(OUTLINE_CLASS);
    wrapper.appendChild(banner);
    flaggedNodes.set(node, warning);
  }

  function removeBanner(node) {
    const wrapper = node.parentElement;

    if (!wrapper || !wrapper.classList.contains(WRAP_CLASS)) {
      flaggedNodes.delete(node);
      return;
    }

    const banner = wrapper.querySelector(`:scope > .${BANNER_CLASS}`);
    if (banner) {
      banner.remove();
    }

    wrapper.classList.remove(OUTLINE_CLASS);
    flaggedNodes.delete(node);

    if (wrapper.childElementCount === 1 && wrapper.firstElementChild === node) {
      unwrapNode(node, wrapper);
    }
  }

  function ensureWrapped(node) {
    const parent = node.parentElement;

    if (parent && parent.classList.contains(WRAP_CLASS)) {
      return parent;
    }

    const wrapper = document.createElement("div");
    wrapper.className = WRAP_CLASS;
    applyWrapperLayout(node, wrapper);

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

  function applyWrapperLayout(node, wrapper) {
    const display = window.getComputedStyle(node).display;

    if (display === "block" || display === "flex" || display === "grid" || display === "table") {
      wrapper.style.display = "block";
      const width = node.getBoundingClientRect().width || node.clientWidth;
      if (width > 0) {
        wrapper.style.width = `${width}px`;
      }
      return;
    }

    wrapper.style.display = "inline-block";
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
