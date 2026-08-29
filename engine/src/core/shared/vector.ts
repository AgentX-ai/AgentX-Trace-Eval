// Cosine plus the text helpers that go with it. Extracted from curation.ts (which still owns the
// calibration) once insights/ needed the same math: dedupe and coverage ask the same question in
// different directions and must not answer it with two different formulas.

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Element-wise mean, unit-normalized. Differing lengths mean two embedding models got mixed, so
// the shortest wins - padding zeros would drag every centroid toward the origin.
export function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) {
    return null;
  }
  const dims = Math.min(...vectors.map(v => v.length));
  if (dims === 0) {
    return null;
  }
  const sum = new Array<number>(dims).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i++) {
      sum[i]! += vector[i] ?? 0;
    }
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    sum[i]! /= vectors.length;
    norm += sum[i]! * sum[i]!;
  }
  norm = Math.sqrt(norm);
  return norm === 0 ? sum : sum.map(v => v / norm);
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Content words for the lexical fallback: stopwords and short tokens dropped, so "how do I reset
// my password" and "password reset" overlap on what carries the topic.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "of", "to", "in", "on", "at", "for",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "how", "what", "when", "where", "why", "who", "which", "can", "could", "would", "should", "will",
  "my", "me", "i", "you", "your", "it", "its", "this", "that", "these", "those", "there", "here",
  "not", "no", "yes", "please", "help",
]);

export function contentWords(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared++;
    }
  }
  return shared / (a.size + b.size - shared);
}
