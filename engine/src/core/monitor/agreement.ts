// Chance-corrected agreement between the judge's binary verdict and human/recorded ground truth.
//
// Raw agreement rate is inflated by class imbalance: with 90% of traffic genuinely fine, a judge
// that rubber-stamps everything scores 0.90 agreement while detecting nothing. Krippendorff's
// alpha corrects for the agreement two raters would reach by chance given how often each label
// occurs at all. For two raters over a binary nominal label this is Scott's pi with
// Krippendorff's small-sample correction - pi's shared-distribution chance model is the right
// (conservative) choice here, because a judge whose base rate drifts away from the humans' is
// itself a form of miscalibration that Cohen's kappa would partially forgive.
//
// Reading it: 1 = perfect, 0 = no better than chance, negative = systematically worse than
// chance. The bands below follow the Landis-Koch convention, shifted to alpha's usual framing.
//
// Two honesty guards, both enforced by returning null rather than a number:
// - Below MIN_ALPHA_ITEMS labeled pairs the statistic is noise (a handful of reviews can swing
//   it from -0.4 to +0.8), so it is withheld, not fabricated.
// - When every label on both sides is the same category there is no variation to attribute and
//   alpha is mathematically undefined (0/0) - also withheld.
//
// Callers should present alpha as "alignment on human-reviewed items": the ground-truth streams
// (triage corrections, review labels, disputes) are disagreement-enriched by construction, not a
// random sample of traffic.

export const MIN_ALPHA_ITEMS = 15;

export type VerdictCounts = {
  bothBad: number; // judge flagged, human agreed it was bad
  bothFine: number; // judge passed, human agreed it was fine
  judgeOnlyBad: number; // over-flagged: judge said bad, human said fine
  humanOnlyBad: number; // missed: judge said fine, human said bad
};

export function krippendorffAlpha(counts: VerdictCounts): number | null {
  const { bothBad, bothFine, judgeOnlyBad, humanOnlyBad } = counts;
  const items = bothBad + bothFine + judgeOnlyBad + humanOnlyBad;
  if (items < MIN_ALPHA_ITEMS) return null;

  // Coincidence-matrix formulation, two values per item (judge + human), no missing values:
  // N pairable values total, n_bad/n_fine of each label across both raters, D discordant items.
  const N = 2 * items;
  const nBad = 2 * bothBad + judgeOnlyBad + humanOnlyBad;
  const nFine = 2 * bothFine + judgeOnlyBad + humanOnlyBad;
  const discordant = judgeOnlyBad + humanOnlyBad;

  const expectedDisagreement = (2 * nBad * nFine) / (N * (N - 1));
  if (expectedDisagreement === 0) return null; // every label identical - undefined, not 1.0
  const observedDisagreement = discordant / items;
  return Math.round((1 - observedDisagreement / expectedDisagreement) * 1000) / 1000;
}

// Landis-Koch-style interpretation band for the UI/docs - shipped from one place so the
// dashboard, SDK docs, and any future surface describe the same alpha the same way.
export function alphaBand(alpha: number): "poor" | "slight" | "fair" | "moderate" | "substantial" | "near-perfect" {
  if (alpha < 0) return "poor";
  if (alpha < 0.2) return "slight";
  if (alpha < 0.4) return "fair";
  if (alpha < 0.6) return "moderate";
  if (alpha < 0.8) return "substantial";
  return "near-perfect";
}
