/**
 * SEOBetter Topic Research Endpoint
 *
 * POST /api/topic-research
 *
 * Combines 5 free data sources to find REAL topic ideas with search demand:
 * - Google Suggest (real search queries people type)
 * - Datamuse (semantic word clusters)
 * - Wikipedia OpenSearch (authoritative subtopics)
 * - Reddit search (real questions + audience demand)
 * - DuckDuckGo (web result patterns)
 *
 * Returns scored topics with intent classification, difficulty estimate, and source attribution.
 * No API keys required. No AI hallucination.
 */

const rateLimitStore = new Map();
const RATE_LIMIT = 20;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const { niche, site_url, country } = req.body || {};
  if (!niche) return res.status(400).json({ error: 'niche is required.' });
  // v1.5.57 — accept country code to geo-localize Google Suggest completions
  const gl = (country && typeof country === 'string') ? country.toLowerCase().slice(0, 2) : '';

  // Rate limit
  const rateKey = `${site_url || 'unknown'}_${new Date().getHours()}`;
  const count = rateLimitStore.get(rateKey) || 0;
  if (count >= RATE_LIMIT) return res.status(429).json({ error: 'Rate limit exceeded.' });
  rateLimitStore.set(rateKey, count + 1);

  try {
    // v1.5.35 — extract the core business/topic hint from the niche before
    // calling Datamuse. Datamuse's ml= endpoint is designed for 1-3 word
    // queries and returns nonsense (aborigines, balance of payments, lidl,
    // arsenal, magazine) when given a long-tail phrase like
    // "best gelato shops in lucignano italy 2026". It treats those as
    // separate words and finds weak associations to "Italy" or "2026".
    // Fix: strip location, year, generic qualifiers, then pass the core
    // 1-3 word topic to Datamuse. Wikipedia + Google Suggest get the full
    // phrase since they handle long queries correctly.
    const coreTopic = extractCoreTopic(niche);

    // v1.5.54 — Google Suggest also receives the core topic instead of the
    // full long-tail niche. Google's suggestqueries endpoint has no
    // completion data for 8+ word phrases like "best pet shops in mudgee
    // nsw 2026", so it was silently returning zero suggestions. The core
    // topic "pet shops" has thousands of completions ("pet shops near me",
    // "pet shops sydney", "pet shops online", etc) which then flow through
    // the overlap filter in buildKeywordSets. We run BOTH the full niche
    // AND the core topic in parallel and merge the results, so if the
    // long-tail does have any completions we still capture them.
    const [suggestLong, suggestCore, datamuse, wiki, reddit] = await Promise.all([
      fetchGoogleSuggest(niche, gl),
      (niche !== coreTopic) ? fetchGoogleSuggest(coreTopic, gl) : Promise.resolve([]),
      fetchDatamuse(coreTopic),
      fetchWikipedia(niche),
      fetchReddit(niche),
    ]);
    // Merge core-topic suggestions into the main list, deduped
    const suggest = [...suggestLong];
    for (const s of suggestCore) {
      if (!suggest.includes(s)) suggest.push(s);
    }

    // Build topic candidates with scoring
    const topics = buildTopics(niche, suggest, datamuse, wiki, reddit);

    // v1.5.22 — extract short keyword phrases for the Auto-suggest button
    // in admin/views/content-generator.php. The button used to call
    // /api/generate (LLM) with a strict-format prompt + fragile regex parser
    // that frequently failed silently when Llama wrapped its output in
    // markdown. Now Auto-suggest reads these arrays directly — real data
    // from Google Suggest + Datamuse + Wikipedia, no LLM hallucination.
    const keywords = buildKeywordSets(niche, suggest, datamuse, wiki);

    return res.status(200).json({
      success: true,
      niche,
      topics,
      keywords,
      sources: {
        google_suggest: suggest.length,
        datamuse: datamuse.length,
        wikipedia: wiki.length,
        reddit: reddit.length,
      },
    });
  } catch (err) {
    console.error('Topic research error:', err);
    return res.status(500).json({ error: 'Research failed: ' + err.message });
  }
}

