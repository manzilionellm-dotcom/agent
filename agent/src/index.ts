import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { migrate } from "./memory/migrate.js";
import { closeDb, db } from "./memory/db.js";
import { spentToday } from "./memory/store.js";
import { connectMcpServers, disconnectMcpServers, mcpStatus } from "./mcp/registry.js";
import { resolveMission, MISSIONS } from "./missions/index.js";
import { listCustomMissions } from "./missions/custom.js";
import { buildAndDeliverReport } from "./missions/report.js";
import { launch, startScheduler, stopScheduler, scheduledJobs, withLock, listSchedules } from "./scheduler.js";
import { runSwarm } from "./swarm/coordinator.js";
import { sandboxExec } from "./tools/sandbox.js";
import { handleChat } from "./channels/chat.js";
import { deliverWhatsApp, primaryNumber, allowedNumbers, markRead, parseMetaWebhook, parseTwilioWebhook, readRawBody, sendWhatsApp, sendWhatsAppAudio, sendWhatsAppMedia, verifyMetaSignature, verifyTwilioSignature, whatsappEnabled } from "./channels/whatsapp.js";
import { mediaToText } from "./channels/media.js";
import { Rafale, assembler } from "./channels/rafale.js";
import { createAgent, getAgent, listAgents, deleteAgent, agentSpend } from "./agents/store.js";
import { createTask, listTasks, unblockTask } from "./agents/tasks.js";
import { startRuntime, stopRuntime } from "./agents/runtime.js";
import { timeline } from "./events.js";
import { homePage, privacyPage, termsPage, vaultPage } from "./pages.js";
import { consumeVaultTicket, createVaultTicket, forgetCredential, importerMotsDePasse, listCredentials, putCredential, vaultEnabled } from "./vault.js";
import { pageEcran, proxyScreen, proxyScreenSocket } from "./screen.js";
import { boardJson, boardPage } from "./board.js";
import { panelPage, panelState } from "./panel.js";
import { estSection } from "./panel-sections.js";
import { LANGUES_ECOUTE, sourceEcoute, transcrire } from "./ecoute.js";
import { lireVue } from "./panel-diagnostic.js";
import { dansTrace, ouvrirBoiteNoire, viderBoiteNoire } from "./boite-noire.js";
import { creerTicket, demarrerInspecteur, inspecter, marquerProbleme, reglerInspecteur, type Reglages } from "./inspecteur.js";
import { livrerReponse } from "./voice.js";
import { adresse, definirMotDePasse, motDePasseDefini, pageConnexion, retirerMotDePasse, tenter } from "./login.js";
import { CARACTERES, EMOJIS, LANGUES, LIBRE_MAX, LONGUEURS, NOM_MAX, REFLEXIONS, personnalite } from "./personality.js";
import { VOIX_MODES, synthese } from "./voice.js";
import { estCommandeEcran, ouvrirSurEcran, sitesConnectes, telecommande } from "./navigator.js";
import { annulerRappel, demarrerRappels, heureLocale, planifier, supprimerRappel } from "./rappels.js";
import { oublierFait, oublierFichierProfil, oublierTout } from "./souvenirs.js";
import { apprendre, basculerCompetence, oublierCompetence } from "./competences.js";
import { genererImage, typeImage } from "./images.js";
import { basculerDeclencheur, creerDeclencheur, decrire, demarrerDeclencheurs, supprimerDeclencheur } from "./declencheurs.js";
import { SANS_LIMITE, bumpProviderPriority, deleteProvider, getProvider, listProviders, putProvider, seedFromEnv, setProviderEnabled, setSetting, setting, testProvider, type Category } from "./providers.js";

const PUBLIC_PAGES: Record<string, () => string> = {
  "/": homePage,
  "/privacy": privacyPage,
  "/terms": termsPage,
};

/**
 * Point d'entrée du démon. Ordre : config → migrations → MCP → sandbox check →
 * scheduler (mode manual : rien sans ordre) → API HTTP.
 *
 * API (Bearer ORCHESTRATOR_TOKEN, sauf /healthz et le webhook WhatsApp signé) :
 *   GET  /healthz
 *   POST /chat {peer, text}          conversation (Jarvis, curl) — mêmes outils que WhatsApp
 *   GET  /missions · POST /missions/:name · POST /report
 *   POST /swarm {objective} · GET /swarm/:id
 *   GET  /reports/latest · GET /schedules
 *   GET|POST /whatsapp/webhook       Meta Cloud API ou Twilio (signature vérifiée, liste blanche)
 */

const swarms = new Map<string, { status: "running" | "done" | "failed"; objective: string; result?: unknown; error?: string; startedAt: string }>();

