import type { Metadata } from "next";
import Link from "next/link";
import { AioTranscript, HowToJsonLd } from "../../components/aio-blocks";
import { aio } from "../../lib/aio";

export const metadata: Metadata = {
  title: "Installer Manzi Junior",
  description: aio.howto?.description,
};

export default function InstallationPage() {
  const howto = aio.howto;
  if (!howto) return null;

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main
        lang="fr"
        className="flex w-full max-w-3xl flex-col gap-8 bg-white px-16 py-16 text-lg leading-8 text-zinc-600 dark:bg-black dark:text-zinc-400"
      >
        <p>
          <Link className="font-medium text-zinc-950 dark:text-zinc-50" href="/">
            Manzi Junior
          </Link>
        </p>
        <h1 className="text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
          {howto.name}
        </h1>
        <p>{howto.description}</p>
        {howto.lead ? (
          <>
            <h2 className="text-xl font-semibold text-black dark:text-zinc-50">{howto.lead.q}</h2>
            <p>{howto.lead.a}</p>
          </>
        ) : null}
        <ol className="flex flex-col gap-8">
          {howto.steps.map((step, index) => (
            <li id={step.id} key={step.id}>
              <h2 className="text-xl font-semibold text-black dark:text-zinc-50">
                {index + 1}. {step.name}
              </h2>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
        <AioTranscript text={aio.videoTranscript} />
        <HowToJsonLd />
      </main>
    </div>
  );
}