// ============================================================
// Source 1: Google Suggest (real search queries)
// ============================================================
async function fetchGoogleSuggest(query, gl = '') {
  const variations = [
    query,
    'best ' + query,
    'how to ' + query,
    query + ' for',
    query + ' vs',
    'why ' + query,
    'what is ' + query,
  ];

  // v1.5.57 — geo-localize completions so "pet shops" for an AU user returns
  // Australian completions ("pet shops sydney", "pet shops melbourne") not
  // US ones ("pet shops washington", "pet shops florida"). Google Suggest
  // uses `gl=XX` for country and `hl=XX` for language. We pass both.
  const geoParams = gl ? `&gl=${encodeURIComponent(gl)}&hl=${encodeURIComponent(gl)}` : '';

  const allSuggestions = [];
  for (const v of variations) {
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(v)}${geoParams}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      // Format: ["query", ["suggestion1", "suggestion2", ...]]
      if (Array.isArray(data) && Array.isArray(data[1])) {
        data[1].forEach(s => {
          if (s && s.length > query.length && !allSuggestions.includes(s)) {
            allSuggestions.push(s);
          }
        });
      }
    } catch {}
  }
  return allSuggestions.slice(0, 30);
}

// ============================================================
// v1.5.35 — Extract the core business/topic hint from a long-tail keyword.
// Strips location names, years, and generic SEO qualifiers ("best", "top",
// "must-try", "2026", etc) so Datamuse's ml= query receives a short 1-3 word
// topic it can actually match against.
//
// Examples:
//   "best gelato shops in lucignano italy 2026" → "gelato shops"
//   "top 10 restaurants in rome italy"          → "restaurants"
//   "how to introduce raw food to a dog"        → "raw food dog"
//   "dog vitamins australia"                    → "dog vitamins"
// ============================================================
/**
 * v1.5.58 — extract the target location from a niche that contains "in X"
 * or "near X" (e.g. "best pet shops in mudgee nsw 2026" → ["mudgee", "nsw"]).
 * Returns an array of location tokens (lowercased, ≥3 chars, stopwords removed).
 * Empty array if no location clause found.
 */
function extractLocationTokens(niche) {
  if (!niche || typeof niche !== 'string') return [];
  const n = niche.toLowerCase().trim();
  const m = n.match(/\b(?:in|near|around|at)\s+(.+?)(?:\s+\d{4})?$/);
  if (!m) return [];
  const stop = new Set(['the','and','for','with','from','are','you','can','of','to','a','an','best','top','new','old','nsw','vic','qld','wa','sa','tas','act','nt','usa','uk','us','uae']);
  return m[1]
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !stop.has(w) && !/^\d+$/.test(w));
}

/**
 * v1.5.58 — blocklist of ~100 common English-speaking cities and US states
 * that Google Suggest frequently returns as completions for generic topic
 * queries. Used to filter secondary keyword suggestions so a local article
 * about (e.g.) Mudgee NSW doesn't end up with "pet shops washington" as a
 * secondary keyword. Suggestions containing any of these words are rejected
 * UNLESS they also contain the target location tokens.
 */
const OTHER_CITY_BLOCKLIST = new Set([
  // Major US cities
  'new york','los angeles','chicago','houston','phoenix','philadelphia','san antonio','san diego','dallas','austin','jacksonville','indianapolis','columbus','charlotte','san francisco','seattle','denver','washington','boston','nashville','baltimore','oklahoma','portland','las vegas','memphis','milwaukee','tucson','fresno','sacramento','atlanta','miami','tampa','cleveland','minneapolis','detroit','pittsburgh','orlando','cincinnati','kansas city','st louis','raleigh','salt lake',
  // US states (frequent in Google Suggest)
  'california','texas','florida','georgia','illinois','ohio','michigan','virginia','arizona','colorado','maryland','wisconsin','minnesota','alabama','louisiana','kentucky','oregon','oklahoma','connecticut','iowa','utah','nevada','arkansas','mississippi','kansas','nebraska','idaho','hawaii','maine','montana','alaska','vermont','wyoming',
  // Major UK/AU/CA cities
  'london','manchester','birmingham','glasgow','edinburgh','liverpool','bristol','leeds','sheffield','cardiff','belfast',
  'sydney','melbourne','brisbane','perth','adelaide','darwin','hobart','canberra','gold coast','newcastle','geelong','wollongong',
  'toronto','montreal','vancouver','calgary','ottawa','edmonton','winnipeg','quebec',
  // Major EU cities
  'paris','berlin','madrid','rome','milan','amsterdam','barcelona','munich','vienna','prague','dublin','lisbon','athens','florence','naples','venice','zurich','geneva','brussels','copenhagen','stockholm','oslo','helsinki','warsaw',
  // Major Asian cities
  'tokyo','osaka','kyoto','seoul','beijing','shanghai','hong kong','singapore','bangkok','mumbai','delhi','dubai','manila','jakarta',
]);

