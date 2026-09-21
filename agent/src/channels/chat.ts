import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { runAgent, resolveModel } from "../llm.js";
import { logger } from "../logger.js";
import { db } from "../memory/db.js";
import { memoryTool, memoryDigest, rememberFact, recallFacts, taskTool, episodesTool, feedbackTool, captureFeedback, spentToday } from "../memory/store.js";
import { MISSIONS, resolveMission } from "../missions/index.js";
import { listCustomMissions, saveCustomMission, deleteCustomMission, NAME_RE, TOOLSETS, MODELS, type Toolset, type ModelKind } from "../missions/custom.js";
import { buildAndDeliverReport } from "../missions/report.js";
import { launch, withLock, setSchedule, listSchedules } from "../scheduler.js";
import { runSwarm } from "../swarm/coordinator.js";
import { searchTools } from "../tools/search.js";
import { sendWhatsApp } from "./whatsapp.js";
import { handleApprovalReply } from "./approvals.js";

/**
 * Le chat : ce que tu vois dans WhatsApp (ou par l'API /chat pour Jarvis).
 *
 * Principe « ordre explicite » : ce module est la SEULE porte d'entrée en mode manuel.
 * Il ne lance rien de lui-même ; il expose des outils que le modèle appelle quand tu
 * le lui demandes : lancer une mission, un essaim, lire le rapport, planifier ou
 * déplanifier une mission (le planning est un ordre visible, jamais une règle cachée).
 *
 * Chaque numéro a sa conversation (table chat_messages) ; les messages d'un même
 * numéro sont traités en série ; les tâches longues répondent immédiatement puis
 * envoient un second message à la fin.
 */

const CHAT_SYSTEM = `Tu es Manzi Junior, l'agent de l'opérateur, joignable sur WhatsApp. Tu es son bras droit : compétent, direct, chaleureux, jamais bavard.

Style WhatsApp : messages courts (1 à 6 lignes), pas de markdown lourd (pas de #, pas de tableaux), listes avec des tirets si besoin, emojis rares. Tutoiement.

Règle absolue : tu n'agis que sur ordre explicite. Quand l'opérateur demande une action, tu l'exécutes avec l'outil adéquat puis tu confirmes en une phrase (ce qui est lancé, combien de temps, ce qu'il recevra). Tu ne proposes pas d'actions automatiques ; si une action pourrait être planifiée, tu le mentionnes en une ligne et tu attends son ordre.

Les tâches longues (mission, essaim) : lance, réponds tout de suite « lancé, je t'écris quand c'est fini », et c'est tout — un message de fin arrivera automatiquement.

Missions sur mesure : quand l'opérateur décrit un travail qu'il voudra refaire (« surveille X », « chaque semaine, compare Y »), crée-la avec create_mission plutôt que de l'exécuter une fois et l'oublier. Rédige l'objectif toi-même, en cahier des charges précis, à partir de ce qu'il a dit — ne lui demande pas de le formuler. Confirme en une ligne, puis demande s'il veut la lancer maintenant ou la planifier. Il peut en créer autant qu'il veut.

Ne fabrique aucun chiffre. Consulte recall_facts / read_episodes / latest_report avant de dire « je ne sais pas ». Les préférences de l'opérateur vont dans remember_fact avec topic 'profil:...'.

Si l'opérateur dit « stop » ou « annule » : réponds « ok » sans rien lancer.`;

type Notify = (text: string) => Promise<void>;

