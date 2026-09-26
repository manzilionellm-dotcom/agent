/**
 * Masquage des clés d'API dans tout texte destiné à un modèle.
 *
 * Une clé lue par un modèle est une clé exposée : elle part chez le
 * fournisseur du modèle (parfois gratuit, et qui entraîne sur ses échanges)
 * et ressort dans les journaux. Ce que le navigateur rapporte d'une page —
 * texte, liens, HTML, résultat d'un clic — passe par ce filtre.
 */
/** Ce que le modèle peut voir d'une clé : ses quatre derniers caractères. */
export function empreinte(cle: string): string {
  return `…${cle.slice(-4)}`;
}

/** Motifs de clés connus, pour masquer toute clé dans ce que le navigateur renvoie au modèle. */
const MOTIFS_CLES = /AIza[0-9A-Za-z_\-]{35}|sk-or-v1-[0-9a-f]{64}|gsk_[A-Za-z0-9]{40,64}|sk-ant-[A-Za-z0-9_\-]{20,}|sk-proj-[A-Za-z0-9_\-]{20,}|xai-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\bsk-[0-9a-f]{32}\b|\bsk-[A-Za-z0-9]{40,}/g;

export function masquerCles(texte: string): string {
  return texte.replace(MOTIFS_CLES, (m) => `[clé masquée ${empreinte(m)}]`);
}

