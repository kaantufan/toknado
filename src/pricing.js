// What-if API cost comparison.
//
// Toknado is NOT a cost tracker — subscription users don't pay per token, and
// we deliberately show tokens first everywhere. This module powers exactly one
// panel: "what WOULD this usage cost if billed at public API list prices?" —
// useful for comparing your subscription against pay-as-you-go, or comparing
// model tiers against each other.
//
// Prices are USD per **million** tokens. Cache multipliers follow Anthropic's
// published economics: reads ≈ 0.1× input price, writes ≈ 1.25× input price.
// Models without a known list price show as "n/a" — pass --pricing <file>
// (JSON of per-Mtok prices, merged over DEFAULT_PRICES) to fill in your own.

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

// prefix-matched against model IDs, longest prefix wins
export const DEFAULT_PRICES = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4': { input: 5, output: 25 }, // 4.6 / 4.7 / 4.8
  'claude-opus-4-20250514': { input: 15, output: 75 }, // legacy Opus 4 exact ID
  'claude-opus-4-1': { input: 15, output: 75 }, // legacy Opus 4.1
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Reference tiers for the cross-model "what if ALL of it ran on X" comparison.
export const REFERENCE_TIERS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4', label: 'Claude Opus 4.x' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
];

export function findPrice(model, prices) {
  let best = null;
  let bestLen = -1;
  for (const [prefix, p] of Object.entries(prices)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = p;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Cost in USD for a token bucket at a given per-Mtok price.
 * Uses the model's own cacheRead/cacheWrite rates when known (live pricing
 * provides them); otherwise falls back to the standard multipliers. */
export function costOf(bucket, price) {
  if (!price) return null;
  const per = 1_000_000;
  const cacheReadRate = price.cacheRead ?? price.input * CACHE_READ_MULT;
  const cacheWriteRate = price.cacheWrite ?? price.input * CACHE_WRITE_MULT;
  return (
    (bucket.input / per) * price.input +
    (bucket.output / per) * price.output +
    (bucket.cacheRead / per) * cacheReadRate +
    (bucket.cacheWrite / per) * cacheWriteRate
  );
}

/**
 * Build the comparison panel data.
 * @param {Array} models per-model buckets from aggregate()
 * @param {object} totals overall bucket
 * @param {object} userPrices optional overrides merged over DEFAULT_PRICES
 * @param {object|null} livePrices optional live table (sits between defaults and user overrides)
 */
export function costComparison(models, totals, userPrices = {}, livePrices = null) {
  const prices = { ...DEFAULT_PRICES, ...(livePrices ?? {}), ...userPrices };

  // 1) actual mix: price each model's own usage where a rate is known
  const perModel = models.map((m) => {
    const price = findPrice(m.model, prices);
    return {
      model: m.model,
      total: m.total,
      cost: price ? round2(costOf(m, price)) : null,
      priced: !!price,
    };
  });
  const knownCost = perModel.reduce((s, m) => s + (m.cost ?? 0), 0);
  const unpricedTokens = perModel.filter((m) => !m.priced).reduce((s, m) => s + m.total, 0);

  // 2) cross-tier: what if the WHOLE mix had run on each reference tier
  const tiers = REFERENCE_TIERS.map((t) => ({
    ...t,
    cost: round2(costOf(totals, prices[t.id])),
  }));

  return {
    disclaimer:
      'Hypothetical: public API list prices × your token mix. Subscription plans do not bill per token.',
    perModel,
    knownCost: round2(knownCost),
    unpricedTokens,
    tiers,
    pricingSource: livePrices ? 'live' : 'builtin',
  };
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