function controlTools(notify: Notify) {
  const runMission = betaZodTool({
    name: "run_mission",
    description: `Lance immédiatement une mission (asynchrone). Missions intégrées : ${MISSIONS.map((m) => m.name).join(", ")}, report. Les missions créées par l'opérateur marchent pareil — list_missions les énumère. L'opérateur recevra un message à la fin.`,
    inputSchema: z.object({ name: z.string() }),
    run: async (i) => {
      if (i.name === "report") {
        void withLock("report", buildAndDeliverReport).then(() => notify("📋 Rapport envoyé.")).catch((e) => notify(`Rapport en échec : ${String(e).slice(0, 200)}`));
        return "rapport lancé";
      }
      const m = await resolveMission(i.name);
      if (!m) return `Error: mission inconnue (${MISSIONS.map((x) => x.name).join(", ")}, + celles de list_missions)`;
      void launch(m)
        .then((r) => notify(r ? `✅ ${m.name} terminée (${r.status}, ${r.usage.usd.toFixed(2)} $).\n${r.text.slice(0, 1200)}` : `${m.name} : déjà en cours ou plafond journalier atteint.`))
        .catch((e) => notify(`❌ ${m.name} en erreur : ${String(e).slice(0, 200)}`));
      return `mission ${m.name} lancée (budget ${m.budgetUsd} $, ~${Math.round(m.maxIterations / 6)} min)`;
    },
  });

  const swarm = betaZodTool({
    name: "run_swarm",
    description: "Lance un essaim de sous-agents parallèles sur un objectif complet (asynchrone, 5-20 min). Donne un objectif précis avec critères de succès.",
    inputSchema: z.object({ objective: z.string().min(10), budget_usd: z.number().positive().max(50).optional() }),
    run: async (i) => {
      void runSwarm(i.objective, { budgetUsd: i.budget_usd })
        .then((r) => notify(`🐝 Essaim terminé en ${Math.round(r.wallSeconds / 60)} min pour ${r.totalUsd.toFixed(2)} $.\n\n${r.merged.slice(0, 2500)}`))
        .catch((e) => notify(`❌ Essaim en erreur : ${String(e).slice(0, 200)}`));
      return "essaim lancé";
    },
  });

  const latestReport = betaZodTool({
    name: "latest_report",
    description: "Dernier rapport du matin (markdown).",
    inputSchema: z.object({}),
    run: async () => {
      const r = await db().query<{ day: string; markdown: string }>(`SELECT day, markdown FROM reports ORDER BY day DESC LIMIT 1`);
      return r.rows[0] ? `${r.rows[0].day}\n${r.rows[0].markdown}` : "aucun rapport";
    },
  });

  const schedule = betaZodTool({
    name: "schedule_mission",
    description:
      "Planifie (ou déplanifie) une mission sur ordre de l'opérateur. C'est le SEUL moyen qu'une mission tourne sans ordre direct ; le planning est visible via list_schedules. cron 5 champs en heure locale (ex: '0 5 * * *' = tous les jours 5h ; '30 7 * * 1-5' = 7h30 en semaine), ou 'off' pour retirer.",
    inputSchema: z.object({ name: z.string(), cron: z.string() }),
    run: async (i) => {
      if (i.name !== "report" && !(await resolveMission(i.name))) return "Error: mission inconnue";
      await setSchedule(i.name, i.cron === "off" ? null : i.cron, "whatsapp");
      return i.cron === "off" ? `${i.name} déplanifiée` : `${i.name} planifiée : ${i.cron}`;
    },
  });

  const schedules = betaZodTool({
    name: "list_schedules",
    description: "Planning en vigueur (missions planifiées sur ordre) et mode d'autonomie.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await listSchedules();
      return `mode: ${config().AUTONOMY_MODE}\n` + (rows.map((r) => `- ${r.mission}: ${r.cron} (ordre du ${r.created_at.slice(0, 10)} via ${r.created_by})`).join("\n") || "- aucun planning : rien ne tourne sans ordre");
    },
  });

  const spend = betaZodTool({
    name: "spend_today",
    description: "Dépense LLM du jour et plafond.",
    inputSchema: z.object({}),
    run: async () => `${(await spentToday()).toFixed(2)} $ / plafond ${config().DAILY_BUDGET_USD} $`,
  });

  // Créer une mission depuis WhatsApp plutôt que dans le code : l'opérateur en
  // ajoute autant qu'il veut, elles passent par le même moteur et les mêmes
  // garde-fous que les neuf missions intégrées.
  const createMission = betaZodTool({
    name: "create_mission",
    description:
      "Crée (ou remplace) une mission durable définie par l'opérateur. À utiliser dès qu'il décrit un travail récurrent. L'objectif doit être rédigé comme un cahier des charges : quoi faire, sur quoi, et le critère de succès. Réutiliser un nom existant écrase la mission.",
    inputSchema: z.object({
      name: z.string().regex(NAME_RE, "minuscules, chiffres et _ ; commence par une lettre ; 3 à 40 caractères"),
      objective: z.string().min(40, "décris la mission en détail : étapes et critère de succès"),
      toolset: z
        .enum(TOOLSETS)
        .default("recherche")
        .describe("recherche = web, scraping, navigateur | code = sandbox, fichiers | complet = les deux"),
      model: z.enum(MODELS).default("worker").describe("worker = courant | planner = raisonnement | critical = écrit du code ou déploie"),
      budget_usd: z.number().positive().max(10).default(1),
      max_iterations: z.number().int().min(5).max(120).default(30),
    }),
    run: async (i) => {
      if (MISSIONS.some((m) => m.name === i.name) || i.name === "report") return `Error: « ${i.name} » est une mission intégrée, choisis un autre nom`;
      await saveCustomMission({
        name: i.name,
        objective: i.objective,
        toolset: i.toolset as Toolset,
        model: i.model as ModelKind,
        budgetUsd: i.budget_usd,
        maxIterations: i.max_iterations,
        createdBy: "whatsapp",
      });
      return `mission « ${i.name} » enregistrée (${i.toolset}, ${i.model}, ${i.budget_usd} $). Lance-la avec run_mission, planifie-la avec schedule_mission.`;
    },
  });

  const deleteMission = betaZodTool({
    name: "delete_mission",
    description: "Supprime une mission créée par l'opérateur. Les missions intégrées ne sont pas supprimables.",
    inputSchema: z.object({ name: z.string() }),
    run: async (i) => ((await deleteCustomMission(i.name)) ? `mission « ${i.name} » supprimée` : `aucune mission créée nommée « ${i.name} »`),
  });

  const listMissions = betaZodTool({
    name: "list_missions",
    description: "Liste toutes les missions : les intégrées et celles créées par l'opérateur.",
    inputSchema: z.object({}),
    run: async () => {
      const custom = await listCustomMissions();
      return [
        `intégrées : ${MISSIONS.map((m) => m.name).join(", ")}, report`,
        custom.length
          ? `créées par toi :\n${custom.map((m) => `- ${m.name} (${m.toolset}, ${m.model}, ${m.budget_usd} $) : ${m.objective.slice(0, 120)}`).join("\n")}`
          : "créées par toi : aucune pour l'instant",
      ].join("\n");
    },
  });

  const playbooks = betaZodTool({
    name: "show_playbooks",
    description: "Affiche les playbooks (règles que l'agent s'est données lors des réflexions ordonnées). Rien n'est caché.",
    inputSchema: z.object({}),
    run: async () => memoryDigest(6_000, "/memories/playbooks"),
  });

  return [runMission, swarm, latestReport, schedule, schedules, spend, playbooks, createMission, deleteMission, listMissions];
}

