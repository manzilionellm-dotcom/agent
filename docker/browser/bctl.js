#!/usr/bin/env node
/**
 * Client du démon navigateur : `bctl <action> '<json args>'`.
 * Démarre le démon s'il ne tourne pas (détaché), attend qu'il réponde, envoie la commande,
 * imprime la réponse JSON sur stdout. Utilisé par l'outil `browser` de l'orchestrateur.
 *
 * Les variables BROWSER_* (CDP_URL, STEALTH, LOCALE, TIMEZONE…) doivent être dans
 * process.env au démarrage du démon (passées par docker exec -e depuis browser.ts).
 */
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const PORT = 9333;
const [action, rawArgs] = process.argv.slice(2);
if (!action) { console.error("usage: bctl <action> [json]"); process.exit(2); }
const args = rawArgs ? JSON.parse(rawArgs) : {};

function post(payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/", timeout: 120_000 }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(JSON.stringify(payload));
  });
}

async function ensureDaemon() {
  try { await post({ action: "status" }); return; } catch {}
  const log = fs.openSync("/work/browser-daemon.log", "a");
  const child = spawn(process.execPath, [__dirname + "/daemon.js"], { detached: true, stdio: ["ignore", log, log], env: process.env, cwd: "/work" });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await post({ action: "status" }); return; } catch {}
  }
  throw new Error("le démon navigateur ne démarre pas (voir /work/browser-daemon.log)");
}

ensureDaemon()
  .then(() => post({ action, args }))
  .then((out) => { process.stdout.write(out); })
  .catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); });
