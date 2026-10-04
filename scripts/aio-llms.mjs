#!/usr/bin/env node
// Génère public/llms.txt depuis aio.config.json (source unique). Usage: node scripts/aio-llms.mjs
import fs from "node:fs";

const c = JSON.parse(fs.readFileSync(new URL("../aio.config.json", import.meta.url), "utf8"));
const L = c.defaultLang;
const i = c.i18n[L];
const wc = (s) => [
  (s.match(/\S+/g) || []).length,
  (s.match(/[\p{L}\p{N}€$%]+(?:['’][\p{L}]+)?/gu) || []).length,
];

if (!Array.isArray(i.faq) || i.faq.length !== 10) {
  console.error(`llms.txt : ${i?.faq?.length ?? 0} questions, 10 attendues (ne pas inventer le reste)`);
  process.exit(1);
}
for (const f of i.faq) {
  if (!/\?\s*$/.test(f.q)) {
    console.error("Question sans point d'interrogation : " + f.q);
    process.exit(1);
  }
  const [w1, w2] = wc(f.a);
  if (w1 < 40 || w1 > 60 || w2 < 40 || w2 > 60) {
    console.error(`Réponse hors 40–60 mots (${w1}/${w2}) : ${f.q}`);
    process.exit(1);
  }
}

const shown = (value) => {
  if (value == null) return "non indiqué";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "non indiqué";
  return String(value);
};

const lines = [];
lines.push(`# ${c.siteName}`, "", `> ${i.description}`, "");
lines.push("## Services", "");
for (const service of c.services ?? []) lines.push(`- ${service}`);
lines.push("", "## Prix", "");
if (c.plans?.length) {
  for (const p of c.plans) {
    const name = p.name?.[L] ?? p.id;
    const price = p.price == null || !c.currency ? "non indiqué" : `${p.price} ${c.currency}`;
    lines.push(`- ${name} : ${price}`);
  }
}
for (const note of c.pricingNotes ?? []) lines.push(`- ${note}`);
if (!c.plans?.length && !(c.pricingNotes ?? []).length) lines.push("- non indiqué");
lines.push("", "## Caractéristiques techniques", "");
const t = c.tech ?? {};
lines.push(`- Résolution maximale : ${shown(t.maxResolution)}`);
lines.push(`- Débit / bitrate : ${shown(t.bitrate)}`);
lines.push(`- Appareils : ${shown(t.devices)}`);
lines.push(`- Délai d’activation : ${shown(t.activationMinutes)}`);
lines.push(`- Nombre de chaînes : ${shown(t.channelCount)}`);
for (const note of c.techNotes ?? []) lines.push(`- ${note}`);
lines.push("", `## Questions fréquentes (${i.faq.length})`, "");
for (const f of i.faq) lines.push(`### ${f.q}`, "", f.a, "");
if (c.howto?.steps?.length) {
  lines.push("## Tutoriel d’installation", "", c.howto.description, "");
  c.howto.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.name} : ${step.text}`, "");
  });
} else {
  lines.push("## Tutoriel d’installation", "", "Aucun tutoriel publié. HowTo non généré.", "");
}

fs.mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../public/llms.txt", import.meta.url), lines.join("\n").trimEnd() + "\n");
console.log("public/llms.txt écrit (" + i.faq.length + " Q/R)");