function authorized(req: IncomingMessage): boolean {
  const token = config().ORCHESTRATOR_TOKEN;
  if (!token) return false;
  const h = req.headers.authorization ?? "";
  const given = Buffer.from(h.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Authentification de la page /vault par cookie.
 *
 * Un formulaire HTML ne peut pas porter d'en-tête `Authorization` : le
 * contrôle Bearer du reste de l'API ne s'applique donc pas ici. On entre
 * avec un billet à usage unique (`?t=`), échangé contre un cookie
 * HttpOnly + SameSite=Lax, et la redirection nettoie la barre d'adresse.
 * Le jeton de l'API, lui, ne circule jamais dans une URL : une adresse qui
 * contient un secret finit recopiée quelque part.
 */
function vaultCookieOk(req: IncomingMessage): boolean {
  const token = config().ORCHESTRATOR_TOKEN;
  if (!token) return false;
  const raw = /(?:^|;\s*)manzi_vault=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  if (!raw) return false;
  const given = Buffer.from(decodeURIComponent(raw));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * L'écran du navigateur du serveur.
 *
 * Même porte que le coffre : un billet à usage unique, échangé contre un
 * cookie. Le billet arrive par WhatsApp quand l'agent demande un coup de
 * main, ou se génère à la main avec `deploy/vault-link.sh`.
 */
async function ticketToCookie(req: IncomingMessage, res: ServerResponse, url: URL, destination: string): Promise<void> {
  const token = config().ORCHESTRATOR_TOKEN;
  const ticket = url.searchParams.get("t") ?? "";
  if (!token) return void json(res, 503, { error: "ORCHESTRATOR_TOKEN absent" });
  if (!(await consumeVaultTicket(ticket).catch(() => false))) {
    logger.warn({ ip: req.socket.remoteAddress, destination }, "billet invalide ou déjà utilisé");
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    return void res.end("<!doctype html><meta charset=utf-8><p style=\"font:16px system-ui;padding:2rem\">Ce lien a déjà servi ou a expiré. Demande-en un autre au bot, ou lance <code>bash deploy/vault-link.sh</code>.");
  }
  poserCookie(req, res, destination, 3600);
}

/**
 * Pose le cookie de session et redirige.
 *
 * `SameSite=Lax`, pas `Strict`. Avec `Strict`, un lien à billet ouvert
 * DEPUIS WHATSAPP ne marchait pas : la navigation vient d'une autre
 * application, le billet pose le cookie, puis la redirection vers /panel
 * fait partie de cette même navigation « venue d'ailleurs » — et Chrome
 * refuse d'y joindre un cookie Strict. Le panneau ne reconnaissait pas la
 * session et renvoyait vers /login. Sur PC, ouvrir.ps1 ouvre Chrome
 * directement, sans site d'origine : la panne ne s'y voyait pas.
 * Reproduit avec un vrai Chromium avant correction.
 *
 * `Lax` est le réglage standard d'une session : le cookie accompagne une
 * ARRIVÉE depuis un autre site (clic sur un lien), mais pas un formulaire
 * POST ni une requête de fond venus d'un autre site. Or tout ce qui modifie
 * quelque chose ici est un POST, et le flux de l'écran est un WebSocket —
 * une requête de fond. La protection qui compte reste entière.
 *
 * `Secure` seulement derrière HTTPS : posé toujours, le cookie serait
 * rejeté lors d'un test local sur 127.0.0.1, et la page redemanderait un
 * billet en boucle sans jamais dire pourquoi.
 */
function poserCookie(req: IncomingMessage, res: ServerResponse, destination: string, maxAge: number): void {
  const token = config().ORCHESTRATOR_TOKEN ?? "";
  const https = (req.headers["x-forwarded-proto"] ?? "").toString().includes("https") || (config().PUBLIC_URL ?? "").startsWith("https");
  res.writeHead(302, {
    location: destination,
    "set-cookie": `manzi_vault=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? "; Secure" : ""}`,
  });
  res.end();
}

/**
 * Où revenir après connexion. Liste fermée : accepter n'importe quelle
 * adresse en paramètre ferait de /login un tremplin vers un site piégé
 * (« connecte-toi ici » → renvoyé chez un imitateur).
 */
const SUITES: Record<string, string> = { "/panel": "/panel", "/board": "/board", "/vault": "/vault", "/screen": "/screen" };

function versConnexion(res: ServerResponse, suite: string): void {
  res.writeHead(302, { location: `/login?suite=${encodeURIComponent(suite)}`, "cache-control": "no-store" });
  res.end();
}

/**
 * Connexion par mot de passe : l'adresse du panneau s'ouvre comme n'importe
 * quel site, sans passer par le serveur ni par la conversation.
 * Douze heures de session : assez pour une journée de travail, assez court
 * pour qu'un téléphone oublié ne reste pas ouvert indéfiniment.
 */
async function loginRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const nom = (await personnalite().catch(() => undefined))?.nom;
  const demandee = url.searchParams.get("suite") ?? "";
  const page = (m = "", code = 200, suite = demandee) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(pageConnexion(m, nom, SUITES[suite] ? suite : ""));
  };
  if (!config().ORCHESTRATOR_TOKEN) return page("ORCHESTRATOR_TOKEN absent du serveur : connexion impossible.", 503);
  if (req.method !== "POST") {
    if (vaultCookieOk(req)) return void (res.writeHead(302, { location: SUITES[url.searchParams.get("suite") ?? ""] ?? "/panel" }), res.end());
    return page(await motDePasseDefini() ? "" : "Aucun mot de passe défini pour l'instant. Entre avec un lien du bot, puis définis-le dans le panneau, section Accès.");
  }
  const f = new URLSearchParams((await readRawBody(req)).toString("utf8"));
  const ip = adresse(req);
  const voulue = f.get("suite") ?? "";
  const r = await tenter(ip, f.get("mdp") ?? "");
  if (!r.ok) {
    logger.warn({ ip }, "connexion refusée");
    return page(r.raison, 401, voulue);
  }
  logger.info({ ip }, "connexion au panneau par mot de passe");
  poserCookie(req, res, SUITES[voulue] ?? "/panel", 12 * 3600);
}

/**
 * Le panneau. Tout ce qui s'y fait prend effet en quinze secondes, sans
 * redémarrage : c'est ce qui distingue un réglage qu'on ajuste d'un réglage
 * qu'on subit.
 */
async function panelRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // `s` ouvre la page directement sur une section — mais seulement une section
  // qui existe : l'ancre vient de la liste fermée, jamais du lien tel quel.
  if (url.searchParams.get("t")) {
    const s = url.searchParams.get("s") ?? "";
    return ticketToCookie(req, res, url, estSection(s) ? `/panel#${s}` : "/panel");
  }
  if (!vaultCookieOk(req)) {
    return versConnexion(res, "/panel");
  }

  let notice = "";
  let ton: "" | "bon" | "bad" = "";
  // Le formulaire poste sur l'URL courante, donc sur « ?edit=x ». Après un
  // enregistrement réussi on repart à vide : rester en édition laisserait
  // croire que rien n'a été pris.
  let edit = url.searchParams.get("edit") ?? "";
  if (req.method === "POST") {
    const f = new URLSearchParams((await readRawBody(req)).toString("utf8"));
    const g = (k: string): string => (f.get(k) ?? "").trim();
    const id = g("id");
    try {
      switch (g("op")) {
        case "put": {
          const p = await putProvider({
            id,
            category: (g("category") || "modele") as Category,
            label: g("label") || undefined,
            kind: g("kind") === "anthropic" ? "anthropic" : "openai_compat",
            baseUrl: g("baseUrl") || undefined,
            model: g("model") || undefined,
            // Une clé vide ne remplace rien : le formulaire ne la réaffiche
            // jamais, donc l'enregistrer viderait la clé à chaque retouche.
            apiKey: f.get("apiKey")?.trim() || undefined,
            priority: Number(g("priority")) || 50,
            roles: f.getAll("roles"),
            // Champ absent (un appel à la main, un formulaire tronqué) =
            // « garde le plafond en place ». Le remettre à 0 lèverait une
            // limite de dépense sans que personne l'ait demandé.
            dailyCapUsd: f.has("dailyCap") ? Math.max(0, Number(g("dailyCap")) || 0) : undefined,
            note: g("note") || undefined,
          });
          notice = `${p.label || p.id} enregistré${p.has_key ? "" : " (sans clé : inutilisable tant qu'il n'en a pas)"}.`;
          edit = "";
          break;
        }
        case "pause": notice = (await setProviderEnabled(id, false)) ? `${id} mis en pause.` : `${id} introuvable.`; break;
        case "reprendre": notice = (await setProviderEnabled(id, true)) ? `${id} réactivé.` : `${id} introuvable.`; break;
        case "up": await bumpProviderPriority(id, -10); notice = `${id} passe devant.`; break;
        case "down": await bumpProviderPriority(id, 10); notice = `${id} recule.`; break;
        case "delete": notice = (await deleteProvider(id)) ? `${id} supprimé.` : `${id} introuvable.`; edit = ""; break;
        // Le seul bouton qui répond à « pourquoi il n'a pas accès à GitHub ? »
        // sans ouvrir un terminal : il appelle vraiment le service.
        case "test": { const t = await testProvider(id); notice = t.message; ton = t.ok ? "bon" : "bad"; break; }
        case "memoire": {
          const off = g("etat") === "off";
          await setSetting("MEMOIRE", off ? "off" : "on");
          notice = off ? "Mémoire coupée : il ne retient plus rien et ne lit plus ton profil." : "Mémoire réactivée.";
          ton = off ? "bad" : "bon";
          break;
        }
        case "oublier_fait": {
          notice = (await oublierFait(Number(g("fid")))) ? "Oublié." : "Déjà oublié.";
          ton = "bon";
          break;
        }
        case "oublier_profil": {
          notice = (await oublierFichierProfil(g("chemin"))) ? "Fichier de profil effacé." : "Introuvable (ou hors du profil).";
          ton = "bon";
          break;
        }
        case "oublier_tout": {
          const r = await oublierTout();
          notice = `Tout effacé : ${r.faits} fait(s), ${r.profil} fichier(s) de profil.`;
          ton = "bad";
          break;
        }
        case "rappel_creer": {
          const to = primaryNumber();
          if (!to) throw new Error("aucun numéro WhatsApp autorisé : à qui l'envoyer ?");
          const type = g("type") === "tache" ? "tache" : "rappel";
          const r = await planifier({ peer: to, type, quoi: f.get("quoi") ?? "", quand: g("quand") || undefined, cron: g("cron") || undefined });
          notice = `Planifié n°${r.id} — ${r.cron ? "prochaine fois " : ""}${heureLocale(r.prochain)}.`;
          ton = "bon";
          break;
        }
        case "rappel_annuler": { notice = (await annulerRappel(Number(g("rid")))) ? "Annulé." : "Déjà terminé."; ton = "bon"; break; }
        case "rappel_supprimer": { notice = (await supprimerRappel(Number(g("rid")))) ? "Retiré de la liste." : "Introuvable."; ton = "bon"; break; }
        case "competence_enregistrer": {
          const { competence, remplacee } = await apprendre({ nom: g("nom"), quand: g("quand"), instructions: f.get("instructions") ?? "", source: "panneau" });
          notice = `Compétence « ${competence.nom} » ${remplacee ? "mise à jour" : "apprise"}. Elle s'applique dès le prochain message.`;
          ton = "bon";
          break;
        }
        case "competence_basculer": {
          await basculerCompetence(g("nom"), g("etat") !== "off");
          notice = g("etat") === "off" ? "Compétence en pause." : "Compétence réactivée.";
          ton = "bon";
          break;
        }
        case "competence_oublier": { notice = (await oublierCompetence(g("nom"))) ? "Compétence supprimée." : "Introuvable."; ton = "bon"; break; }
        case "declencheur_creer": {
          const d = await creerDeclencheur({ nom: g("nom"), expediteur: g("expediteur"), sujet: g("sujet"), piece_jointe: f.get("piece_jointe") === "on", consigne: f.get("consigne") ?? "" });
          notice = `Déclencheur « ${d.nom} » actif : ${decrire(d)}.`;
          ton = "bon";
          break;
        }
        case "declencheur_basculer": {
          await basculerDeclencheur(Number(g("did")), g("etat") !== "off");
          notice = g("etat") === "off" ? "Déclencheur en pause." : "Déclencheur réactivé.";
          ton = "bon";
          break;
        }
        case "declencheur_supprimer": { notice = (await supprimerDeclencheur(Number(g("did")))) ? "Déclencheur supprimé." : "Introuvable."; ton = "bon"; break; }
        case "testimage": {
          const to = primaryNumber();
          if (!to) throw new Error("aucun numéro WhatsApp autorisé à qui l'envoyer");
          const img = await genererImage("Un petit robot sympathique qui fait un signe de la main, style illustration plate, couleurs vives, fond uni.");
          const t = typeImage(img);
          const envoi = await sendWhatsAppMedia(to, img, { mime: t.mime, type: "image", fichier: `test.${t.ext}`, legende: "Test d'image — si tu la vois, c'est branché." });
          if (!envoi.ok) throw new Error(envoi.error ?? "envoi refusé");
          notice = "Image de test envoyée sur ton WhatsApp.";
          ton = "bon";
          break;
        }
        case "ouvrir_site": {
          // Succès : on file directement sur l'écran, où le site vient de
          // s'ouvrir. Revenir au panneau avec un bandeau « ouvert » obligerait
          // à trouver le lien de l'écran pour faire la seule chose utile.
          const o = await ouvrirSurEcran(g("url"));
          logger.info({ url: o.url }, "site ouvert dans le navigateur du bot depuis le panneau");
          res.writeHead(303, { location: "/screen", "cache-control": "no-store" });
          return void res.end();
        }
        case "sites_connectes": {
          const sites = await sitesConnectes();
          notice = sites.length
            ? `Il a une session sur ${sites.length} site(s) : ${sites.slice(0, 80).join(", ")}${sites.length > 80 ? "…" : ""}`
            : "Aucune session ouverte dans son navigateur pour l'instant.";
          ton = "bon";
          break;
        }
        case "personnalite": {
          const nom = g("nom").replace(/[\u0000-\u001f]/g, "").slice(0, NOM_MAX);
          const choix = (cle: string, table: Record<string, unknown>): string => {
            const v = g(cle);
            if (!(v in table)) throw new Error(`valeur inconnue pour ${cle} : « ${v} »`);
            return v;
          };
          await Promise.all([
            setSetting("BOT_NOM", nom),
            setSetting("BOT_CARACTERE", choix("caractere", CARACTERES)),
            setSetting("BOT_REFLEXION", choix("reflexion", REFLEXIONS)),
            setSetting("BOT_LONGUEUR", choix("longueur", LONGUEURS)),
            setSetting("BOT_EMOJIS", choix("emojis", EMOJIS)),
            setSetting("BOT_LANGUE", choix("langue", LANGUES)),
            setSetting("BOT_LIBRE", (f.get("libre") ?? "").slice(0, LIBRE_MAX)),
          ]);
          notice = `Personnalité enregistrée. ${nom || "Il"} la prend au prochain message.`;
          ton = "bon";
          break;
        }
        case "voix": {
          const mode = g("mode");
          if (!(mode in VOIX_MODES)) throw new Error("mode de voix inconnu");
          const nomVoix = g("nom") || "onyx";
          if (!/^[a-z0-9_-]{1,30}$/i.test(nomVoix)) throw new Error("nom de voix invalide (lettres, chiffres, - et _)");
          await Promise.all([
            setSetting("VOIX_MODE", mode),
            setSetting("VOIX_NOM", nomVoix),
            setSetting("VOIX_CONSIGNES", (f.get("consignes") ?? "").slice(0, 600)),
            // Case décochée = champ absent du formulaire : c'est « off ».
            setSetting("VOIX_TEXTE_AUSSI", f.get("texte") === "on" ? "on" : "off"),
          ]);
          notice = mode === "off" ? "Voix coupée : il répond par écrit." : `Voix enregistrée (${VOIX_MODES[mode as keyof typeof VOIX_MODES].toLowerCase()}).`;
          ton = "bon";
          break;
        }
        case "testvoix": {
          const to = primaryNumber();
          if (!to) throw new Error("aucun numéro WhatsApp autorisé à qui l'envoyer");
          const p = await personnalite();
          const son = await synthese(`Salut Lionel, c'est ${p.nom}. Si tu m'entends, ma voix est branchée et je peux te répondre en vocal.`);
          const envoi = await sendWhatsAppAudio(to, son);
          if (!envoi.ok) throw new Error(envoi.error ?? "envoi refusé");
          notice = "Note vocale envoyée sur ton WhatsApp. Écoute-la : si la voix te plaît, c'est réglé.";
          ton = "bon";
          break;
        }
        case "ecoute": {
          const four = g("fournisseur") === "openai" ? "openai" : "groq";
          const cle = (f.get("cle") ?? "").trim();
          const langue = g("langue");
          if (!(langue in LANGUES_ECOUTE)) throw new Error("langue inconnue");
          const existe = await getProvider("ecoute");
          if (!cle && !existe) throw new Error("colle d'abord une clé Groq ou OpenAI");
          if (cle && /\s/.test(cle)) throw new Error("la clé contient un espace : recopie-la sans espace");
          if (cle || existe) {
            await putProvider({
              id: "ecoute",
              category: "autre",
              label: four === "openai" ? "OpenAI (écoute)" : "Groq (écoute)",
              kind: "openai_compat",
              baseUrl: four === "openai" ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1",
              model: "",
              apiKey: cle || undefined,
              note: "transcription des vocaux WhatsApp",
            });
          }
          await setSetting("ECOUTE_LANGUE", langue);
          notice = `Écoute enregistrée (${four === "openai" ? "OpenAI" : "Groq"}). Appuie sur « Tester l'écoute » pour vérifier.`;
          ton = "bon";
          break;
        }
        case "testecoute": {
          const src = await sourceEcoute();
          if (!src) throw new Error("aucune clé d'écoute : colle-en une au-dessus");
          // Le vrai test : on lui fait ENTENDRE une phrase. Si la voix est
          // branchée, on la fabrique ; sinon on vérifie au moins que la clé
          // est acceptée et que le modèle existe.
          const voix = await getProvider("voix");
          if (voix?.enabled && voix.api_key) {
            const phrase = "Bonjour Lionel, ceci est un test d'écoute de Manzi Junior.";
            const son = await synthese(phrase);
            const r = await transcrire(son, "audio/ogg", src);
            if (!r.ok) throw new Error(r.raison);
            notice = `Écoute OK (${src.nom}, ${src.modele}). Il a entendu : « ${r.texte} »`;
          } else {
            const res = await fetch(`${src.base}/models`, { headers: { authorization: `Bearer ${src.cle}` }, signal: AbortSignal.timeout(20_000) });
            if (res.status === 401 || res.status === 403) throw new Error(`clé refusée par ${src.nom} (HTTP ${res.status}) : recolle-la`);
            if (!res.ok) throw new Error(`${src.nom} a répondu HTTP ${res.status}`);
            const ids = (((await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }).data ?? []).map((m) => m.id);
            notice = ids.includes(src.modele)
              ? `Clé acceptée par ${src.nom}, modèle ${src.modele} disponible. Envoie-lui un vocal sur WhatsApp pour l'entendre répondre.`
              : `Clé acceptée par ${src.nom}, mais le modèle ${src.modele} n'apparaît pas dans sa liste. Envoie un vocal pour vérifier.`;
          }
          ton = "bon";
          break;
        }
        case "motdepasse": {
          await definirMotDePasse(f.get("mdp") ?? "", f.get("mdp2") ?? "");
          logger.info({ ip: adresse(req) }, "mot de passe du panneau défini");
          notice = "Mot de passe enregistré. Tu peux maintenant ouvrir ce panneau depuis n'importe quel navigateur, à l'adresse /login.";
          ton = "bon";
          break;
        }
        case "retirermdp": {
          await retirerMotDePasse();
          notice = "Mot de passe retiré : on n'entre plus qu'avec un lien du bot.";
          ton = "bad";
          break;
        }
        case "approbations": {
          const off = g("etat") === "off";
          await setSetting("APPROBATIONS", off ? "off" : "on");
          notice = off
            ? "Approbations coupées : les actions irréversibles partent sans te demander."
            : "Approbations réactivées : une action irréversible te demandera OUI-XXXX sur WhatsApp.";
          ton = off ? "bad" : "bon";
          break;
        }
        case "vercel": {
          const v = g("projet").replace(/^https?:\/\/[^/]+\//, "").replace(/\/.*$/, "").trim();
          if (v && !/^[\w.-]{1,100}$/.test(v)) throw new Error("nom de projet invalide (lettres, chiffres, - et _)");
          await setSetting("VERCEL_PROJECT", v);
          notice = v ? `Déploiements suivis sur le projet ${v}.` : "Plus aucun projet suivi après un push.";
          ton = "bon";
          break;
        }
        case "inspecter": {
          const r = await inspecter({ declencheur: "manuel", analyse: g("ia") !== "off" });
          notice = `Inspection faite : santé ${r.inspection.sante}/100, ${r.inspection.ouverts} problème(s).${r.analyse ? " L'analyse IA tourne : recharge la page dans une minute." : ""}`;
          ton = r.inspection.sante >= 85 ? "bon" : "";
          break;
        }
        case "probleme": {
          const statut = g("statut");
          if (statut !== "ouvert" && statut !== "resolu" && statut !== "ignore") throw new Error("statut inconnu");
          if (!(await marquerProbleme(g("sig"), statut))) throw new Error("problème introuvable");
          notice = statut === "resolu" ? "Noté comme réglé. S'il revient, il sera signalé « revenu après réparation »." : statut === "ignore" ? "Ignoré : il ne compte plus dans la santé." : "Rouvert.";
          ton = "bon";
          break;
        }
        case "probleme_ticket": {
          const url = await creerTicket(g("sig"));
          notice = `Ticket GitHub créé : ${url}`;
          ton = "bon";
          break;
        }
        case "inspecteur_reglages": {
          const ret = Number(g("retention"));
          await reglerInspecteur({
            heure: g("heure"),
            ia: g("ia") !== "off",
            whatsapp: g("whatsapp") as Reglages["whatsapp"],
            retention: ret,
          });
          notice = `Inspecteur réglé : passage chaque jour à ${g("heure")}.`;
          ton = "bon";
          break;
        }
        case "boite_noire_vider": {
          await viderBoiteNoire();
          logger.info("boîte noire vidée depuis le panneau");
          notice = "Boîte noire vidée.";
          ton = "bad";
          break;
        }
        case "budget": {
          const v = Number(g("daily"));
          if (!Number.isFinite(v) || v < 0) throw new Error("plafond invalide");
          await setSetting("DAILY_BUDGET_USD", v === 0 ? SANS_LIMITE : String(v));
          notice = v === 0 ? "Plafond journalier désactivé : aucune limite de dépense." : `Plafond journalier porté à ${v} $.`;
          break;
        }
        default: notice = "Action inconnue.";
      }
    } catch (e) {
      notice = `Refusé : ${e instanceof Error ? e.message : String(e)}`;
      ton = "bad";
    }
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(panelPage(await panelState(lireVue(url.searchParams)), notice, edit, ton));
}

async function screenRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.searchParams.get("t")) return ticketToCookie(req, res, url, "/screen");
  if (!vaultCookieOk(req)) {
    logger.warn({ ip: req.socket.remoteAddress, path: url.pathname }, "accès refusé à l'écran");
    // L'entrée renvoie vers la connexion ; les fichiers internes de l'écran
    // (scripts, flux) reçoivent un simple 401 — les rediriger vers une page
    // HTML casserait le client sans rien expliquer.
    if (url.pathname === "/screen" || url.pathname === "/screen/vnc.html") return versConnexion(res, "/screen");
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    return void res.end("connexion requise");
  }
  // La page humaine : l'écran ET sa télécommande. noVNC nu reste servi
  // (c'est lui qui tourne dans le cadre), mais on n'y envoie plus personne.
  if (url.pathname === "/screen") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
    return void res.end(pageEcran((await personnalite().catch(() => undefined))?.nom ?? "Manzi"));
  }
  if (url.pathname === "/screen/action") return actionEcran(req, res);
  return proxyScreen(req, res, url);
}

