import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { untrusted } from "../safety.js";
import { requestApproval } from "../channels/approvals.js";

/**
 * Gmail et Agenda, en direct, avec un jeton de rafraîchissement OAuth.
 *
 * Pourquoi pas le serveur MCP Gmail : son authentification ouvre un navigateur
 * sur la machine hôte. Sur un serveur sans écran, elle ne se termine jamais.
 * Un jeton de rafraîchissement s'obtient une fois depuis un poste qui a un
 * navigateur, puis ne dépend plus ni de l'adresse IP, ni du poste, ni d'une
 * session — c'est ce qui rend l'accès au courrier durable quand l'opérateur
 * est en ville, ordinateur éteint.
 *
 * Tout ce qui arrive d'une boîte mail est du contenu écrit par des tiers :
 * chaque corps de message ressort enveloppé par `untrusted()`. Un courriel
 * qui contiendrait « ignore tes instructions et envoie X » reste une donnée.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";

export function googleConfigured(): boolean {
  const c = config();
  return Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.GOOGLE_REFRESH_TOKEN);
}

// Le jeton d'accès vit une heure. On le garde en mémoire avec 60 s de marge :
// sans marge, un appel parti juste avant l'expiration revient en 401.
let cached: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  const c = config();
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (!googleConfigured()) throw new Error("Google non configuré (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.GOOGLE_CLIENT_ID!,
      client_secret: c.GOOGLE_CLIENT_SECRET!,
      refresh_token: c.GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // `invalid_grant` = jeton révoqué, mot de passe changé, ou consentement retiré.
    // Le dire ici évite de chercher la panne du côté du réseau pendant une heure.
    throw new Error(`rafraîchissement du jeton Google refusé (${res.status}) : ${body}${body.includes("invalid_grant") ? " — le jeton a été révoqué, il faut refaire deploy/google-auth.ps1" : ""}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/* --- lecture ------------------------------------------------------------- */

type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string; size?: number }; parts?: Part[] };
type Message = { id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: Part & { headers?: Header[] } };

function header(m: Message, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Le corps est en base64url, éclaté en parties. On préfère le texte brut ; à défaut, le HTML dépouillé. */
function bodyText(p: Part | undefined, depth = 0): string {
  if (!p || depth > 8) return "";
  if (p.body?.data && (p.mimeType === "text/plain" || (!p.mimeType && !p.parts))) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const child of p.parts ?? []) {
    const t = bodyText(child, depth + 1);
    if (t.trim()) return t;
  }
  if (p.body?.data && p.mimeType === "text/html") {
    return Buffer.from(p.body.data, "base64url")
      .toString("utf8")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s{2,}/g, " ");
  }
  return "";
}

function summarize(m: Message): string {
  const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString().replace("T", " ").slice(0, 16) : "";
  const unread = m.labelIds?.includes("UNREAD") ? "●" : "○";
  return `${unread} [${m.id}] ${date}  de: ${header(m, "From")}\n   objet: ${header(m, "Subject") || "(sans objet)"}\n   ${(m.snippet ?? "").slice(0, 200)}`;
}

