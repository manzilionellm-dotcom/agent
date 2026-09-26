/**
 * Stealth patches for sandbox Chromium (Playwright persistent context).
 * Goal: reduce obvious automation fingerprints for legitimate research / soft-sell browsing.
 * Not a captcha farm, not credential stuffing. Real Chrome via BROWSER_CDP_URL remains best.
 *
 * BROWSER_STEALTH=false disables init-script patches (launch flags for locale/tz/viewport still apply).
 */
"use strict";

const CHROME_MAJOR = "140";
const CHROME_FULL = "140.0.7339.16"; // matches playwright@1.55 Chromium

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

/** @param {string} [seed] */
function pickViewport(seed) {
  const i = seed
    ? Math.abs([...seed].reduce((a, c) => a + c.charCodeAt(0), 0)) % VIEWPORTS.length
    : Math.floor(Math.random() * VIEWPORTS.length);
  return VIEWPORTS[i];
}

/**
 * @param {string} locale e.g. sv-SE, fr-FR, fr-CA, en-CA
 */
function languagesFor(locale) {
  const primary = (locale || "sv-SE").replace("_", "-");
  const lang = primary.split("-")[0];
  if (primary === "fr-CA") return ["fr-CA", "fr", "en-CA", "en"];
  if (primary === "en-CA") return ["en-CA", "en", "fr-CA", "fr"];
  if (lang === "sv") return ["sv-SE", "sv", "en-US", "en"];
  if (lang === "fr") return ["fr-FR", "fr", "en-US", "en"];
  return [primary, lang, "en-US", "en"];
}

/**
 * Linux desktop UA matching bundled Chromium major.
 * @param {string} [platform]
 */
function userAgent(platform = "linux") {
  if (platform === "mac") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
  }
  if (platform === "win") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
}

/**
 * Init script applied to every new document (context.addInitScript).
 * Mild fingerprints only — no captcha bypass.
 */
function initScriptSource(opts) {
  const languages = JSON.stringify(opts.languages);
  const platform = JSON.stringify(opts.platform || "Linux x86_64");
  const hw = opts.hardwareConcurrency || 8;
  const mem = opts.deviceMemory || 8;
  const vendor = JSON.stringify(opts.webglVendor || "Google Inc. (Intel)");
  const renderer = JSON.stringify(
    opts.webglRenderer || "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (UHD Graphics 620), OpenGL 4.5)",
  );
  return `(() => {
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) {}

  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function () {},
        sendMessage: function () {},
        id: undefined,
      };
    }
  } catch (_) {}

  try {
    Object.defineProperty(navigator, "languages", {
      get: () => Object.freeze(${languages}),
      configurable: true,
    });
    Object.defineProperty(navigator, "language", {
      get: () => ${languages}[0],
      configurable: true,
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, "platform", {
      get: () => ${platform},
      configurable: true,
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: () => ${hw},
      configurable: true,
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, "deviceMemory", {
      get: () => ${mem},
      configurable: true,
    });
  } catch (_) {}

  try {
    const orig = Permissions.prototype.query;
    Permissions.prototype.query = function (desc) {
      if (desc && desc.name === "notifications") {
        return Promise.resolve({ state: Notification.permission || "default", onchange: null });
      }
      return orig.apply(this, arguments);
    };
  } catch (_) {}

  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return ${vendor};
      if (param === 37446) return ${renderer};
      return getParam.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== "undefined") {
      const getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return ${vendor};
        if (param === 37446) return ${renderer};
        return getParam2.apply(this, arguments);
      };
    }
  } catch (_) {}
})();`;
}

function envFlag(name, defaultTrue = true) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultTrue;
  return !/^(0|false|no|off)$/i.test(v);
}

function resolveLocale() {
  return process.env.BROWSER_LOCALE || "sv-SE";
}

function resolveTimezone() {
  return process.env.BROWSER_TIMEZONE || "Europe/Stockholm";
}

/**
 * Launch options for chromium.launchPersistentContext (sandbox mode).
 */
function persistentLaunchOptions() {
  const stealth = envFlag("BROWSER_STEALTH", true);
  const locale = resolveLocale();
  const timezoneId = resolveTimezone();
  const languages = languagesFor(locale);
  const viewport = pickViewport(process.env.BROWSER_VIEWPORT_SEED || undefined);
  const ua = userAgent(process.env.BROWSER_UA_PLATFORM || "linux");

  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (stealth) {
    args.push("--disable-blink-features=AutomationControlled");
  }

  /** @type {import('playwright').LaunchPersistentContextOptions} */
  const opts = {
    headless: true,
    viewport,
    locale,
    timezoneId,
    userAgent: ua,
    args,
    ignoreDefaultArgs: stealth ? ["--enable-automation"] : [],
    extraHTTPHeaders: {
      "Accept-Language": languages
        .map((l, i) => (i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`))
        .join(","),
    },
  };

  return { opts, stealth, locale, timezoneId, languages, viewport, chromeVersion: CHROME_FULL };
}

/**
 * Slightly randomized human-like settle delay (ms).
 * @param {number} [base]
 * @param {number} [jitter]
 */
function settleMs(base = 800, jitter = 250) {
  const j = Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
  return Math.max(200, base + j);
}

module.exports = {
  CHROME_FULL,
  CHROME_MAJOR,
  initScriptSource,
  persistentLaunchOptions,
  settleMs,
  envFlag,
  resolveLocale,
  resolveTimezone,
  languagesFor,
  userAgent,
  pickViewport,
};
