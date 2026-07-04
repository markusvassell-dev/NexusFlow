// Internal SEO scorer — pure function, no external calls.
// Weighted: keyword density 30% · readability 30% · heading structure 20% · meta tags 20%.

export interface SeoReport {
  total: number; // 0–100
  breakdown: {
    keywordDensity: number;
    readability: number;
    headingStructure: number;
    metaTags: number;
  };
  suggestions: string[];
}

export function scoreSeo(input: {
  blogText: string; // markdown
  title: string;
  metaDescription: string;
  keywords: string[];
}): SeoReport {
  const { blogText, title, metaDescription, keywords } = input;
  const suggestions: string[] = [];
  const words = blogText.toLowerCase().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const primary = (keywords[0] ?? '').toLowerCase();

  // ---- Keyword density (target 1.0–1.5% for the primary keyword) ----
  let keywordDensity = 50;
  if (primary && wordCount > 0) {
    const occurrences = countOccurrences(blogText.toLowerCase(), primary);
    const density = (occurrences * primary.split(' ').length * 100) / wordCount;
    if (density >= 1.0 && density <= 1.5) keywordDensity = 95;
    else if (density >= 0.6 && density < 1.0) {
      keywordDensity = 75;
      suggestions.push(`Keyword density ${density.toFixed(1)}% — target 1–1.5% for “${primary}”.`);
    } else if (density > 1.5 && density <= 2.5) {
      keywordDensity = 70;
      suggestions.push(`Keyword density ${density.toFixed(1)}% reads as stuffing — thin it out.`);
    } else {
      keywordDensity = 45;
      suggestions.push(`Primary keyword “${primary}” barely appears — add it to the intro and one H2.`);
    }
    const first100 = words.slice(0, 100).join(' ');
    if (!first100.includes(primary)) {
      keywordDensity = Math.max(30, keywordDensity - 15);
      suggestions.push('Primary keyword missing from the first 100 words — add to the intro paragraph.');
    }
  }

  // ---- Readability (Flesch reading ease approximation) ----
  const sentences = blogText.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  const syllables = words.reduce((acc, w) => acc + estimateSyllables(w), 0);
  const flesch =
    206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllables / Math.max(1, wordCount));
  const readability = clamp(Math.round(flesch * 1.1), 0, 100);
  const longSentences = sentences.filter((s) => s.split(/\s+/).length > 28).length;
  if (longSentences > 2)
    suggestions.push(`Readability: ${longSentences} sentences exceed 28 words — split them.`);
  if (wordCount < 1000)
    suggestions.push(`Post is ${wordCount} words — the generator contract requires 1000+.`);

  // ---- Heading structure ----
  const h2s = (blogText.match(/^##\s+.+$/gm) ?? []).length;
  const h3s = (blogText.match(/^###\s+.+$/gm) ?? []).length;
  let headingStructure = 50;
  if (h2s >= 3) headingStructure = 90;
  else if (h2s >= 1) headingStructure = 70;
  else suggestions.push('No H2 headings found — break the post into scannable sections.');
  if (h3s > 0 && h2s >= 3) headingStructure = 95;
  const secondary = (keywords[1] ?? '').toLowerCase();
  const headingText = (blogText.match(/^#{2,3}\s+.+$/gm) ?? []).join(' ').toLowerCase();
  if (secondary && !headingText.includes(secondary)) {
    headingStructure = Math.max(40, headingStructure - 10);
    suggestions.push(`Add the secondary keyword “${secondary}” to at least one H2.`);
  }

  // ---- Meta tags ----
  let metaTags = 90;
  if (title.length > 60) {
    metaTags -= 20;
    suggestions.push(`Title is ${title.length} chars — trim to ≤60 so it doesn’t truncate in SERPs.`);
  }
  if (metaDescription.length > 155) {
    metaTags -= 25;
    suggestions.push(`Meta description is ${metaDescription.length} chars — trim to ≤155.`);
  } else if (metaDescription.length < 120) {
    metaTags -= 15;
    suggestions.push('Meta description under 120 chars — use the full width for the pitch.');
  }
  if (primary && !`${title} ${metaDescription}`.toLowerCase().includes(primary)) {
    metaTags -= 20;
    suggestions.push('Primary keyword missing from title/meta description.');
  }
  metaTags = clamp(metaTags, 0, 100);

  const total = Math.round(
    keywordDensity * 0.3 + readability * 0.3 + headingStructure * 0.2 + metaTags * 0.2
  );

  return {
    total,
    breakdown: { keywordDensity, readability, headingStructure, metaTags },
    suggestions
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

function estimateSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const vowelGroups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, vowelGroups ? vowelGroups.length : 1);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