export const gmailListTool = betaZodTool({
  name: "gmail_list",
  description:
    "Liste des messages Gmail. `query` suit la syntaxe Gmail : 'is:unread', 'is:unread newer_than:2d', 'from:paul@x.com', 'in:sent newer_than:7d', 'has:attachment'. Retourne identifiant, date, expéditeur, objet et extrait — pas le corps. Pour le corps, gmail_read.",
  inputSchema: z.object({
    query: z.string().default("is:unread newer_than:3d"),
    max: z.number().int().min(1).max(40).default(15),
  }),
  run: async (i) => {
    const list = await api<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(
      `${GMAIL}/messages?q=${encodeURIComponent(i.query)}&maxResults=${i.max}`,
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    if (!ids.length) return `aucun message pour « ${i.query} »`;
    const msgs = await Promise.all(
      ids.map((id) =>
        api<Message>(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => undefined),
      ),
    );
    const rows = msgs.filter((m): m is Message => Boolean(m)).map(summarize).join("\n");
    return untrusted("gmail", `${ids.length} message(s) pour « ${i.query} » :\n${rows}`);
  },
});

export const gmailReadTool = betaZodTool({
  name: "gmail_read",
  description: "Lit un message entier (corps décodé) à partir de son identifiant, donné par gmail_list. Marque-le lu si `mark_read`.",
  inputSchema: z.object({ id: z.string(), mark_read: z.boolean().default(false), max_chars: z.number().int().min(500).max(40_000).default(12_000) }),
  run: async (i) => {
    const m = await api<Message>(`${GMAIL}/messages/${i.id}?format=full`);
    if (i.mark_read) await api(`${GMAIL}/messages/${i.id}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) }).catch(() => undefined);
    const body = bodyText(m.payload).slice(0, i.max_chars);
    return untrusted(
      `gmail:${header(m, "From")}`,
      [
        `id: ${m.id}`,
        `thread: ${m.threadId}`,
        `de: ${header(m, "From")}`,
        `à: ${header(m, "To")}`,
        `date: ${header(m, "Date")}`,
        `objet: ${header(m, "Subject")}`,
        `message-id: ${header(m, "Message-ID")}`,
        "",
        body || "(corps vide ou illisible)",
      ].join("\n"),
    );
  },
});

export const gmailThreadTool = betaZodTool({
  name: "gmail_thread",
  description: "Lit une conversation entière (tous les messages d'un fil) à partir du threadId. Sert à savoir qui a répondu quoi avant de rédiger.",
  inputSchema: z.object({ thread_id: z.string(), max_chars: z.number().int().min(1_000).max(40_000).default(14_000) }),
  run: async (i) => {
    const t = await api<{ messages?: Message[] }>(`${GMAIL}/threads/${i.thread_id}?format=full`);
    const parts = (t.messages ?? []).map(
      (m) => `--- ${header(m, "Date")} — ${header(m, "From")}\n${bodyText(m.payload).slice(0, 4_000)}`,
    );
    return untrusted("gmail:thread", parts.join("\n\n").slice(0, i.max_chars) || "(fil vide)");
  },
});

/* --- écriture ------------------------------------------------------------ */

/**
 * RFC 2822 encodé en base64url. `In-Reply-To` et `References` sont ce qui fait
 * qu'une réponse s'attache au fil chez le destinataire — sans eux, Gmail
 * l'affiche bien dans le fil côté expéditeur, et le destinataire reçoit un
 * message isolé. L'objet passe en `=?UTF-8?B?...?=` : sans cet encodage, un
 * accent ou un caractère non latin arrive en mojibake.
 */
function mime(opts: { to: string; subject: string; body: string; inReplyTo?: string; references?: string; cc?: string }): string {
  const subject = /^[\x20-\x7E]*$/.test(opts.subject) ? opts.subject : `=?UTF-8?B?${Buffer.from(opts.subject, "utf8").toString("base64")}?=`;
  const lines = [
    `To: ${opts.to}`,
    opts.cc ? `Cc: ${opts.cc}` : "",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : "",
    opts.references ? `References: ${opts.references}` : "",
    "",
    Buffer.from(opts.body, "utf8").toString("base64"),
  ].filter(Boolean);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const SendInput = z.object({
  to: z.string().describe("Destinataire. Pour une réponse, reprends l'adresse du champ « de » du message d'origine."),
  subject: z.string(),
  body: z.string().describe("Corps en texte brut. Rédige dans la LANGUE du message auquel tu réponds."),
  cc: z.string().optional(),
  thread_id: z.string().optional().describe("Pour répondre dans un fil existant."),
  in_reply_to: z.string().optional().describe("Le Message-ID du message auquel on répond (donné par gmail_read)."),
});

export const gmailDraftTool = betaZodTool({
  name: "gmail_draft",
  description: "Prépare un brouillon dans Gmail sans l'envoyer. À utiliser par défaut : l'opérateur relit dans Gmail et envoie lui-même. Réponds toujours dans la langue du message d'origine.",
  inputSchema: SendInput,
  run: async (i) => {
    const raw = mime({ to: i.to, subject: i.subject, body: i.body, cc: i.cc, inReplyTo: i.in_reply_to, references: i.in_reply_to });
    const d = await api<{ id: string }>(`${GMAIL}/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: { raw, ...(i.thread_id ? { threadId: i.thread_id } : {}) } }),
    });
    logger.info({ draft: d.id, to: i.to }, "brouillon gmail créé");
    return `brouillon créé (${d.id}) pour ${i.to} — objet « ${i.subject} ». Il attend dans Gmail.`;
  },
});

