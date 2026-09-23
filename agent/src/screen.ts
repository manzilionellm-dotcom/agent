import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tcpConnect } from "node:net";
import { logger } from "./logger.js";
import { config } from "./config.js";

/**
 * L'écran du navigateur du serveur, servi dans une page web.
 *
 * Le conteneur `desktop` fait tourner un Chromium sur un écran virtuel,
 * partagé en VNC et servi en HTTP par noVNC. Rien de tout cela n'est publié
 * sur l'hôte : on passe par l'orchestrateur, qui sait déjà qui a le droit
 * d'entrer.
 *
 * À quoi ça sert, concrètement : quand l'agent tombe sur une connexion qu'il
 * ne peut pas faire seul — compte sans mot de passe au coffre, double
 * authentification, captcha — il envoie un lien à l'opérateur. L'opérateur
 * ouvre la page, voit LE navigateur de l'agent, se connecte de ses propres
 * mains, ferme l'onglet. La session reste sur le serveur, et l'agent reprend
 * où il en était. Aucun mot de passe n'a traversé une conversation, aucun
 * n'est stocké, et l'opérateur n'a pas eu besoin de son ordinateur.
 */

const host = (): string => config().DESKTOP_HOST;
const port = (): number => config().DESKTOP_PORT;

/** Page d'entrée : noVNC en plein écran, connecté d'office, redimensionné au navigateur. */
// `resize=scale` et non `remote` : `remote` demande au serveur de changer de
// résolution, ce que cet écran ne sait pas faire (Xvfb à taille fixe, x11vnc
// lancé sans -xrandr). La demande était ignorée en silence : sur un PC l'écran
// tenait par chance, sur un téléphone il s'affichait en taille réelle et il
// fallait le parcourir au doigt. `scale` réduit l'image à la taille de l'écran
// qui regarde, quel qu'il soit.
export const SCREEN_ENTRY = "/screen/vnc.html?path=screen/websockify&autoconnect=true&resize=scale&reconnect=true&show_dot=true";

/**
 * Relaie une requête HTTP vers noVNC.
 *
 * Le préfixe `/screen` est retiré : noVNC référence ses fichiers en relatif
 * depuis `vnc.html`, donc la page fonctionne telle quelle sous un préfixe, à
 * condition que ce préfixe disparaisse avant d'atteindre websockify.
 */
export function proxyScreen(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const path = url.pathname.replace(/^\/screen/, "") + (url.search || "");
  const up = httpRequest(
    { host: host(), port: port(), method: req.method, path: path || "/", headers: { ...req.headers, host: `${host()}:${port()}` } },
    (r) => {
      // SAMEORIGIN : noVNC s'affiche dans NOTRE page de télécommande, jamais
      // dans le cadre d'un autre site (qui pourrait faire cliquer à l'aveugle).
      res.writeHead(r.statusCode ?? 502, { ...r.headers, "x-frame-options": "SAMEORIGIN" });
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    logger.error({ err: String(e) }, "écran injoignable");
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem">` +
        `<h2>Le navigateur du serveur ne répond pas.</h2>` +
        `<p>Il démarre en une quarantaine de secondes après un redémarrage. Recharge la page.</p>` +
        `<p style="color:#666">Si ça persiste : <code>docker compose logs desktop</code></p>`,
    );
  });
  req.pipe(up);
}

/**
 * Relaie la connexion WebSocket de noVNC.
 *
 * Un `upgrade` ne passe pas par le gestionnaire HTTP ordinaire : il faut
 * rejouer la poignée de main à la main et raccorder les deux sockets. Sans
 * ça, la page s'affiche, reste noire, et n'explique rien.
 */
