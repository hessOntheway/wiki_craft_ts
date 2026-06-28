import { normalizeWhitespace } from "../util.ts";

export function termsFor(text: string): string[] {
  const normalized = normalizeWhitespace(text.toLowerCase());
  const words = normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? [];
  const segmented = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(normalized)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
    : [];
  const cjk = [...normalized].filter((ch) => /\p{Script=Han}/u.test(ch));
  const cjkBigrams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) cjkBigrams.push(`${cjk[i]}${cjk[i + 1]}`);
  return [...words, ...segmented, ...cjk, ...cjkBigrams].filter((term) => term.length > 0);
}

export function normalizeGraphText(text: string): string {
  return [...new Set(termsFor(text))].join(" ");
}
