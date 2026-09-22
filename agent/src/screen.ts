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
export const SCREEN_ENTRY = "/screen/vnc.html?path=screen/websockify&autoconnect=true&resize=remote&reconnect=true&show_dot=true";

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
      res.writeHead(r.statusCode ?? 502, r.headers);
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