export function proxyScreenSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const path = (req.url ?? "/").replace(/^\/screen/, "") || "/";
  const up = tcpConnect(port(), host(), () => {
    const lignes = [
      `GET ${path} HTTP/1.1`,
      ...Object.entries(req.headers).flatMap(([k, v]) =>
        k === "host" ? [`host: ${host()}:${port()}`] : Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : [],
      ),
      "",
      "",
    ];
    up.write(lignes.join("\r\n"));
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const fin = (e: unknown): void => {
    if (e) logger.warn({ err: String(e) }, "socket de l'écran interrompue");
    up.destroy();
    socket.destroy();
  };
  up.on("error", fin);
  socket.on("error", fin);
}

/** L'écran répond-il ? Sert au diagnostic et à la page d'accueil. */
export async function screenAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const r = httpRequest({ host: host(), port: port(), path: "/", method: "HEAD", timeout: 3000 }, (res) => {
      resolve((res.statusCode ?? 500) < 500);
      res.resume();
    });
    r.on("error", () => resolve(false));
    r.on("timeout", () => {
      r.destroy();
      resolve(false);
    });
    r.end();
  });
}

const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * La page de l'écran : l'image du navigateur du bot en haut, une
 * télécommande en bas, à portée de pouce.
 *
 * Pourquoi pas noVNC seul : au doigt, noVNC transforme un glissement en
 * sélection de texte au lieu de faire défiler, et le clavier du téléphone
 * s'ouvre mal. Résultat constaté le 23 septembre : le formulaire de
 * connexion d'un site dépassait sous le bas de l'écran, et rien ne
 * permettait d'y descendre — « le site n'est pas cliquable ». Chaque geste
 * difficile devient ici un bouton, exécuté directement dans l'onglet visible.
 *
 * Les boutons appellent /screen/action en JSON, sans recharger la page :
 * l'image reste connectée pendant qu'on s'en sert.
 */
