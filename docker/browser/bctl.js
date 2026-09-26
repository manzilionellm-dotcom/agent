#!/usr/bin/env node
/**
 * Client du démon navigateur : `bctl <action> '<json args>'`.
 * Démarre le démon s'il ne tourne pas (détaché), attend qu'il réponde, envoie la commande,
 * imprime la réponse JSON sur stdout. Utilisé par l'outil `browser` de l'orchestrateur.
 *
 * Stealth : charge stealth-preload.js avant daemon.js (fingerprint + locale/tz).
 */
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const PORT = 9333;
const [action, rawArgs] = process.argv.slice(2);
if (!action) { console.error("usage: bctl <action> [json|-]"); process.exit(2); }

/**
 * `bctl <action> -` lit ses arguments sur l'entrée standard.
 *
 * Indispensable pour `login` : un mot de passe passé en argument serait
 * lisible par `ps aux` depuis le sandbox, et le sandbox exécute du code
 * proposé par un modèle. Sur stdin, il ne touche jamais le disque ni la
 * table des processus.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let b = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (b += d));
    process.stdin.on("end", () => resolve(b));
    process.stdin.on("error", reject);
  });
}

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
  // -r stealth-preload : patches Playwright avant que daemon.js ne le require
  const child = spawn(process.execPath, ["-r", __dirname + "/stealth-preload.js", __dirname + "/daemon.js"], { detached: true, stdio: ["ignore", log, log], env: process.env, cwd: "/work" });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await post({ action: "status" }); return; } catch {}
  }
  throw new Error("le démon navigateur ne démarre pas (voir /work/browser-daemon.log)");
}

(async () => {
  const args = rawArgs === "-" ? JSON.parse((await readStdin()) || "{}") : rawArgs ? JSON.parse(rawArgs) : {};
  await ensureDaemon();
  process.stdout.write(await post({ action, args }));
})().catch((e) => {
  // `e.message` seul : une erreur de JSON.parse recopie l'entrée dans son
  // message, et cette entrée contient parfois un mot de passe.
  const msg = action === "login" ? "échec de la connexion (détail masqué)" : String(e.message || e);
  process.stdout.write(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
});