function extractCoreTopic(query) {
  if (!query || typeof query !== 'string') return query || '';
  let q = query.toLowerCase().trim();

  // Drop year (4-digit number)
  q = q.replace(/\b20\d{2}\b/g, '');

  // Drop generic SEO qualifiers
  const stopQualifiers = [
    'best', 'top', 'greatest', 'finest', 'cheapest', 'biggest', 'must try',
    'must-try', 'must have', 'must-have', 'ultimate', 'complete', 'essential',
    'recommended', 'favorite', 'popular', 'trending', 'new', 'latest',
    'guide', 'review', 'reviews', 'tips', 'how to', 'what is', 'where to',
    'which', 'when', 'how', 'why', 'should i', 'should you',
  ];
  const qualifierRe = new RegExp('\\b(' + stopQualifiers.map(w => w.replace(' ', '\\s+')).join('|') + ')\\b', 'gi');
  q = q.replace(qualifierRe, '');

  // Drop "in X [country]" location clauses — keep the business type that
  // precedes "in". If the query has " in ", everything after is location.
  const inMatch = q.match(/^(.*?)\s+in\s+/);
  if (inMatch) {
    q = inMatch[1];
  }

  // Drop country/region names that commonly leak into queries
  const countries = [
    'italy', 'france', 'spain', 'germany', 'portugal', 'greece', 'uk',
    'usa', 'america', 'australia', 'canada', 'new zealand', 'japan',
    'china', 'korea', 'thailand', 'vietnam', 'india', 'mexico', 'brazil',
    'argentina', 'tuscany', 'lombardy', 'sicily', 'andalusia', 'provence',
  ];
  const countryRe = new RegExp('\\b(' + countries.join('|') + ')\\b', 'gi');
  q = q.replace(countryRe, '');

  // v1.5.59 — aggressively strip action verbs, pronouns, articles,
  // prepositions, conjunctions, and adverbs. Datamuse's ml= endpoint
  // works best with 1-3 CONCRETE NOUN queries. Long "how to ..." phrases
  // like "transition your dog to raw food safely" previously got
  // truncated to "transition your dog to raw foo" and returned garbage
  // semantic associations (lion, curb, race, nose) because Datamuse
  // treated each individual word independently. Stripping filler leaves
  // "dog raw food" which Datamuse handles correctly.
  const stopContentWords = [
    // Action verbs common in how-to/informational queries
    'transition', 'transitioning', 'introduce', 'introducing', 'train', 'training',
    'teach', 'teaching', 'feed', 'feeding', 'choose', 'choosing', 'pick', 'picking',
    'select', 'selecting', 'switch', 'switching', 'change', 'changing', 'move',
    'moving', 'make', 'making', 'start', 'starting', 'begin', 'beginning', 'stop',
    'stopping', 'prepare', 'preparing', 'give', 'giving', 'find', 'finding', 'know',
    'knowing', 'understand', 'use', 'using', 'try', 'trying', 'help', 'helping',
    'keep', 'keeping', 'avoid', 'avoiding', 'prevent', 'preventing', 'fix', 'fixing',
    'solve', 'solving', 'improve', 'improving', 'learn', 'learning', 'safely',
    'quickly', 'easily', 'properly', 'correctly', 'slowly', 'carefully', 'gradually',
    'naturally', 'effectively', 'efficiently',
    // Articles + pronouns
    'a', 'an', 'the', 'your', 'my', 'his', 'her', 'their', 'our', 'its', 'some',
    // Prepositions
    'to', 'for', 'from', 'with', 'about', 'into', 'onto', 'by', 'of', 'on', 'at',
    'as', 'like', 'up', 'down', 'off', 'out', 'over', 'under',
    // Conjunctions
    'and', 'or', 'but', 'so', 'if', 'then', 'that', 'than', 'because',
    // Generic nouns that add no topic signal
    'way', 'ways', 'method', 'methods', 'step', 'steps', 'thing', 'things', 'type',
    'types', 'kind', 'kinds', 'sort', 'sorts', 'option', 'options',
  ];
  const stopContentRe = new RegExp('\\b(' + stopContentWords.join('|') + ')\\b', 'gi');
  q = q.replace(stopContentRe, '');

  // Collapse whitespace
  q = q.replace(/\s+/g, ' ').trim();

  // If we stripped too much, fall back to the last 3 content words of the original
  if (q.length < 3) {
    const allStopWords = new Set([
      ...stopQualifiers.flatMap(s => s.split(/\s+/)),
      ...stopContentWords,
      ...countries,
    ]);
    const words = query.toLowerCase().trim().split(/\s+/)
      .filter(w => w.length >= 3 && !allStopWords.has(w) && !/^\d+$/.test(w));
    q = words.slice(-3).join(' ');
  }

  // v1.5.59 — cap at 3 words (not 30 chars). Datamuse's ml= endpoint works
  // best with 1-3 noun queries. Character truncation previously cut "raw
  // food" to "raw foo" which matched the wrong semantic cluster.
  const topicWords = q.split(/\s+/).filter(w => w.length >= 3);
  if (topicWords.length > 3) {
    // Prefer the LAST 3 content words (the topic usually comes at the end
    // after the verbs/qualifiers are stripped).
    q = topicWords.slice(-3).join(' ');
  } else {
    q = topicWords.join(' ');
  }

  return q;
}

