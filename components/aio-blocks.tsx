import Link from "next/link";
import { aio, faqFor, jsonLdString } from "../lib/aio";

/** Transcription textuelle d’une vidéo de tutoriel. Rien n’est rendu si le champ est null. */
export function AioTranscript({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="aio-transcript" data-aio-transcript>
      {text}
    </div>
  );
}

/**
 * Citation Hooks : chaque question est un h3 suivi immédiatement d’un p,
 * HTML rendu par le serveur, sans accordéon ni masquage.
 */
export function CitationFaq() {
  const faq = faqFor();
  return (
    <section
      id="faq"
      lang="fr"
      className="w-full max-w-3xl border-t border-black/[.08] bg-white px-16 pt-12 pb-24 text-lg leading-8 text-zinc-600 dark:border-white/[.145] dark:bg-black dark:text-zinc-400"
    >
      <h2 className="mb-8 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Questions documentées
      </h2>
      <div className="flex flex-col gap-8">
        {faq.map((item) => (
          <div key={item.q}>
            <h3 className="text-lg font-semibold text-black dark:text-zinc-50">{item.q}</h3>
            <p>{item.a}</p>
          </div>
        ))}
      </div>
      <p className="mt-10">
        <Link className="font-medium text-zinc-950 dark:text-zinc-50" href="/installation">
          Tutoriel d’installation du profil éco
        </Link>
      </p>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString("home") }} />
    </section>
  );
}

export function HowToJsonLd() {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString("howto") }} />;
}

export function installationSteps() {
  return aio.howto?.steps ?? [];
}