/* ------------------------------------------------------------------------ */

const queues = new Map<string, Promise<unknown>>();
const seen = new Set<string>();

export async function handleChat(opts: { channel: "whatsapp" | "api"; peer: string; text: string; extId?: string; notify?: Notify }): Promise<string> {
  if (opts.extId) {
    if (seen.has(opts.extId)) return "";
    seen.add(opts.extId);
    if (seen.size > 5000) seen.delete(seen.values().next().value!);
    const dup = await db().query(`SELECT 1 FROM chat_messages WHERE ext_id=$1`, [opts.extId]);
    if (dup.rowCount) return "";
  }
  const prev = queues.get(opts.peer) ?? Promise.resolve();
  const next = prev.then(() => respond(opts)).catch((e) => {
    logger.error({ err: String(e) }, "chat");
    return "Je bute sur une erreur interne, réessaie dans une minute.";
  });
  queues.set(opts.peer, next);
  return next;
}

async function respond(opts: { channel: "whatsapp" | "api"; peer: string; text: string; extId?: string; notify?: Notify }): Promise<string> {
  const text = opts.text.trim();
  if (!text) return "";
  // Réponse à une demande d'approbation (OUI-XXXX / NON-XXXX) : pas de LLM.
  const approval = await handleApprovalReply(text);
  if (approval) return approval;
  // « bien » / « nul » (+ commentaire) : retour capturé pour la réflexion, sans LLM.
  const fb = await captureFeedback(opts.peer, text);
  if (fb) {
    await db().query(`INSERT INTO chat_messages(channel, peer, role, content) VALUES ($1,$2,'assistant',$3)`, [opts.channel, opts.peer, fb]);
    return fb;
  }
  // Limite de débit par numéro : un téléphone volé ou un webhook rejoué ne vide pas le budget.
  const recent = await db().query<{ n: string }>(`SELECT count(*) AS n FROM chat_messages WHERE peer=$1 AND role='user' AND ts > now() - interval '1 hour'`, [opts.peer]);
  if (Number(recent.rows[0]?.n ?? 0) >= config().CHAT_RATE_LIMIT_PER_HOUR) return "Trop de messages cette heure-ci ; je reprends dans un moment.";
  if ((await spentToday()) >= config().DAILY_BUDGET_USD) return `Plafond journalier atteint (${config().DAILY_BUDGET_USD} $). Je ne lance plus rien aujourd'hui ; relève DAILY_BUDGET_USD si besoin.`;
  await db().query(`INSERT INTO chat_messages(channel, peer, role, content, ext_id) VALUES ($1,$2,'user',$3,$4)`, [opts.channel, opts.peer, text, opts.extId ?? null]);

  const hist = await db().query<{ role: string; content: string; ts: string }>(
    `SELECT role, content, ts FROM chat_messages WHERE peer=$1 ORDER BY ts DESC LIMIT 30`,
    [opts.peer],
  );
  const history = hist.rows.reverse().slice(0, -1);
  const notify: Notify = opts.notify ?? (opts.channel === "whatsapp" ? async (t) => void (await sendWhatsApp(opts.peer, t)) : async () => undefined);

  const task = [
    `Date: ${new Date().toISOString()}`,
    `<profil>\n${await memoryDigest(2_000, "/memories/profil")}\n</profil>`,
    history.length ? `<historique>\n${history.map((h) => `${h.role === "user" ? "opérateur" : "toi"}: ${h.content}`).join("\n")}\n</historique>` : "",
    `Message de l'opérateur :\n${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await runAgent({
    ...resolveModel("chat"),
    system: CHAT_SYSTEM,
    task,
    tools: [memoryTool, rememberFact, recallFacts, taskTool, episodesTool, feedbackTool, ...controlTools(notify), ...searchTools()],
    effort: "low",
    maxIterations: 8,
    budgetUsd: 0.5,
  });
  const reply = res.finalText || (res.stopReason === "refusal" ? "Je ne peux pas faire ça." : "Fait.");
  await db().query(`INSERT INTO chat_messages(channel, peer, role, content) VALUES ($1,$2,'assistant',$3)`, [opts.channel, opts.peer, reply]);
  await db().query(`INSERT INTO spend(day, usd) VALUES (CURRENT_DATE, $1) ON CONFLICT (day) DO UPDATE SET usd = spend.usd + EXCLUDED.usd`, [res.usage.usd]);
  return reply;
}