// ============================================================
// Source 2: Datamuse (semantic word clusters)
// ============================================================
async function fetchDatamuse(query) {
  try {
    // v1.5.35 — Datamuse ml= returns results with a `score` field (typically
    // 0-20000). High scores indicate strong semantic relevance. We request
    // 40 results, then filter by score and POS tags in buildKeywordSets.
    // md=fp adds frequency + part-of-speech tags per result.
    const url = `https://api.datamuse.com/words?ml=${encodeURIComponent(query)}&max=40&md=fp`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map(d => ({
      word: d.word,
      score: d.score || 0,
      freq: d.tags ? parseFreq(d.tags) : 0,
      pos: d.tags ? parsePOS(d.tags) : '',
    }));
  } catch {
    return [];
  }
}

// v1.5.35 — extract part-of-speech from Datamuse tags array. Returns the
// first POS tag found ('n', 'v', 'adj', 'adv') or empty string.
function parsePOS(tags) {
  for (const t of tags) {
    if (['n', 'v', 'adj', 'adv'].includes(t)) return t;
  }
  return '';
}

function parseFreq(tags) {
  const f = tags.find(t => t.startsWith('f:'));
  return f ? parseFloat(f.substring(2)) : 0;
}

// ============================================================
// Source 3: Wikipedia OpenSearch (subtopics)
// ============================================================
async function fetchWikipedia(query) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=15&format=json&namespace=0`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    // Format: [query, [titles], [descriptions], [urls]]
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return data[1].map((title, i) => ({
        title,
        url: data[3] && data[3][i] ? data[3][i] : '',
      }));
    }
    return [];
  } catch {
    return [];
  }
}

// ============================================================
// Source 4: Reddit (real questions + audience demand)
// ============================================================
async function fetchReddit(query) {
  try {
    const url = `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=25`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.0 (Research Bot)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const posts = (data?.data?.children || []).map(c => ({
      title: c.data.title,
      score: c.data.score || 0,
      comments: c.data.num_comments || 0,
      subreddit: c.data.subreddit,
      url: 'https://reddit.com' + c.data.permalink,
      isQuestion: /\?$|^(how|why|what|when|where|which|can|do|is|are|should)/i.test(c.data.title),
    }));
    return posts;
  } catch {
    return [];
  }
}

// ============================================================
// v1.5.22 — Keyword set builder for the Auto-suggest button
// ============================================================
// Extracts short keyword phrases from the raw research arrays so the
// Auto-suggest button in admin/views/content-generator.php can populate
// the secondary_keywords + lsi_keywords fields directly. The LLM path
// (/api/generate with strict-format prompt) was unreliable because Llama
// wrapped output in markdown, breaking the client-side regex parser.
function buildKeywordSets(niche, suggest, datamuse, wiki) {
  const nicheLower = (niche || '').toLowerCase().trim();
  const seen = new Set([ nicheLower ]);

  // Secondary keywords — real Google Suggest variations of the niche.
  // These are full phrases people actually search. 5-7 best fits.
  // v1.5.54 — overlap filter relaxed from "word length > 3" to "word length
  // >= 3" so 3-letter niche tokens like "pet", "cat", "gym", "vet", "bar"
  // count as overlap signals. This was dropping valid suggestions like
  // "pet supplies online" or "vet clinic near me" because the filter only
  // looked at words ≥4 chars, so "pet shops in mudgee" → filter words
  // ["best","shops","mudgee","2026"] missed the core topic word "pet".
  // v1.5.58 — location-aware filter. For local-intent keywords like
  // "best pet shops in mudgee nsw 2026", extract the target location
  // ("mudgee nsw") and reject any Google Suggest completion that names
  // a DIFFERENT city. Previously "pet shops sydney" and "pet shops
  // washington" were accepted because they contained "shops" — valid
  // overlap but completely wrong for a Mudgee article. Now such
  // suggestions are dropped unless they also contain a Mudgee/NSW token.
  const secondary = [];
  const nicheParts = nicheLower.split(/\s+/).filter(w => w.length >= 3 && !['the','and','for','with','from','are','you','can','how','why','what','when','where','who','2024','2025','2026','2027','2028'].includes(w));
  const targetLocationTokens = extractLocationTokens(niche);
  const hasTargetLocation = targetLocationTokens.length > 0;

  for (const s of suggest) {
    const phrase = (s || '').toLowerCase().trim();
    if (!phrase || seen.has(phrase)) continue;
    if (phrase.length < 6 || phrase.length > 80) continue;

    // Must contain the niche or a piece of it (sanity filter)
    const overlaps = nicheParts.some(w => phrase.includes(w));
    if (!overlaps) continue;

    // v1.5.58 — location filter. If this keyword is location-specific,
    // reject suggestions containing a different city from the global
    // blocklist unless they also contain the target location tokens.
    if (hasTargetLocation) {
      const containsTargetLocation = targetLocationTokens.some(t => phrase.includes(t));
      if (!containsTargetLocation) {
        // Check if phrase contains any other-city blocklist term
        let containsOtherCity = false;
        for (const city of OTHER_CITY_BLOCKLIST) {
          if (phrase.includes(city)) { containsOtherCity = true; break; }
        }
        if (containsOtherCity) continue;
      }
    }

    seen.add(phrase);
    secondary.push(phrase);
    if (secondary.length >= 7) break;
  }

  // v1.5.58 — for local-intent keywords, synthesize additional secondary
  // keywords by combining the target location with common business-type
  // variations. Real small towns almost never have Google Suggest data
  // for their specific business types, so Google returns 0-3 phrases
  // after filtering. Augment with synthetic combinations so the article
  // has enough secondary keyword signals.
  if (hasTargetLocation && secondary.length < 5) {
    const locationStr = targetLocationTokens.slice(0, 2).join(' ');
    const core = extractCoreTopic(niche);
    if (core && core.length >= 3) {
      // Generate variations: "core + location", "location + core",
      // and a few business-type swaps.
      const synths = [
        `${core} ${locationStr}`,
        `${locationStr} ${core}`,
        `${core} near ${locationStr}`,
        `best ${core} ${locationStr}`,
        `${locationStr} ${core.replace(/shops?/, 'supplies').replace(/stores?/, 'supplies')}`,
      ];
      for (const s of synths) {
        const phrase = s.toLowerCase().trim().replace(/\s+/g, ' ');
        if (!phrase || seen.has(phrase)) continue;
        if (phrase === core || phrase === nicheLower) continue;
        seen.add(phrase);
        secondary.push(phrase);
        if (secondary.length >= 7) break;
      }
    }
  }

  // LSI keywords — semantic single-word terms from Datamuse.
  // v1.5.35 — much stricter filtering to prevent garbage like "aborigines",
  // "balance of payments", "lidl", "arsenal", "magazine" from leaking into
  // the user's LSI field. Requires:
  //   1. Datamuse score >= 1000 (below that is weak noise)
  //   2. Noun or adjective (POS filter) — no verbs, no adverbs
  //   3. Not a country, brand, or demographic term (blocklist)
  //   4. Single word or 2-word phrase (no 3+ word junk)
  //   5. Not a subset of the niche, not in secondary words
  //
  // 8-10 best fits, deduplicated against secondary phrases.
  const BLOCKLIST = new Set([
    // Countries + regions (leak in when Datamuse parses a multi-word query)
    'italy', 'france', 'spain', 'germany', 'portugal', 'greece', 'england',
    'britain', 'america', 'australia', 'canada', 'japan', 'china', 'korea',
    'india', 'mexico', 'brazil', 'russia', 'europe', 'asia', 'africa',
    'aborigines', 'aboriginal', 'population', 'demographics', 'government',
    // Economic/political terms (Datamuse loves these for any country query)
    'economy', 'politics', 'policy', 'balance', 'payments', 'inflation',
    'gdp', 'tariff', 'trade', 'ministry',
    // Brands that hit unrelated queries
    'lidl', 'aldi', 'walmart', 'tesco', 'amazon', 'ebay', 'google',
    'arsenal', 'chelsea', 'liverpool', 'manchester', 'juventus',
    // Generic media
    'magazine', 'newspaper', 'journal', 'blog', 'website', 'article',
    // Adjectives that mean nothing in LSI
    'best', 'top', 'great', 'amazing', 'wonderful', 'perfect', 'excellent',
    'good', 'bad', 'new', 'old', 'recent', 'modern', 'popular',
    // Meta words
    'guide', 'review', 'list', 'example', 'type', 'kind', 'sort', 'way',
    'thing', 'stuff', 'place', 'area', 'region', 'location',
    // Year-like
    'year', 'years', 'decade', 'century', 'today', 'tomorrow', 'yesterday',
  ]);

  const lsi = [];
  const secondaryWords = new Set();
  secondary.forEach(s => s.split(/\s+/).forEach(w => secondaryWords.add(w)));

  // Core topic words from the extracted hint — the LSI results should be
  // semantically clustered around THIS, not around full-sentence noise
  const coreWords = extractCoreTopic(niche).split(/\s+/).filter(w => w.length > 3);

  for (const d of datamuse) {
    const word = (d.word || '').toLowerCase().trim();
    if (!word || word.length < 4 || word.length > 30) continue;
    if (seen.has(word) || secondaryWords.has(word)) continue;
    // Skip exact-match niche words
    if (nicheLower.includes(word)) continue;
    // v1.5.35 — Datamuse score threshold. Below 1000 is typically noise.
    if ((d.score || 0) < 1000) continue;
    // v1.5.35 — POS filter. Keep only nouns and adjectives. Skip verbs,
    // adverbs, and POS-less results (which are often rare/weird words).
    if (d.pos && !['n', 'adj'].includes(d.pos)) continue;
    // v1.5.35 — blocklist filter
    if (BLOCKLIST.has(word)) continue;
    // v1.5.35 — phrase junk filter (Datamuse can return multi-word results
    // which are almost always noise for LSI keyword purposes)
    if (/\s/.test(word)) continue;
    seen.add(word);
    lsi.push(word);
    if (lsi.length >= 10) break;
  }

  // If Datamuse returned too few results, top up with Wikipedia titles
  // (single-word or 2-word) — these are always real concepts.
  if (lsi.length < 6) {
    for (const w of wiki) {
      const title = (w.title || '').toLowerCase().trim();
      if (!title) continue;
      const wordCount = title.split(/\s+/).length;
      if (wordCount > 2) continue;
      if (seen.has(title)) continue;
      if (nicheLower.includes(title) || title.includes(nicheLower)) continue;
      seen.add(title);
      lsi.push(title);
      if (lsi.length >= 10) break;
    }
  }

  return {
    secondary,
    lsi,
    // Convenience: pre-joined comma-separated strings for the UI
    secondary_string: secondary.join(', '),
    lsi_string: lsi.join(', '),
  };
}

// ============================================================
// Topic builder + scoring
// ============================================================
function buildTopics(niche, suggest, datamuse, wiki, reddit) {
  const topics = [];
  const seen = new Set();

  // From Google Suggest — real searches
  suggest.forEach(s => {
    if (seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    topics.push({
      topic: titleCase(s),
      source: 'Google Suggest',
      intent: classifyIntent(s),
      difficulty: 'medium',
      score: scoreTopic(s, niche, 40),
      reason: 'Real search query — people actively type this into Google',
      url: `https://www.google.com/search?q=${encodeURIComponent(s)}`,
    });
  });

  // From Reddit — high-engagement questions
  reddit
    .filter(r => r.isQuestion && r.comments >= 5)
    .sort((a, b) => b.comments - a.comments)
    .slice(0, 10)
    .forEach(r => {
      const cleanTitle = r.title.replace(/^\w+:/, '').trim();
      if (seen.has(cleanTitle.toLowerCase())) return;
      seen.add(cleanTitle.toLowerCase());
      topics.push({
        topic: cleanTitle,
        source: `Reddit (r/${r.subreddit})`,
        intent: 'informational',
        difficulty: r.comments > 50 ? 'high-demand' : 'medium',
        score: scoreTopic(cleanTitle, niche, 30) + Math.min(r.comments / 5, 20),
        reason: `${r.comments} Reddit comments — proven audience demand`,
        url: r.url,
      });
    });

  // From Wikipedia — authoritative subtopics
  wiki
    .filter(w => w.title && w.title.toLowerCase() !== niche.toLowerCase())
    .slice(0, 8)
    .forEach(w => {
      if (seen.has(w.title.toLowerCase())) return;
      seen.add(w.title.toLowerCase());
      topics.push({
        topic: w.title,
        source: 'Wikipedia',
        intent: 'informational',
        difficulty: 'low',
        score: scoreTopic(w.title, niche, 25),
        reason: 'Authoritative subtopic — Wikipedia has an article on this',
        url: w.url,
      });
    });

  // From Datamuse — semantic clusters (combine with intent modifiers)
  const topDatamuse = datamuse.slice(0, 8);
  const intentPrefixes = ['Best', 'How to Choose', 'Top'];
  topDatamuse.forEach((d, i) => {
    if (!d.word || d.word.length < 4) return;
    const prefix = intentPrefixes[i % intentPrefixes.length];
    const topic = `${prefix} ${titleCase(d.word)}`;
    if (seen.has(topic.toLowerCase())) return;
    seen.add(topic.toLowerCase());
    topics.push({
      topic,
      source: 'Datamuse',
      intent: prefix === 'Best' || prefix === 'Top' ? 'commercial' : 'informational',
      difficulty: 'low',
      score: scoreTopic(topic, niche, 20) + (d.freq > 1 ? 10 : 0),
      reason: 'Semantically related to your niche',
      url: '',
    });
  });

  // Sort by score, return top 15
  return topics
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
}

function scoreTopic(topic, niche, baseScore) {
  let score = baseScore;
  // Bonus for containing the niche keyword
  if (topic.toLowerCase().includes(niche.toLowerCase())) score += 15;
  // Bonus for question format
  if (/\?$|^(how|why|what|when|where|which)/i.test(topic)) score += 10;
  // Bonus for "best/top" (commercial intent)
  if (/\b(best|top|review)\b/i.test(topic)) score += 8;
  // Bonus for year (current/timely)
  if (/202[5-9]/.test(topic)) score += 5;
  // Penalty for very long titles (over 70 chars)
  if (topic.length > 70) score -= 10;
  return score;
}

function classifyIntent(query) {
  const q = query.toLowerCase();
  if (/\b(buy|price|cost|cheap|deal|sale|discount|coupon|near me)\b/.test(q)) return 'transactional';
  if (/\b(best|top|vs|versus|review|comparison|alternative)\b/.test(q)) return 'commercial';
  if (/^(how|what|why|when|where|which|guide|tutorial)/.test(q)) return 'informational';
  return 'informational';
}

function titleCase(str) {
  return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substring(1));
}