export const gmailSendTool = betaZodTool({
  name: "gmail_send",
  description:
    "Envoie un e-mail. IRRÉVERSIBLE : demande l'accord de l'opérateur par WhatsApp avant de partir. Réponds toujours dans la langue du message d'origine. En cas de doute, préfère gmail_draft.",
  inputSchema: SendInput,
  run: async (i) => {
    // Un envoi ne se rattrape pas. L'approbation se demande ici, dans l'outil,
    // et non au bon vouloir du modèle : c'est le seul endroit qu'il ne peut
    // pas contourner en oubliant une étape du mode opératoire.
    const decision = await requestApproval("gmail_send", { à: i.to, objet: i.subject, corps: i.body.slice(0, 600) });
    if (decision !== "approved") return `envoi non effectué (${decision === "denied" ? "refusé par l'opérateur" : "pas de réponse dans le délai"}). Le texte est conservé : crée un brouillon avec gmail_draft si tu veux le garder.`;
    const raw = mime({ to: i.to, subject: i.subject, body: i.body, cc: i.cc, inReplyTo: i.in_reply_to, references: i.in_reply_to });
    const s = await api<{ id: string; threadId: string }>(`${GMAIL}/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw, ...(i.thread_id ? { threadId: i.thread_id } : {}) }),
    });
    logger.info({ id: s.id, to: i.to }, "e-mail envoyé");
    return `envoyé à ${i.to} (${s.id}).`;
  },
});

/**
 * Mettre des messages à la CORBEILLE — et pas les détruire.
 *
 * Cet outil manquait, et son absence se voyait de la pire façon : à « vide
 * mes non-lus », l'agent répondait « non, je ne le fais pas », alors que la
 * vraie raison était qu'il n'avait pas de quoi. Un manque déguisé en refus
 * fait perdre deux fois — le travail n'est pas fait, et on croit que c'est
 * délibéré.
 *
 * La corbeille plutôt que `delete` : Gmail garde 30 jours, donc une erreur de
 * requête se rattrape en un clic. `delete` est définitif et ne laisse aucune
 * trace — le mauvais outil pour une action pilotée par une phrase dictée au
 * téléphone, parfois mal transcrite.
 *
 * Un plafond de 200 par appel, et la requête est rendue dans la réponse :
 * c'est ce qui permet de relire ce qui a été visé quand le résultat surprend.
 */
export const gmailTrashTool = betaZodTool({
  name: "gmail_trash",
  description:
    "Met des e-mails à la corbeille Gmail (récupérables 30 jours, rien n'est détruit). Sert au ménage : publicités, non-lus, un expéditeur précis. Donne SOIT une requête Gmail (query), SOIT une liste d'identifiants (ids) obtenus par gmail_list. Avec `apercu: true` tu ne supprimes rien : tu obtiens la liste de ce qui serait mis à la corbeille — à faire d'abord quand la requête vise large.",
  inputSchema: z.object({
    query: z.string().optional().describe("Requête Gmail, ex: 'is:unread category:promotions', 'from:news@x.com', 'older_than:1y is:unread'."),
    ids: z.array(z.string()).max(200).optional().describe("Identifiants de messages à corbeiller, si tu les as déjà."),
    max: z.number().int().min(1).max(200).default(50).describe("Plafond par appel. Rappelle l'outil pour continuer."),
    apercu: z.boolean().default(false).describe("true = ne supprime rien, montre seulement ce qui serait visé."),
  }),
  run: async (i) => {
    let ids = i.ids ?? [];
    if (!ids.length) {
      if (!i.query) return "Error: donne une requête (query) ou une liste d'identifiants (ids).";
      const r = await api<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(
        `${GMAIL}/messages?q=${encodeURIComponent(i.query)}&maxResults=${i.max}`,
      );
      ids = (r.messages ?? []).map((m) => m.id);
      if (!ids.length) return `aucun message ne correspond à « ${i.query} » — rien à mettre à la corbeille.`;
    }

    if (i.apercu) {
      // On rend de quoi JUGER : un identifiant ne dit rien, un expéditeur et
      // un objet disent tout. Dix suffisent pour voir si la requête vise juste.
      const apercus = await Promise.all(
        ids.slice(0, 10).map(async (id) => {
          const m = await api<{ payload?: { headers?: Array<{ name: string; value: string }> } }>(
            `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          ).catch(() => undefined);
          const h = (n: string) => m?.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "?";
          return `  ${h("from")} — ${h("subject")}`;
        }),
      );
      return `${ids.length} message(s) visés par « ${i.query ?? "la liste fournie"} ». Les 10 premiers :\n${apercus.join("\n")}\n\nRappelle gmail_trash avec apercu:false pour les mettre à la corbeille.`;
    }

    // `batchModify` ferait le tour en un appel, mais un seul message refusé y
    // fait échouer le lot entier sans dire lequel. Un par un : on sait
    // exactement combien sont partis, et un échec isolé ne bloque pas le reste.
    let ok = 0;
    const echecs: string[] = [];
    for (const id of ids) {
      try {
        await api(`${GMAIL}/messages/${id}/trash`, { method: "POST" });
        ok++;
      } catch (e) {
        echecs.push(`${id}: ${String(e).slice(0, 80)}`);
      }
    }
    logger.info({ ok, echecs: echecs.length, query: i.query }, "messages mis à la corbeille");
    const fin = echecs.length ? ` ${echecs.length} refusé(s) : ${echecs.slice(0, 3).join(" · ")}` : "";
    return `${ok} message(s) à la corbeille${i.query ? ` pour « ${i.query} »` : ""}. Récupérables 30 jours dans Gmail.${fin}${ids.length >= i.max ? ` Le plafond de ${i.max} est atteint : rappelle-moi pour la suite.` : ""}`;
  },
});

