import raw from "../aio.config.json";

type Plan = {
  id: string;
  price: number | null;
  durationDays?: number | null;
  name: Record<string, string>;
};

type AioConfig = {
  siteName: string;
  siteUrl: string;
  defaultLang: string;
  currency: string | null;
  contact: { whatsapp?: string | null } | null;
  plans: Plan[] | null;
  videoTranscript: string | null;
  services: string[];
  pricingNotes: string[];
  tech: {
    maxResolution: string | null;
    bitrate: string | null;
    devices: string[] | null;
    activationMinutes: string | null;
    channelCount: number | string | null;
  };
  techNotes: string[];
  howto: {
    name: string;
    description: string;
    lead?: { q: string; a: string } | null;
    steps: { id: string; name: string; text: string }[];
  } | null;
  i18n: Record<
    string,
    {
      description: string;
      productDescription: string | null;
      faq: { q: string; a: string }[];
    }
  >;
};

type JsonLdNode = Record<string, unknown>;

export const aio = raw as AioConfig;
export const defaultLang = aio.defaultLang;

export function faqFor(lang: string = defaultLang) {
  return aio.i18n[lang].faq;
}

/**
 * JSON-LD Schema.org rendu côté serveur.
 * Product seulement si un abonnement a un prix numérique et une devise.
 * HowTo seulement si aio.config.json contient un vrai tutoriel (page /installation).
 */
export function buildJsonLd(kind: "home" | "howto" = "home") {
  const url = aio.siteUrl;
  const lang = defaultLang;
  const copy = aio.i18n[lang];
  const org: JsonLdNode = {
    "@type": "Organization",
    "@id": `${url}/#org`,
    name: aio.siteName,
    url,
    description: copy.description,
  };
  const nodes: JsonLdNode[] = [org];

  if (kind === "home") {
    nodes.push({
      "@type": "FAQPage",
      "@id": `${url}/#faq`,
      inLanguage: lang,
      mainEntity: faqFor(lang).map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });

    const productDescription = copy.productDescription;
    if (aio.currency && productDescription) {
      for (const plan of aio.plans ?? []) {
        if (typeof plan.price !== "number") continue;
        const name = plan.name[lang] ?? plan.id;
        nodes.push({
          "@type": "Product",
          "@id": `${url}/#product-${plan.id}`,
          name: `${aio.siteName} – ${name}`,
          description: productDescription.replace("{name}", name),
          brand: { "@type": "Brand", name: aio.siteName },
          offers: {
            "@type": "Offer",
            url: `${url}/#faq`,
            price: plan.price.toFixed(2),
            priceCurrency: aio.currency,
            availability: "https://schema.org/InStock",
            seller: { "@id": `${url}/#org` },
          },
        });
      }
    }
  }

  if (kind === "howto" && aio.howto && aio.howto.steps.length > 0) {
    nodes.push({
      "@type": "HowTo",
      "@id": `${url}/installation#howto`,
      name: aio.howto.name,
      description: aio.howto.description,
      inLanguage: lang,
      step: aio.howto.steps.map((step, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: step.name,
        text: step.text,
        url: `${url}/installation#${step.id}`,
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": nodes };
}

/** Sérialisation sûre pour <script type="application/ld+json"> */
export function jsonLdString(kind: "home" | "howto" = "home") {
  return JSON.stringify(buildJsonLd(kind)).replace(/</g, "\\u003c");
}
