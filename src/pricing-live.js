// OPT-IN live pricing.
//
// With --live-pricing, Toknado fetches one public JSON file — LiteLLM's
// community-maintained model price database — and merges it over the built-in
// table. This is the ONLY outbound request Toknado can ever make, it contains
// no data about you (a plain GET), and it never happens without the flag.
//
// Source: https://github.com/BerriAI/litellm (model_prices_and_context_window.json)
// Fields are USD per TOKEN there; we convert to USD per MILLION tokens.

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const REFRESH_MS = 6 * 60 * 60 * 1000; // refetch at most every 6h per process

let cache = null; // { prices, fetchedAt }

/**
 * Fetch and normalize the live price table.
 * Returns { prices: {modelKey: {input, output, cacheRead?, cacheWrite?}}, fetchedAt }
 * or null on any failure (caller falls back to built-in prices).
 */
export async function fetchLivePrices() {
  if (cache && Date.now() - cache.fetchedAt < REFRESH_MS) return cache;
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();

    const prices = {};
    for (const [key, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const inTok = v.input_cost_per_token;
      const outTok = v.output_cost_per_token;
      if (typeof inTok !== 'number' || typeof outTok !== 'number') continue;
      const entry = {
        input: inTok * 1e6,
        output: outTok * 1e6,
      };
      if (typeof v.cache_read_input_token_cost === 'number') {
        entry.cacheRead = v.cache_read_input_token_cost * 1e6;
      }
      if (typeof v.cache_creation_input_token_cost === 'number') {
        entry.cacheWrite = v.cache_creation_input_token_cost * 1e6;
      }
      // LiteLLM keys come both bare ("gpt-4o") and provider-prefixed
      // ("anthropic/claude-…", "gemini/gemini-…"). Index the bare name too,
      // without clobbering an existing bare entry.
      prices[key] = entry;
      const slash = key.lastIndexOf('/');
      if (slash > 0) {
        const bare = key.slice(slash + 1);
        if (!(bare in prices)) prices[bare] = entry;
      }
    }
    cache = { prices, fetchedAt: Date.now() };
    return cache;
  } catch (err) {
    console.error(`⚠️  live pricing fetch failed (${err.message}) — using built-in prices`);
    return null;
  }
}