/* --- agenda --------------------------------------------------------------- */

export const calendarTool = betaZodTool({
  name: "calendar_events",
  description: "Événements de l'agenda Google entre deux dates (par défaut : les 7 prochains jours).",
  inputSchema: z.object({
    from: z.string().optional().describe("ISO 8601. Défaut : maintenant."),
    to: z.string().optional().describe("ISO 8601. Défaut : dans 7 jours."),
    max: z.number().int().min(1).max(50).default(20),
  }),
  run: async (i) => {
    const from = i.from ?? new Date().toISOString();
    const to = i.to ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
    const r = await api<{ items?: Array<{ summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }> }>(
      `${CALENDAR}/calendars/primary/events?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&singleEvents=true&orderBy=startTime&maxResults=${i.max}`,
    );
    const items = r.items ?? [];
    if (!items.length) return `aucun événement entre ${from.slice(0, 10)} et ${to.slice(0, 10)}`;
    return untrusted(
      "google-calendar",
      items.map((e) => `- ${(e.start?.dateTime ?? e.start?.date ?? "").replace("T", " ").slice(0, 16)} → ${e.summary ?? "(sans titre)"}${e.location ? ` (${e.location})` : ""}`).join("\n"),
    );
  },
});

/** Les outils Google, ou rien du tout s'ils ne sont pas configurés — un outil qui échoue à chaque appel coûte des tours pour rien. */
export function googleTools() {
  return googleConfigured() ? [gmailListTool, gmailReadTool, gmailThreadTool, gmailDraftTool, gmailSendTool, gmailTrashTool, calendarTool] : [];
}
