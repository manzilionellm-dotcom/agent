#!/usr/bin/env node
/**
 * Démon navigateur de Manzi Junior (tourne DANS le sandbox, sur 127.0.0.1:9333).
 *
 * Deux modes, dans cet ordre de préférence :
 *   - BROWSER_CDP_URL défini ET joignable → TON Chrome (Chrome DevTools Protocol) via
 *     tunnel SSH : toutes tes sessions connectées, exactement comme « Claude dans Chrome ».
 *   - sinon                               → Chromium persistant dans /work/browser-profile :
 *     les connexions faites une fois (cookies, localStorage) survivent entre missions.
 *
 * Le second n'est pas un mode dégradé, c'est le mode normal. Le premier dépend
 * d'un tunnel ouvert depuis le poste de l'opérateur, donc d'une machine
 * allumée : le jour où elle dort, échouer laisserait l'agent sans navigateur
 * du tout. On bascule, et `status` dit lequel tourne réellement.
 *
 * Un seul onglet actif à la fois par défaut (tabs: list/switch/new/close).
 * Auto-arrêt après 15 min sans commande. Le client est bctl.js.
 */
const http = require("node:http");
const fs = require("node:fs");
const dns = require("node:dns").promises;
const { chromium } = require("playwright");

const PORT = 9333;
const IDLE_MS = 15 * 60_000;
const PROFILE = "/work/browser-profile";
const SHOTS = "/work/browser-shots";
const DOWNLOADS = "/work/downloads";

let browser, context, page, idleTimer;

/** Mode réellement retenu au démarrage : "cdp" (Chrome de l'opérateur) ou "profile" (local). */
let mode = "profile";
/** Pourquoi le mode CDP a été abandonné, s'il l'a été. Remonté par `status`. */
let cdpError = null;

async function tryCdp() {
  let cdp = process.env.BROWSER_CDP_URL;
  if (!cdp) return false;
  try {
    // Chrome refuse un en-tête Host qui n'est ni une IP ni localhost : on résout le nom en IP.
    const u = new URL(cdp);
    if (!/^(\d+\.){3}\d+$|^localhost$|^\[/.test(u.hostname)) {
      const { address } = await dns.lookup(u.hostname);
      u.hostname = address;
      cdp = u.toString();
    }
    browser = await chromium.connectOverCDP(cdp, { timeout: 15_000 });
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages()[0] || (await context.newPage());
    mode = "cdp";
    return true;
  } catch (e) {
    // Le Chrome de l'opérateur passe par un tunnel depuis son poste : il est
    // absent dès que ce poste dort. Échouer ici rendait le navigateur mort
    // pour tout le monde, missions comprises, alors qu'un Chromium local
    // attend dans le conteneur. On bascule, et on dit pourquoi.
    cdpError = String(e).slice(0, 300);
    console.error("CDP injoignable, bascule sur le profil local :", cdpError);
    browser = undefined;
    return false;
  }
}

async function boot() {
  if (!(await tryCdp())) {
    mode = "profile";
    fs.mkdirSync(PROFILE, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      locale: "fr-FR",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    });
    page = context.pages()[0] || (await context.newPage());
    // Import optionnel de cookies exportés depuis ton navigateur (format Playwright/EditThisCookie).
    if (fs.existsSync("/work/cookies.json")) {
      try {
        const raw = JSON.parse(fs.readFileSync("/work/cookies.json", "utf8"));
        const cookies = (Array.isArray(raw) ? raw : raw.cookies || []).map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
          expires: c.expirationDate || c.expires || -1, httpOnly: !!c.httpOnly, secure: !!c.secure,
          sameSite: c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : "Lax",
        }));
        await context.addCookies(cookies);
        fs.renameSync("/work/cookies.json", "/work/cookies.imported.json");
      } catch (e) { console.error("cookies.json ignoré:", String(e)); }
    }
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  console.log(`navigateur prêt en mode ${mode}${cdpError ? " (CDP indisponible)" : ""}`);
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => { try { await (browser ? browser.close() : context.close()); } finally { process.exit(0); } }, IDLE_MS);
}

async function text(maxChars) {
  const snap = await page.locator("body").ariaSnapshot().catch(() => null);
  const body = snap || (await page.evaluate(() => document.body.innerText));
  return body.replace(/\n{3,}/g, "\n\n").slice(0, maxChars || 20_000);
}

/** Construit un localisateur dans un contexte donné (la page, ou une de ses iframes). */
function locatorIn(scope, a) {
  if (a.selector) return scope.locator(a.selector).first();
  if (a.text) return scope.getByText(a.text, { exact: !!a.exact }).first();
  if (a.role) return scope.getByRole(a.role, a.name ? { name: a.name } : {}).first();
  if (a.label) return scope.getByLabel(a.label).first();
  if (a.placeholder) return scope.getByPlaceholder(a.placeholder).first();
  throw new Error("cible requise : selector | text | role(+name) | label | placeholder");
}

/**
 * Trouve la cible dans la page OU dans une de ses iframes.
 *
 * Sans ça, un formulaire de paiement, un lecteur vidéo, un widget de chat ou
 * un bandeau de consentement sont invisibles : ils vivent dans une iframe, et
 * l'outil répondait « élément introuvable » devant un bouton parfaitement
 * visible à l'écran. C'est la panne la plus déroutante d'un agent navigateur,
 * parce que la capture d'écran, elle, montre le bouton.
 */
async function locator(a) {
  const direct = locatorIn(page, a);
  if (await direct.count().then((n) => n > 0).catch(() => false)) return direct;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const l = locatorIn(f, a);
      if (await l.count().then((n) => n > 0)) return l;
    } catch { /* une iframe peut disparaître pendant qu'on l'interroge */ }
  }
  return direct; // laisse Playwright produire son message d'erreur habituel
}

