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

const handlers = {
  async goto(a) { const r = await page.goto(a.url, { waitUntil: a.wait || "domcontentloaded", timeout: 45_000 }); await page.waitForTimeout(a.settle_ms ?? 800); return { status: r ? r.status() : null, url: page.url(), title: await page.title(), text: await text(a.max_chars ?? 6_000) }; },
  async text(a) { return { url: page.url(), title: await page.title(), text: await text(a.max_chars) }; },
  async html(a) { const h = await (a.selector ? page.locator(a.selector).first().innerHTML() : page.content()); return { html: h.slice(0, a.max_chars || 20_000) }; },
  async click(a) {
    const l = await locator(a);
    const suivi = await followPopup(() => l.click({ timeout: 10_000 }));
    await page.waitForTimeout(a.settle_ms ?? 800);
    return { url: page.url(), title: await page.title(), nouvel_onglet: suivi, text: await text(3_000) };
  },
  async type(a) { const l = await locator(a); await l.click({ timeout: 10_000 }); if (a.clear !== false) await l.fill(""); await l.type(a.value, { delay: 20 }); if (a.enter) await page.keyboard.press("Enter"); await page.waitForTimeout(a.settle_ms ?? 600); return { ok: true, url: page.url() }; },

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
    const l = await locator(a);
    if (a.value === "false" || a.uncheck) await l.uncheck({ timeout: 10_000 });
    else await l.check({ timeout: 10_000 });
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
    const l = await locator(a);
    await l.setInputFiles(files, { timeout: 15_000 });
    await page.waitForTimeout(a.settle_ms ?? 800);
    return { ok: true, envoyes: files, url: page.url() };
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
    const wait = page.waitForEvent("download", { timeout: a.timeout_ms ?? 60_000 });
    if (a.url) await page.goto(a.url).catch(() => undefined);
    else await (await locator(a)).click({ timeout: 10_000 });
    const dl = await wait;
    const nom = (dl.suggestedFilename() || `fichier-${Date.now()}`).replace(/[^\w.\-]/g, "_");
    const dest = `${DOWNLOADS}/${Date.now()}-${nom}`;
    await dl.saveAs(dest);
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
  async screenshot(a) { const file = `${SHOTS}/${Date.now()}.png`; await page.screenshot({ path: file, fullPage: !!a.full }); return { file, base64: fs.readFileSync(file).toString("base64") }; },
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