/**
 * Un geste de la télécommande. JSON seulement : un formulaire posté depuis
 * un autre site ne peut pas envoyer ce type de contenu sans autorisation
 * préalable du navigateur, et le cookie de session (SameSite=Lax) ne part
 * de toute façon pas avec un POST venu d'ailleurs. L'origine, quand le
 * navigateur la donne, doit être la nôtre.
 */
async function actionEcran(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST attendu" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { ok: false, error: "JSON attendu" });
  const origine = req.headers.origin;
  const hote = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "").toString();
  if (origine && origine !== "null" && new URL(origine).host !== hote) return json(res, 403, { ok: false, error: "origine refusée" });
  let corps: { op?: unknown; texte?: unknown };
  try {
    corps = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
  } catch {
    return json(res, 400, { ok: false, error: "JSON illisible" });
  }
  if (!estCommandeEcran(corps.op)) return json(res, 400, { ok: false, error: "commande inconnue" });
  try {
    const r = await telecommande(corps.op, typeof corps.texte === "string" ? corps.texte : undefined);
    // Le texte écrit n'est JAMAIS journalisé : ce peut être un mot de passe.
    return json(res, 200, { ok: true, ...r });
  } catch (e) {
    return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

async function vaultRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = config().ORCHESTRATOR_TOKEN;
  const html = (body: string, code = 200): void => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(body);
  };

  // Entrée par billet à usage unique, jamais par le jeton de l'API. Un
  // jeton dans une URL finit recopié quelque part ; un billet recopié est
  // déjà mort. Il s'obtient sur le serveur : `node dist/cli.js vault-link`.
  const ticket = url.searchParams.get("t");
  if (ticket) {
    if (!token) return html("<!doctype html><meta charset=utf-8><p>ORCHESTRATOR_TOKEN n'est pas configuré : la page du coffre est désactivée.", 503);
    if (!(await consumeVaultTicket(ticket).catch(() => false))) {
      logger.warn({ ip: req.socket.remoteAddress }, "billet de coffre invalide ou déjà utilisé");
      return html("<!doctype html><meta charset=utf-8><title>Coffre</title><p style=\"font:16px system-ui;padding:2rem\">Ce lien a déjà servi ou a expiré. Génère-en un autre :<br><code>ssh manzi@… 'cd manzi-junior &amp;&amp; bash deploy/vault-link.sh'</code>", 401);
    }
    // Le lien peut porter un site et un identifiant à pré-remplir (jamais le
    // mot de passe) : on les garde à travers la redirection, pour que la page
    // ouvre le formulaire déjà rempli sur le bon compte.
    const qp = new URLSearchParams();
    for (const k of ["site", "login", "url"]) {
      const v = (url.searchParams.get(k) ?? "").slice(0, 200);
      if (v) qp.set(k, v);
    }
    return poserCookie(req, res, qp.toString() ? `/vault?${qp.toString()}` : "/vault", 3600);
  }

  if (!vaultCookieOk(req)) {
    logger.warn({ ip: req.socket.remoteAddress }, "accès refusé au coffre");
    return versConnexion(res, "/vault");
  }

  const prefill = {
    site: (url.searchParams.get("site") ?? "").slice(0, 200) || undefined,
    login: (url.searchParams.get("login") ?? "").slice(0, 200) || undefined,
    url: (url.searchParams.get("url") ?? "").slice(0, 200) || undefined,
  };

  let notice = "";
  if (req.method === "POST") {
    const form = new URLSearchParams((await readRawBody(req)).toString("utf8"));
    const get = (k: string): string => (form.get(k) ?? "").trim();
    try {
      if (get("op") === "delete") {
        notice = (await forgetCredential(get("site"))) ? `${get("site")} supprimé.` : `${get("site")} n'était pas enregistré.`;
      } else if (get("op") === "importer") {
        // Le contenu du fichier n'est JAMAIS journalisé : il contient tous les
        // mots de passe en clair. Seul le bilan (des noms de sites) sort d'ici.
        const b = await importerMotsDePasse(form.get("csv") ?? "");
        logger.info({ importes: b.importes, remplaces: b.remplaces, ignores: b.ignores.length }, "mots de passe importés dans le coffre");
        const ign = b.ignores.length
          ? ` ${b.ignores.length} ignoré(s) : ${b.ignores.slice(0, 12).map((x) => `${x.ligne} (${x.raison})`).join(" ; ")}${b.ignores.length > 12 ? "…" : ""}.`
          : "";
        notice = `${b.importes} site(s) ajouté(s), ${b.remplaces} mis à jour.${ign} Supprime maintenant le fichier CSV de ton appareil : il contient tous tes mots de passe en clair.`;
      } else {
        const saved = await putCredential({ site: get("site"), login: get("login"), secret: form.get("secret") ?? "", totp: get("totp") || undefined, url: get("url") || undefined, note: get("note") });
        notice = `${saved.site} enregistré pour ${saved.login}${saved.has_totp ? " (double authentification incluse)" : ""}.`;
      }
    } catch (e) {
      notice = `Refusé : ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // La liste ne peut pas se lire si VAULT_KEY manque — elle n'en a pas besoin
  // (rien n'est déchiffré ici), mais le dire évite une page blanche.
  const entries = await listCredentials().catch(() => []);
  return html(vaultPage(entries, notice, vaultEnabled(), req.method === "POST" ? {} : prefill));
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/* --- WhatsApp ---------------------------------------------------------------- */

async function whatsappWebhook(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const cfg = config();
  if (!whatsappEnabled()) return json(res, 404, { error: "WhatsApp désactivé" });

  if (req.method === "GET" && cfg.WHATSAPP_PROVIDER === "meta") {
    // Vérification du webhook par Meta.
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === cfg.WHATSAPP_VERIFY_TOKEN) {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(url.searchParams.get("hub.challenge") ?? "");
    }
    return json(res, 403, { error: "verify token invalide" });
  }
  if (req.method !== "POST") return json(res, 405, {});

  const raw = await readRawBody(req);
  let inbound;
  if (cfg.WHATSAPP_PROVIDER === "meta") {
    if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
      logger.warn("webhook meta : signature invalide");
      return json(res, 401, {});
    }
    inbound = parseMetaWebhook(JSON.parse(raw.toString("utf8") || "{}"));
  } else {
    const params = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
    const publicUrl = (cfg.PUBLIC_URL ?? "").replace(/\/$/, "") + url.pathname;
    if (!verifyTwilioSignature(publicUrl, params, req.headers["x-twilio-signature"] as string | undefined)) {
      logger.warn("webhook twilio : signature invalide (PUBLIC_URL correct ?)");
      return json(res, 401, {});
    }
    inbound = parseTwilioWebhook(params);
  }
  // Répondre 200 tout de suite : Meta/Twilio réessaient sinon, et le raisonnement prend des secondes.
  res.writeHead(200, { "content-type": cfg.WHATSAPP_PROVIDER === "twilio" ? "text/xml" : "application/json" });
  res.end(cfg.WHATSAPP_PROVIDER === "twilio" ? "<Response></Response>" : "{}");

  const allowed = allowedNumbers();
  for (const m of inbound) {
    if (!allowed.has(m.from)) {
      logger.warn({ from: m.from }, "whatsapp : numéro non autorisé, ignoré");
      continue;
    }
    void markRead(m.id);
    // Les messages d'une même rafale (plusieurs photos, un texte puis sa
    // suite) sont retenus quelques secondes et traités ensemble : voir
    // channels/rafale.ts. Ils sont lus (pièce jointe → texte, dépôt du
    // fichier) dès maintenant, en parallèle, pour ne pas attendre deux fois.
    const prepared: Promise<string> = m.media
      ? mediaToText(m.media, m.from).then((t) => [t, m.text && m.text !== m.media?.caption ? m.text : ""].filter(Boolean).join("\n\n"))
      : Promise.resolve(m.text);
    prepared.catch(() => undefined);
    rafale.ajouter(m.from, { prepared, media: Boolean(m.media), vocal: m.media?.kind === "vocal", id: m.id }, m.id);
  }
}

type EntreeRafale = { prepared: Promise<string>; media: boolean; vocal: boolean; id: string };

const rafale = new Rafale<EntreeRafale>(
  async (peer, lot) => {
    const parts = await Promise.all(
      lot.map(async (e) => ({ texte: await e.prepared.catch((err) => `[message illisible : ${String(err).slice(0, 120)}]`), media: e.media })),
    );
    const text = assembler(parts);
    const extId = lot[lot.length - 1]!.id;
    const entrantVocal = lot.some((e) => e.vocal);
    try {
      const reply = await handleChat({ channel: "whatsapp", peer, text, extId });
      if (reply) await livrerReponse(peer, reply, { entrantVocal });
    } catch (e) {
      logger.error({ err: String(e) }, "whatsapp chat");
    }
  },
  (e) => e.media,
);

/* --- API ----------------------------------------------------------------------- */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/whatsapp/webhook") return whatsappWebhook(req, res, url);

  // Pages publiques exigées par Google pour publier l'écran de consentement
  // OAuth. Servies ici, sur l'adresse qui porte déjà le webhook : le domaine
  // et le tunnel existent, il n'y a rien de plus à héberger, et une politique
  // de confidentialité qui vit à côté du code ne décrit pas une version
  // d'il y a six mois. Volontairement sans authentification — Google doit
  // pouvoir les lire, et elles ne disent rien de privé.
  if (req.method === "GET" && PUBLIC_PAGES[url.pathname]) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
    return void res.end(PUBLIC_PAGES[url.pathname]!());
  }
  // Coffre d'identifiants. Sa propre authentification, avant le contrôle
  // Bearer : un navigateur ne sait pas envoyer d'en-tête Authorization sur
  // un formulaire. Le jeton passe UNE fois en ?k=, est échangé contre un
  // cookie, et la redirection le retire immédiatement de la barre d'adresse.
  if (url.pathname === "/login") return loginRoute(req, res, url);
  if (url.pathname === "/logout") {
    res.writeHead(302, { location: "/login", "set-cookie": "manzi_vault=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
    return void res.end();
  }
  if (url.pathname === "/vault") return vaultRoute(req, res, url);
  if (url.pathname === "/screen" || url.pathname.startsWith("/screen/")) return screenRoute(req, res, url);

  // Panneau : clés, fournisseurs, consommation, plafond. Même porte.
  if (url.pathname === "/panel") return panelRoute(req, res, url);

  // Tableau de bord. Même porte que le coffre et l'écran : un billet à usage
  // unique échangé contre un cookie. Il n'affiche que ce que l'API rendait
  // déjà — la nouveauté est qu'on peut le regarder depuis un téléphone.
  if (url.pathname === "/board" || url.pathname === "/board.json") {
    if (url.searchParams.get("t")) return ticketToCookie(req, res, url, "/board");
    if (!vaultCookieOk(req)) {
      if (url.pathname === "/board.json") return json(res, 401, { error: "connexion requise" });
      return versConnexion(res, "/board");
    }
    if (url.pathname === "/board.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return void res.end(await boardJson());
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    return void res.end(boardPage());
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    const spent = await spentToday().catch(() => -1);
    return json(res, spent < 0 ? 500 : 200, { ok: spent >= 0, mode: config().AUTONOMY_MODE, spentTodayUsd: spent, mcp: mcpStatus(), whatsapp: config().WHATSAPP_PROVIDER, jobs: scheduledJobs() });
  }
  if (!authorized(req)) return json(res, 401, { error: "Bearer ORCHESTRATOR_TOKEN requis" });

  const body = async () => JSON.parse((await readRawBody(req)).toString("utf8") || "{}") as Record<string, unknown>;

  if (req.method === "POST" && url.pathname === "/chat") {
    const b = await body();
    const text = typeof b.text === "string" ? b.text : "";
    const peer = typeof b.peer === "string" && b.peer ? b.peer : "api";
    if (!text.trim()) return json(res, 400, { error: "text requis" });
    return json(res, 200, { reply: await handleChat({ channel: "api", peer, text }) });
  }
  // --- Agents (section 48) ------------------------------------------------
  // Un segment d'URL peut contenir n'importe quoi : on décode, et l'identité
  // est validée par le store avant toute écriture.
  const agentPath = /^\/agents\/([^/]+)(?:\/(tasks|timeline|unblock))?$/.exec(url.pathname);

  if (url.pathname === "/agents") {
    if (req.method === "GET") return json(res, 200, await listAgents({ includeEphemeral: url.searchParams.get("all") === "1" }));
    if (req.method === "POST") {
      const b = await body();
      if (typeof b.id !== "string" || typeof b.name !== "string") return json(res, 400, { error: "id et name requis" });
      try {
        return json(res, 200, await createAgent(b as never));
      } catch (e) {
        return json(res, 400, { error: String(e instanceof Error ? e.message : e) });
      }
    }
    return json(res, 405, {});
  }

  if (agentPath) {
    const id = decodeURIComponent(agentPath[1]!);
    const sub = agentPath[2];
    const agent = await getAgent(id);
    if (!agent) return json(res, 404, { error: `agent ${id} inconnu` });

    if (!sub && req.method === "GET") return json(res, 200, { ...agent, spend24h: await agentSpend(id) });
    if (!sub && req.method === "DELETE") return json(res, 200, { deleted: await deleteAgent(id) });
    if (sub === "timeline" && req.method === "GET") return json(res, 200, await timeline(id, Number(url.searchParams.get("limit") ?? 50)));
    if (sub === "tasks" && req.method === "GET") return json(res, 200, await listTasks(id));
    if (sub === "tasks" && req.method === "POST") {
      const b = await body();
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (!title) return json(res, 400, { error: "title requis" });
      return json(res, 200, await createTask({
        agentId: id,
        title,
        brief: typeof b.brief === "string" ? b.brief : "",
        mission: typeof b.mission === "string" ? b.mission : undefined,
        priority: typeof b.priority === "number" ? b.priority : undefined,
        dependsOn: Array.isArray(b.depends_on) ? (b.depends_on as number[]) : undefined,
      }));
    }
    if (sub === "unblock" && req.method === "POST") {
      const b = await body();
      if (typeof b.task_id !== "number") return json(res, 400, { error: "task_id requis" });
      await unblockTask(b.task_id);
      return json(res, 200, { unblocked: b.task_id });
    }
    return json(res, 405, {});
  }

  if (req.method === "GET" && url.pathname === "/tasks") {
    const st = url.searchParams.get("status");
    return json(res, 200, await listTasks(undefined, st ? (st.split(",") as never) : undefined));
  }

  if (req.method === "GET" && url.pathname === "/missions") {
    const custom = await listCustomMissions();
    return json(res, 200, [
      ...MISSIONS.map((m) => ({ name: m.name, defaultCron: m.cron, model: m.model, budgetUsd: m.budgetUsd, source: "intégrée" })),
      ...custom.map((m) => ({ name: m.name, defaultCron: "", model: m.model, budgetUsd: m.budget_usd, source: `créée par ${m.created_by}` })),
    ]);
  }
  if (req.method === "GET" && url.pathname === "/schedules") return json(res, 200, { mode: config().AUTONOMY_MODE, schedules: await listSchedules(), jobs: scheduledJobs() });
  const mission = url.pathname.match(/^\/missions\/([a-z0-9_]+)$/);
  if (req.method === "POST" && mission) {
    const m = await resolveMission(mission[1]!);
    if (!m) return json(res, 404, { error: "mission inconnue" });
    void launch(m).catch((e) => logger.error({ err: String(e) }, "mission HTTP"));
    return json(res, 202, { started: m.name });
  }
  if (req.method === "POST" && url.pathname === "/report") {
    void withLock("report", buildAndDeliverReport).catch((e) => logger.error({ err: String(e) }, "report HTTP"));
    return json(res, 202, { started: "report" });
  }
  if (req.method === "POST" && url.pathname === "/swarm") {
    const b = await body();
    const objective = typeof b.objective === "string" ? b.objective.trim() : "";
    if (objective.length < 10) return json(res, 400, { error: "objective (≥10 caractères) requis" });
    const id = `sw_${Date.now().toString(36)}`;
    swarms.set(id, { status: "running", objective, startedAt: new Date().toISOString() });
    void runSwarm(objective, { budgetUsd: typeof b.budgetUsd === "number" ? b.budgetUsd : undefined })
      .then((r) => swarms.set(id, { ...swarms.get(id)!, status: "done", result: { merged: r.merged, totalUsd: r.totalUsd, wallSeconds: r.wallSeconds, subtasks: r.results.map((x) => ({ id: x.id, role: x.role, status: x.status, seconds: Math.round(x.seconds), usd: x.usage.usd })) } }))
      .catch((e) => swarms.set(id, { ...swarms.get(id)!, status: "failed", error: String(e) }));
    return json(res, 202, { id });
  }
  const sw = url.pathname.match(/^\/swarm\/(sw_[a-z0-9]+)$/);
  if (req.method === "GET" && sw) {
    const s = swarms.get(sw[1]!);
    return s ? json(res, 200, s) : json(res, 404, { error: "inconnu" });
  }
  if (req.method === "GET" && url.pathname === "/reports/latest") {
    const r = await db().query<{ day: string; markdown: string }>(`SELECT day, markdown FROM reports ORDER BY day DESC LIMIT 1`);
    return r.rows[0] ? json(res, 200, r.rows[0]) : json(res, 404, { error: "aucun rapport" });
  }
  json(res, 404, { error: "route inconnue" });
}

async function main(): Promise<void> {
  const cfg = config();
  // La longueur du jeton, jamais sa valeur : un 401 sur l'API locale vient presque
  // toujours d'un jeton absent (0) ou porteur d'un caractère invisible — un \r de
  // fin de ligne Windows. Sans ce chiffre au démarrage, le diagnostic se fait à
  // l'aveugle, et l'erreur « jeton requis » ne dit pas que le jeton est là mais faux.
  logger.info(
    {
      tz: cfg.TZ,
      mode: cfg.AUTONOMY_MODE,
      provider: cfg.LLM_PROVIDER,
      critical: cfg.LLM_PROVIDER_CRITICAL ?? cfg.LLM_PROVIDER,
      whatsapp: cfg.WHATSAPP_PROVIDER,
      pool: cfg.SANDBOX_POOL || "(défaut)",
      apiTokenLen: cfg.ORCHESTRATOR_TOKEN?.length ?? 0,
      apiTokenClean: /^[A-Za-z0-9_-]*$/.test(cfg.ORCHESTRATOR_TOKEN ?? ""),
    },
    "boot",
  );

  await migrate();
  await ouvrirBoiteNoire().catch((e) => logger.warn({ err: String(e) }, "boîte noire non ouverte"));
  await connectMcpServers();

  const probe = await sandboxExec("node -v && git --version", { timeoutMs: 20_000 });
  if (probe.code !== 0) logger.error({ probe }, "sandbox injoignable — les missions code échoueront");
  else logger.info({ sandbox: probe.stdout.trim().replace(/\n/g, " ") }, "sandbox OK");
  if (!cfg.ORCHESTRATOR_TOKEN) logger.warn("ORCHESTRATOR_TOKEN absent : API HTTP désactivée (sauf /healthz et webhook)");

  // APRÈS migrate : la reprise des tâches orphelines écrit dans des tables
  // qui doivent exister. AVANT le scheduler : une routine qui déclenche une
  // tâche doit trouver une file déjà vidée de ses orphelines.
  await seedFromEnv().catch(() => 0);
  await startRuntime();
  // Rappels et tâches planifiées. Un rappel est une alarme : texte envoyé
  // tel quel, sans modèle. Une tâche passe par le chat, avec tous ses
  // outils, et son résultat part par `deliverWhatsApp` — qui bascule sur le
  // modèle approuvé hors de la fenêtre de 24 h : un rappel de 9 h ne doit pas
  // se perdre parce que Lionel n'a rien écrit depuis la veille.
  await demarrerRappels((r) => dansTrace("rappel", `${r.type === "tache" ? "Tâche" : "Rappel"} n°${r.id} : ${r.quoi.slice(0, 100)}`, async () => {
    if (!whatsappEnabled()) return "WhatsApp non configuré : rien envoyé";
    if (r.type === "rappel") {
      const ok = await deliverWhatsApp(r.peer, `⏰ ${r.quoi}`);
      return ok ? "envoyé" : "non livré";
    }
    const reponse = await handleChat({
      channel: "whatsapp",
      peer: r.peer,
      text: `[Tâche planifiée n°${r.id}, que tu as enregistrée sur ordre de Lionel — exécute-la maintenant et donne le résultat] ${r.quoi}`,
    });
    if (reponse) await deliverWhatsApp(r.peer, reponse);
    return reponse || "(réponse vide)";
  })).catch((e) => logger.error({ err: String(e) }, "rappels non démarrés"));
  // Déclencheurs e-mail : le résultat part au numéro principal.
  demarrerDeclencheurs(async (texte) => {
    const to = primaryNumber();
    if (to && whatsappEnabled()) await deliverWhatsApp(to, texte);
  });
  // L'inspecteur : un passage par jour sur la boîte noire, résumé sur
  // WhatsApp seulement si quelque chose de grave est nouveau.
  await demarrerInspecteur(
    async (texte) => {
      const to = primaryNumber();
      if (to && whatsappEnabled()) await deliverWhatsApp(to, texte);
    },
    async () => {
      const base = config().PUBLIC_URL;
      if (!base) return undefined;
      const t = await createVaultTicket(120);
      return `${base}/panel?t=${t.id}&s=diagnostic`;
    },
  ).catch((e) => logger.error({ err: String(e) }, "inspecteur non démarré"));
  await startScheduler();
  if (cfg.HEARTBEAT_ALERTS) { startHeartbeat(); startKeyWatch(); }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err: String(err) }, "http");
      if (!res.headersSent) json(res, 500, { error: "erreur interne" });
    });
  });
  // Le flux d'image de noVNC est une WebSocket : elle ne passe pas par le
  // gestionnaire HTTP. Sans ce branchement, la page s'affiche, reste noire,
  // et n'explique rien.
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/screen") || !vaultCookieOk(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void socket.destroy();
    }
    proxyScreenSocket(req, socket, head);
  });
  server.listen(cfg.HEALTH_PORT, "0.0.0.0", () => logger.info({ port: cfg.HEALTH_PORT }, "api"));

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "arrêt");
    stopScheduler();
  stopRuntime();
    server.close();
    await disconnectMcpServers();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, "boot échoué");
  process.exit(1);
});

/**
 * Heartbeat : toutes les heures, vérifie DB + sandbox. Alerte UNE fois quand ça casse,
 * une fois quand ça revient. Ce n'est pas une mission (aucun LLM, aucune action) : un état de santé.
 */
function startHeartbeat(): void {
  let down = false;
  const check = async () => {
    let problem = "";
    try {
      await db().query("SELECT 1");
    } catch (e) {
      problem = `Postgres injoignable (${String(e).slice(0, 120)})`;
    }
    if (!problem) {
      const p = await sandboxExec("true", { timeoutMs: 15_000 });
      if (p.code !== 0) problem = `sandbox injoignable (${p.stderr.slice(0, 120)})`;
    }
    if (problem && !down) {
      down = true;
      logger.error({ problem }, "heartbeat: panne");
      const msg = `⚠️ Manzi Junior : ${problem}. Les missions échoueront jusqu'à réparation (docker compose ps / logs).`;
      const to = primaryNumber();
      if (to) await deliverWhatsApp(to, msg).catch(() => false);
      const { sendTelegram } = await import("./tools/notify.js");
      await sendTelegram(msg).catch(() => false);
    } else if (!problem && down) {
      down = false;
      const to = primaryNumber();
      if (to) await deliverWhatsApp(to, "✅ Manzi Junior : de retour en service.").catch(() => false);
    }
  };
  setInterval(() => void check().catch((e) => logger.error({ err: String(e) }, "heartbeat")), 60 * 60_000).unref();
}

