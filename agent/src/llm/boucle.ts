/**
 * Détection de boucle dans une suite d'appels d'outils.
 *
 * L'ancienne règle — « le même appel trois fois dans toute la mission » —
 * arrêtait la veille quand elle relisait trois fois un fichier de mémoire
 * en quarante actions, ce qui n'est pas une boucle, c'est un agent qui
 * vérifie. Une boucle, c'est le même appel qui revient TOUT DE SUITE
 * (trois fois d'affilée), ou tellement souvent (six fois) que l'agent
 * tourne en rond même en alternant.
 */
export const SUITE_MAX = 3;
export const TOTAL_MAX = 6;

export class DetecteurBoucle {
  private totaux = new Map<string, number>();
  private dernier = "";
  private suite = 0;

  /** Enregistre un appel ; rend true s'il faut arrêter. */
  ajouter(cle: string): boolean {
    const n = (this.totaux.get(cle) ?? 0) + 1;
    this.totaux.set(cle, n);
    this.suite = cle === this.dernier ? this.suite + 1 : 1;
    this.dernier = cle;
    return this.suite >= SUITE_MAX || n >= TOTAL_MAX;
  }

  private dernierTour = "";
  private suiteTours = 0;

  /**
   * Plusieurs appels dans un même tour : le tour boucle si l'un d'eux
   * boucle, ou si le tour entier (même jeu d'appels) revient trois fois de
   * suite — un modèle qui relance la même paire « chercher + lire » à
   * chaque tour tourne en rond même si chaque clé, prise seule, alterne.
   */
  ajouterTour(cles: string[]): boolean {
    let boucle = false;
    for (const c of cles) if (this.ajouter(c)) boucle = true;
    if (!cles.length) return boucle;
    const tour = [...cles].sort().join("\u0000");
    this.suiteTours = tour === this.dernierTour ? this.suiteTours + 1 : 1;
    this.dernierTour = tour;
    return boucle || this.suiteTours >= SUITE_MAX;
  }
}