export function pageEcran(nom: string): string {
  const b = (op: string, icone: string, texte: string, titre: string): string =>
    `<button type="button" data-op="${op}" title="${escHtml(titre)}"><span aria-hidden="true">${icone}</span>${texte}</button>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${escHtml(nom)} — écran</title>
<style>
:root{color-scheme:dark;--bg:#0f1115;--barre:#171a21;--bouton:#232833;--bord:#323846;--texte:#e8eaef;--doux:#9aa3b2;--go:#6ea8ff;--bad:#ff7a6e;--ok:#4fd18b}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--texte);font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{display:flex;flex-direction:column;height:100dvh}
/* Debout : l'écran en haut à sa vraie proportion (5:4), sans bandes noires ;
   tous les boutons visibles en grille dessous, sans défilement de côté. */
.ecran{position:relative;flex:none;width:100%;aspect-ratio:5/4;max-height:62dvh;background:#000}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
.barre{flex:1;min-height:0;overflow-y:auto;background:var(--barre);border-top:1px solid var(--bord);padding:.5rem .5rem calc(.5rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:.45rem}
.gestes{display:grid;grid-template-columns:repeat(4,1fr);gap:.35rem}
.sep{display:none}
#copier,#coller{grid-column:span 2}
button{min-height:46px;padding:.3rem .4rem;border-radius:10px;border:1px solid var(--bord);background:var(--bouton);color:var(--texte);font:inherit;font-size:.8rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.1rem;cursor:pointer;touch-action:manipulation;line-height:1.1}
button:active{transform:scale(.96);background:var(--bord)}
button span{font-size:1.1rem;line-height:1}
button.principal{background:var(--go);border-color:transparent;color:#0b1020;font-weight:600;flex-direction:row;padding:.3rem 1rem;font-size:.9rem}
form{display:grid;grid-template-columns:1fr auto;gap:.35rem .5rem;align-items:center}
input[type=text],input[type=password]{grid-column:1/-1;width:100%;min-height:46px;padding:.5rem .7rem;border-radius:10px;border:1px solid var(--bord);background:var(--bg);color:var(--texte);font:inherit;font-size:16px}
input:focus{outline:2px solid var(--go);outline-offset:0;border-color:transparent}
.options{display:flex;gap:.9rem}
label.cache{display:flex;align-items:center;gap:.3rem;color:var(--doux);font-size:.82rem;white-space:nowrap}
label.cache input{width:1.1rem;height:1.1rem;margin:0}
.etat{display:flex;justify-content:space-between;gap:.6rem;color:var(--doux);font-size:.78rem;min-height:1.1em}
.etat b{color:var(--texte);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.etat .bad{color:var(--bad)}.etat .ok{color:var(--ok)}
.etat a{color:var(--go);text-decoration:none;white-space:nowrap}
/* Couché (téléphone de côté, ordinateur) : l'écran prend toute la place,
   la télécommande devient une colonne à droite. */
@media (min-aspect-ratio:1/1){
  body{flex-direction:row}
  .ecran{flex:1;height:100%;max-height:none;aspect-ratio:auto;width:auto}
  .barre{flex:none;width:14.5rem;border-top:0;border-left:1px solid var(--bord)}
  .gestes{grid-template-columns:repeat(2,1fr)}
  #copier,#coller{grid-column:auto}
  form{grid-template-columns:1fr}
  .options{justify-content:space-between}
  button.principal{width:100%}
}
/* Téléphone couché : peu de hauteur, des boutons en ligne et compacts pour
   que toute la télécommande tienne sans défiler. */
@media (min-aspect-ratio:1/1) and (max-height:500px){
  .barre{width:15.5rem;gap:.3rem;padding:.35rem}
  .gestes{gap:.25rem}
  button{flex-direction:row;min-height:36px;font-size:.74rem;gap:.3rem;justify-content:flex-start;padding:.2rem .45rem}
  button span{font-size:.95rem}
  input[type=text],input[type=password]{min-height:38px;padding:.35rem .6rem}
  button.principal{min-height:38px;justify-content:center}
  .etat{display:none}
}
</style></head><body>
<div class="ecran"><iframe src="${SCREEN_ENTRY}" title="Écran du navigateur de ${escHtml(nom)}" allow="clipboard-read; clipboard-write"></iframe></div>
<div class="barre">
  <div class="gestes" role="toolbar" aria-label="Télécommande">
    ${b("haut", "⬆", "Monter", "Faire défiler la page vers le haut")}
    ${b("bas", "⬇", "Descendre", "Faire défiler la page vers le bas")}
    <i class="sep"></i>
    ${b("zoom_moins", "－", "Réduire", "Rapetisser la page pour tout voir")}
    ${b("zoom_normal", "◻", "100 %", "Taille normale")}
    ${b("zoom_plus", "＋", "Agrandir", "Agrandir la page")}
    <i class="sep"></i>
    ${b("tab", "⇥", "Suivante", "Aller à la case suivante (Tab)")}
    ${b("maj_tab", "⇤", "Précédente", "Revenir à la case précédente (Maj+Tab)")}
    ${b("entree", "⏎", "Entrée", "Valider (touche Entrée)")}
    ${b("effacer", "⌫", "Effacer", "Effacer un caractère")}
    ${b("echap", "✕", "Échap", "Fermer une fenêtre (touche Échap)")}
    <i class="sep"></i>
    ${b("retour", "←", "Retour", "Page précédente")}
    ${b("recharger", "↻", "Recharger", "Recharger la page")}
    <button type="button" id="copier" title="Copier le texte sélectionné sur l'écran (Ctrl+C sur ordinateur)"><span aria-hidden="true">⧉</span>Copier</button>
    <button type="button" id="coller" title="Coller ton presse-papiers dans la case sélectionnée (Ctrl+V sur ordinateur)"><span aria-hidden="true">📋</span>Coller</button>
  </div>
  <form id="ecrire" autocomplete="off">
    <input id="texte" type="text" maxlength="5000" placeholder="Écrire dans la case sélectionnée" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send">
    <div class="options"><label class="cache"><input type="checkbox" id="masquer"> caché</label>
    <label class="cache"><input type="checkbox" id="valider"> + Entrée</label></div>
    <button class="principal" type="submit">Écrire</button>
  </form>
  <div class="etat"><b id="etat">1. Touche la case du site sur l'écran · 2. Écris en bas · 3. Écrire</b><a href="/panel">Panneau</a></div>
</div>
<script>
(() => {
  const etat = document.getElementById("etat");
  const texte = document.getElementById("texte");
  let occupe = false;
  const dire = (t, classe) => { etat.textContent = t; etat.className = classe || ""; };
  async function envoyer(op, charge) {
    if (occupe) return;
    occupe = true;
    try {
      const r = await fetch("/screen/action", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(Object.assign({ op }, charge || {})) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { location.href = "/login?suite=%2Fscreen"; return; }
      if (!r.ok || !j.ok) throw new Error(j.error || ("erreur " + r.status));
      dire((j.titre || j.url || "fait") + (j.zoom && j.zoom !== 1 ? " · zoom " + Math.round(j.zoom * 100) + " %" : ""), "ok");
    } catch (e) {
      dire(String(e.message || e), "bad");
    } finally {
      occupe = false;
    }
  }
  document.querySelectorAll("[data-op]").forEach((el) => el.addEventListener("click", () => envoyer(el.dataset.op)));

  // --- Presse-papiers -------------------------------------------------------
  // UN seul presse-papiers : celui de l'appareil de Lionel. « Copier » y met
  // le texte sélectionné sur l'écran du bot ; « Coller » l'écrit dans la case
  // sélectionnée. noVNC seul ne le fait pas : il faut passer par son panneau
  // latéral, et sur téléphone ça ne marche pas du tout.
  async function action(op, charge) {
    const r = await fetch("/screen/action", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(Object.assign({ op }, charge || {})) });
    if (r.status === 401) { location.href = "/login?suite=%2Fscreen"; throw new Error("connexion requise"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ("erreur " + r.status));
    return j;
  }
  async function copier() {
    try {
      const j = await action("copier");
      if (!j.texte) return dire("Sélectionne d'abord du texte sur l'écran, puis Copier.", "bad");
      try {
        await navigator.clipboard.writeText(j.texte);
        dire("Copié : « " + j.texte.slice(0, 40) + (j.texte.length > 40 ? "… »" : " »"), "ok");
      } catch {
        // Presse-papiers refusé (navigateur ancien, page non sécurisée) : on
        // met le texte dans la case, sélectionné, pour le copier à la main.
        texte.type = "text"; texte.value = j.texte; texte.focus(); texte.select();
        dire("Copie-le à la main : il est sélectionné dans la case du bas.", "bad");
      }
    } catch (e) { dire(String(e.message || e), "bad"); }
  }
  async function coller(contenu) {
    try {
      const t = typeof contenu === "string" ? contenu : await navigator.clipboard.readText();
      if (!t) return dire("Ton presse-papiers est vide.", "bad");
      await action("ecrire", { texte: t.slice(0, 5000) });
      dire("Collé (" + t.length + " caractères).", "ok");
    } catch (e) {
      if (typeof contenu !== "string") { texte.focus(); return dire("Ton navigateur bloque la lecture du presse-papiers : colle dans la case du bas, puis Écrire.", "bad"); }
      dire(String(e.message || e), "bad");
    }
  }
  document.getElementById("copier").addEventListener("click", () => copier());
  document.getElementById("coller").addEventListener("click", () => coller());

  // Sur ordinateur : Ctrl+C / Ctrl+V directement sur l'écran, comme dans un
  // navigateur normal. noVNC tourne dans un cadre de la même origine : on
  // intercepte les deux raccourcis AVANT lui (phase de capture), sinon il
  // les enverrait au bot, qui collerait son propre presse-papiers — vide.
  const cadre = document.querySelector("iframe");
  function brancher() {
    let w;
    try { w = cadre.contentWindow; w.document; } catch { return; }
    w.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); e.stopImmediatePropagation(); copier(); }
      // Ctrl+V : on arrête noVNC mais on laisse faire le navigateur, qui
      // produit l'événement « paste » ci-dessous avec le contenu.
      else if (k === "v") { e.stopImmediatePropagation(); }
    }, true);
    w.document.addEventListener("paste", (e) => {
      const t = e.clipboardData && e.clipboardData.getData("text/plain");
      e.preventDefault(); e.stopImmediatePropagation();
      if (t) coller(t);
    }, true);
  }
  cadre.addEventListener("load", brancher);
  brancher();
  document.getElementById("masquer").addEventListener("change", (e) => { texte.type = e.target.checked ? "password" : "text"; });
  document.getElementById("ecrire").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!texte.value) { texte.focus(); return dire("La case du bas est vide : écris ton texte dedans, puis Écrire.", "bad"); }
    await envoyer("ecrire", { texte: texte.value });
    if (document.getElementById("valider").checked) await envoyer("entree");
    texte.value = "";
  });
})();
</script>
</body></html>`;
}