/**
 * Surveillance des clés : une clé morte doit se signaler, pas se découvrir.
 *
 * Le 22 septembre, un jeton GitHub refusé a coûté 2,28 $ et une soirée. Il
 * n'était mort nulle part de visible : le .env le contenait, le panneau
 * l'affichait « actif », et seul un appel réel disait qu'il était refusé.
 * On a donc appris la panne par la facture.
 *
 * Toutes les six heures, chaque service à clé est réellement appelé. Une
 * seule alerte par service quand il casse, une quand il revient — et le lien
 * du panneau dans le message, pour que la réparation tienne en un geste.
 *
 * L'état « déjà signalé » vit dans la table `settings`, pas en mémoire : sans
 * ça, chaque redémarrage réalerterait sur une panne connue, et une alerte
 * qu'on apprend à ignorer ne sert plus à rien.
 */
function startKeyWatch(): void {
  const check = async () => {
    const services = await listProviders().catch(() => []);
    for (const s of services) {
      if (!s.enabled || !s.has_key) continue;
      const verdict = await testProvider(s.id).catch(() => undefined);
      if (!verdict) continue; // Pas de verdict : on ne réveille personne sur un doute.
      const cle = `alerte_cle_${s.id}`;
      const connu = await setting(cle);
      const etat = verdict.ok ? "ok" : "ko";
      if (etat === connu) continue;
      await setSetting(cle, etat);

      const to = primaryNumber();
      if (!to) continue;
      if (verdict.ok) {
        // Rien à signaler au premier passage : seul un RETOUR après panne mérite un message.
        if (connu === "ko") await deliverWhatsApp(to, `✅ La clé ${s.label || s.id} refonctionne. Je reprends ce qui attendait.`).catch(() => false);
        continue;
      }
      logger.error({ service: s.id, raison: verdict.message }, "clé de service refusée");
      const base = config().PUBLIC_URL;
      const lignes = [
        `🔑 La clé ${s.label || s.id} ne marche plus.`,
        verdict.message,
        "",
        "Ce qui en dépend attend — rien ne se relance dans le vide, rien ne brûle.",
      ];
      if (base) {
        const t = await createVaultTicket(15).catch(() => undefined);
        if (t) lignes.push("", "Corrige-la ici :", `${base}/panel?t=${t.id}`, "", "Valable 15 min, une seule ouverture.");
      }
      await deliverWhatsApp(to, lignes.join("\n")).catch(() => false);
    }
  };
  // Deux minutes après le démarrage : assez pour que la base et le réseau
  // soient prêts, assez tôt pour qu'un redémarrage serve de vérification.
  setTimeout(() => void check().catch((e) => logger.error({ err: String(e) }, "surveillance des clés")), 2 * 60_000).unref();
  setInterval(() => void check().catch((e) => logger.error({ err: String(e) }, "surveillance des clés")), 6 * 60 * 60_000).unref();
}
