/**
 * Preload: wrap Playwright launchPersistentContext with stealth.js
 * Usage: node -r /opt/browser/stealth-preload.js /opt/browser/daemon.js
 * Or: NODE_OPTIONS='--require /opt/browser/stealth-preload.js'
 */
"use strict";
const stealth = require("./stealth.js");
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const mod = origRequire.apply(this, arguments);
  if (id === "playwright" || id === "playwright-core") {
    if (mod.__manziStealthPatched) return mod;
    const chromium = mod.chromium;
    if (!chromium || typeof chromium.launchPersistentContext !== "function") return mod;
    const orig = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async function (userDataDir, options = {}) {
      const { opts, stealth: steOn, locale, timezoneId, chromeVersion } =
        stealth.persistentLaunchOptions();
      const merged = { ...options, ...opts, acceptDownloads: options.acceptDownloads !== false };
      // Prefer caller locale/tz if already set and stealth off
      if (!steOn) return orig(userDataDir, options);
      const ctx = await orig(userDataDir, merged);
      try {
        const src = stealth.initScriptSource({
          locale: locale || merged.locale,
          timezoneId: timezoneId || merged.timezoneId,
        });
        if (src) await ctx.addInitScript(src);
      } catch (e) {
        console.error("stealth initScript:", String(e).slice(0, 200));
      }
      console.log("stealth-preload:", JSON.stringify({ stealth: steOn, locale, timezoneId, chromeVersion }));
      return ctx;
    };
    mod.__manziStealthPatched = true;
  }
  return mod;
};
