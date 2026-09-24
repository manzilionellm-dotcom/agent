/**
 * Regroupement des messages envoyés en rafale.
 *
 * Quatre photos envoyées d'un coup sur WhatsApp arrivent en quatre webhooks,
 * à une seconde d'écart. Traités un par un, ils font quatre conversations :
 * le bot voyait une casquette, puis une autre, publiait ou redemandait à
 * chaque fois, et ne comprenait jamais « voici les photos, publie ». Un
 * humain attend que tout soit arrivé avant de répondre. C'est ce que fait ce
 * module : les messages d'un même numéro sont retenus tant qu'il en arrive
 * encore, puis livrés ensemble, une seule fois.
 *
 * Deux fenêtres : courte pour du texte seul (une phrase vaut réponse), plus
 * longue quand il y a une pièce jointe (les suivantes sont probablement en
 * route). Et une limite dure depuis le premier message, pour qu'un flot
 * continu ne fasse pas attendre indéfiniment.
 */

export type Reglages = { texteMs: number; mediaMs: number; maxMs: number; taille: number };

export const REGLAGES_RAFALE: Reglages = { texteMs: 1_200, mediaMs: 4_000, maxMs: 15_000, taille: 20 };

type Lot<T> = { items: T[]; timer?: NodeJS.Timeout; debut: number };

export class Rafale<T> {
  private lots = new Map<string, Lot<T>>();
  private vus = new Map<string, number>();

  constructor(
    private readonly livrer: (peer: string, items: T[]) => Promise<void> | void,
    private readonly avecMedia: (item: T) => boolean,
    private readonly reglages: Reglages = REGLAGES_RAFALE,
  ) {}

  /** Un identifiant déjà vu dans les dix dernières minutes est ignoré : Meta rejoue parfois un webhook. */
  private dejaVu(id: string | undefined): boolean {
    if (!id) return false;
    const maintenant = Date.now();
    if (this.vus.size > 2_000) for (const [k, t] of this.vus) if (maintenant - t > 600_000) this.vus.delete(k);
    if (this.vus.has(id)) return true;
    this.vus.set(id, maintenant);
    return false;
  }

  ajouter(peer: string, item: T, id?: string): void {
    if (this.dejaVu(id)) return;
    const maintenant = Date.now();
    let lot = this.lots.get(peer);
    if (!lot) {
      lot = { items: [], debut: maintenant };
      this.lots.set(peer, lot);
    }
    lot.items.push(item);
    if (lot.timer) clearTimeout(lot.timer);
    if (lot.items.length >= this.reglages.taille) return void this.vider(peer);
    const attente = lot.items.some(this.avecMedia) ? this.reglages.mediaMs : this.reglages.texteMs;
    const restant = Math.max(0, this.reglages.maxMs - (maintenant - lot.debut));
    lot.timer = setTimeout(() => this.vider(peer), Math.min(attente, restant));
  }

  private vider(peer: string): void {
    const lot = this.lots.get(peer);
    if (!lot) return;
    if (lot.timer) clearTimeout(lot.timer);
    this.lots.delete(peer);
    if (!lot.items.length) return;
    void Promise.resolve(this.livrer(peer, lot.items)).catch(() => undefined);
  }

  /** Pour les tests et l'arrêt propre : livre tout ce qui attend. */
  toutVider(): void {
    for (const peer of [...this.lots.keys()]) this.vider(peer);
  }

  enAttente(peer: string): number {
    return this.lots.get(peer)?.items.length ?? 0;
  }
}

/**
 * Assemble les textes d'un lot en un seul message. Plusieurs pièces jointes
 * sont numérotées, pour que « la deuxième photo » veuille dire quelque chose.
 */
export function assembler(parts: Array<{ texte: string; media: boolean }>): string {
  const medias = parts.filter((p) => p.media).length;
  if (medias <= 1) return parts.map((p) => p.texte).filter(Boolean).join("\n\n");
  let n = 0;
  return [
    `[${medias} pièces jointes reçues d'un coup — traite-les ensemble, comme un seul envoi]`,
    ...parts.map((p) => (p.media ? `— Pièce jointe ${++n}/${medias} —\n${p.texte}` : p.texte)),
  ]
    .filter(Boolean)
    .join("\n\n");
}
