import pino from "pino";

/**
 * Écouteurs des avertissements et erreurs : c'est par là que la boîte noire
 * reçoit le journal. Le logger ne connaît pas la base — la base importe le
 * logger — d'où cette inversion : on s'abonne ici, on écrit ailleurs.
 */
export type EcouteurLog = (niveau: number, objet: Record<string, unknown> | undefined, message: string) => void;
const ecouteurs: EcouteurLog[] = [];

export function surLog(f: EcouteurLog): void {
  ecouteurs.push(f);
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "manzi-junior" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["*.token", "*.apiKey", "*.authorization", "headers.authorization"],
    censor: "[redacted]",
  },
  hooks: {
    logMethod(args, method, level) {
      if (level >= 40 && ecouteurs.length) {
        // Un écouteur qui plante ne doit JAMAIS empêcher la ligne de journal
        // de sortir : c'est souvent la seule trace d'une panne.
        try {
          const [a, b] = args as unknown[];
          const objet = a && typeof a === "object" ? (a as Record<string, unknown>) : undefined;
          const message = typeof a === "string" ? a : typeof b === "string" ? b : "";
          for (const f of ecouteurs) f(level, objet, message);
        } catch {
          /* rien : le journal passe avant tout */
        }
      }
      return method.apply(this, args);
    },
  },
});

export type Logger = typeof logger;