function decrireCible(a) {
  return a.selector ? `selector ${a.selector}` : a.text ? `texte « ${a.text} »` : a.role ? `role ${a.role}${a.name ? ` « ${a.name} »` : ""}` : a.label ? `label « ${a.label} »` : a.placeholder ? `placeholder « ${a.placeholder} »` : "cible";
}

/**
 * La cible, ou une erreur IMMÉDIATE et utile si elle n'existe pas.
 *
 * Avant, un sélecteur faux attendait 10 s (clic) ou 30 s (saisie) avant
 * « Timeout exceeded » : 33 échecs de ce genre le 25 septembre, soit des
 * minutes perdues par conversation et un message qui ne disait pas quoi
 * faire. On attend au plus 5 s qu'elle apparaisse (page qui charge), puis on
 * dit qu'elle n'existe pas, et comment trouver la bonne.
 */
async function cible(a) {
  const l = await locator(a);
  if (await l.count().then((n) => n > 0).catch(() => false)) return l;
  const vue = await l.waitFor({ state: "attached", timeout: 5_000 }).then(() => true).catch(() => false);
  if (!vue) throw new Error(`cible introuvable : ${decrireCible(a)}. Appelle text, links ou form pour voir ce qui est vraiment sur la page, puis vise un texte ou un label qui y figure.`);
  return l;
}

/** Une erreur qui veut dire « l'élément existe mais Playwright refuse de cliquer » (recouvert, hors écran, pas stable). */
const BLOQUE = /Timeout|intercepts pointer events|not visible|outside of the viewport|not stable|element is not enabled/i;

/**
 * Clic, avec repli. Un bandeau cookies, une bulle de chat ou une animation
 * recouvre souvent le bouton : Playwright attend alors qu'il soit « cliquable »
 * et abandonne. Le repli déclenche le clic dans la page (element.click()),
 * comme le ferait un script du site — l'élément reçoit le clic même recouvert.
 */
async function cliquer(l) {
  try {
    await l.click({ timeout: 6_000 });
    return "normal";
  } catch (e) {
    if (!BLOQUE.test(String(e))) throw e;
    await l.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    await l.evaluate((el) => el.click(), undefined, { timeout: 3_000 });
    return "dom";
  }
}

/**
 * Écrit une valeur dans un champ en passant par la page. Le « setter » natif
 * est nécessaire : React et Vue ignorent une valeur posée directement, et le
 * formulaire se soumet vide alors que le champ affiche le texte.
 */
function poserValeur(el, v) {
  el.focus();
  if (el.isContentEditable) {
    el.textContent = v;
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (set) set.call(el, v); else el.value = v;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Nom de fichier propre, avec l'extension déduite du type si l'adresse n'en a pas. */
function nomFichier(brut, type) {
  let nom = (brut || `fichier-${Date.now()}`).split(/[?#]/)[0].split("/").pop() || `fichier-${Date.now()}`;
  try { nom = decodeURIComponent(nom); } catch { /* garde tel quel */ }
  nom = nom.replace(/[^\w.\-]/g, "_").slice(-100);
  const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf", "text/csv": ".csv", "application/zip": ".zip" }[(type || "").split(";")[0].trim()];
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(nom)) nom += ext;
  return nom;
}

/**
 * Récupère un fichier par son adresse, avec les cookies du navigateur (une
 * photo derrière une connexion reste accessible). C'est le bon chemin pour
 * une IMAGE : ouvrir l'adresse d'une image l'affiche, ça ne « télécharge »
 * rien, et attendre un téléchargement tournait 60 s pour rien.
 */
async function recupererParAdresse(url) {
  if (/^(blob|data):/i.test(url)) {
    // Une adresse blob: n'existe que dans la page : c'est elle qui la lit.
    const r = await page.evaluate(async (u) => {
      const b = await (await fetch(u)).blob();
      if (b.size > 25 * 1024 * 1024) throw new Error(`fichier de ${b.size} octets : trop gros (25 Mo max)`);
      const buf = new Uint8Array(await b.arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { type: b.type, b64: btoa(s) };
    }, url);
    return { corps: Buffer.from(r.b64, "base64"), type: r.type, nom: nomFichier("", r.type) };
  }
  const r = await context.request.get(url, { timeout: 60_000, maxRedirects: 10 });
  if (!r.ok()) throw new Error(`HTTP ${r.status()} en récupérant ${url}`);
  const type = r.headers()["content-type"] || "";
  const dispo = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers()["content-disposition"] || "");
  return { corps: await r.body(), type, nom: nomFichier(dispo ? dispo[1] : url, type), html: /text\/html/i.test(type) };
}

function ranger(f) {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const dest = `${DOWNLOADS}/${Date.now()}-${f.nom}`;
  fs.writeFileSync(dest, f.corps);
  return dest;
}

/**
 * Exécute une action susceptible d'ouvrir un onglet, et suit l'onglet ouvert.
 *
 * Beaucoup de sites ouvrent le détail d'une annonce, un PDF ou un paiement
 * dans un nouvel onglet. Sans ce suivi, l'agent cliquait, ne voyait rien
 * changer, et concluait que le clic n'avait pas marché.
 */
async function followPopup(fn) {
  const before = context.pages().length;
  const popup = context.waitForEvent("page", { timeout: 4_000 }).catch(() => null);
  await fn();
  const p = await popup;
  if (p && context.pages().length > before) {
    await p.waitForLoadState("domcontentloaded").catch(() => undefined);
    page = p;
    return true;
  }
  return false;
}

/**
 * Cherche une clé d'API affichée dans la page (texte, champs, iframes).
 *
 * Appelée UNIQUEMENT par le code de l'orchestrateur (outil
 * enregistrer_cle_affichee), jamais par un modèle : le résultat contient la
 * clé en clair, et il va directement dans la base, chiffré. Le motif est
 * imposé par l'orchestrateur, qui vérifie aussi le domaine de la page.
 */
async function chercherCles(a) {
  const re = new RegExp(a.motif, "g");
  const trouvees = new Set();
  for (const f of page.frames()) {
    const textes = await f.evaluate(() => {
      const t = [document.body ? document.body.innerText : ""];
      for (const el of document.querySelectorAll("input, textarea")) t.push(el.value || "");
      for (const el of document.querySelectorAll("[value], [data-value], code, pre")) t.push(el.getAttribute("value") || el.getAttribute("data-value") || el.textContent || "");
      return t;
    }).catch(() => []);
    for (const t of textes) for (const m of String(t).matchAll(re)) trouvees.add(m[0]);
  }
  return { url: page.url(), cles: [...trouvees] };
}

const handlers = {
  async cles(a) { return chercherCles(a); },
  async goto(a) { const r = await page.goto(a.url, { waitUntil: a.wait || "domcontentloaded", timeout: 45_000 }); await page.waitForTimeout(a.settle_ms ?? 800); return { status: r ? r.status() : null, url: page.url(), title: await page.title(), text: await text(a.max_chars ?? 6_000) }; },
  async text(a) { return { url: page.url(), title: await page.title(), text: await text(a.max_chars) }; },
  async html(a) { const h = await (a.selector ? page.locator(a.selector).first().innerHTML() : page.content()); return { html: h.slice(0, a.max_chars || 20_000) }; },
  async click(a) {
    const l = await cible(a);
    let methode = "normal";
    const suivi = await followPopup(async () => { methode = await cliquer(l); });
    await page.waitForTimeout(a.settle_ms ?? 800);
    return { url: page.url(), title: await page.title(), nouvel_onglet: suivi, clic: methode, text: await text(3_000) };
  },
  async type(a) {
    if (typeof a.value !== "string") throw new Error("value requis : le texte à écrire");
    const l = await cible(a);
    await cliquer(l).catch(() => undefined);
    let methode = "clavier";
    try {
      if (a.clear !== false) await l.fill("", { timeout: 6_000 });
      await l.pressSequentially(a.value, { delay: 20, timeout: 30_000 });
    } catch (e) {
      if (!BLOQUE.test(String(e)) && !/not an <input>|not editable/i.test(String(e))) throw e;
      await l.evaluate(poserValeur, a.value, { timeout: 5_000 });
      methode = "dom";
    }
    if (a.enter) await page.keyboard.press("Enter");
    await page.waitForTimeout(a.settle_ms ?? 600);
    return { ok: true, saisie: methode, url: page.url() };
  },

  /**
   * Liste déroulante. `type` ne marche pas sur un <select> : Playwright
   * refuse d'y écrire, et l'agent tournait en rond sur « choisis une taille »,
   * « choisis un pays », « choisis une catégorie » — c'est-à-dire sur la
   * moitié des formulaires qui comptent.
   */
  async select(a) {
    const l = await locator(a);
    const opts = await l.locator("option").allTextContents().catch(() => []);
    const par = a.value !== undefined ? { value: a.value } : a.name !== undefined ? { label: a.name } : { index: a.index ?? 0 };
    await l.selectOption(par, { timeout: 10_000 });
    await page.waitForTimeout(a.settle_ms ?? 600);
    return { ok: true, choisi: a.value ?? a.name ?? a.index, options_disponibles: opts.slice(0, 40), url: page.url() };
  },

  /** Case à cocher ou interrupteur. `click` fonctionne parfois ; `check` connaît l'état voulu et est donc idempotent. */
  async check(a) {
    const l = await cible(a);
    const voulu = !(a.value === "false" || a.uncheck);
    try {
      if (voulu) await l.check({ timeout: 6_000 }); else await l.uncheck({ timeout: 6_000 });
    } catch (e) {
      // Case stylée (l'<input> est caché derrière un dessin) : un clic dans
      // la page bascule l'état, on ne le fait que si l'état n'est pas déjà bon.
      if (!BLOQUE.test(String(e)) && !/did not change its state/i.test(String(e))) throw e;
      if ((await l.isChecked().catch(() => !voulu)) !== voulu) await l.evaluate((el) => el.click(), undefined, { timeout: 3_000 });
    }
    await page.waitForTimeout(a.settle_ms ?? 400);
    return { ok: true, coche: await l.isChecked().catch(() => null), url: page.url() };
  },

  /** Envoi de fichier. Le fichier doit déjà être dans /work — écrit par le sandbox, ou téléchargé plus tôt. */
  async upload(a) {
    const files = (Array.isArray(a.files) ? a.files : [a.file]).filter(Boolean);
    if (!files.length) throw new Error("file (ou files) requis : chemin absolu sous /work");
    for (const f of files) {
      if (!f.startsWith("/work/")) throw new Error(`chemin hors de /work : ${f}`);
      if (!fs.existsSync(f)) throw new Error(`fichier introuvable : ${f}`);
    }
    // Sans cible : le premier champ fichier de la page, visible ou caché —
    // c'est le cas de presque tous les boutons « Ajouter des photos ».
    const sansCible = !a.selector && !a.text && !a.role && !a.label && !a.placeholder;
    const l = sansCible ? page.locator("input[type=file]").first() : await cible(a);
    let methode = "champ";
    try {
      await l.setInputFiles(files, { timeout: 6_000 });
    } catch (e) {
      // La cible est un bouton qui OUVRE le sélecteur de fichiers, pas le
      // champ lui-même : on clique et on répond au sélecteur.
      try {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8_000 }), cliquer(l)]);
        await chooser.setFiles(files);
        methode = "selecteur";
      } catch {
        const champ = page.locator("input[type=file]").first();
        if (!(await champ.count().catch(() => 0))) throw new Error(`aucun champ fichier trouvé (${String(e).split("\n")[0].slice(0, 160)}). Appelle form pour voir les champs.`);
        await champ.setInputFiles(files, { timeout: 8_000 });
        methode = "premier_champ_fichier";
      }
    }
    await page.waitForTimeout(a.settle_ms ?? 800);
    return { ok: true, envoyes: files, methode, url: page.url() };
  },

  /**
   * Téléchargement : clique, attend le fichier, le range dans /work/downloads.
   *
   * De là, le sandbox peut le lire et la chaîne de lecture de pièces jointes
   * peut en extraire le texte. Sans ça, une facture en PDF derrière un bouton
   * « Télécharger » était hors de portée — et c'est précisément le genre de
   * document qu'on veut récupérer.
   */
  async download(a) {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    // Une adresse : on va chercher le fichier directement. C'est le cas des
    // photos d'annonce (une image s'affiche, elle ne se « télécharge » pas).
    if (a.url) {
      const f = await recupererParAdresse(a.url);
      if (f.html) throw new Error(`${a.url} est une page web, pas un fichier. Ouvre-la (goto) et clique le lien de téléchargement (download{text}), ou donne l'adresse de l'image elle-même (eval : document.querySelector('img').src).`);
      const dest = ranger(f);
      return { ok: true, fichier: dest, octets: f.corps.length, type: f.type, url: page.url() };
    }
    const l = await cible(a);
    // Le `.catch` est posé TOUT DE SUITE : si l'attente expire pendant le clic
    // (bouton recouvert, repli), une promesse rejetée sans gestionnaire fait
    // tomber tout le démon — et avec lui la session du navigateur.
    const wait = page.waitForEvent("download", { timeout: a.timeout_ms ?? 30_000 }).catch(() => null);
    await cliquer(l);
    const dl = await wait;
    if (!dl) throw new Error(`le clic sur ${decrireCible(a)} n'a déclenché aucun téléchargement en ${Math.round((a.timeout_ms ?? 30_000) / 1000)} s. Si c'est une image, donne son adresse : download{url} (trouve-la avec eval ou html).`);
    const nom = nomFichier(dl.suggestedFilename(), "");
    const dest = `${DOWNLOADS}/${Date.now()}-${nom}`;
    try {
      await dl.saveAs(dest);
    } catch (e) {
      // Navigateur dans un autre conteneur (écran du serveur) : Chrome a
      // écrit le fichier chez LUI, et saveAs le cherche ICI — « ENOENT ».
      // On le reprend par son adresse, avec les mêmes cookies.
      const url = dl.url();
      if (!url) throw e;
      const f = await recupererParAdresse(url);
      fs.writeFileSync(dest, f.corps);
      await dl.cancel().catch(() => undefined);
    }
    return { ok: true, fichier: dest, nom_propose: dl.suggestedFilename(), octets: fs.statSync(dest).size, url: page.url() };
  },

  /** Ce que la page contient comme formulaires : les champs, leur nom, leur type. Évite de deviner un sélecteur. */
  async form(a) {
    const scope = a.selector ? page.locator(a.selector).first() : page.locator("body");
    return {
      url: page.url(),
      champs: await scope
        .locator("input, select, textarea, button[type=submit]")
        .evaluateAll((els) =>
          els.slice(0, 60).map((e) => ({
            balise: e.tagName.toLowerCase(),
            type: e.getAttribute("type") || "",
            nom: e.getAttribute("name") || e.id || "",
            etiquette: (e.labels && e.labels[0] && e.labels[0].innerText.trim().slice(0, 60)) || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "",
            options: e.tagName === "SELECT" ? Array.from(e.options).slice(0, 30).map((o) => o.value || o.text) : undefined,
            requis: e.hasAttribute("required"),
            visible: Boolean(e.offsetParent) || e.tagName === "SELECT",
          })),
        )
        .catch(() => []),
    };
  },
  async press(a) { await page.keyboard.press(a.key); await page.waitForTimeout(400); return { ok: true, url: page.url() }; },
  async scroll(a) { await page.mouse.wheel(0, a.dy ?? 1200); await page.waitForTimeout(400); return { ok: true }; },
  // Le fichier seulement, jamais l'image en base64 dans la réponse : une
  // capture pèse 200 ko à 3 Mo, la sortie du sandbox est coupée à 40 000
  // caractères, et TOUTES les captures revenaient « réponse illisible »
  // (27 échecs le 25 septembre). Qui a besoin des octets lit le fichier.
  async screenshot(a) { fs.mkdirSync(SHOTS, { recursive: true }); const file = `${SHOTS}/${Date.now()}.png`; await page.screenshot({ path: file, fullPage: !!a.full, timeout: 20_000 }); return { file, octets: fs.statSync(file).size, url: page.url() }; },
  async links(a) { const links = await page.$$eval("a[href]", (els) => els.map((e) => ({ text: (e.innerText || "").trim().slice(0, 80), href: e.href })).filter((l) => l.text)); return { links: links.slice(0, a.max ?? 100) }; },
  async eval(a) { const v = await page.evaluate(a.js); return { value: typeof v === "string" ? v.slice(0, 20_000) : v }; },
  async wait(a) { if (a.selector) await page.waitForSelector(a.selector, { timeout: a.timeout_ms ?? 15_000 }); else await page.waitForTimeout(a.ms ?? 1000); return { ok: true }; },
  async tabs(a) {
    const pages = context.pages();
    if (a.op === "new") { page = await context.newPage(); if (a.url) await page.goto(a.url); }
    else if (a.op === "switch") { page = pages[a.index]; if (!page) throw new Error("index d'onglet invalide"); await page.bringToFront(); }
    else if (a.op === "close") { if (pages.length > 1) { await page.close(); page = context.pages()[0]; } }
    return { tabs: context.pages().map((p, i) => ({ index: i, url: p.url(), active: p === page })) };
  },
  async back() { await page.goBack({ waitUntil: "domcontentloaded" }); return { url: page.url(), title: await page.title() }; },

  /**
   * Télécommande de l'écran : agit sur l'onglet que l'HUMAIN voit, pas sur
   * celui que le bot pilote — ce ne sont pas forcément les mêmes s'il a
   * changé d'onglet à la main. Au doigt, à travers noVNC, défiler, zoomer ou
   * taper dans une case est pénible ou impossible ; ici chaque geste est un
   * bouton.
   */
  async ecran(a) {
    const cible = await ongletVisible();
    const zoomActuel = async () => Number(await cible.evaluate(() => document.documentElement.style.zoom || 1)) || 1;
    const zoomer = async (z) => {
      const v = Math.min(1.5, Math.max(0.5, Math.round(z * 10) / 10));
      await cible.evaluate((x) => { document.documentElement.style.zoom = x === 1 ? "" : String(x); }, v);
      return v;
    };
    const vue = cible.viewportSize() || { width: 1280, height: 900 };
    switch (a.op) {
      case "haut":
      case "bas":
        await cible.mouse.move(vue.width / 2, vue.height / 2);
        await cible.mouse.wheel(0, a.op === "bas" ? 600 : -600);
        break;
      case "zoom_moins": await zoomer((await zoomActuel()) - 0.1); break;
      case "zoom_plus": await zoomer((await zoomActuel()) + 0.1); break;
      case "zoom_normal": await zoomer(1); break;
      case "recharger": await cible.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }); break;
      case "retour": await cible.goBack({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null); break;
      case "tab": await cible.keyboard.press("Tab"); break;
      case "maj_tab": await cible.keyboard.press("Shift+Tab"); break;
      case "entree": await cible.keyboard.press("Enter"); break;
      case "effacer": await cible.keyboard.press("Backspace"); break;
      case "echap": await cible.keyboard.press("Escape"); break;
      case "ecrire":
        if (typeof a.texte !== "string" || !a.texte) throw new Error("rien à écrire");
        // Sans case sélectionnée, le texte partait dans le vide — et l'écran
        // répondait « fait ». On le dit plutôt, avec le geste qui manque.
        if (!(await caseActive(cible))) throw new Error("aucune case sélectionnée dans le site : touche d'abord la case sur l'écran (ou appuie sur « Suivante »), puis Écrire");
        // insertText et non type : pas d'événement par touche, donc pas de
        // raccourci déclenché par une lettre, et les accents passent tels quels.
        await cible.keyboard.insertText(a.texte.slice(0, 5000));
        break;
      case "copier": {
        // Le texte sélectionné — dans la page ou dans un de ses cadres (un
        // éditeur de message vit souvent dans un iframe). Jamais le contenu
        // d'un champ mot de passe : le copier le ferait sortir en clair.
        let texte = "";
        for (const f of cible.frames()) {
          texte = await f.evaluate(() => {
            // D'abord la sélection DANS la case active ; sinon, la sélection de
            // la page — sélectionner du texte ne retire pas le curseur d'une case.
            const el = document.activeElement;
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && typeof el.selectionStart === "number" && el.type !== "password") {
              const dedans = el.value.substring(el.selectionStart, el.selectionEnd);
              if (dedans) return dedans;
            }
            // Un champ mot de passe sélectionné donne « •••••• » : pas le
            // secret, mais rien d'utile à copier non plus.
            const sel = String(window.getSelection() || "");
            return /^[\u2022\u25CF*]+$/.test(sel) ? "" : sel;
          }).catch(() => "");
          if (texte) break;
        }
        return { ok: true, url: cible.url(), title: await cible.title().catch(() => ""), texte: texte.slice(0, 20_000) };
      }
      default: throw new Error(`commande inconnue : ${a.op}`);
    }
    await cible.waitForTimeout(300);
    return { ok: true, url: cible.url(), title: await cible.title().catch(() => ""), zoom: await zoomActuel().catch(() => 1) };
  },
  async cookies(a) { const c = await context.cookies(a.url ? [a.url] : undefined); return { count: c.length, domains: [...new Set(c.map((x) => x.domain))] }; },
  // `status` disait le mode VOULU (la variable d'environnement), pas le mode
  // obtenu. Quand le tunnel est fermé il annonçait donc "cdp" en servant le
  // profil local, ce qui envoie chercher la panne à l'exact opposé.
  async status() { return { mode, cdp_configure: Boolean(process.env.BROWSER_CDP_URL), cdp_erreur: cdpError, url: page.url(), tabs: context.pages().length }; },

  /**
   * Connexion automatique à un site.
   *
   * Les identifiants arrivent par l'entrée standard depuis l'orchestrateur,
   * qui les a déchiffrés du coffre. Ils ne sont ni journalisés, ni renvoyés,
   * ni visibles par le modèle : ce handler ne rend qu'un état.
   *
   * Le formulaire est trouvé par heuristique, dans cet ordre : identifiant,
   * puis mot de passe, puis code à six chiffres. Les trois étapes sont
   * séparées parce que la moitié des sites sérieux demandent l'identifiant
   * d'abord et n'affichent le champ mot de passe qu'ensuite ; un script qui
   * suppose les deux champs présents en même temps échoue sur Microsoft,
   * Amazon et la plupart des banques.
   */
  async login(a) {
    if (!a.login || !a.secret) throw new Error("identifiants manquants");
    const url = a.url;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
    await dismissBanners();

    const before = page.url();
    let steps = [];

    // Déjà connecté : ni champ identifiant ni champ mot de passe. On le dit
    // au lieu de chercher un formulaire qui n'existe pas, sinon chaque appel
    // sur un site déjà ouvert finit en « champ introuvable ».
    if (!(await firstVisible(PASSWORD_SEL)) && !(await firstVisible(IDENT_SEL)) && !(await firstVisible((a.hints || {}).ident || []))) {
      return { signed_in: true, already: true, url: page.url(), title: await page.title(), steps: ["aucun formulaire de connexion : session déjà ouverte"], text: await text(1_500) };
    }

    // Les indices du profil de site passent devant les heuristiques : sur
    // LinkedIn, « input[name=session_key] » ne se devine pas, et deviner
    // mal remplit le champ de recherche avec une adresse e-mail.
    const h = a.hints || {};
    const identSel = [...(h.ident || []), ...IDENT_SEL];
    const passSel = [...(h.password || []), ...PASSWORD_SEL];

    const ident = await firstVisible(identSel);
    if (ident) {
      await ident.fill(a.login);
      steps.push("identifiant saisi");
      // Si le mot de passe n'est pas encore là, c'est un formulaire en deux
      // temps : on valide l'identifiant et on attend le second écran.
      if (!(await firstVisible(passSel))) {
        await submitStep(h.submit);
        await page.waitForTimeout(2500);
        await dismissBanners();
        steps.push("étape 1 validée");
      }
    }

    const pw = await waitVisible(passSel, 12_000);
    if (!pw) return { signed_in: false, url: page.url(), title: await page.title(), steps, error: "champ mot de passe introuvable", text: await text(2_000) };
    await pw.fill(a.secret);
    steps.push("mot de passe saisi");
    await submitStep(h.submit);
    await page.waitForTimeout(3500);
    await dismissBanners();

    // Double authentification. Sans ça le coffre s'arrête au premier site qui
    // compte : le code à six chiffres est la règle, plus l'exception.
    const otp = await firstVisible(OTP_SEL);
    if (otp) {
      if (!a.totp) {
        return { signed_in: false, url: page.url(), title: await page.title(), steps, needs_code: true, error: "le site demande un code à six chiffres et aucune clé TOTP n'est enregistrée pour lui", text: await text(1_500) };
      }
      await otp.fill(a.totp);
      steps.push("code à usage unique saisi");
      await submitStep(h.submit);
      await page.waitForTimeout(3500);
    }

    // Succès = plus de champ mot de passe visible. C'est le seul signal
    // universel : le texte de confirmation, lui, change à chaque site et à
    // chaque langue.
    const stillAsking = Boolean(await firstVisible(passSel));
    return {
      signed_in: !stillAsking,
      url: page.url(),
      title: await page.title(),
      moved: page.url() !== before,
      steps,
      text: await text(2_500),
    };
  },

  /**
   * Va sur une page de résultats et en rend les annonces normalisées.
   *
   * En une seule commande plutôt que goto + text : une page de place de
   * marché fait 200 ko de texte dont 190 sont du menu et du pied de page.
   * La passer entière au modèle coûte cher et noie les dix lignes utiles.
   */
  async listings(a) {
    await page.goto(a.url, { waitUntil: a.wait || "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(a.settle_ms ?? 2_500);
    await dismissBanners();
    // Les grilles se remplissent au défilement : sans ça on ne voit que la
    // première rangée sur la moitié des sites.
    for (let i = 0; i < (a.scrolls ?? 2); i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(700);
    }
    const r = await extractListings(a.selectors, a.max ?? 25);
    return { url: page.url(), titre: await page.title(), ...r };
  },

  /**
   * Gmail par le web, pour quand l'API Google n'est pas branchée ou que son
   * jeton est révoqué : le compte est connecté dans ce navigateur, et une
   * boîte de réception se lit très bien à l'écran. Trois opérations :
   *   inbox  — les derniers messages (expéditeur, objet, aperçu, date, non lu) ;
   *   search — pareil, sur une recherche Gmail (« from:ionos », « is:unread ») ;
   *   read   — ouvre le n-ième message de la liste courante et rend son texte.
   *
   * Les classes de Gmail (tr.zA, .yP, .bog, .y2, .a3s…) sont stables depuis
   * des années mais pas éternelles : si elles manquent, on rend le texte
   * lisible de la page, pour que le modèle s'en sorte quand même, et on dit
   * lequel des deux chemins a servi. Si Gmail renvoie vers une page de
   * connexion, on le dit tel quel : c'est à l'opérateur de se connecter à
   * Google sur l'écran, jamais au robot de taper un mot de passe Google.
   */
  async gmail(a) {
    const op = a.op || "inbox";
    // `url` n'est là que pour les tests, qui servent une fausse boîte en local.
    const base = a.url || "https://mail.google.com/mail/u/0/";
    if (op === "inbox" || op === "search") {
      const url = op === "search" ? `${base}#search/${encodeURIComponent(a.query || "")}` : `${base}#inbox`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("tr.zA, input[type=email], #identifierId, .a3s", { timeout: 20_000 }).catch(() => undefined);
      if (/accounts\.google\.com/.test(page.url()) || (await page.$("input[type=email], #identifierId"))) {
        return { ok: false, connexion_requise: true, error: "Gmail demande une connexion : le compte Google n'est pas connecté dans ce navigateur. Lionel doit se connecter à Google sur l'écran, une fois ; ne tape jamais son mot de passe.", url: page.url() };
      }
      await page.waitForTimeout(a.settle_ms ?? 1_200);
      const lignes = await page.evaluate((max) => {
        const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
        return [...document.querySelectorAll("tr.zA")].slice(0, max).map((tr, i) => {
          const exp = tr.querySelector(".yX .yP, .yX .zF, .yW span[email]");
          const objet = tr.querySelector(".bog, .y6 span:not(.y2)");
          const date = tr.querySelector(".xW span[title], .xW span");
          return {
            index: i,
            non_lu: tr.classList.contains("zE"),
            de: clean(exp?.textContent) || clean(tr.querySelector(".yW")?.textContent),
            email: exp?.getAttribute("email") || "",
            objet: clean(objet?.textContent),
            apercu: clean(tr.querySelector(".y2")?.textContent).replace(/^-\s*/, ""),
            date: date?.getAttribute("title") || clean(date?.textContent),
            piece_jointe: Boolean(tr.querySelector(".brd, .yf .brc")),
          };
        });
      }, a.max ?? 10);
      if (!lignes.length) {
        return { ok: true, chemin: "texte", messages: [], note: "aucune ligne reconnue (boîte vide, ou Gmail a changé) : voici le texte de la page", texte: await text(6_000), url: page.url() };
      }
      return { ok: true, chemin: "selecteurs", messages: lignes, url: page.url() };
    }
    if (op === "read") {
      const rows = await page.$$("tr.zA");
      const i = a.index ?? 0;
      if (!rows.length) throw new Error("aucune liste de messages à l'écran : appelle d'abord gmail inbox ou gmail search");
      if (!rows[i]) throw new Error(`index ${i} hors de la liste (${rows.length} messages)`);
      await rows[i].click({ timeout: 10_000 });
      await page.waitForSelector(".a3s", { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(a.settle_ms ?? 800);
      const m = await page.evaluate((maxChars) => {
        const clean = (t) => (t || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        const corps = [...document.querySelectorAll(".a3s")].map((e) => clean(e.innerText)).filter(Boolean);
        const de = document.querySelector(".gD");
        return {
          objet: clean(document.querySelector("h2.hP")?.textContent),
          de: clean(de?.textContent),
          email: de?.getAttribute("email") || "",
          date: document.querySelector(".g3")?.getAttribute("title") || clean(document.querySelector(".g3")?.textContent),
          messages_dans_le_fil: corps.length,
          corps: corps.slice(-3).join("\n\n— — —\n\n").slice(0, maxChars),
        };
      }, a.max_chars ?? 8_000);
      if (!m.corps) return { ok: true, chemin: "texte", ...m, texte: await text(a.max_chars ?? 8_000), url: page.url() };
      return { ok: true, chemin: "selecteurs", ...m, url: page.url() };
    }
    throw new Error("op attendu : inbox | search | read");
  },

  /**
   * Sauvegarde / restauration des sessions (cookies + localStorage).
   *
   * Le profil vit dans un volume Docker, donc il survit déjà aux
   * redémarrages — mais pas à une reconstruction d'image ni à une migration
   * de serveur. Une session reconquise, c'est une double authentification à
   * refaire à la main pour chaque site : ça vaut un fichier.
   */
  async session(a) {
    const file = "/work/browser-session.json";
    if (a.op === "save") {
      await context.storageState({ path: file });
      const c = await context.cookies();
      return { saved: file, cookies: c.length, domains: [...new Set(c.map((x) => x.domain))].length };
    }
    if (a.op === "load") {
      if (!fs.existsSync(file)) throw new Error(`aucune sauvegarde de session (${file})`);
      const st = JSON.parse(fs.readFileSync(file, "utf8"));
      await context.addCookies(st.cookies || []);
      return { restored: (st.cookies || []).length };
    }
    throw new Error("op attendu : save | load");
  },
};

/**
 * Extraction d'annonces depuis une page de résultats.
 *
 * Deux chemins, et on dit toujours lequel a servi. Les sélecteurs d'un site
 * marchand changent à chaque refonte, c'est-à-dire plusieurs fois par an :
 * un extracteur qui n'a que des sélecteurs rend zéro résultat un matin sans
 * que personne comprenne pourquoi. Le chemin générique cherche à la place ce
 * qui définit une annonce partout — un lien, et un prix à côté — et survit
 * aux refontes au prix d'un peu de bruit.
 */
async function extractListings(sel, max) {
  return page.evaluate(
    ({ sel, max }) => {
      const PRICE = /(?:^|\s)(?:(kr|sek|€|eur|\$|usd|¥|cny|rmb|£)\s*)?((?:\d[\d\s.,]{0,11}\d|\d))\s*(kr|sek|:-|€|eur|\$|usd|¥|元|cny|rmb|£)?(?=\s|$)/i;
      const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
      const priceIn = (el) => {
        const t = clean(el.innerText).slice(0, 400);
        const m = t.match(/(\d[\d\s.,]{0,11}\d|\d)\s*(kr|:-|sek|€|\$|¥|元|£)|(kr|€|\$|¥|£)\s*(\d[\d\s.,]{0,11}\d|\d)/i);
        return m ? clean(m[0]) : "";
      };

      const out = [];
      const seen = new Set();
      const push = (title, href, price) => {
        if (!title || !href || seen.has(href)) return;
        if (title.length < 3) return;
        seen.add(href);
        out.push({ titre: title.slice(0, 160), url: href, prix: price || "" });
      };

      // 1. Sélecteurs fournis par le profil du site.
      if (sel && sel.item) {
        for (const node of document.querySelectorAll(sel.item)) {
          const a = sel.link ? node.querySelector(sel.link) : node.querySelector("a[href]");
          const t = sel.title ? node.querySelector(sel.title) : a;
          push(clean(t && t.innerText) || clean(a && a.getAttribute("aria-label")), a && a.href, sel.price ? clean((node.querySelector(sel.price) || {}).innerText) : priceIn(node));
          if (out.length >= max) break;
        }
        if (out.length >= 3) return { methode: "selecteurs", annonces: out.slice(0, max) };
      }

      // 2. Générique : chaque lien dont le voisinage contient un prix. On
      //    remonte au plus trois parents, parce que le prix vit rarement
      //    dans la balise du lien et presque toujours dans sa carte.
      out.length = 0;
      seen.clear();
      for (const a of document.querySelectorAll("a[href]")) {
        // Un lien de menu ou de pied de page n'est pas une annonce, même
        // quand il y a un prix quelque part sur la page.
        if (a.closest("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]")) continue;
        const title = clean(a.innerText) || clean(a.getAttribute("aria-label")) || clean(a.getAttribute("title"));
        if (!title || title.length < 6) continue;
        let node = a;
        let price = "";
        for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
          // On s'arrête dès que le conteneur regroupe plusieurs annonces :
          // sinon on remonte jusqu'au <body>, on y trouve le prix du premier
          // article, et on le colle à « Se connecter ». Une carte d'annonce
          // porte un à trois liens ; une grille en porte vingt.
          if (node !== a && node.querySelectorAll("a[href]").length > 3) break;
          price = priceIn(node);
          if (price) break;
        }
        if (price) push(title, a.href, price);
        if (out.length >= max) break;
      }
      if (out.length) return { methode: "generique", annonces: out };

      // 3. Rien : c'est une information, pas un bug. Souvent une page de
      //    contrôle anti-robot, ou une recherche sans résultat.
      return { methode: "aucune", annonces: [], titre_page: document.title, apercu: clean(document.body.innerText).slice(0, 600) };
    },
    { sel, max },
  );
}

/* --- Heuristiques de formulaire ------------------------------------------ */

/** `:visible` compte : les sites gardent des formulaires cachés (mobile, modale fermée) qu'on remplirait à vide. */
const IDENT_SEL = [
  'input[autocomplete="username"]:visible',
  'input[type="email"]:visible',
  'input[name*="email" i]:visible',
  'input[name*="user" i]:visible',
  'input[name*="login" i]:visible',
  'input[id*="email" i]:visible',
  'input[id*="user" i]:visible',
  'input[type="tel"][name*="phone" i]:visible',
];

const PASSWORD_SEL = ['input[type="password"]:visible'];

const OTP_SEL = [
  'input[autocomplete="one-time-code"]:visible',
  'input[name*="otp" i]:visible',
  'input[name*="totp" i]:visible',
  'input[id*="otp" i]:visible',
  'input[name*="code" i]:visible',
  'input[maxlength="6"]:visible',
];

/**
 * L'onglet affiché à l'écran. `visibilityState` le dit sans ambiguïté : un
 * onglet en arrière-plan est « hidden ». Plusieurs visibles (fenêtres
 * séparées) : celui que le bot pilote s'il en fait partie, sinon le dernier.
 */
async function ongletVisible() {
  const visibles = [];
  for (const p of context.pages()) {
    const etat = await p.evaluate(() => document.visibilityState).catch(() => "hidden");
    if (etat === "visible") visibles.push(p);
  }
  if (!visibles.length) return page;
  return visibles.includes(page) ? page : visibles[visibles.length - 1];
}

/** Une case où l'on peut écrire a-t-elle le curseur, dans la page ou un de ses cadres ? */
async function caseActive(p) {
  for (const f of p.frames()) {
    const oui = await f.evaluate(() => {
      const e = document.activeElement;
      if (!e) return false;
      if (e.isContentEditable || e.tagName === "TEXTAREA") return true;
      if (e.tagName === "INPUT") return !["button", "submit", "checkbox", "radio", "hidden", "image", "reset", "file", "range", "color"].includes(e.type);
      return false;
    }).catch(() => false);
    if (oui) return true;
  }
  return false;
}

async function firstVisible(selectors) {
  for (const s of selectors) {
    const l = page.locator(s).first();
    if (await l.count().then((n) => n > 0).catch(() => false)) return l;
  }
  return null;
}

async function waitVisible(selectors, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const l = await firstVisible(selectors);
    if (l) return l;
    if (Date.now() > until) return null;
    await page.waitForTimeout(400);
  }
}

/** Valide l'étape courante : un bouton explicite s'il existe, la touche Entrée sinon. */
async function submitStep(custom) {
  if (custom && custom.length) {
    const c = page.locator(custom.join(", ")).first();
    if (await c.count().then((n) => n > 0).catch(() => false)) {
      await c.click({ timeout: 8_000 }).catch(() => page.keyboard.press("Enter"));
      return;
    }
  }
  const names = /^(se connecter|connexion|continuer|suivant|valider|log ?in|sign ?in|continue|next|submit|logga in|fortsätt)$/i;
  const btn = page.getByRole("button", { name: names }).first();
  if (await btn.count().then((n) => n > 0).catch(() => false)) {
    await btn.click({ timeout: 8_000 }).catch(() => page.keyboard.press("Enter"));
    return;
  }
  const submit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if (await submit.count().then((n) => n > 0).catch(() => false)) {
    await submit.click({ timeout: 8_000 }).catch(() => page.keyboard.press("Enter"));
    return;
  }
  await page.keyboard.press("Enter");
}

/**
 * Bandeaux de cookies. Ce n'est pas un détail de confort : en Europe le
 * bandeau est une modale qui capte les clics, et sans lui le formulaire de
 * connexion est là, visible, et parfaitement inatteignable.
 */
async function dismissBanners() {
  const names = /^(tout accepter|accepter tout|accepter|j'accepte|accept all|allow all|godkänn alla|acceptera|ok, tout accepter)$/i;
  for (const frame of page.frames()) {
    try {
      const b = frame.getByRole("button", { name: names }).first();
      if (await b.count().then((n) => n > 0)) {
        await b.click({ timeout: 4_000 });
        await page.waitForTimeout(600);
        return;
      }
    } catch { /* un iframe peut disparaître pendant qu'on l'interroge */ }
  }
}

boot().then(() => {
  const server = http.createServer(async (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      touch();
      try {
        const { action, args } = JSON.parse(body || "{}");
        const h = handlers[action];
        if (!h) throw new Error(`action inconnue: ${action}`);
        if (page.isClosed()) page = context.pages()[0] || (await context.newPage());
        const out = await h(args || {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 800) }));
      }
    });
  });
  server.listen(PORT, "127.0.0.1", () => { touch(); console.log(`browser daemon ready on ${PORT}`); });
}).catch((e) => { console.error("boot failed:", String(e)); process.exit(1); });
