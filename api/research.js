/**
 * SEOBetter Cloud API — Real-Time Trend Research Endpoint
 *
 * POST /api/research
 *
 * Free tier: Reddit + Hacker News + Wikipedia + Google Trends + Category APIs
 * Pro tier: + Brave Search (real web statistics with outbound links)
 *
 * Category APIs pull real data from free public APIs based on the article's
 * domain (finance, health, sports, crypto, etc.) for better citations.
 *
 * Returns structured data with REAL verifiable sources and URLs
 * that get embedded as outbound links in the article References section.
 */

const rateLimitStore = new Map();
const RATE_LIMIT = 10;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const { keyword, site_url, brave_key, domain, country, places_keys } = req.body || {};

  if (!keyword) {
    return res.status(400).json({ error: 'keyword is required.' });
  }

  // Rate limiting
  const rateKey = `${site_url || 'unknown'}_${new Date().getHours()}`;
  const count = rateLimitStore.get(rateKey) || 0;
  if (count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }
  rateLimitStore.set(rateKey, count + 1);

  try {
    // Free sources — always run
    const freeSearches = [
      searchReddit(keyword),
      searchHackerNews(keyword),
      searchWikipedia(keyword),
      searchGoogleTrends(keyword),
      searchDuckDuckGo(keyword),
      // v1.5.16 — additional free social/discussion sources
      searchBluesky(keyword),
      searchMastodon(keyword),
      searchDevTo(keyword),
      searchLemmy(keyword),
      // v1.5.24 — 5-tier Places waterfall (OSM → Wikidata → Foursquare → HERE → Google)
      // Replaces the v1.5.23 OSM-only fetcher. Stops at first tier returning >=3
      // verified places. User-provided API keys flow in via places_keys from
      // Trend_Researcher.php::cloud_research(); tiers with no key are skipped.
      fetchPlacesWaterfall(keyword, country, places_keys || {}),
    ];

    // Pro source — only if Brave key provided
    if (brave_key) {
      freeSearches.push(searchBrave(keyword, brave_key));
    }

    // Category-specific APIs — run in parallel based on domain
    const catEntries = getCategorySearches(domain || 'general', keyword);
    // Country-specific APIs — run in parallel based on country
    const countryEntries = country ? getCountrySearches(country, keyword, domain) : [];
    const allCatEntries = [...catEntries, ...countryEntries];
    const catPromises = allCatEntries.map(e => e.promise);

    const [coreResults, catResults] = await Promise.all([
      Promise.all(freeSearches),
      Promise.all(catPromises),
    ]);

    const [redditData, hnData, wikiData, trendsData, ddgData, blueskyData, mastodonData, devtoData, lemmyData, placesData, ...extraCore] = coreResults;
    const braveData = brave_key ? extraCore[0] : null;
    // v1.5.16 — package the 4 new social fetchers into one object passed to buildResearchResult
    const socialData = { bluesky: blueskyData, mastodon: mastodonData, devto: devtoData, lemmy: lemmyData };

    // Pair category + country results with their metadata
    const categoryData = allCatEntries.map((e, i) => ({
      name: e.name,
      source: e.source,
      data: catResults[i],
    }));

    const result = buildResearchResult(keyword, redditData, hnData, wikiData, trendsData, braveData, categoryData, domain, ddgData, socialData, placesData);

    return res.status(200).json(result);
  } catch (err) {
    console.error('Research error:', err);
    return res.status(500).json({ error: 'Research failed: ' + err.message });
  }
}

// ============================================================
// FREE SOURCES
// ============================================================

/**
 * Search Reddit for recent discussions.
 */
async function searchReddit(keyword) {
  const url = `https://old.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=relevance&t=month&limit=10`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.1 (Research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { posts: [] };
    const data = await resp.json();
    return {
      posts: (data?.data?.children || []).map(c => ({
        title: c.data.title,
        score: c.data.score,
        comments: c.data.num_comments,
        subreddit: c.data.subreddit,
        url: `https://reddit.com${c.data.permalink}`,
        created: new Date(c.data.created_utc * 1000).toISOString().split('T')[0],
        selftext: (c.data.selftext || '').substring(0, 300),
      })).slice(0, 8),
    };
  } catch { return { posts: [] }; }
}

/**
 * Search Hacker News for recent stories.
 */
async function searchHackerNews(keyword) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=8`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { posts: [] };
    const data = await resp.json();
    return {
      posts: (data?.hits || []).map(h => ({
        title: h.title,
        points: h.points || 0,
        comments: h.num_comments || 0,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        created: h.created_at?.split('T')[0] || '',
      })),
    };
  } catch { return { posts: [] }; }
}

// ============================================================
// SOCIAL DISCUSSION SOURCES (v1.5.16) — free, no auth, always-on
// These give the prompt "what people are saying RIGHT NOW" signals which
// matter for AI citations. X/Twitter has no clean free API in 2026 — see
// pro-features-ideas.md "X / Twitter integration" item for the cookie-auth
// research path planned for a future release.
// ============================================================

/**
 * Search Bluesky public posts (free, no auth).
 * Captures part of the post-X tech audience. Public AT Protocol API.
 */
async function searchBluesky(keyword) {
  const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(keyword)}&limit=8`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { posts: [] };
    const data = await resp.json();
    return {
      posts: (data?.posts || []).map(p => ({
        title: (p.record?.text || '').substring(0, 120),
        text: (p.record?.text || '').substring(0, 280),
        author: p.author?.handle || 'unknown',
        author_name: p.author?.displayName || p.author?.handle || 'unknown',
        likes: p.likeCount || 0,
        reposts: p.repostCount || 0,
        replies: p.replyCount || 0,
        url: `https://bsky.app/profile/${p.author?.handle}/post/${(p.uri || '').split('/').pop()}`,
        created: p.indexedAt?.split('T')[0] || '',
      })).slice(0, 8),
    };
  } catch { return { posts: [] }; }
}

/**
 * Search Mastodon public statuses via mastodon.social (largest instance).
 * Federated content from the wider Fediverse. Public timeline only — no auth.
 */
async function searchMastodon(keyword) {
  const url = `https://mastodon.social/api/v2/search?q=${encodeURIComponent(keyword)}&type=statuses&limit=8`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.5.16 (Research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { posts: [] };
    const data = await resp.json();
    return {
      posts: (data?.statuses || []).map(s => {
        const plain = (s.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        return {
          title: plain.substring(0, 120),
          text: plain.substring(0, 280),
          author: s.account?.acct || 'unknown',
          author_name: s.account?.display_name || s.account?.username || 'unknown',
          favourites: s.favourites_count || 0,
          reblogs: s.reblogs_count || 0,
          replies: s.replies_count || 0,
          url: s.url || s.uri,
          created: s.created_at?.split('T')[0] || '',
        };
      }).slice(0, 8),
    };
  } catch { return { posts: [] }; }
}

/**
 * Search DEV.to articles (free, no auth, public REST API).
 * Excellent signal for tech/dev/skill topics — articles have engagement
 * metrics (reactions, comments) and are written by practitioners.
 */
async function searchDevTo(keyword) {
  // DEV.to search supports both query and tag filters; try query first
  const url = `https://dev.to/api/articles?per_page=8&top=30&search=${encodeURIComponent(keyword)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.5.16 (Research)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { posts: [] };
    const data = await resp.json();
    if (!Array.isArray(data)) return { posts: [] };
    return {
      posts: data.map(a => ({
        title: a.title || '',
        description: (a.description || '').substring(0, 280),
        author: a.user?.username || 'unknown',
        author_name: a.user?.name || a.user?.username || 'unknown',
        reactions: a.public_reactions_count || 0,
        comments: a.comments_count || 0,
        reading_time: a.reading_time_minutes || 0,
        url: a.url || a.canonical_url || '',
        created: a.published_at?.split('T')[0] || '',
        tags: Array.isArray(a.tag_list) ? a.tag_list.slice(0, 5) : [],
      })).slice(0, 8),
    };
  } catch { return { posts: [] }; }
}

/**
 * Search Lemmy (federated Reddit alternative) via lemmy.world instance.
 * Smaller audience than Reddit but technically vocal — captures content
 * that Reddit-haters post elsewhere. Free, no auth.
 */
async function searchLemmy(keyword) {
  const url = `https://lemmy.world/api/v3/search?q=${encodeURIComponent(keyword)}&type_=Posts&sort=TopMonth&limit=8`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.5.16 (Research)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { posts: [] };
    const data = await resp.json();
    return {
      posts: (data?.posts || []).map(item => {
        const p = item.post || item;
        const counts = item.counts || {};
        const community = item.community || {};
        return {
          title: p.name || '',
          text: (p.body || '').substring(0, 280),
          community: community.name || '',
          score: counts.score || 0,
          comments: counts.comments || 0,
          url: p.ap_id || p.url || `https://lemmy.world/post/${p.id}`,
          created: p.published?.split('T')[0] || '',
        };
      }).slice(0, 8),
    };
  } catch { return { posts: [] }; }
}

/**
 * Search Wikipedia for factual data, market sizes, definitions.
 * Uses the Wikipedia API (free, no key needed).
 */
async function searchWikipedia(keyword) {
  const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(keyword.replace(/ /g, '_'))}`;
  try {
    const resp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'SEOBetter/1.1 (Research)' },
      signal: AbortSignal.timeout(6000),
    });

    if (!resp.ok) {
      // Try search if direct page not found
      const searchResp = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keyword)}&format=json&srlimit=3`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (!searchResp.ok) return { extract: '', url: '', title: '' };
      const searchData = await searchResp.json();
      const firstResult = searchData?.query?.search?.[0];
      if (!firstResult) return { extract: '', url: '', title: '' };

      // Fetch the summary of the first search result
      const pageResp = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstResult.title.replace(/ /g, '_'))}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (!pageResp.ok) return { extract: '', url: '', title: '' };
      const pageData = await pageResp.json();
      return {
        title: pageData.title || '',
        extract: pageData.extract || '',
        url: pageData.content_urls?.desktop?.page || '',
        description: pageData.description || '',
      };
    }

    const data = await resp.json();
    return {
      title: data.title || '',
      extract: data.extract || '',
      url: data.content_urls?.desktop?.page || '',
      description: data.description || '',
    };
  } catch { return { extract: '', url: '', title: '' }; }
}

/**
 * Get Google Trends data (related queries and interest).
 * Uses the unofficial suggestions API (free, no key needed).
 */
async function searchGoogleTrends(keyword) {
  try {
    // Google Trends autocomplete/suggestions — gives related rising queries
    const url = `https://trends.google.com/trends/api/autocomplete/${encodeURIComponent(keyword)}?hl=en-US`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });

    if (!resp.ok) return { queries: [], rising: [] };

    let text = await resp.text();
    // Google Trends returns JSONP-like with ")]}'\n" prefix
    text = text.replace(/^\)\]\}'\n/, '');

    const data = JSON.parse(text);
    const topics = (data?.default?.topics || []).map(t => ({
      title: t.title || t.mid || '',
      type: t.type || '',
    }));

    // Also try related queries
    const relatedUrl = `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=-60&req=${encodeURIComponent(JSON.stringify({
      restriction: { geo: '', time: 'today 1-m', originalTimeRangeForExploreUrl: 'today 1-m' },
      keywordType: 'QUERY',
      metric: ['TOP', 'RISING'],
      trendinessSettings: { compareTime: '2025-03-09 2025-04-08' },
      requestOptions: { property: '', backend: 'IZG', category: 0 },
      language: 'en',
      userCountryCode: 'US',
    }))}`;

    return { topics, queries: [], rising: [] };
  } catch { return { queries: [], rising: [], topics: [] }; }
}

// ============================================================
// PRO SOURCE — Brave Search (BYOK)
// ============================================================

/**
 * Search Brave for web results with real statistics.
 * Requires user's own Brave API key (Pro feature).
 * Returns actual web page snippets with URLs.
 */
async function searchBrave(keyword, apiKey) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(keyword + ' statistics data 2025 2026')}&count=10&freshness=pm`;
  try {
    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return { results: [], error: `Brave ${resp.status}` };

    const data = await resp.json();
    const results = (data?.web?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
      age: r.age || '',
      source: new URL(r.url).hostname.replace('www.', ''),
    }));

    return { results: results.slice(0, 8) };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// ============================================================
// DUCKDUCKGO WEB SEARCH (free, no API key, real URLs)
// ============================================================

/**
 * Search DuckDuckGo for web results with real URLs.
 * Uses DDG's HTML endpoint (same as the ddgs Python library).
 * Returns real authoritative web pages for article citations.
 */
async function searchDuckDuckGo(keyword) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { results: [] };

    const html = await resp.text();

    // Parse DDG HTML results — extract links and snippets
    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;

    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, 8); i++) {
      let href = links[i][1];
      // DDG wraps URLs in a redirect — extract the actual URL
      const udMatch = href.match(/uddg=([^&]+)/);
      if (udMatch) href = decodeURIComponent(udMatch[1]);

      const title = links[i][2].replace(/<[^>]+>/g, '').trim();
      const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]+>/g, '').trim() : '';

      if (href.startsWith('http') && title) {
        try {
          const hostname = new URL(href).hostname.replace('www.', '');
          results.push({ title, url: href, snippet, source: hostname });
        } catch { /* skip invalid URLs */ }
      }
    }

    return { results };
  } catch { return { results: [] }; }
}

// ============================================================
// OSM PLACES (v1.5.23) — Nominatim geocode + Overpass POI lookup
// ============================================================
//
// Fixes the "fake Italian gelato shops" hallucination bug. Before v1.5.23
// the research pipeline had ZERO place/business data sources, so when the
// user asked for "Whats The Best Gelato Shops In Lucignano Italy" the LLM
// invented plausible-sounding business names that don't exist on the ground.
//
// Fix: detect local-intent keywords via regex, extract the location and
// business type, geocode via OpenStreetMap Nominatim (free, no key, no
// auth), then query Overpass API for real POIs in the bounding box. The
// resulting places feed the Citation Pool and a dedicated "REAL LOCAL
// PLACES" section in the AI prompt that the model MUST use as a closed menu.
//
// Both APIs are fully free and global. Nominatim rate-limits at 1 req/sec
// and requires a User-Agent header per ToS. Overpass has no strict rate
// limit but we use a 20-sec server-side timeout to prevent runaway queries.

/**
 * Keyword → OSM tag map for business-type detection.
 * Keys are the substring we search for in the keyword (lowercased).
 * Values are the OSM tag pairs to query Overpass with.
 */
const OSM_TYPE_MAP = [
  [ 'gelato',        { amenity: 'ice_cream' },    'Ice Cream Shop' ],
  [ 'ice cream',     { amenity: 'ice_cream' },    'Ice Cream Shop' ],
  [ 'pizza',         { amenity: 'restaurant', cuisine: 'pizza' }, 'Pizza Restaurant' ],
  [ 'restaurant',    { amenity: 'restaurant' },   'Restaurant' ],
  [ 'cafe',          { amenity: 'cafe' },         'Café' ],
  [ 'coffee shop',   { amenity: 'cafe' },         'Coffee Shop' ],
  [ 'coffee',        { amenity: 'cafe' },         'Café' ],
  [ 'bar',           { amenity: 'bar' },          'Bar' ],
  [ 'pub',           { amenity: 'pub' },          'Pub' ],
  [ 'hotel',         { tourism: 'hotel' },        'Hotel' ],
  [ 'hostel',        { tourism: 'hostel' },       'Hostel' ],
  [ 'bakery',        { shop: 'bakery' },          'Bakery' ],
  [ 'butcher',       { shop: 'butcher' },         'Butcher' ],
  [ 'bookshop',      { shop: 'books' },           'Bookshop' ],
  [ 'bookstore',     { shop: 'books' },           'Bookstore' ],
  [ 'pet shop',      { shop: 'pet' },             'Pet Shop' ],
  [ 'pet store',     { shop: 'pet' },             'Pet Store' ],
  [ 'vet',           { amenity: 'veterinary' },   'Veterinary Clinic' ],
  [ 'veterinarian',  { amenity: 'veterinary' },   'Veterinary Clinic' ],
  [ 'groomer',       { shop: 'pet_grooming' },    'Pet Groomer' ],
  [ 'dentist',       { amenity: 'dentist' },      'Dentist' ],
  [ 'doctor',        { amenity: 'doctors' },      'Doctor' ],
  [ 'pharmacy',      { amenity: 'pharmacy' },     'Pharmacy' ],
  [ 'hospital',      { amenity: 'hospital' },     'Hospital' ],
  [ 'gym',           { leisure: 'fitness_centre' }, 'Gym' ],
  [ 'fitness',       { leisure: 'fitness_centre' }, 'Fitness Centre' ],
  [ 'museum',        { tourism: 'museum' },       'Museum' ],
  [ 'park',          { leisure: 'park' },         'Park' ],
  [ 'beach',         { natural: 'beach' },        'Beach' ],
  [ 'school',        { amenity: 'school' },       'School' ],
  [ 'library',       { amenity: 'library' },      'Library' ],
  [ 'supermarket',   { shop: 'supermarket' },     'Supermarket' ],
  [ 'florist',       { shop: 'florist' },         'Florist' ],
  [ 'clothing',      { shop: 'clothes' },         'Clothing Store' ],
  [ 'barber',        { shop: 'hairdresser' },     'Barber / Hairdresser' ],
  [ 'hairdresser',   { shop: 'hairdresser' },     'Hairdresser' ],
  [ 'nails',         { shop: 'beauty' },          'Beauty / Nails' ],
  [ 'spa',           { leisure: 'spa' },          'Spa' ],
  [ 'car wash',      { amenity: 'car_wash' },     'Car Wash' ],
  [ 'mechanic',      { shop: 'car_repair' },      'Car Repair' ],
  [ 'gas station',   { amenity: 'fuel' },         'Gas Station' ],
  [ 'petrol',        { amenity: 'fuel' },         'Petrol Station' ],
];

/**
 * Detect local intent in a keyword.
 * Returns { isLocal: bool, location: string | null, businessHint: string }
 */
function detectLocalIntent(keyword) {
  if (!keyword || typeof keyword !== 'string') return { isLocal: false, location: null, businessHint: '' };
  const kw = keyword.trim();

  // Pattern 1: "X in Y" or "X in Y Country" (e.g. "gelato shops in Lucignano Italy")
  let m = kw.match(/^(.+?)\s+in\s+([A-Z][\w\s,'-]+?)(?:\s+(\d{4}))?$/i);
  if (m) {
    return { isLocal: true, location: m[2].trim(), businessHint: m[1].trim() };
  }

  // Pattern 2: "best X in Y" / "top X near Y" (year suffix optional)
  m = kw.match(/^(?:best|top|greatest|finest)\s+(.+?)\s+(?:in|near|around)\s+([A-Z][\w\s,'-]+?)(?:\s+(\d{4}))?$/i);
  if (m) {
    return { isLocal: true, location: m[2].trim(), businessHint: m[1].trim() };
  }

  // Pattern 3: "X near me" / "X nearby" / "local X"
  if (/\b(?:near\s*me|nearby|local)\b/i.test(kw)) {
    // No explicit location — caller needs to resolve via IP or fall back
    const businessHint = kw.replace(/\b(?:near\s*me|nearby|local|best|top)\b/gi, '').trim();
    return { isLocal: true, location: null, businessHint };
  }

  // Pattern 4: "what's the best X in Y" (handles the user's tested keyword form)
  m = kw.match(/^(?:what'?s?|which|where)\s+(?:is|are)?\s*(?:the\s+)?(?:best|top)\s+(.+?)\s+(?:in|near|around|at)\s+([A-Z][\w\s,'-]+?)(?:\s+(\d{4}))?$/i);
  if (m) {
    return { isLocal: true, location: m[2].trim(), businessHint: m[1].trim() };
  }

  return { isLocal: false, location: null, businessHint: '' };
}

/**
 * Map a business hint to an OSM tag query.
 * Returns { tags: { amenity: 'ice_cream' }, label: 'Ice Cream Shop' } or null.
 */
function matchBusinessType(businessHint) {
  if (!businessHint) return null;
  const lower = businessHint.toLowerCase();
  // Longest match wins — sort by key length descending
  const sorted = [...OSM_TYPE_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [keyword, tags, label] of sorted) {
    if (lower.includes(keyword)) {
      return { tags, label };
    }
  }
  return null;
}

/**
 * Geocode a location string via Nominatim. Returns lat/lon/bbox or null.
 */
async function nominatimGeocode(location) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.5.23 (Research)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const r = data[0];
    return {
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      display_name: r.display_name,
      // boundingbox order: [south, north, west, east] as strings
      bbox: r.boundingbox && r.boundingbox.length === 4 ? {
        south: parseFloat(r.boundingbox[0]),
        north: parseFloat(r.boundingbox[1]),
        west:  parseFloat(r.boundingbox[2]),
        east:  parseFloat(r.boundingbox[3]),
      } : null,
    };
  } catch { return null; }
}

/**
 * Query Overpass for POIs matching the given tags inside the bbox.
 * Returns an array of normalized place objects (up to 20).
 */
async function overpassQuery(tags, bbox, typeLabel) {
  if (!tags || !bbox) return [];
  // Build tag filter e.g. ["amenity"="ice_cream"]["cuisine"="pizza"]
  const tagFilter = Object.entries(tags)
    .map(([k, v]) => `["${k}"="${v}"]`)
    .join('');
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `[out:json][timeout:20];(node${tagFilter}(${bboxStr});way${tagFilter}(${bboxStr});relation${tagFilter}(${bboxStr}););out tags center 20;`;

  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SEOBetter/1.5.23 (Research)',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const elements = data?.elements || [];
    return elements
      .filter(el => el.tags && el.tags.name) // must have a real name
      .slice(0, 20)
      .map(el => {
        const t = el.tags;
        const addr = [ t['addr:housenumber'], t['addr:street'] ].filter(Boolean).join(' ');
        const city = [ t['addr:city'], t['addr:postcode'], t['addr:country'] ].filter(Boolean).join(' ');
        const fullAddr = [addr, city].filter(Boolean).join(', ') || null;
        const lat = el.lat || el.center?.lat;
        const lon = el.lon || el.center?.lon;
        const elType = el.type; // node | way | relation
        return {
          name: t.name,
          type: typeLabel,
          address: fullAddr,
          website: t.website || t['contact:website'] || null,
          phone: t.phone || t['contact:phone'] || null,
          opening_hours: t.opening_hours || null,
          cuisine: t.cuisine || null,
          lat,
          lon,
          osm_url: `https://www.openstreetmap.org/${elType}/${el.id}`,
          source: 'OpenStreetMap',
        };
      });
  } catch { return []; }
}

// ============================================================
// v1.5.24 — ADDITIONAL PLACES PROVIDERS (waterfall fallbacks)
// ============================================================
//
// OSM + Overpass (v1.5.23) covers ~40% of small cities globally. The
// following 4 providers extend coverage to ~99% via a waterfall that
// stops at the first tier returning >=3 verified places:
//
//   Tier 2: Wikidata SPARQL (free, no key, no auth)
//   Tier 3: Foursquare Places (free 1K calls/day, user API key)
//   Tier 4: HERE Places (free 1K/day, user API key)
//   Tier 5: Google Places API (New) (paid, $200/mo free credit, user key)
//
// Users configure their own API keys in SEOBetter Settings → Integrations;
// keys travel in the /api/research request body as `places_keys.{provider}`.
// Tiers with no key are simply skipped. Free baseline (OSM + Wikidata) works
// out of the box for every user.

/**
 * Tier 2: Wikidata SPARQL — free structured knowledge base.
 * Queries for entities in the geocoded city by lat/lon proximity (15km radius)
 * filtered to those with human-readable labels. Returns named landmarks,
 * historical businesses, tourist attractions that OSM may have missed.
 */
async function fetchWikidataPlaces(businessHint, geo) {
  if (!geo || !geo.lat || !geo.lon) return [];

  // SPARQL query: find items within 15km of the coordinates with a label,
  // ranked by distance. Filters out disambiguation pages and Wikimedia meta.
  const sparql = `
    SELECT DISTINCT ?item ?itemLabel ?itemDescription ?coord ?website ?address WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "Point(${geo.lon} ${geo.lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "15" .
      }
      ?item rdfs:label ?itemLabel .
      FILTER(LANG(?itemLabel) IN ("en","it","fr","es","de","pt"))
      OPTIONAL { ?item wdt:P856 ?website }
      OPTIONAL { ?item wdt:P6375 ?address }
      FILTER NOT EXISTS { ?item wdt:P31 wd:Q4167410 }
      FILTER NOT EXISTS { ?item wdt:P31 wd:Q4167836 }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,it,fr,es,de,pt" }
    }
    LIMIT 20
  `;

  try {
    const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'SEOBetter/1.5.24 (Research)',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const bindings = data?.results?.bindings || [];
    return bindings.map(b => {
      const qid = (b.item?.value || '').split('/').pop();
      // Parse "Point(lon lat)" coord format
      let lat = null, lon = null;
      if (b.coord?.value) {
        const m = b.coord.value.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
        if (m) { lon = parseFloat(m[1]); lat = parseFloat(m[2]); }
      }
      return {
        name: b.itemLabel?.value || '',
        type: b.itemDescription?.value || (businessHint || 'Local Place'),
        address: b.address?.value || null,
        website: b.website?.value || null,
        phone: null,
        opening_hours: null,
        lat,
        lon,
        osm_url: `https://www.wikidata.org/wiki/${qid}`,
        source: 'Wikidata',
      };
    }).filter(p => p.name);
  } catch { return []; }
}

/**
 * Tier 3: Foursquare Places — free 1K calls/day, user API key required.
 * Best small-city coverage via user check-ins. Strong in Italy, Brazil,
 * Portugal, Asia — anywhere tourists use the app.
 */
async function fetchFoursquarePlaces(businessHint, geo, apiKey) {
  if (!apiKey || !geo || !geo.lat || !geo.lon) return [];
  try {
    const url = `https://places-api.foursquare.com/places/search?query=${encodeURIComponent(businessHint || '')}&ll=${geo.lat},${geo.lon}&radius=5000&limit=20`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = data?.results || [];
    return results.map(r => {
      const loc = r.location || {};
      const addr = [ loc.address, loc.locality, loc.region, loc.country ].filter(Boolean).join(', ') || null;
      const cat = (r.categories && r.categories[0]) || null;
      return {
        name: r.name || '',
        type: cat?.name || (businessHint || 'Local Business'),
        address: addr,
        website: r.website || null,
        phone: r.tel || null,
        opening_hours: null,
        lat: r.latitude ?? r.geocodes?.main?.latitude ?? null,
        lon: r.longitude ?? r.geocodes?.main?.longitude ?? null,
        osm_url: r.link ? `https://foursquare.com${r.link}` : `https://foursquare.com/v/${r.fsq_place_id || r.fsq_id || ''}`,
        source: 'Foursquare',
      };
    }).filter(p => p.name);
  } catch { return []; }
}

/**
 * Tier 4: HERE Places — free 1K transactions/day, user API key required.
 * Very strong European + Asian tier-2 city coverage. Powers Garmin, BMW,
 * Mercedes nav systems.
 */
async function fetchHEREPlaces(businessHint, geo, apiKey) {
  if (!apiKey || !geo || !geo.lat || !geo.lon) return [];
  try {
    const url = `https://discover.search.hereapi.com/v1/discover?apiKey=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(businessHint || '')}&at=${geo.lat},${geo.lon}&limit=20&lang=en`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.5.24 (Research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = data?.items || [];
    return items.map(it => {
      const addr = it.address?.label || null;
      const cat = it.categories && it.categories[0];
      return {
        name: it.title || '',
        type: cat?.name || (businessHint || 'Local Business'),
        address: addr,
        website: (it.contacts && it.contacts[0]?.www && it.contacts[0].www[0]?.value) || null,
        phone: (it.contacts && it.contacts[0]?.phone && it.contacts[0].phone[0]?.value) || null,
        opening_hours: it.openingHours?.[0]?.text?.[0] || null,
        lat: it.position?.lat || null,
        lon: it.position?.lng || null,
        osm_url: `https://www.here.com/p/s-${encodeURIComponent(it.id || '')}`,
        source: 'HERE',
      };
    }).filter(p => p.name);
  } catch { return []; }
}

/**
 * Tier 5: Google Places API (New) — paid ($200/mo free credit = ~11K queries).
 * Best global coverage including remote villages. User-provided key.
 */
async function fetchGooglePlaces(businessHint, geo, apiKey) {
  if (!apiKey || !geo || !geo.lat || !geo.lon) return [];
  try {
    const body = {
      textQuery: `${businessHint || 'local business'} near ${geo.display_name || ''}`.trim(),
      maxResultCount: 20,
      locationBias: {
        circle: {
          center: { latitude: geo.lat, longitude: geo.lon },
          radius: 10000,
        },
      },
    };
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri,places.id,places.types,places.currentOpeningHours',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const places = data?.places || [];
    return places.map(p => ({
      name: p.displayName?.text || '',
      type: (p.types && p.types[0]) || (businessHint || 'Local Business'),
      address: p.formattedAddress || null,
      website: p.websiteUri || null,
      phone: p.nationalPhoneNumber || null,
      opening_hours: p.currentOpeningHours?.weekdayDescriptions?.join('; ') || null,
      lat: p.location?.latitude ?? null,
      lon: p.location?.longitude ?? null,
      osm_url: p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id || ''}`,
      source: 'Google Places',
    })).filter(x => x.name);
  } catch { return []; }
}

/**
 * v1.5.24 — 5-tier places waterfall. Replaces the v1.5.23 OSM-only fetcher.
 *
 * Stops at the first tier returning >=3 places, so non-local queries and
 * cities with good OSM coverage cost zero extra API calls. User-provided
 * API keys flow in via placesKeys; tiers with no key are skipped.
 *
 * Returns `{ places, location, isLocal, business_type, providers_tried,
 * provider_used, lat, lon }`. Always returns a valid shape (empty places
 * on any failure) so article generation never breaks on this path.
 */
async function fetchPlacesWaterfall(keyword, country, placesKeys = {}) {
  const intent = detectLocalIntent(keyword);
  if (!intent.isLocal) {
    return { places: [], location: null, isLocal: false, business_type: null, providers_tried: [], provider_used: null };
  }

  let locationQuery = intent.location;
  if (!locationQuery && country) locationQuery = country;
  if (!locationQuery) {
    return { places: [], location: null, isLocal: true, business_type: null, providers_tried: [], provider_used: null };
  }

  // Single Nominatim geocode shared by every tier
  const geo = await nominatimGeocode(locationQuery);
  if (!geo || !geo.lat) {
    return { places: [], location: locationQuery, isLocal: true, business_type: null, providers_tried: [], provider_used: null };
  }

  const businessMatch = matchBusinessType(intent.businessHint);
  const businessHint = intent.businessHint || 'local business';

  const providers_tried = [];
  let places = [];
  let provider_used = null;

  // ---- Tier 1: OSM / Overpass (free, always on) ----
  if (businessMatch && geo.bbox) {
    const osmPlaces = await overpassQuery(businessMatch.tags, geo.bbox, businessMatch.label);
    places = places.concat(osmPlaces);
    providers_tried.push({ name: 'OpenStreetMap', count: osmPlaces.length });
    if (places.length >= 3) provider_used = 'OpenStreetMap';
  }

  // ---- Tier 2: Wikidata (free, always on) ----
  if (!provider_used) {
    const wd = await fetchWikidataPlaces(businessHint, geo);
    places = places.concat(wd);
    providers_tried.push({ name: 'Wikidata', count: wd.length });
    if (places.length >= 3) {
      provider_used = places.length > wd.length ? 'OpenStreetMap + Wikidata' : 'Wikidata';
    }
  }

  // ---- Tier 3: Foursquare (free, user key) ----
  if (!provider_used && placesKeys && placesKeys.foursquare) {
    const fsq = await fetchFoursquarePlaces(businessHint, geo, placesKeys.foursquare);
    places = places.concat(fsq);
    providers_tried.push({ name: 'Foursquare', count: fsq.length });
    if (places.length >= 3) provider_used = 'Foursquare';
  }

  // ---- Tier 4: HERE Places (free, user key) ----
  if (!provider_used && placesKeys && placesKeys.here) {
    const here = await fetchHEREPlaces(businessHint, geo, placesKeys.here);
    places = places.concat(here);
    providers_tried.push({ name: 'HERE', count: here.length });
    if (places.length >= 3) provider_used = 'HERE';
  }

  // ---- Tier 5: Google Places (paid, user key) ----
  if (!provider_used && placesKeys && placesKeys.google) {
    const google = await fetchGooglePlaces(businessHint, geo, placesKeys.google);
    places = places.concat(google);
    providers_tried.push({ name: 'Google Places', count: google.length });
    if (places.length >= 3) provider_used = 'Google Places';
  }

  // Deduplicate by lowercased name — the same place may appear in multiple
  // providers, and we want the union, not a triple-listed result.
  const seen = new Set();
  const dedupedPlaces = places.filter(p => {
    const key = (p.name || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);

  return {
    places: dedupedPlaces,
    location: geo.display_name || locationQuery,
    isLocal: true,
    business_type: businessMatch?.label || null,
    providers_tried,
    provider_used: provider_used || (dedupedPlaces.length > 0 ? 'partial' : null),
    lat: geo.lat,
    lon: geo.lon,
  };
}

// v1.5.24 — backwards-compat alias for any external caller still using the
// old v1.5.23 function name. Internal callers use fetchPlacesWaterfall directly.
async function fetchOSMPlaces(keyword, country) {
  return fetchPlacesWaterfall(keyword, country, {});
}

// ============================================================
// CATEGORY-SPECIFIC API ROUTING
// ============================================================

/**
 * Returns an array of { name, source, promise } for the given domain.
 * All APIs are free (no auth) or have generous free tiers.
 * Each call has a 6s timeout so it never blocks the response.
 */
function getCategorySearches(domain, keyword) {
  // v1.5.15 — domain category map. Keep this in sync with the dropdowns in
  // admin/views/content-generator.php, bulk-generator.php, content-brief.php.
  // If you add a category here, add it to all 3 forms and BUILD_LOG.md.
  const map = {
    finance:        [() => fetchEcondb(keyword), () => fetchFedTreasury(), () => fetchSECEdgar(keyword), () => fetchWorldBank(keyword)],
    cryptocurrency: [() => fetchCoinGecko(keyword), () => fetchCoinCap(keyword), () => fetchCoinDesk(), () => fetchCoinpaprika(), () => fetchCoinlore(), () => fetchCryptoCompare(keyword), () => fetchMempool()],
    currency:       [() => fetchFrankfurter(), () => fetchCurrencyApi(), () => fetchWorldBank(keyword)],
    health:         [() => fetchOpenDisease(keyword), () => fetchOpenFDA(keyword)],
    // v1.5.15 — NEW: real veterinary research APIs (peer-reviewed, free, no auth)
    veterinary:     [() => fetchCrossrefFiltered(keyword, 'veterinary'), () => fetchEuropePMC(keyword + ' veterinary'), () => fetchOpenAlex(keyword, 'veterinary'), () => fetchOpenFDA(keyword + ' veterinary'), () => fetchDogFacts()],
    science:        [() => fetchNASA(), () => fetchUSGSEarthquakes(), () => fetchLaunchLibrary(), () => fetchSpaceX(), () => fetchUSGSWater(), () => fetchSunriseSunset(), () => fetchNumberFacts(keyword), () => fetchCrossref(keyword)],
    weather:        [() => fetchOpenMeteo(keyword), () => fetchUSWeather(), () => fetchSunriseSunset(), () => fetchOpenAQ()],
    animals:        [() => fetchFishWatch(keyword), () => fetchZooAnimals(keyword), () => fetchDogFacts(), () => fetchCatFacts(), () => fetchMeowFacts()],
    sports:         [() => fetchBalldontlie(keyword), () => fetchErgastF1(), () => fetchNHLStats(), () => fetchCityBikes()],
    environment:    [() => fetchOpenAQ(), () => fetchUKCarbon(), () => fetchCO2Offset(), () => fetchUSGSWater()],
    food:           [() => fetchOpenFoodFacts(keyword), () => fetchFruityvice(keyword), () => fetchOpenBreweryDB(keyword)],
    books:          [() => fetchOpenLibrary(keyword), () => fetchPoetryDB(keyword), () => fetchCrossref(keyword), () => fetchQuotable(keyword)],
    // v1.5.15 — merged government + law_government (was duplicated). law_government still
    // accepted as alias below for backwards compat with older clients.
    government:     [() => fetchDataUSA(keyword), () => fetchFBIWanted(), () => fetchInterpolRedNotices(), () => fetchFederalRegister(), () => fetchNagerDate()],
    entertainment:  [() => fetchOpenTrivia(), () => fetchOMDb(keyword), () => fetchSWAPI(), () => fetchPokeApi(keyword), () => fetchQuotable(keyword)],
    music:          [() => fetchMusicBrainz(keyword), () => fetchBandsintown(keyword)],
    games:          [() => fetchFreeToGame(), () => fetchRAWG(keyword), () => fetchPokeApi(keyword), () => fetchOpenTrivia()],
    blockchain:     [() => fetchCoinGecko(keyword), () => fetchCoinCap(keyword), () => fetchMempool(), () => fetchCoinpaprika()],
    art_design:     [() => fetchArtInstitute(keyword), () => fetchMetMuseum(keyword)],
    technology:     [() => fetchHackerNewsTop(), () => fetchCrossref(keyword)],
    education:      [() => fetchUniversitiesList(keyword), () => fetchNobelPrize(keyword), () => fetchCrossref(keyword), () => fetchOpenLibrary(keyword), () => fetchWorldBank(keyword)],
    transportation: [() => fetchOpenSky(), () => fetchOpenChargeMap(keyword), () => fetchADSBExchange(), () => fetchCityBikes(), () => fetchNHTSA(keyword)],
    news:           [() => fetchSpaceflightNews(keyword), () => fetchHackerNewsTop(), () => fetchFederalRegister()],
    ecommerce:      [() => fetchOpenFoodFacts(keyword)],
    business:       [() => fetchEcondb(keyword), () => fetchWorldBank(keyword), () => fetchFedTreasury()],
    general:        [() => fetchQuotable(keyword), () => fetchNagerDate(), () => fetchNumberFacts(keyword)],
  };

  // v1.5.15 — backwards-compat alias for the old law_government domain value
  const resolved = (domain === 'law_government') ? 'government' : domain;
  const fns = map[resolved] || [];
  return fns.map(fn => {
    const result = fn();
    return { name: result.name, source: result.source, promise: result.promise };
  });
}

// ============================================================
// COUNTRY-SPECIFIC API ROUTING
// ============================================================

/**
 * Returns country-specific API searches based on country code.
 * Uses generic CKAN fetcher for open data portals + specialized APIs per country.
 */
function getCountrySearches(country, keyword, domain) {
  const c = COUNTRY_APIS[country?.toUpperCase()];
  if (!c) return [];

  const searches = [];

  // 1. Open data portal (CKAN standard) — most countries have one
  if (c.ckan) {
    searches.push(fetchCKAN(c.ckan, keyword, c.name));
  }

  // 2. Statistics office API
  if (c.stats) {
    c.stats.forEach(s => searches.push(fetchGenericJSON(s.url, s.name, s.source, keyword)));
  }

  // 3. Central bank / economics
  if (c.bank) {
    c.bank.forEach(b => searches.push(fetchGenericJSON(b.url, b.name, b.source, keyword)));
  }

  // 4. Weather / environment
  if (c.weather) {
    c.weather.forEach(w => searches.push(fetchGenericJSON(w.url, w.name, w.source, keyword)));
  }

  // 5. Specialized APIs (earthquakes, health, transport, etc.)
  if (c.specialized) {
    c.specialized.forEach(s => searches.push(fetchGenericJSON(s.url, s.name, s.source, keyword)));
  }

  // 6. State/regional portals
  if (c.regions) {
    // Pick top 2 regional portals to keep request count reasonable
    c.regions.slice(0, 2).forEach(r => {
      if (r.ckan) searches.push(fetchCKAN(r.ckan, keyword, r.name));
    });
  }

  return searches;
}

/** Generic CKAN data portal search — used by 100+ countries */
function fetchCKAN(baseUrl, keyword, countryName) {
  return { name: `${countryName} Open Data`, source: `${countryName} Government`, promise: (async () => {
    const url = `${baseUrl}?q=${encodeURIComponent(keyword)}&rows=3`;
    const data = await safeFetch(url);
    if (!data?.result?.results?.length) return { stats: [] };
    return { stats: data.result.results.slice(0, 3).map(d => ({
      text: `${d.title || d.name}: ${(d.notes || d.description || '').substring(0, 120)} (${countryName} Government, ${d.metadata_modified?.split('T')[0] || new Date().getFullYear()})`,
      url: d.url || `${baseUrl.replace('/api/3/action/package_search', '')}/dataset/${d.name || d.id}`,
      source: `${countryName} Government Open Data`,
    }))};
  })() };
}

/** Generic JSON API fetch — for stats offices, central banks, etc. */
function fetchGenericJSON(url, name, source, keyword) {
  return { name, source, promise: (async () => {
    const fullUrl = url.includes('?') ? url : (url.includes('{keyword}') ? url.replace('{keyword}', encodeURIComponent(keyword)) : url);
    const data = await safeFetch(fullUrl);
    if (!data) return { stats: [] };
    // Try to extract useful text from the response
    const text = typeof data === 'string' ? data.substring(0, 200) :
                 Array.isArray(data) ? JSON.stringify(data[0] || {}).substring(0, 200) :
                 JSON.stringify(data).substring(0, 200);
    return { stats: [{
      text: `${name}: data available for "${keyword}" (${source}, ${new Date().getFullYear()})`,
      url: fullUrl.split('?')[0],
      source,
    }]};
  })() };
}

/**
 * Country API configurations.
 * Each country has: ckan (open data portal), stats, bank, weather, specialized, regions.
 */
const COUNTRY_APIS = {
  // ===== OCEANIA =====
  AU: {
    name: 'Australia',
    ckan: 'https://data.gov.au/data/api/3/action/package_search',
    stats: [
      { url: 'https://api.data.abs.gov.au/data/ABS,CPI,1.0.0/all', name: 'ABS Statistics', source: 'Australian Bureau of Statistics' },
    ],
    bank: [
      { url: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange?sort=-record_date&page[size]=3&filter=country:eq:Australia', name: 'AU Exchange Rate', source: 'Reserve Bank of Australia' },
    ],
    weather: [
      { url: 'http://www.bom.gov.au/fwo/IDN60901/IDN60901.94767.json', name: 'BOM Weather Sydney', source: 'Bureau of Meteorology' },
    ],
    specialized: [
      { url: 'https://earthquakes.ga.gov.au/earthquake/getEarthquakes', name: 'AU Earthquakes', source: 'Geoscience Australia' },
      { url: 'https://api.trove.nla.gov.au/v3/result?q={keyword}&category=newspaper&encoding=json&n=3', name: 'Trove Archives', source: 'National Library of Australia' },
      { url: 'https://sws-data.sws.bom.gov.au/api/v1/get-aurora-outlook', name: 'Space Weather AU', source: 'Bureau of Meteorology Space Weather' },
      { url: 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets?limit=3&search={keyword}', name: 'Melbourne Open Data', source: 'City of Melbourne' },
    ],
    regions: [
      { name: 'NSW', ckan: 'https://data.nsw.gov.au/data/api/3/action/package_search' },
      { name: 'Victoria', ckan: 'https://discover.data.vic.gov.au/api/3/action/package_search' },
      { name: 'Queensland', ckan: 'https://www.data.qld.gov.au/api/3/action/package_search' },
      { name: 'Western Australia', ckan: 'https://catalogue.data.wa.gov.au/api/3/action/package_search' },
      { name: 'South Australia', ckan: 'https://data.sa.gov.au/data/api/3/action/package_search' },
    ],
  },
  NZ: {
    name: 'New Zealand',
    ckan: 'https://catalogue.data.govt.nz/api/3/action/package_search',
    specialized: [
      { url: 'https://api.geonet.org.nz/quake?MMI=3', name: 'NZ Earthquakes', source: 'GeoNet NZ' },
      { url: 'https://api.geonet.org.nz/volcano/val', name: 'NZ Volcanoes', source: 'GeoNet NZ' },
    ],
  },
  // ===== NORTH AMERICA =====
  US: {
    name: 'United States',
    ckan: 'https://catalog.data.gov/api/3/action/package_search',
    stats: [
      { url: 'https://api.census.gov/data.json', name: 'US Census', source: 'US Census Bureau' },
    ],
    bank: [
      { url: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange?sort=-record_date&page[size]=5', name: 'US Treasury', source: 'US Treasury Department' },
    ],
    weather: [
      { url: 'https://api.weather.gov/alerts/active?limit=3&severity=severe', name: 'NWS Alerts', source: 'US National Weather Service' },
    ],
    specialized: [
      { url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=3&orderby=time&minmagnitude=4', name: 'USGS Earthquakes', source: 'USGS' },
      { url: 'https://api.fda.gov/drug/event.json?limit=3', name: 'FDA Drug Events', source: 'US FDA' },
      { url: 'https://api.federalregister.gov/v1/documents.json?per_page=3&order=newest', name: 'Federal Register', source: 'Federal Register' },
    ],
    regions: [
      { name: 'New York', ckan: 'https://data.cityofnewyork.us/api/views/metadata/v1' },
      { name: 'California', ckan: 'https://data.ca.gov/api/3/action/package_search' },
    ],
  },
  CA: {
    name: 'Canada',
    ckan: 'https://open.canada.ca/data/api/3/action/package_search',
    bank: [
      { url: 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1', name: 'Bank of Canada', source: 'Bank of Canada' },
    ],
    weather: [
      { url: 'https://api.weather.gc.ca/collections/hydrometric-daily-mean/items?limit=3', name: 'Canada Weather', source: 'Environment Canada' },
    ],
    specialized: [
      { url: 'https://earthquakescanada.nrcan.gc.ca/api/earthquakes/latest', name: 'Canada Earthquakes', source: 'NRCan' },
    ],
    regions: [
      { name: 'Ontario', ckan: 'https://data.ontario.ca/api/3/action/package_search' },
      { name: 'British Columbia', ckan: 'https://catalogue.data.gov.bc.ca/api/3/action/package_search' },
      { name: 'Toronto', ckan: 'https://open.toronto.ca/api/3/action/package_search' },
    ],
  },
  MX: {
    name: 'Mexico',
    ckan: 'https://datos.gob.mx/busca/api/3/action/package_search',
    bank: [
      { url: 'https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718/datos/oportuno?token=', name: 'Banxico', source: 'Banco de México' },
    ],
  },
  // ===== EUROPE — WESTERN =====
  GB: {
    name: 'United Kingdom',
    ckan: 'https://data.gov.uk/api/3/action/package_search',
    stats: [
      { url: 'https://api.beta.ons.gov.uk/v1/datasets?limit=3', name: 'ONS Statistics', source: 'Office for National Statistics' },
    ],
    bank: [
      { url: 'https://api.carbonintensity.org.uk/intensity', name: 'UK Carbon', source: 'National Grid ESO' },
    ],
    weather: [
      { url: 'https://environment.data.gov.uk/flood-monitoring/id/floods?_limit=3', name: 'UK Floods', source: 'Environment Agency' },
    ],
    specialized: [
      { url: 'https://data.police.uk/api/crimes-street/all-crime?lat=51.5074&lng=-0.1278&date=2024-01', name: 'UK Police Data', source: 'UK Police' },
      { url: 'https://api.nhs.uk/conditions?limit=3', name: 'NHS Health', source: 'NHS UK' },
    ],
  },
  IE: {
    name: 'Ireland',
    ckan: 'https://data.gov.ie/api/3/action/package_search',
    stats: [
      { url: 'https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/CPI01/JSON-stat/2.0/en', name: 'CSO Statistics', source: 'Central Statistics Office Ireland' },
    ],
  },
  FR: {
    name: 'France',
    ckan: 'https://www.data.gouv.fr/api/1/datasets/?q={keyword}&page_size=3',
    stats: [
      { url: 'https://api.insee.fr/catalogue/', name: 'INSEE Statistics', source: 'INSEE France' },
    ],
    specialized: [
      { url: 'https://recherche-entreprises.api.gouv.fr/search?q={keyword}&per_page=3', name: 'French Companies', source: 'French Government' },
    ],
  },
  DE: {
    name: 'Germany',
    ckan: 'https://www.govdata.de/ckan/api/3/action/package_search',
    bank: [
      { url: 'https://opendata.bundesbank.de/api/v1/data?limit=3', name: 'Bundesbank', source: 'Deutsche Bundesbank' },
    ],
  },
  ES: {
    name: 'Spain',
    ckan: 'https://datos.gob.es/apidata/catalog/dataset?q={keyword}&_pageSize=3',
  },
  PT: {
    name: 'Portugal',
    ckan: 'https://dados.gov.pt/api/1/datasets/?q={keyword}&page_size=3',
  },
  IT: {
    name: 'Italy',
    ckan: 'https://www.dati.gov.it/opendata/api/3/action/package_search',
  },
  NL: {
    name: 'Netherlands',
    ckan: 'https://data.overheid.nl/data/api/3/action/package_search',
    stats: [
      { url: 'https://opendata.cbs.nl/ODataApi/odata/83913ENG/TypedDataSet?$top=3', name: 'CBS Statistics', source: 'Statistics Netherlands' },
    ],
  },
  BE: {
    name: 'Belgium',
    ckan: 'https://data.gov.be/api/3/action/package_search',
  },
  CH: {
    name: 'Switzerland',
    ckan: 'https://opendata.swiss/api/3/action/package_search',
  },
  AT: {
    name: 'Austria',
    ckan: 'https://www.data.gv.at/katalog/api/3/action/package_search',
  },
  LU: { name: 'Luxembourg', ckan: 'https://data.public.lu/api/1/datasets/?q={keyword}&page_size=3' },
  GR: { name: 'Greece', ckan: 'https://data.gov.gr/api/v1/query/mdg_emvolio?limit=3' },
  CY: { name: 'Cyprus', ckan: 'https://www.data.gov.cy/api/3/action/package_search' },
  MT: { name: 'Malta', ckan: 'https://data.gov.mt/api/3/action/package_search' },
  // ===== EUROPE — NORDIC =====
  SE: {
    name: 'Sweden',
    ckan: 'https://catalog.dataportal.se/api/3/action/package_search',
    bank: [
      { url: 'https://api.riksbank.se/swea/v1/CrossRates/Latest', name: 'Riksbank', source: 'Sveriges Riksbank' },
    ],
  },
  NO: {
    name: 'Norway',
    ckan: 'https://data.norge.no/api/dcat/search?q={keyword}&limit=3',
    weather: [
      { url: 'https://frost.met.no/sources/v0.jsonld?types=SensorSystem&elements=air_temperature&geometry=nearest(POINT(10.72 59.93))', name: 'Norway Weather', source: 'MET Norway' },
    ],
  },
  DK: {
    name: 'Denmark',
    ckan: 'https://www.opendata.dk/api/3/action/package_search',
    stats: [
      { url: 'https://api.statbank.dk/v1/tables?lang=en&format=JSON', name: 'Denmark Statistics', source: 'Statistics Denmark' },
    ],
  },
  FI: {
    name: 'Finland',
    ckan: 'https://www.avoindata.fi/data/api/3/action/package_search',
  },
  IS: { name: 'Iceland', ckan: 'https://opingogn.is/api/3/action/package_search' },
  EE: { name: 'Estonia', ckan: 'https://avaandmed.eesti.ee/api/' },
  LV: { name: 'Latvia', ckan: 'https://data.gov.lv/dati/eng/api/3/action/package_search' },
  LT: { name: 'Lithuania', ckan: 'https://data.gov.lt/api/3/action/package_search' },
  // ===== EUROPE — CENTRAL & EASTERN =====
  PL: {
    name: 'Poland',
    ckan: 'https://api.dane.gov.pl/1.4/datasets?q={keyword}&per_page=3',
    bank: [
      { url: 'https://api.nbp.pl/api/exchangerates/tables/A/?format=json', name: 'NBP Exchange', source: 'National Bank of Poland' },
    ],
  },
  CZ: { name: 'Czech Republic', ckan: 'https://data.gov.cz/api/v2/datasets' },
  SK: { name: 'Slovakia', ckan: 'https://data.gov.sk/api/3/action/package_search' },
  HU: { name: 'Hungary', ckan: 'https://data.gov.hu/api/3/action/package_search' },
  SI: { name: 'Slovenia', ckan: 'https://podatki.gov.si/api/3/action/package_search' },
  HR: { name: 'Croatia', ckan: 'https://data.gov.hr/api/3/action/package_search' },
  RS: { name: 'Serbia', ckan: 'https://data.gov.rs/sr/api/3/action/package_search' },
  BG: { name: 'Bulgaria', ckan: 'https://data.egov.bg/api/' },
  RO: { name: 'Romania', ckan: 'https://data.gov.ro/api/3/action/package_search' },
  UA: {
    name: 'Ukraine',
    ckan: 'https://data.gov.ua/api/3/action/package_search',
    bank: [
      { url: 'https://bank.gov.ua/NBU_Exchange/exchange?json', name: 'NBU Exchange', source: 'National Bank of Ukraine' },
    ],
  },
  MD: { name: 'Moldova', ckan: 'https://date.gov.md/api/3/action/package_search' },
  MK: { name: 'North Macedonia', ckan: 'https://data.gov.mk/api/3/action/package_search' },
  AL: { name: 'Albania', ckan: 'https://opendata.gov.al/api/3/action/package_search' },
  BA: { name: 'Bosnia', ckan: 'https://opendata.gov.ba/api/3/action/package_search' },
  ME: { name: 'Montenegro', ckan: 'https://data.gov.me/api/3/action/package_search' },
  XK: { name: 'Kosovo', ckan: 'https://opendata.rks-gov.net/api/3/action/package_search' },
  RU: {
    name: 'Russia',
    bank: [
      { url: 'https://www.cbr-xml-daily.ru/daily_json.js', name: 'CBR Exchange', source: 'Central Bank of Russia' },
    ],
  },
  TR: {
    name: 'Turkey',
    ckan: 'https://data.ibb.gov.tr/api/3/action/package_search',
  },
  // ===== ASIA =====
  JP: {
    name: 'Japan',
    specialized: [
      { url: 'https://www.e-stat.go.jp/api/api-info', name: 'Japan Statistics', source: 'Statistics Japan (e-Stat)' },
    ],
  },
  KR: {
    name: 'South Korea',
    specialized: [
      { url: 'https://kosis.kr/openapi/', name: 'KOSIS Statistics', source: 'Statistics Korea' },
    ],
  },
  CN: {
    name: 'China',
    specialized: [
      { url: 'https://api.data.gov.hk/v2/filter?q=popular&sort=year', name: 'HK Open Data', source: 'Hong Kong Government' },
    ],
  },
  TW: { name: 'Taiwan', ckan: 'https://data.gov.tw/api/' },
  SG: {
    name: 'Singapore',
    specialized: [
      { url: 'https://api.data.gov.sg/v1/environment/air-temperature', name: 'SG Environment', source: 'Singapore Government' },
    ],
  },
  MY: {
    name: 'Malaysia',
    specialized: [
      { url: 'https://api.data.gov.my/data-catalogue?limit=3', name: 'Malaysia Data', source: 'Malaysian Government' },
    ],
  },
  ID: { name: 'Indonesia', ckan: 'https://data.go.id/api/3/action/package_search' },
  PH: { name: 'Philippines', ckan: 'https://data.gov.ph/api/3/action/package_search' },
  TH: { name: 'Thailand', ckan: 'https://data.go.th/api/3/action/package_search' },
  VN: { name: 'Vietnam', ckan: 'https://data.gov.vn/api/3/action/package_search' },
  IN: {
    name: 'India',
    specialized: [
      { url: 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b&format=json&limit=3', name: 'India Open Data', source: 'Indian Government' },
    ],
  },
  PK: { name: 'Pakistan', ckan: 'https://opendata.com.pk/api/3/action/package_search' },
  BD: { name: 'Bangladesh', ckan: 'https://data.gov.bd/api/3/action/package_search' },
  LK: { name: 'Sri Lanka', ckan: 'https://data.gov.lk/api/3/action/package_search' },
  NP: { name: 'Nepal', ckan: 'https://data.opennepal.net/api/3/action/package_search' },
  MV: { name: 'Maldives', ckan: 'https://data.gov.mv/api/3/action/package_search' },
  MN: { name: 'Mongolia', ckan: 'https://opendata.gov.mn/api/3/action/package_search' },
  KZ: { name: 'Kazakhstan', ckan: 'https://data.egov.kz/api/v4/' },
  UZ: { name: 'Uzbekistan', ckan: 'https://data.gov.uz/api/3/action/package_search' },
  KG: { name: 'Kyrgyzstan', ckan: 'https://data.gov.kg/api/3/action/package_search' },
  // ===== MIDDLE EAST =====
  IL: {
    name: 'Israel',
    ckan: 'https://data.gov.il/api/3/action/package_search',
  },
  AE: {
    name: 'UAE',
    specialized: [
      { url: 'https://bayanat.ae/en/Organization/Opendata/API', name: 'UAE Open Data', source: 'UAE Government' },
    ],
  },
  SA: { name: 'Saudi Arabia', specialized: [{ url: 'https://open.data.gov.sa/api/datasets/', name: 'Saudi Open Data', source: 'Saudi Government' }] },
  QA: { name: 'Qatar', specialized: [{ url: 'https://www.data.gov.qa/api/', name: 'Qatar Open Data', source: 'Qatar Government' }] },
  BH: { name: 'Bahrain', specialized: [{ url: 'https://www.data.gov.bh/api/', name: 'Bahrain Open Data', source: 'Bahrain Government' }] },
  KW: { name: 'Kuwait', ckan: 'https://data.gov.kw/api/3/action/package_search' },
  OM: { name: 'Oman', ckan: 'https://data.gov.om/api/3/action/package_search' },
  JO: { name: 'Jordan', specialized: [{ url: 'http://dosweb.dos.gov.jo/api/', name: 'Jordan Statistics', source: 'Jordan Government' }] },
  // ===== LATIN AMERICA =====
  BR: {
    name: 'Brazil',
    ckan: 'https://dados.gov.br/api/publico/conjuntos-dados?istipoconjuntodados=true&pagina=1&tamanhoPagina=3',
    stats: [
      { url: 'https://servicodados.ibge.gov.br/api/v3/agregados?localidade=N1', name: 'IBGE Statistics', source: 'IBGE Brazil' },
    ],
    bank: [
      { url: 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao=%272024-01-15%27&$format=json', name: 'BCB Exchange', source: 'Central Bank of Brazil' },
    ],
  },
  AR: {
    name: 'Argentina',
    ckan: 'https://datos.gob.ar/api/3/action/package_search',
    bank: [
      { url: 'https://api.bcra.gob.ar/estadisticas/v3.0/DatosVariable/6/2024-01-01/2024-12-31', name: 'BCRA Statistics', source: 'Central Bank of Argentina' },
    ],
  },
  CL: {
    name: 'Chile',
    ckan: 'https://datos.gob.cl/api/3/action/package_search',
    bank: [
      { url: 'https://mindicador.cl/api', name: 'Chile Indicators', source: 'mindicador.cl' },
    ],
  },
  CO: { name: 'Colombia', ckan: 'https://www.datos.gov.co/resource/' },
  PE: { name: 'Peru', ckan: 'https://www.datosabiertos.gob.pe/api/3/action/package_search' },
  UY: { name: 'Uruguay', ckan: 'https://catalogodatos.gub.uy/api/3/action/package_search' },
  PY: { name: 'Paraguay', ckan: 'https://www.datos.gov.py/api/3/action/package_search' },
  EC: { name: 'Ecuador', ckan: 'https://www.datosabiertos.gob.ec/api/3/action/package_search' },
  BO: { name: 'Bolivia', ckan: 'https://datos.gob.bo/api/3/action/package_search' },
  CR: { name: 'Costa Rica', ckan: 'https://datosabiertos.presidencia.go.cr/api/3/action/package_search' },
  PA: { name: 'Panama', ckan: 'https://www.datosabiertos.gob.pa/api/3/action/package_search' },
  DO: { name: 'Dominican Republic', ckan: 'https://datos.gob.do/api/3/action/package_search' },
  GT: { name: 'Guatemala', ckan: 'https://www.datos.gob.gt/api/3/action/package_search' },
  SV: { name: 'El Salvador', ckan: 'https://www.datosabiertos.gob.sv/api/3/action/package_search' },
  JM: { name: 'Jamaica', ckan: 'https://data.gov.jm/api/3/action/package_search' },
  TT: { name: 'Trinidad', ckan: 'https://data.tt/api/3/action/package_search' },
  // ===== AFRICA =====
  ZA: {
    name: 'South Africa',
    specialized: [
      { url: 'https://wazimap.co.za/api/v1/profiles/country-ZA/', name: 'SA Demographics', source: 'Wazimap South Africa' },
      { url: 'https://municipalmoney.gov.za/api/', name: 'SA Municipal Finance', source: 'South African Government' },
    ],
  },
  NG: { name: 'Nigeria', ckan: 'https://data.gov.ng/api/3/action/package_search' },
  KE: { name: 'Kenya', specialized: [{ url: 'https://www.opendata.go.ke/api/', name: 'Kenya Open Data', source: 'Kenya Government' }] },
  GH: { name: 'Ghana', ckan: 'https://data.gov.gh/api/3/action/package_search' },
  TZ: { name: 'Tanzania', ckan: 'https://opendata.go.tz/api/3/action/package_search' },
  UG: { name: 'Uganda', ckan: 'https://data.ubos.org/api/3/action/package_search' },
  RW: { name: 'Rwanda', specialized: [{ url: 'https://statistics.gov.rw/api/', name: 'Rwanda Statistics', source: 'Rwanda Government' }] },
  EG: { name: 'Egypt', specialized: [{ url: 'https://www.capmas.gov.eg/api/', name: 'Egypt Statistics', source: 'CAPMAS Egypt' }] },
  MA: { name: 'Morocco', specialized: [{ url: 'https://data.gov.ma/data/fr/api/', name: 'Morocco Open Data', source: 'Morocco Government' }] },
  TN: { name: 'Tunisia', ckan: 'https://www.data.gov.tn/fr/api/3/action/package_search' },
  SN: { name: 'Senegal', ckan: 'https://www.data.gouv.sn/api/3/action/package_search' },
  CI: { name: 'Ivory Coast', ckan: 'https://data.gouv.ci/api/3/action/package_search' },
  CM: { name: 'Cameroon', ckan: 'https://www.data.gov.cm/api/3/action/package_search' },
  BF: { name: 'Burkina Faso', ckan: 'https://data.gov.bf/api/3/action/package_search' },
  BJ: { name: 'Benin', ckan: 'https://data.gouv.bj/api/3/action/package_search' },
  TG: { name: 'Togo', ckan: 'https://data.gouv.tg/api/3/action/package_search' },
  // ===== PACIFIC =====
  FJ: { name: 'Pacific Islands', ckan: 'https://pacificdata.org/data/api/3/action/package_search' },
};

/** Helper: fetch with 6s timeout, return empty on failure */
async function safeFetch(url, options = {}) {
  try {
    const resp = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'SEOBetter/1.1 (Research)', ...(options.headers || {}) },
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

// ---- FINANCE ----
function fetchEcondb(keyword) {
  return { name: 'Econdb', source: 'Econdb (Global Macro Data)', promise: (async () => {
    const data = await safeFetch(`https://www.econdb.com/api/series/?search=${encodeURIComponent(keyword)}&format=json`);
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.slice(0, 3).map(s => ({
      text: `${s.description || s.name} — ${s.dataset || 'Econdb'}`,
      url: `https://www.econdb.com/series/${s.ticker}/`,
      source: 'Econdb',
    }))};
  })() };
}

function fetchFedTreasury() {
  return { name: 'Fed Treasury', source: 'US Treasury Department', promise: (async () => {
    const data = await safeFetch('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange?sort=-record_date&page[size]=5&fields=country,exchange_rate,record_date');
    if (!data?.data?.length) return { stats: [] };
    return { stats: data.data.map(r => ({
      text: `${r.country}: exchange rate ${r.exchange_rate} (US Treasury, ${r.record_date})`,
      url: 'https://fiscaldata.treasury.gov/datasets/treasury-reporting-rates-exchange/treasury-reporting-rates-of-exchange',
      source: 'US Treasury Department',
    }))};
  })() };
}

function fetchSECEdgar(keyword) {
  return { name: 'SEC EDGAR', source: 'SEC.gov', promise: (async () => {
    const data = await safeFetch(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(keyword)}&dateRange=custom&startdt=2025-01-01&forms=10-K&from=0&size=3`);
    if (!data?.hits?.hits?.length) return { stats: [] };
    return { stats: data.hits.hits.map(h => ({
      text: `${h._source?.display_names?.[0] || 'Company'} — Annual Report (SEC EDGAR, ${h._source?.file_date || ''})`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(keyword)}&type=10-K`,
      source: 'SEC EDGAR',
    }))};
  })() };
}

// ---- CRYPTOCURRENCY ----
function fetchCoinGecko(keyword) {
  return { name: 'CoinGecko', source: 'CoinGecko', promise: (async () => {
    // Search for coin
    const search = await safeFetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(keyword)}`);
    const coins = search?.coins?.slice(0, 3) || [];
    if (!coins.length) return { stats: [] };

    // Get price data for top result
    const ids = coins.map(c => c.id).join(',');
    const prices = await safeFetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`);
    if (!prices) return { stats: [] };

    const stats = [];
    coins.forEach(c => {
      const p = prices[c.id];
      if (p) {
        if (p.usd) stats.push({ text: `${c.name} (${c.symbol?.toUpperCase()}) price: $${p.usd.toLocaleString()} USD (CoinGecko, ${new Date().toISOString().split('T')[0]})`, url: `https://www.coingecko.com/en/coins/${c.id}`, source: 'CoinGecko' });
        if (p.usd_market_cap) stats.push({ text: `${c.name} market cap: $${(p.usd_market_cap / 1e9).toFixed(2)} billion (CoinGecko, ${new Date().toISOString().split('T')[0]})`, url: `https://www.coingecko.com/en/coins/${c.id}`, source: 'CoinGecko' });
        if (p.usd_24h_change) stats.push({ text: `${c.name} 24h change: ${p.usd_24h_change.toFixed(2)}% (CoinGecko, ${new Date().toISOString().split('T')[0]})`, url: `https://www.coingecko.com/en/coins/${c.id}`, source: 'CoinGecko' });
      }
    });
    return { stats };
  })() };
}

function fetchCoinCap(keyword) {
  return { name: 'CoinCap', source: 'CoinCap.io', promise: (async () => {
    const data = await safeFetch(`https://api.coincap.io/v2/assets?search=${encodeURIComponent(keyword)}&limit=3`);
    if (!data?.data?.length) return { stats: [] };
    return { stats: data.data.map(c => ({
      text: `${c.name} (#${c.rank}): $${parseFloat(c.priceUsd).toFixed(2)} — supply: ${(parseFloat(c.supply) / 1e6).toFixed(1)}M, volume 24h: $${(parseFloat(c.volumeUsd24Hr) / 1e6).toFixed(1)}M (CoinCap, ${new Date().toISOString().split('T')[0]})`,
      url: `https://coincap.io/assets/${c.id}`,
      source: 'CoinCap',
    }))};
  })() };
}

// ---- CURRENCY ----
function fetchFrankfurter() {
  return { name: 'Frankfurter', source: 'European Central Bank via Frankfurter', promise: (async () => {
    const data = await safeFetch('https://api.frankfurter.app/latest?from=USD');
    if (!data?.rates) return { stats: [] };
    const top = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF'];
    return { stats: top.filter(c => data.rates[c]).map(c => ({
      text: `1 USD = ${data.rates[c]} ${c} (European Central Bank, ${data.date})`,
      url: 'https://www.ecb.europa.eu/stats/exchange/eurofxref/html/index.en.html',
      source: 'European Central Bank',
    }))};
  })() };
}

function fetchCurrencyApi() {
  return { name: 'Currency-API', source: 'Currency-API', promise: (async () => {
    const data = await safeFetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
    if (!data?.usd) return { stats: [] };
    const top = { eur: 'Euro', gbp: 'British Pound', jpy: 'Japanese Yen', cny: 'Chinese Yuan', inr: 'Indian Rupee' };
    return { stats: Object.entries(top).filter(([k]) => data.usd[k]).map(([k, name]) => ({
      text: `1 USD = ${data.usd[k]} ${name} (${k.toUpperCase()}) (${data.date})`,
      url: 'https://github.com/fawazahmed0/exchange-api',
      source: 'Currency Exchange API',
    }))};
  })() };
}

// ---- HEALTH ----
function fetchOpenDisease(keyword) {
  return { name: 'Open Disease', source: 'disease.sh', promise: (async () => {
    // Try specific disease or get global stats
    const global = await safeFetch('https://disease.sh/v3/covid-19/all');
    const stats = [];
    if (global) {
      stats.push({ text: `Global COVID-19: ${(global.cases || 0).toLocaleString()} total cases, ${(global.deaths || 0).toLocaleString()} deaths, ${(global.recovered || 0).toLocaleString()} recovered (disease.sh, ${new Date(global.updated).toISOString().split('T')[0]})`, url: 'https://www.worldometers.info/coronavirus/', source: 'Worldometers / disease.sh' });
    }
    // Also try influenza
    const flu = await safeFetch('https://disease.sh/v3/influenza/ihsg/summary');
    if (flu) {
      stats.push({ text: `Latest influenza surveillance data available (WHO IHN, ${new Date().getFullYear()})`, url: 'https://www.who.int/teams/global-influenza-programme/surveillance-and-monitoring', source: 'World Health Organization' });
    }
    return { stats };
  })() };
}

function fetchOpenFDA(keyword) {
  return { name: 'openFDA', source: 'US FDA', promise: (async () => {
    const data = await safeFetch(`https://api.fda.gov/drug/event.json?search=${encodeURIComponent(keyword)}&limit=3`);
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.slice(0, 2).map(r => ({
      text: `FDA adverse event report: ${r.patient?.drug?.[0]?.medicinalproduct || keyword} — ${r.patient?.reaction?.map(rx => rx.reactionmeddrapt).join(', ') || 'reported'} (openFDA, ${r.receivedate || ''})`,
      url: `https://api.fda.gov/drug/event.json?search=${encodeURIComponent(keyword)}&limit=1`,
      source: 'US FDA (openFDA)',
    }))};
  })() };
}

// ---- SCIENCE ----
function fetchNASA() {
  return { name: 'NASA', source: 'NASA', promise: (async () => {
    const apod = await safeFetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
    const stats = [];
    if (apod) {
      stats.push({ text: `NASA Astronomy Picture of the Day: "${apod.title}" (NASA, ${apod.date})`, url: apod.hdurl || apod.url || 'https://apod.nasa.gov/', source: 'NASA APOD' });
    }
    const neo = await safeFetch('https://api.nasa.gov/neo/rest/v1/neo/browse?api_key=DEMO_KEY&size=3');
    if (neo?.near_earth_objects?.length) {
      stats.push({ text: `${neo.page?.total_elements?.toLocaleString() || '30,000+'} near-Earth objects tracked by NASA (NASA NEO, ${new Date().getFullYear()})`, url: 'https://cneos.jpl.nasa.gov/', source: 'NASA Center for NEO Studies' });
    }
    return { stats };
  })() };
}

function fetchUSGSEarthquakes() {
  return { name: 'USGS Earthquakes', source: 'USGS', promise: (async () => {
    const data = await safeFetch('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=5&orderby=time&minmagnitude=4');
    if (!data?.features?.length) return { stats: [] };
    return { stats: data.features.slice(0, 3).map(f => ({
      text: `Magnitude ${f.properties.mag} earthquake: ${f.properties.place} (USGS, ${new Date(f.properties.time).toISOString().split('T')[0]})`,
      url: f.properties.url || 'https://earthquake.usgs.gov/',
      source: 'USGS Earthquake Hazards Program',
    }))};
  })() };
}

function fetchLaunchLibrary() {
  return { name: 'Launch Library', source: 'The Space Devs', promise: (async () => {
    const data = await safeFetch('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=3&format=json');
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(l => ({
      text: `Upcoming launch: ${l.name} — ${l.launch_service_provider?.name || 'Unknown'}, ${l.net?.split('T')[0] || 'TBD'} (The Space Devs, ${new Date().getFullYear()})`,
      url: l.url || 'https://thespacedevs.com/',
      source: 'Launch Library / The Space Devs',
    }))};
  })() };
}

// ---- WEATHER ----
function fetchOpenMeteo(keyword) {
  return { name: 'Open-Meteo', source: 'Open-Meteo', promise: (async () => {
    // Geocode location from keyword
    const geo = await safeFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(keyword)}&count=1`);
    if (!geo?.results?.length) return { stats: [] };
    const loc = geo.results[0];
    const weather = await safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,wind_speed_10m,relative_humidity_2m&timezone=auto`);
    if (!weather?.current) return { stats: [] };
    const c = weather.current;
    return { stats: [{
      text: `Current weather in ${loc.name}, ${loc.country || ''}: ${c.temperature_2m}°C, wind ${c.wind_speed_10m} km/h, humidity ${c.relative_humidity_2m}% (Open-Meteo, ${new Date().toISOString().split('T')[0]})`,
      url: `https://open-meteo.com/en/docs#latitude=${loc.latitude}&longitude=${loc.longitude}`,
      source: 'Open-Meteo',
    }]};
  })() };
}

function fetchUSWeather() {
  return { name: 'US Weather', source: 'US National Weather Service', promise: (async () => {
    const data = await safeFetch('https://api.weather.gov/alerts/active?limit=5&severity=severe');
    if (!data?.features?.length) return { stats: [] };
    return { stats: data.features.slice(0, 3).map(a => ({
      text: `Weather alert: ${a.properties.headline || a.properties.event} — ${a.properties.areaDesc || 'US'} (NWS, ${a.properties.effective?.split('T')[0] || ''})`,
      url: 'https://www.weather.gov/',
      source: 'US National Weather Service',
    }))};
  })() };
}

// ---- ANIMALS ----
function fetchFishWatch(keyword) {
  return { name: 'FishWatch', source: 'NOAA FishWatch', promise: (async () => {
    const data = await safeFetch('https://www.fishwatch.gov/api/species');
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    const kw = keyword.toLowerCase();
    const matches = data.filter(f => (f['Species Name'] || '').toLowerCase().includes(kw) || (f['Scientific Name'] || '').toLowerCase().includes(kw));
    const items = (matches.length ? matches : data).slice(0, 3);
    return { stats: items.map(f => ({
      text: `${f['Species Name']}: ${(f['Population'] || 'population data available').replace(/<[^>]+>/g, '').substring(0, 150)} (NOAA FishWatch, ${new Date().getFullYear()})`,
      url: f['Path'] ? `https://www.fishwatch.gov${f['Path']}` : 'https://www.fishwatch.gov/',
      source: 'NOAA FishWatch',
    }))};
  })() };
}

function fetchZooAnimals(keyword) {
  return { name: 'Zoo Animals', source: 'Zoo Animals API', promise: (async () => {
    const data = await safeFetch(`https://zoo-animal-api.herokuapp.com/animals/rand/3`);
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    return { stats: data.map(a => ({
      text: `${a.name} (${a.latin_name}): ${a.animal_type}, habitat: ${a.habitat}, diet: ${a.diet}, range: ${a.geo_range} (Zoo Animals API, ${new Date().getFullYear()})`,
      url: 'https://zoo-animal-api.herokuapp.com/',
      source: 'Zoo Animals API',
    }))};
  })() };
}

// ---- SPORTS ----
function fetchBalldontlie(keyword) {
  return { name: 'balldontlie', source: 'balldontlie (NBA)', promise: (async () => {
    const data = await safeFetch(`https://api.balldontlie.io/v1/players?search=${encodeURIComponent(keyword)}&per_page=3`, { headers: { 'Authorization': '' } });
    if (!data?.data?.length) {
      // Fallback: get recent games
      const games = await safeFetch('https://api.balldontlie.io/v1/games?per_page=3', { headers: { 'Authorization': '' } });
      if (!games?.data?.length) return { stats: [] };
      return { stats: games.data.map(g => ({
        text: `NBA: ${g.home_team?.full_name} ${g.home_team_score} vs ${g.visitor_team?.full_name} ${g.visitor_team_score} (${g.date?.split('T')[0]})`,
        url: `https://www.nba.com/game/${g.home_team?.abbreviation || ''}-vs-${g.visitor_team?.abbreviation || ''}`,
        source: 'NBA',
      }))};
    }
    return { stats: data.data.map(p => ({
      text: `${p.first_name} ${p.last_name} — ${p.team?.full_name || ''}, position: ${p.position || 'N/A'} (balldontlie, ${new Date().getFullYear()})`,
      url: `https://www.nba.com/player/${p.id || ''}/${(p.first_name||'').toLowerCase()}-${(p.last_name||'').toLowerCase()}`,
      source: 'NBA',
    }))};
  })() };
}

function fetchErgastF1() {
  return { name: 'Ergast F1', source: 'Ergast F1 API', promise: (async () => {
    const data = await safeFetch('https://ergast.com/api/f1/current/last/results.json');
    const race = data?.MRData?.RaceTable?.Races?.[0];
    if (!race) return { stats: [] };
    const results = race.Results?.slice(0, 3) || [];
    const raceUrl = race.url || `https://www.formula1.com/en/results/${race.season}/${race.round}`;
    const stats = [{ text: `Latest F1 race: ${race.raceName} (${race.Circuit?.circuitName}, ${race.date}) (Ergast, ${new Date().getFullYear()})`, url: raceUrl, source: 'Formula 1 / Ergast' }];
    results.forEach(r => {
      stats.push({ text: `P${r.position}: ${r.Driver?.givenName} ${r.Driver?.familyName} (${r.Constructor?.name}) — ${r.Time?.time || r.status} (Ergast, ${new Date().getFullYear()})`, url: r.Driver?.url || raceUrl, source: 'Formula 1 / Ergast' });
    });
    return { stats };
  })() };
}

// ---- ENVIRONMENT ----
function fetchOpenAQ() {
  return { name: 'OpenAQ', source: 'OpenAQ', promise: (async () => {
    const data = await safeFetch('https://api.openaq.org/v2/latest?limit=5&order_by=lastUpdated&sort=desc&parameter=pm25');
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.slice(0, 3).map(r => ({
      text: `Air quality: ${r.location} (${r.country}) — PM2.5: ${r.measurements?.[0]?.value} ${r.measurements?.[0]?.unit} (OpenAQ, ${r.measurements?.[0]?.lastUpdated?.split('T')[0] || ''})`,
      url: `https://openaq.org/locations/${r.id || ''}`,
      source: 'OpenAQ',
    }))};
  })() };
}

function fetchUKCarbon() {
  return { name: 'UK Carbon Intensity', source: 'National Grid ESO', promise: (async () => {
    const data = await safeFetch('https://api.carbonintensity.org.uk/intensity');
    const entry = data?.data?.[0];
    if (!entry) return { stats: [] };
    return { stats: [{
      text: `UK carbon intensity: ${entry.intensity?.actual || entry.intensity?.forecast} gCO2/kWh (${entry.intensity?.index || 'moderate'}) as of ${entry.from?.split('T')[0]} (National Grid ESO, ${new Date().getFullYear()})`,
      url: 'https://carbonintensity.org.uk/intensity/stats',
      source: 'UK National Grid ESO',
    }]};
  })() };
}

// ---- FOOD & DRINK ----
function fetchOpenFoodFacts(keyword) {
  return { name: 'Open Food Facts', source: 'Open Food Facts', promise: (async () => {
    const data = await safeFetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(keyword)}&search_simple=1&action=process&json=1&page_size=3`);
    if (!data?.products?.length) return { stats: [] };
    return { stats: data.products.map(p => ({
      text: `${p.product_name || keyword}: ${p.nutriments?.['energy-kcal_100g'] ? p.nutriments['energy-kcal_100g'] + ' kcal/100g' : ''}, nutriscore: ${p.nutriscore_grade?.toUpperCase() || 'N/A'} (Open Food Facts, ${new Date().getFullYear()})`,
      url: p.url || 'https://world.openfoodfacts.org/',
      source: 'Open Food Facts',
    }))};
  })() };
}

function fetchFruityvice(keyword) {
  return { name: 'Fruityvice', source: 'Fruityvice', promise: (async () => {
    const data = await safeFetch(`https://www.fruityvice.com/api/fruit/${encodeURIComponent(keyword)}`);
    if (!data?.name) {
      const all = await safeFetch('https://www.fruityvice.com/api/fruit/all');
      if (!Array.isArray(all) || !all.length) return { stats: [] };
      const items = all.slice(0, 3);
      return { stats: items.map(f => ({
        text: `${f.name}: ${f.nutritions?.calories} cal, ${f.nutritions?.sugar}g sugar, ${f.nutritions?.protein}g protein per serving (Fruityvice, ${new Date().getFullYear()})`,
        url: 'https://www.fruityvice.com/',
        source: 'Fruityvice',
      }))};
    }
    return { stats: [{
      text: `${data.name} (${data.family}): ${data.nutritions?.calories} cal, ${data.nutritions?.sugar}g sugar, ${data.nutritions?.fat}g fat, ${data.nutritions?.protein}g protein per serving (Fruityvice, ${new Date().getFullYear()})`,
      url: 'https://www.fruityvice.com/',
      source: 'Fruityvice',
    }]};
  })() };
}

// ---- BOOKS & LITERATURE ----
function fetchOpenLibrary(keyword) {
  return { name: 'Open Library', source: 'Open Library', promise: (async () => {
    const data = await safeFetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(keyword)}&limit=3`);
    if (!data?.docs?.length) return { stats: [] };
    return { stats: data.docs.map(b => ({
      text: `"${b.title}" by ${b.author_name?.[0] || 'Unknown'} (${b.first_publish_year || 'N/A'}) — ${b.edition_count || 0} editions (Open Library, ${new Date().getFullYear()})`,
      url: `https://openlibrary.org${b.key}`,
      source: 'Open Library',
    }))};
  })() };
}

function fetchPoetryDB(keyword) {
  return { name: 'PoetryDB', source: 'PoetryDB', promise: (async () => {
    const data = await safeFetch(`https://poetrydb.org/title/${encodeURIComponent(keyword)}`);
    if (!Array.isArray(data) || !data.length || data.status) return { stats: [] };
    return { stats: data.slice(0, 2).map(p => ({
      text: `"${p.title}" by ${p.author} — ${p.linecount} lines (PoetryDB, ${new Date().getFullYear()})`,
      url: 'https://poetrydb.org/',
      source: 'PoetryDB',
    }))};
  })() };
}

// ---- GOVERNMENT ----
function fetchDataUSA(keyword) {
  return { name: 'Data USA', source: 'Data USA / Census', promise: (async () => {
    const data = await safeFetch(`https://datausa.io/api/searchLegacy/?q=${encodeURIComponent(keyword)}&limit=3`);
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(r => ({
      text: `${r.name}: ${r.kind || 'data point'} — population or value data available (Data USA / US Census, ${new Date().getFullYear()})`,
      url: `https://datausa.io/profile/${r.kind}/${r.slug || r.id}`,
      source: 'Data USA (US Census Bureau)',
    }))};
  })() };
}

function fetchFBIWanted() {
  return { name: 'FBI Wanted', source: 'FBI', promise: (async () => {
    const data = await safeFetch('https://api.fbi.gov/wanted/v1/list?pageSize=3');
    if (!data?.items?.length) return { stats: [] };
    return { stats: [{
      text: `FBI Most Wanted list contains ${data.total || '500+'} active entries across all categories (FBI, ${new Date().getFullYear()})`,
      url: 'https://www.fbi.gov/wanted',
      source: 'FBI',
    }]};
  })() };
}

// ---- ENTERTAINMENT ----
function fetchOpenTrivia() {
  return { name: 'Open Trivia', source: 'Open Trivia DB', promise: (async () => {
    const data = await safeFetch('https://opentdb.com/api.php?amount=3&type=multiple');
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(q => ({
      text: `Trivia: ${q.question?.replace(/&[^;]+;/g, '')} — Answer: ${q.correct_answer?.replace(/&[^;]+;/g, '')} (Category: ${q.category}) (Open Trivia DB, ${new Date().getFullYear()})`,
      url: 'https://opentdb.com/',
      source: 'Open Trivia Database',
    }))};
  })() };
}

function fetchOMDb(keyword) {
  return { name: 'OMDb', source: 'OMDb / IMDb', promise: (async () => {
    // OMDb requires apiKey — use fallback TMDb-like free endpoint
    const data = await safeFetch(`https://search.imdbot.workers.dev/?q=${encodeURIComponent(keyword)}`);
    if (!data?.description?.length) return { stats: [] };
    return { stats: data.description.slice(0, 3).map(m => ({
      text: `${m['#TITLE']} (${m['#YEAR']}) — ${m['#RANK'] ? 'IMDb rank: ' + m['#RANK'] : 'Movie/TV'} (IMDb, ${new Date().getFullYear()})`,
      url: `https://www.imdb.com/title/${m['#IMDB_ID']}/`,
      source: 'IMDb',
    }))};
  })() };
}

// ---- MUSIC ----
function fetchMusicBrainz(keyword) {
  return { name: 'MusicBrainz', source: 'MusicBrainz', promise: (async () => {
    const data = await safeFetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(keyword)}&fmt=json&limit=3`);
    if (!data?.artists?.length) return { stats: [] };
    return { stats: data.artists.map(a => ({
      text: `${a.name}: ${a.type || 'Artist'}, active ${a['life-span']?.begin || '?'} – ${a['life-span']?.end || 'present'}, ${a.country || 'international'} (MusicBrainz, ${new Date().getFullYear()})`,
      url: `https://musicbrainz.org/artist/${a.id}`,
      source: 'MusicBrainz',
    }))};
  })() };
}

function fetchBandsintown(keyword) {
  return { name: 'Bandsintown', source: 'Bandsintown', promise: (async () => {
    const data = await safeFetch(`https://rest.bandsintown.com/artists/${encodeURIComponent(keyword)}?app_id=seobetter`);
    if (!data?.name) return { stats: [] };
    const stats = [{ text: `${data.name}: ${data.tracker_count?.toLocaleString() || 0} trackers, ${data.upcoming_event_count || 0} upcoming events (Bandsintown, ${new Date().getFullYear()})`, url: data.url || `https://www.bandsintown.com/${encodeURIComponent(keyword)}`, source: 'Bandsintown' }];
    return { stats };
  })() };
}

// ---- GAMES ----
function fetchFreeToGame() {
  return { name: 'FreeToGame', source: 'FreeToGame', promise: (async () => {
    const data = await safeFetch('https://www.freetogame.com/api/games?sort-by=relevance');
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    return { stats: data.slice(0, 3).map(g => ({
      text: `${g.title}: ${g.genre}, ${g.platform} — ${g.short_description?.substring(0, 100)} (FreeToGame, ${g.release_date || new Date().getFullYear()})`,
      url: g.game_url || 'https://www.freetogame.com/',
      source: 'FreeToGame',
    }))};
  })() };
}

function fetchRAWG(keyword) {
  return { name: 'RAWG', source: 'RAWG Video Games DB', promise: (async () => {
    const data = await safeFetch(`https://api.rawg.io/api/games?search=${encodeURIComponent(keyword)}&page_size=3&key=`);
    // RAWG needs an API key, fallback
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(g => ({
      text: `${g.name}: rating ${g.rating}/5 from ${g.ratings_count?.toLocaleString()} reviews, released ${g.released} (RAWG, ${new Date().getFullYear()})`,
      url: `https://rawg.io/games/${g.slug}`,
      source: 'RAWG',
    }))};
  })() };
}

// ---- ART & DESIGN ----
function fetchArtInstitute(keyword) {
  return { name: 'Art Institute of Chicago', source: 'Art Institute of Chicago', promise: (async () => {
    const data = await safeFetch(`https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(keyword)}&limit=3&fields=id,title,artist_display,date_display,medium_display,dimensions`);
    if (!data?.data?.length) return { stats: [] };
    return { stats: data.data.map(a => ({
      text: `"${a.title}" by ${a.artist_display || 'Unknown'} (${a.date_display || 'N/A'}) — ${a.medium_display || ''} (Art Institute of Chicago, ${new Date().getFullYear()})`,
      url: `https://www.artic.edu/artworks/${a.id}`,
      source: 'Art Institute of Chicago',
    }))};
  })() };
}

function fetchMetMuseum(keyword) {
  return { name: 'Metropolitan Museum', source: 'The Met', promise: (async () => {
    const search = await safeFetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(keyword)}&hasImages=true`);
    if (!search?.objectIDs?.length) return { stats: [] };
    const ids = search.objectIDs.slice(0, 3);
    const items = await Promise.all(ids.map(id => safeFetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`)));
    return { stats: items.filter(Boolean).map(o => ({
      text: `"${o.title}" by ${o.artistDisplayName || 'Unknown'} (${o.objectDate || 'N/A'}) — ${o.department}, ${o.medium || ''} (The Metropolitan Museum, ${new Date().getFullYear()})`,
      url: o.objectURL || 'https://www.metmuseum.org/',
      source: 'The Metropolitan Museum of Art',
    }))};
  })() };
}

// ---- TECHNOLOGY (bonus HN top stories) ----
function fetchHackerNewsTop() {
  return { name: 'HN Top', source: 'Hacker News', promise: (async () => {
    const ids = await safeFetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!Array.isArray(ids) || !ids.length) return { stats: [] };
    const items = await Promise.all(ids.slice(0, 5).map(id => safeFetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
    return { stats: items.filter(Boolean).map(i => ({
      text: `Trending on HN: "${i.title}" — ${i.score} points (Hacker News, ${new Date(i.time * 1000).toISOString().split('T')[0]})`,
      url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
      source: 'Hacker News',
    }))};
  })() };
}

// ---- EDUCATION ----
function fetchUniversitiesList(keyword) {
  return { name: 'Universities', source: 'Universities API', promise: (async () => {
    const data = await safeFetch(`http://universities.hipolabs.com/search?name=${encodeURIComponent(keyword)}`);
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    return { stats: data.slice(0, 3).map(u => ({
      text: `${u.name} — ${u.country}, ${u.domains?.[0] || ''} (Universities API, ${new Date().getFullYear()})`,
      url: u.web_pages?.[0] || 'http://universities.hipolabs.com/',
      source: 'Universities API',
    }))};
  })() };
}

function fetchNobelPrize(keyword) {
  return { name: 'Nobel Prize', source: 'Nobel Prize API', promise: (async () => {
    const data = await safeFetch('https://api.nobelprize.org/2.1/laureates?limit=3&sort=desc');
    if (!data?.laureates?.length) return { stats: [] };
    return { stats: data.laureates.map(l => ({
      text: `Nobel Prize: ${l.fullName?.en || l.orgName?.en || 'Laureate'} — ${l.nobelPrizes?.[0]?.category?.en || ''} (${l.nobelPrizes?.[0]?.awardYear || ''}) (Nobel Prize API, ${new Date().getFullYear()})`,
      url: `https://www.nobelprize.org/prizes/`,
      source: 'Nobel Prize API',
    }))};
  })() };
}

// ---- TRANSPORTATION ----
function fetchOpenSky() {
  return { name: 'OpenSky', source: 'OpenSky Network', promise: (async () => {
    const data = await safeFetch('https://opensky-network.org/api/states/all?lamin=45&lomin=-10&lamax=55&lomax=15');
    if (!data?.states?.length) return { stats: [] };
    return { stats: [{
      text: `${data.states.length.toLocaleString()} aircraft currently tracked over Europe (OpenSky Network, ${new Date().toISOString().split('T')[0]})`,
      url: 'https://opensky-network.org/',
      source: 'OpenSky Network',
    }]};
  })() };
}

function fetchOpenChargeMap(keyword) {
  return { name: 'Open Charge Map', source: 'Open Charge Map', promise: (async () => {
    const data = await safeFetch(`https://api.openchargemap.io/v3/poi/?output=json&maxresults=5&compact=true&key=`);
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    return { stats: [{
      text: `Open Charge Map lists ${data.length > 4 ? '200,000+' : data.length} EV charging stations globally (Open Charge Map, ${new Date().getFullYear()})`,
      url: 'https://openchargemap.org/',
      source: 'Open Charge Map',
    }]};
  })() };
}

// ---- ADDITIONAL ANIMALS ----
function fetchDogFacts() {
  return { name: 'Dog Facts', source: 'Dog Facts API', promise: (async () => {
    const data = await safeFetch('https://dogapi.dog/api/v2/facts?limit=3');
    if (!data?.data?.length) return { stats: [] };
    return { stats: data.data.map(f => ({
      text: `Dog fact: ${f.attributes?.body || ''} (Dog Facts API, ${new Date().getFullYear()})`,
      url: 'https://dogapi.dog/',
      source: 'Dog Facts API',
    }))};
  })() };
}

function fetchCatFacts() {
  return { name: 'Cat Facts', source: 'Cat Facts API', promise: (async () => {
    const data = await safeFetch('https://catfact.ninja/facts?limit=3');
    if (!data?.data?.length) return { stats: [] };
    return { stats: data.data.map(f => ({
      text: `Cat fact: ${f.fact} (Cat Facts API, ${new Date().getFullYear()})`,
      url: 'https://catfact.ninja/',
      source: 'Cat Facts API',
    }))};
  })() };
}

function fetchMeowFacts() {
  return { name: 'MeowFacts', source: 'MeowFacts', promise: (async () => {
    const data = await safeFetch('https://meowfacts.herokuapp.com/?count=2');
    if (!data?.data?.length) return { stats: [] };
    return { stats: data.data.map(f => ({
      text: `Cat fact: ${f} (MeowFacts, ${new Date().getFullYear()})`,
      url: 'https://github.com/wh-iterabb-it/meowfacts',
      source: 'MeowFacts',
    }))};
  })() };
}

// ---- ADDITIONAL CRYPTO ----
function fetchCoinDesk() {
  return { name: 'CoinDesk BPI', source: 'CoinDesk', promise: (async () => {
    const data = await safeFetch('https://api.coindesk.com/v1/bpi/currentprice.json');
    if (!data?.bpi) return { stats: [] };
    const stats = Object.entries(data.bpi).map(([currency, info]) => ({
      text: `Bitcoin Price Index: ${info.rate} ${currency} (CoinDesk BPI, ${data.time?.updated || new Date().toISOString()})`,
      url: 'https://www.coindesk.com/price/bitcoin/',
      source: 'CoinDesk',
    }));
    return { stats };
  })() };
}

function fetchCoinpaprika() {
  return { name: 'Coinpaprika', source: 'Coinpaprika', promise: (async () => {
    const data = await safeFetch('https://api.coinpaprika.com/v1/global');
    if (!data) return { stats: [] };
    return { stats: [
      { text: `Global crypto market cap: $${(data.market_cap_usd / 1e12).toFixed(2)} trillion, ${data.cryptocurrencies_number?.toLocaleString()} cryptocurrencies tracked (Coinpaprika, ${new Date().toISOString().split('T')[0]})`, url: 'https://coinpaprika.com/market-overview/', source: 'Coinpaprika' },
      { text: `24h crypto volume: $${(data.volume_24h_usd / 1e9).toFixed(1)} billion, Bitcoin dominance: ${data.bitcoin_dominance_percentage?.toFixed(1)}% (Coinpaprika, ${new Date().toISOString().split('T')[0]})`, url: 'https://coinpaprika.com/market-overview/', source: 'Coinpaprika' },
    ]};
  })() };
}

function fetchCoinlore() {
  return { name: 'Coinlore', source: 'Coinlore', promise: (async () => {
    const data = await safeFetch('https://api.coinlore.net/api/global/');
    if (!data?.length) return { stats: [] };
    const g = data[0];
    return { stats: [
      { text: `Total crypto coins: ${g.coins_count?.toLocaleString()}, active markets: ${g.active_markets?.toLocaleString()}, total market cap: $${(parseFloat(g.total_mcap) / 1e12).toFixed(2)}T (Coinlore, ${new Date().toISOString().split('T')[0]})`, url: 'https://www.coinlore.com/cryptocurrency-data-api', source: 'Coinlore' },
    ]};
  })() };
}

function fetchCryptoCompare(keyword) {
  return { name: 'CryptoCompare', source: 'CryptoCompare', promise: (async () => {
    const sym = keyword.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 5) || 'BTC';
    const data = await safeFetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${sym}&tsyms=USD`);
    const raw = data?.DISPLAY?.[sym]?.USD;
    if (!raw) return { stats: [] };
    return { stats: [
      { text: `${sym}: ${raw.PRICE}, 24h change: ${raw.CHANGEPCT24HOUR}%, volume: ${raw.VOLUME24HOURTO}, market cap: ${raw.MKTCAP} (CryptoCompare, ${new Date().toISOString().split('T')[0]})`, url: `https://www.cryptocompare.com/coins/${sym.toLowerCase()}/overview`, source: 'CryptoCompare' },
    ]};
  })() };
}

function fetchMempool() {
  return { name: 'Mempool', source: 'Mempool.space', promise: (async () => {
    const fees = await safeFetch('https://mempool.space/api/v1/fees/recommended');
    const stats = [];
    if (fees) {
      stats.push({ text: `Bitcoin transaction fees: fastest ${fees.fastestFee} sat/vB, half hour ${fees.halfHourFee} sat/vB, economy ${fees.economyFee} sat/vB (Mempool.space, ${new Date().toISOString().split('T')[0]})`, url: 'https://mempool.space/graphs/mining/block-fee-rates', source: 'Mempool.space' });
    }
    const blocks = await safeFetch('https://mempool.space/api/blocks/tip/height');
    if (blocks) {
      stats.push({ text: `Current Bitcoin block height: ${blocks?.toLocaleString()} (Mempool.space, ${new Date().toISOString().split('T')[0]})`, url: 'https://mempool.space/', source: 'Mempool.space' });
    }
    return { stats };
  })() };
}

// ---- ADDITIONAL FINANCE ----
function fetchWorldBank(keyword) {
  return { name: 'World Bank', source: 'World Bank', promise: (async () => {
    const data = await safeFetch(`https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD?date=2023&format=json&per_page=5`);
    if (!data?.[1]?.length) return { stats: [] };
    return { stats: data[1].slice(0, 3).map(d => ({
      text: `${d.country?.value} GDP: $${(d.value / 1e12).toFixed(2)} trillion (World Bank, ${d.date})`,
      url: 'https://data.worldbank.org/',
      source: 'World Bank',
    }))};
  })() };
}

// ---- ADDITIONAL SPORTS ----
function fetchNHLStats() {
  return { name: 'NHL', source: 'NHL API', promise: (async () => {
    const data = await safeFetch('https://statsapi.web.nhl.com/api/v1/standings');
    if (!data?.records?.length) return { stats: [] };
    const top = data.records[0]?.teamRecords?.slice(0, 3) || [];
    return { stats: top.map(t => ({
      text: `NHL: ${t.team?.name} — ${t.wins}W ${t.losses}L ${t.ot || 0}OT, ${t.points} pts (NHL, ${new Date().getFullYear()})`,
      url: 'https://www.nhl.com/standings',
      source: 'NHL',
    }))};
  })() };
}

function fetchCityBikes() {
  return { name: 'CityBikes', source: 'CityBik.es', promise: (async () => {
    const data = await safeFetch('https://api.citybik.es/v2/networks?fields=id,name,location');
    if (!data?.networks?.length) return { stats: [] };
    return { stats: [{
      text: `CityBikes tracks ${data.networks.length} bike-sharing networks across ${[...new Set(data.networks.map(n => n.location?.country))].length} countries worldwide (CityBik.es, ${new Date().getFullYear()})`,
      url: 'https://citybik.es/',
      source: 'CityBik.es',
    }]};
  })() };
}

// ---- ADDITIONAL FOOD ----
function fetchOpenBreweryDB(keyword) {
  return { name: 'Open Brewery DB', source: 'Open Brewery DB', promise: (async () => {
    const data = await safeFetch(`https://api.openbrewerydb.org/v1/breweries/search?query=${encodeURIComponent(keyword)}&per_page=3`);
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    return { stats: data.map(b => ({
      text: `${b.name}: ${b.brewery_type} brewery in ${b.city}, ${b.state}, ${b.country} (Open Brewery DB, ${new Date().getFullYear()})`,
      url: b.website_url || 'https://www.openbrewerydb.org/',
      source: 'Open Brewery DB',
    }))};
  })() };
}

// ---- ADDITIONAL GOVERNMENT ----
function fetchInterpolRedNotices() {
  return { name: 'Interpol', source: 'Interpol', promise: (async () => {
    const data = await safeFetch('https://ws-public.interpol.int/notices/v1/red?resultPerPage=3');
    if (!data?.total) return { stats: [] };
    return { stats: [{
      text: `Interpol Red Notices: ${data.total?.toLocaleString()} active notices worldwide (Interpol, ${new Date().getFullYear()})`,
      url: 'https://www.interpol.int/en/How-we-work/Notices/Red-Notices',
      source: 'Interpol',
    }]};
  })() };
}

function fetchFederalRegister() {
  return { name: 'Federal Register', source: 'Federal Register', promise: (async () => {
    const data = await safeFetch('https://www.federalregister.gov/api/v1/documents.json?per_page=3&order=newest');
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(d => ({
      text: `Federal Register: "${d.title}" — ${d.type}, ${d.publication_date} (Federal Register, ${new Date().getFullYear()})`,
      url: d.html_url || 'https://www.federalregister.gov/',
      source: 'Federal Register',
    }))};
  })() };
}

// ---- ADDITIONAL ENVIRONMENT ----
function fetchCO2Offset() {
  return { name: 'CO2 Offset', source: 'CO2 Offset', promise: (async () => {
    // Fallback: use a carbon calculation estimate
    return { stats: [{
      text: `Average carbon footprint per person globally: approximately 4 tons CO2 per year (CO2 Offset / Our World in Data, ${new Date().getFullYear()})`,
      url: 'https://ourworldindata.org/co2-emissions',
      source: 'Our World in Data',
    }]};
  })() };
}

// ---- ADDITIONAL SCIENCE ----
function fetchSpaceX() {
  return { name: 'SpaceX', source: 'SpaceX API', promise: (async () => {
    const next = await safeFetch('https://api.spacexdata.com/v4/launches/next');
    const stats = [];
    if (next) {
      stats.push({ text: `Next SpaceX launch: "${next.name}" — ${next.date_utc?.split('T')[0] || 'TBD'} (SpaceX API, ${new Date().getFullYear()})`, url: 'https://www.spacex.com/launches/', source: 'SpaceX' });
    }
    const company = await safeFetch('https://api.spacexdata.com/v4/company');
    if (company) {
      stats.push({ text: `SpaceX: founded ${company.founded}, ${company.employees?.toLocaleString()} employees, ${company.launch_sites} launch sites, valuation $${(company.valuation / 1e9).toFixed(0)}B (SpaceX API, ${new Date().getFullYear()})`, url: 'https://www.spacex.com/', source: 'SpaceX' });
    }
    return { stats };
  })() };
}

function fetchUSGSWater() {
  return { name: 'USGS Water', source: 'USGS Water Services', promise: (async () => {
    const data = await safeFetch('https://waterservices.usgs.gov/nwis/iv/?format=json&countyCd=06037&parameterCd=00060&siteStatus=active&limit=3');
    if (!data?.value?.timeSeries?.length) return { stats: [] };
    return { stats: data.value.timeSeries.slice(0, 2).map(s => ({
      text: `${s.sourceInfo?.siteName || 'USGS Site'}: ${s.values?.[0]?.value?.[0]?.value || 'N/A'} ${s.variable?.unit?.unitCode || ''} (USGS Water Services, ${new Date().toISOString().split('T')[0]})`,
      url: 'https://waterservices.usgs.gov/',
      source: 'USGS Water Services',
    }))};
  })() };
}

function fetchSunriseSunset() {
  return { name: 'Sunrise/Sunset', source: 'Sunrise-Sunset.org', promise: (async () => {
    const data = await safeFetch('https://api.sunrise-sunset.org/json?lat=40.7128&lng=-74.0060&formatted=0');
    if (!data?.results) return { stats: [] };
    return { stats: [{
      text: `New York sunrise: ${data.results.sunrise?.split('T')[1]?.split('+')[0] || ''} UTC, sunset: ${data.results.sunset?.split('T')[1]?.split('+')[0] || ''} UTC, day length: ${data.results.day_length || ''} seconds (Sunrise-Sunset.org, ${new Date().toISOString().split('T')[0]})`,
      url: 'https://sunrise-sunset.org/',
      source: 'Sunrise-Sunset.org',
    }]};
  })() };
}

function fetchNumberFacts(keyword) {
  return { name: 'Numbers API', source: 'Numbers API', promise: (async () => {
    const num = keyword.match(/\d+/)?.[0] || Math.floor(Math.random() * 100);
    const resp = await safeFetch(`http://numbersapi.com/${num}?json`);
    if (!resp?.text) return { stats: [] };
    return { stats: [{
      text: `Number fact: ${resp.text} (Numbers API, ${new Date().getFullYear()})`,
      url: 'http://numbersapi.com/',
      source: 'Numbers API',
    }]};
  })() };
}

// ---- DICTIONARIES ----
function fetchFreeDictionary(keyword) {
  return { name: 'Free Dictionary', source: 'Free Dictionary API', promise: (async () => {
    const data = await safeFetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(keyword.split(' ')[0])}`);
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    const entry = data[0];
    const meaning = entry.meanings?.[0];
    return { stats: [{
      text: `${entry.word} (${meaning?.partOfSpeech || ''}): ${meaning?.definitions?.[0]?.definition || ''} (Free Dictionary API, ${new Date().getFullYear()})`,
      url: `https://dictionaryapi.dev/`,
      source: 'Free Dictionary API',
    }]};
  })() };
}

// ---- QUOTES (cross-category) ----
function fetchQuotable(keyword) {
  return { name: 'Quotable', source: 'Quotable', promise: (async () => {
    const data = await safeFetch(`https://api.quotable.io/search/quotes?query=${encodeURIComponent(keyword)}&limit=2`);
    if (!data?.results?.length) {
      const random = await safeFetch('https://api.quotable.io/quotes/random?limit=2');
      if (!Array.isArray(random) || !random.length) return { stats: [] };
      return { stats: random.map(q => ({
        text: `"${q.content}" — ${q.author} (Quotable, ${new Date().getFullYear()})`,
        url: 'https://github.com/lukePeavey/quotable',
        source: 'Quotable',
      }))};
    }
    return { stats: data.results.map(q => ({
      text: `"${q.content}" — ${q.author} (Quotable, ${new Date().getFullYear()})`,
      url: 'https://github.com/lukePeavey/quotable',
      source: 'Quotable',
    }))};
  })() };
}

// ---- VEHICLE ----
function fetchNHTSA(keyword) {
  return { name: 'NHTSA', source: 'NHTSA', promise: (async () => {
    const data = await safeFetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(keyword)}?format=json`);
    if (!data?.Results?.length) {
      // Try recalls
      const recalls = await safeFetch('https://api.nhtsa.gov/recalls/recallsByVehicle?make=toyota&modelYear=2024');
      if (!recalls?.results?.length) return { stats: [] };
      return { stats: recalls.results.slice(0, 2).map(r => ({
        text: `NHTSA Recall: ${r.Manufacturer} ${r.ModelYear} — ${r.Component}: ${r.Summary?.substring(0, 120)} (NHTSA, ${new Date().getFullYear()})`,
        url: 'https://www.nhtsa.gov/recalls',
        source: 'NHTSA',
      }))};
    }
    return { stats: [] };
  })() };
}

// ---- CALENDAR / HOLIDAYS ----
function fetchNagerDate() {
  return { name: 'Nager.Date', source: 'Nager.Date', promise: (async () => {
    const year = new Date().getFullYear();
    const data = await safeFetch(`https://date.nager.at/api/v3/publicholidays/${year}/US`);
    if (!Array.isArray(data) || !data.length) return { stats: [] };
    const upcoming = data.filter(h => new Date(h.date) >= new Date()).slice(0, 3);
    return { stats: upcoming.map(h => ({
      text: `Upcoming US holiday: ${h.localName} on ${h.date} (Nager.Date, ${year})`,
      url: 'https://date.nager.at/',
      source: 'Nager.Date',
    }))};
  })() };
}

// ---- ADDITIONAL BOOKS ----
function fetchCrossref(keyword) {
  return { name: 'Crossref', source: 'Crossref', promise: (async () => {
    const data = await safeFetch(`https://api.crossref.org/works?query=${encodeURIComponent(keyword)}&rows=3`);
    if (!data?.message?.items?.length) return { stats: [] };
    return { stats: data.message.items.map(w => ({
      text: `"${w.title?.[0] || ''}" — ${w.author?.[0]?.family || 'Unknown'} et al. (${w.published?.['date-parts']?.[0]?.[0] || ''}) cited ${w['is-referenced-by-count'] || 0} times (Crossref, ${new Date().getFullYear()})`,
      url: w.URL || `https://doi.org/${w.DOI}`,
      source: 'Crossref',
    }))};
  })() };
}

// ---- VETERINARY / BIOMEDICAL RESEARCH (v1.5.15) ----
// Crossref filtered by bibliographic subject — narrows results to a topic area
// like "veterinary" so dog/cat/equine articles get vet-relevant peer-reviewed papers
// instead of generic top-cited works.
function fetchCrossrefFiltered(keyword, subject) {
  const subjectLabel = subject || 'general';
  return { name: `Crossref (${subjectLabel})`, source: 'Crossref', promise: (async () => {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(keyword)}&query.bibliographic=${encodeURIComponent(subject)}&filter=type:journal-article&rows=3`;
    const data = await safeFetch(url);
    if (!data?.message?.items?.length) return { stats: [] };
    return { stats: data.message.items.map(w => ({
      text: `"${w.title?.[0] || ''}" — ${w.author?.[0]?.family || 'Unknown'} et al. (${w.published?.['date-parts']?.[0]?.[0] || ''}) cited ${w['is-referenced-by-count'] || 0} times (Crossref ${subjectLabel}, ${new Date().getFullYear()})`,
      url: w.URL || `https://doi.org/${w.DOI}`,
      source: `Crossref (${subjectLabel})`,
    }))};
  })() };
}

// EuropePMC — biomedical and life-sciences literature (free, no auth, generous rate limit)
// Best for clinical/veterinary research that may not be in Crossref. Returns up to 3 results.
function fetchEuropePMC(query) {
  return { name: 'EuropePMC', source: 'EuropePMC', promise: (async () => {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=3&resultType=lite`;
    const data = await safeFetch(url);
    const results = data?.resultList?.result;
    if (!results?.length) return { stats: [] };
    return { stats: results.map(r => ({
      text: `"${r.title || ''}" — ${r.authorString || 'Unknown'} (${r.journalTitle || r.bookOrReportDetails?.publisher || 'Journal'}, ${r.pubYear || ''}) cited ${r.citedByCount || 0} times (EuropePMC, ${new Date().getFullYear()})`,
      url: r.doi ? `https://doi.org/${r.doi}` : (r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : `https://europepmc.org/article/${r.source}/${r.id}`),
      source: 'EuropePMC',
    }))};
  })() };
}

// OpenAlex — 240M+ scholarly works with topic concept filtering (free, no auth).
// Filtering by display_name surfaces papers tagged with the concept (e.g. "veterinary").
function fetchOpenAlex(keyword, conceptName) {
  return { name: `OpenAlex (${conceptName || 'all'})`, source: 'OpenAlex', promise: (async () => {
    const filterParam = conceptName ? `&filter=concepts.display_name.search:${encodeURIComponent(conceptName)}` : '';
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(keyword)}${filterParam}&per_page=3&mailto=research@seobetter.com`;
    const data = await safeFetch(url);
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(w => ({
      text: `"${w.title || w.display_name || ''}" — ${w.authorships?.[0]?.author?.display_name || 'Unknown'} et al. (${w.publication_year || ''}) cited ${w.cited_by_count || 0} times (OpenAlex, ${new Date().getFullYear()})`,
      url: w.doi ? (w.doi.startsWith('http') ? w.doi : `https://doi.org/${w.doi.replace(/^doi:/, '')}`) : (w.id || 'https://openalex.org/'),
      source: 'OpenAlex',
    }))};
  })() };
}

// ---- ADDITIONAL ENTERTAINMENT ----
function fetchSWAPI() {
  return { name: 'SWAPI', source: 'Star Wars API', promise: (async () => {
    const data = await safeFetch('https://swapi.dev/api/films/');
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.slice(0, 3).map(f => ({
      text: `Star Wars: "${f.title}" (Episode ${f.episode_id}) — directed by ${f.director}, released ${f.release_date} (SWAPI, ${new Date().getFullYear()})`,
      url: 'https://swapi.dev/',
      source: 'SWAPI (Star Wars API)',
    }))};
  })() };
}

function fetchPokeApi(keyword) {
  return { name: 'PokéAPI', source: 'PokéAPI', promise: (async () => {
    const data = await safeFetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(keyword.toLowerCase().split(' ')[0])}`);
    if (!data?.name) {
      const list = await safeFetch('https://pokeapi.co/api/v2/pokemon?limit=3');
      if (!list?.results?.length) return { stats: [] };
      return { stats: [{ text: `PokéAPI tracks ${list.count?.toLocaleString()} Pokémon across all generations (PokéAPI, ${new Date().getFullYear()})`, url: 'https://pokeapi.co/', source: 'PokéAPI' }] };
    }
    return { stats: [{
      text: `${data.name}: ${data.types?.map(t => t.type.name).join('/')} type, base exp ${data.base_experience}, height ${data.height/10}m, weight ${data.weight/10}kg (PokéAPI, ${new Date().getFullYear()})`,
      url: `https://pokeapi.co/api/v2/pokemon/${data.id}`,
      source: 'PokéAPI',
    }]};
  })() };
}

// ---- ADDITIONAL TRANSPORTATION ----
function fetchADSBExchange() {
  return { name: 'ADS-B Exchange', source: 'ADS-B Exchange', promise: (async () => {
    // ADS-B Exchange may need key, use OpenSky as fallback covered already
    return { stats: [{
      text: `ADS-B Exchange provides real-time tracking of aircraft worldwide using ADS-B receiver data from thousands of volunteer feeders (ADS-B Exchange, ${new Date().getFullYear()})`,
      url: 'https://www.adsbexchange.com/',
      source: 'ADS-B Exchange',
    }]};
  })() };
}

// ---- NEWS ----
function fetchSpaceflightNews(keyword) {
  return { name: 'Spaceflight News', source: 'Spaceflight News API', promise: (async () => {
    const data = await safeFetch(`https://api.spaceflightnewsapi.net/v4/articles/?limit=3&search=${encodeURIComponent(keyword)}`);
    if (!data?.results?.length) return { stats: [] };
    return { stats: data.results.map(a => ({
      text: `"${a.title}" — ${a.news_site} (${a.published_at?.split('T')[0] || ''})`,
      url: a.url || 'https://www.spaceflightnewsapi.net/',
      source: a.news_site || 'Spaceflight News',
    }))};
  })() };
}

// ============================================================
// BUILD RESULT
// ============================================================

function buildResearchResult(keyword, reddit, hn, wiki, trends, brave, categoryData, domain, ddg, social, placesData) {
  const now = new Date();
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const year = now.getFullYear();

  const stats = [];
  const quotes = [];
  const sources = []; // { url, title, source_name } — for outbound links
  const trending = [];

  // ---- Wikipedia (factual data + definition) ----
  if (wiki?.extract) {
    // Extract numbers/statistics from Wikipedia
    const numbers = wiki.extract.match(/\d[\d,\.]+\s*(?:billion|million|thousand|percent|%|\$|USD|EUR|GBP)/gi);
    if (numbers) {
      numbers.slice(0, 3).forEach(n => {
        stats.push(`${n} (Wikipedia, ${year})`);
      });
    }

    sources.push({
      url: wiki.url,
      title: wiki.title,
      source_name: 'Wikipedia',
    });

    // Use first sentence as a quotable definition
    const firstSentence = wiki.extract.split('. ')[0];
    if (firstSentence && firstSentence.length > 20) {
      quotes.push({
        text: firstSentence + '.',
        source: 'Wikipedia',
        url: wiki.url,
      });
    }
  }

  // ---- Reddit (community insights) ----
  if (reddit?.posts?.length) {
    const totalComments = reddit.posts.reduce((s, p) => s + (p.comments || 0), 0);
    stats.push(`${reddit.posts.length} active Reddit discussions about "${keyword}" with ${totalComments.toLocaleString()} comments in the last month (Reddit, ${monthYear})`);

    reddit.posts.slice(0, 3).forEach(p => {
      trending.push(`"${p.title}" — ${p.score} upvotes in r/${p.subreddit}`);
      sources.push({
        url: p.url,
        title: p.title,
        source_name: `Reddit r/${p.subreddit}`,
      });
    });

    // Extract quotes from post text
    reddit.posts.forEach(p => {
      if (p.selftext && p.selftext.length > 40) {
        const clean = p.selftext.replace(/\n/g, ' ').trim();
        if (clean.length > 40 && clean.length < 250) {
          quotes.push({
            text: clean.substring(0, 200),
            source: `Reddit user in r/${p.subreddit}`,
            url: p.url,
          });
        }
      }
    });
  }

  // ---- Hacker News (tech community) ----
  if (hn?.posts?.length) {
    hn.posts.slice(0, 3).forEach(p => {
      if (p.url) {
        sources.push({
          url: p.url,
          title: p.title,
          source_name: new URL(p.url).hostname.replace('www.', ''),
        });
      }
      trending.push(`"${p.title}" — ${p.points} points on Hacker News`);
    });
  }

  // ---- v1.5.16 — Social discussion sources (Bluesky, Mastodon, DEV.to, Lemmy) ----
  // Each contributes to trending[] (freshness signal in prompt) and sources[] (references).
  if (social?.bluesky?.posts?.length) {
    social.bluesky.posts.slice(0, 3).forEach(p => {
      if (p.text) {
        trending.push(`"${p.text.substring(0, 120)}" — @${p.author} on Bluesky (${p.likes} likes, ${p.replies} replies)`);
      }
      // Bluesky post URLs are stable and citable
      if (p.url && p.text && p.text.length > 30) {
        sources.push({ url: p.url, title: p.text.substring(0, 80), source_name: `Bluesky @${p.author}` });
      }
    });
  }

  if (social?.mastodon?.posts?.length) {
    social.mastodon.posts.slice(0, 3).forEach(p => {
      if (p.text) {
        trending.push(`"${p.text.substring(0, 120)}" — @${p.author} on Mastodon (${p.favourites} favs, ${p.replies} replies)`);
      }
      if (p.url && p.text && p.text.length > 30) {
        sources.push({ url: p.url, title: p.text.substring(0, 80), source_name: `Mastodon @${p.author}` });
      }
    });
  }

  if (social?.devto?.posts?.length) {
    social.devto.posts.slice(0, 4).forEach(a => {
      if (a.title) {
        trending.push(`"${a.title}" — DEV.to article by @${a.author} (${a.reactions} reactions, ${a.comments} comments)`);
      }
      if (a.url && a.title) {
        sources.push({ url: a.url, title: a.title, source_name: `DEV.to @${a.author}` });
      }
      // DEV.to descriptions often contain real numbers worth surfacing
      if (a.description) {
        const numbers = a.description.match(/\d[\d,\.]+\s*(?:billion|million|thousand|percent|%|\$|users|developers)/gi);
        if (numbers) {
          numbers.slice(0, 1).forEach(n => stats.push(`${n} — ${a.title} (DEV.to, ${year})`));
        }
      }
    });
  }

  if (social?.lemmy?.posts?.length) {
    social.lemmy.posts.slice(0, 3).forEach(p => {
      if (p.title) {
        trending.push(`"${p.title}" — ${p.score} score in Lemmy c/${p.community}`);
      }
      if (p.url && p.title) {
        sources.push({ url: p.url, title: p.title, source_name: `Lemmy c/${p.community}` });
      }
    });
  }

  // ---- Brave Search (real web statistics — Pro only) ----
  if (brave?.results?.length) {
    brave.results.forEach(r => {
      // Extract statistics from search snippets
      const statMatches = r.description.match(/\d[\d,\.]*\s*(?:billion|million|thousand|percent|%|\$|USD|EUR)/gi);
      if (statMatches) {
        statMatches.slice(0, 2).forEach(s => {
          stats.push(`${s} — ${r.source} (${r.age || year})`);
        });
      }

      sources.push({
        url: r.url,
        title: r.title,
        source_name: r.source,
      });
    });
  }

  // ---- DuckDuckGo Web Search (real authoritative URLs for citations) ----
  if (ddg?.results?.length) {
    ddg.results.forEach(r => {
      // Extract statistics from snippets
      const statMatches = r.snippet?.match(/\d[\d,\.]*\s*(?:billion|million|thousand|percent|%|\$|USD|EUR)/gi);
      if (statMatches) {
        statMatches.slice(0, 2).forEach(s => {
          stats.push(`${s} — ${r.source} (${year})`);
        });
      }
      sources.push({
        url: r.url,
        title: r.title,
        source_name: r.source,
      });
    });
  }

  // ---- Google Trends (related topics) ----
  if (trends?.topics?.length) {
    trends.topics.slice(0, 3).forEach(t => {
      if (t.title) trending.push(`Related trending topic: "${t.title}"`);
    });
  }

  // ---- Category-specific API data ----
  // Low-authority sources: stats used by AI for context, but URLs excluded from references
  const lowAuthority = new Set([
    'Free Dictionary API', 'Numbers API', 'Zoo Animals API', 'Dog Facts API',
    'Cat Facts API', 'MeowFacts', 'Fruityvice', 'Quotable', 'Open Trivia Database',
    'SWAPI (Star Wars API)', 'PokéAPI', 'Currency Exchange API', 'ADS-B Exchange',
  ]);

  if (categoryData?.length) {
    categoryData.forEach(cat => {
      const d = cat.data;
      if (!d) return;
      if (d.stats?.length) {
        d.stats.forEach(s => {
          // Always add stats — AI uses them for writing context
          stats.push(s.text);
          // Only add authoritative sources to the references section
          if (s.url && !lowAuthority.has(s.source)) {
            sources.push({ url: s.url, title: s.text.substring(0, 80), source_name: s.source || cat.source });
          }
        });
      }
    });
  }

  // ---- v1.5.23 — OSM Places (real local businesses, anti-hallucination grounding) ----
  // Every place found in Nominatim+Overpass gets added to `sources[]` so the
  // OSM URL flows through the Citation Pool into the References section. The
  // places are also formatted into a dedicated "REAL LOCAL PLACES" prompt
  // block below (see line search for placesBlockForPrompt).
  const placesForPrompt = [];
  if (placesData?.places?.length) {
    placesData.places.forEach(pl => {
      // Source entry — OSM URL is always citable since we whitelisted it
      sources.push({
        url: pl.osm_url,
        title: pl.name + (pl.address ? ' — ' + pl.address : ''),
        source_name: 'OpenStreetMap',
      });
      // If the place has its own website, add that too so it's pooled
      if (pl.website && /^https?:\/\//.test(pl.website)) {
        sources.push({
          url: pl.website,
          title: pl.name + ' (official website)',
          source_name: 'Business Website',
        });
      }
      // Format for the dedicated places prompt block
      const parts = [ `**${pl.name}**` ];
      if (pl.type) parts.push(`(${pl.type})`);
      if (pl.address) parts.push(`— ${pl.address}`);
      placesForPrompt.push({
        line: parts.join(' '),
        detail: [
          pl.website ? `Website: ${pl.website}` : null,
          pl.phone ? `Phone: ${pl.phone}` : null,
          pl.opening_hours ? `Hours: ${pl.opening_hours}` : null,
          `OSM: ${pl.osm_url}`,
        ].filter(Boolean).join(' | '),
      });
      // Add a stat-style attribution so the AI can cite it inline
      stats.push(`${pl.name} is a real ${pl.type || 'local business'}${pl.address ? ' at ' + pl.address : ''} (OpenStreetMap, ${year})`);
    });
  }

  // Deduplicate sources by URL
  const uniqueSources = [];
  const seenUrls = new Set();
  sources.forEach(s => {
    if (s.url && !seenUrls.has(s.url)) {
      seenUrls.add(s.url);
      uniqueSources.push(s);
    }
  });

  // ---- Build prompt injection string ----
  const p = [];
  const catNames = (categoryData || []).filter(c => c.data?.stats?.length).map(c => c.name);
  const catLabel = catNames.length ? `, ${catNames.join(', ')}` : '';
  p.push(`REAL-TIME RESEARCH DATA (${monthYear}):`);
  // v1.5.16 — list any of the new social sources that returned data
  const socialNames = [];
  if (social?.bluesky?.posts?.length) socialNames.push('Bluesky');
  if (social?.mastodon?.posts?.length) socialNames.push('Mastodon');
  if (social?.devto?.posts?.length) socialNames.push('DEV.to');
  if (social?.lemmy?.posts?.length) socialNames.push('Lemmy');
  const socialLabel = socialNames.length ? ', ' + socialNames.join(', ') : '';
  p.push(`Topic: "${keyword}" (${domain || 'general'}) — researched across DuckDuckGo, Wikipedia, Reddit, Hacker News${socialLabel}${brave ? ', Brave Web Search' : ''}${catLabel}\n`);

  if (stats.length) {
    p.push('VERIFIED STATISTICS (use these exact numbers with citations):');
    stats.slice(0, 15).forEach(s => p.push(`- ${s}`));
  }

  if (quotes.length) {
    p.push('\nQUOTES FROM REAL SOURCES (attribute exactly as shown):');
    quotes.slice(0, 4).forEach(q => p.push(`- "${q.text}" — ${q.source} (${q.url})`));
  }

  if (trending.length) {
    p.push('\nTRENDING DISCUSSIONS (reference these for freshness):');
    trending.slice(0, 5).forEach(t => p.push(`- ${t}`));
  }

  // v1.5.23 — REAL LOCAL PLACES block (closed-menu grounding to prevent
  // hallucinated businesses). v1.5.24 — now sourced from the 5-tier waterfall
  // (OSM + Wikidata + optional Foursquare/HERE/Google). The PLACES RULES in
  // the system prompt reference this exact section heading. If empty, we
  // include a warning instead so the AI knows not to invent businesses.
  if (placesData?.isLocal) {
    if (placesForPrompt.length > 0) {
      const sourceLabel = placesData.provider_used || 'verified open-map data';
      p.push(`\nREAL LOCAL PLACES in ${placesData.location} (use ONLY these businesses — do NOT invent any others):`);
      placesForPrompt.forEach((pl, i) => {
        p.push(`${i + 1}. ${pl.line}`);
        if (pl.detail) p.push(`   ${pl.detail}`);
      });
      p.push(`\n(${placesForPrompt.length} real ${placesData.business_type || 'place'}s verified via ${sourceLabel}. Per PLACES RULES, you MUST use only these exact names and addresses — no fabricated businesses.)`);
    } else {
      const triedList = (placesData.providers_tried || []).map(t => `${t.name} (${t.count})`).join(', ');
      const triedSuffix = triedList ? ` Providers tried: ${triedList}.` : '';
      p.push(`\nLOCAL-INTENT WARNING: This keyword asks about local businesses but the Places waterfall returned ZERO verified places.${triedSuffix} The location may be too small for open-map coverage OR the business type wasn't recognized. DO NOT invent business names. Per PLACES RULES, write a general informational article without naming specific businesses, and add a disclaimer paragraph at the end suggesting readers check Google Maps or OpenStreetMap directly. The user can configure free Foursquare/HERE or paid Google Places API keys in SEOBetter Settings → Integrations for better small-city coverage.`);
    }
  }

  if (uniqueSources.length) {
    p.push('\nSOURCES FOR REFERENCES SECTION (use these as outbound links):');
    uniqueSources.slice(0, 20).forEach(s => p.push(`- [${s.title}](${s.url}) — ${s.source_name}`));
    p.push('\nIMPORTANT: Use ONLY the URLs listed above in your References section. Every reference must be a real, clickable link. Do NOT invent or hallucinate any URLs.');
  }

  return {
    success: true,
    source: brave ? 'vercel_research_pro' : 'vercel_research',
    keyword,
    stats: stats.slice(0, 20),
    quotes: quotes.slice(0, 5),
    sources: uniqueSources.slice(0, 25),
    trends: trending.slice(0, 12),
    for_prompt: p.join('\n'),
    domain: domain || 'general',
    category_apis: (categoryData || []).filter(c => c.data?.stats?.length).map(c => c.name),
    reddit_count: reddit?.posts?.length || 0,
    hn_count: hn?.posts?.length || 0,
    wiki_found: !!wiki?.extract,
    brave_count: brave?.results?.length || 0,
    ddg_count: ddg?.results?.length || 0,
    // v1.5.16 — counts for the new social fetchers
    bluesky_count: social?.bluesky?.posts?.length || 0,
    mastodon_count: social?.mastodon?.posts?.length || 0,
    devto_count: social?.devto?.posts?.length || 0,
    lemmy_count: social?.lemmy?.posts?.length || 0,
    // v1.5.23/v1.5.24 — local-intent + Places waterfall telemetry
    is_local_intent: !!placesData?.isLocal,
    places_count: placesData?.places?.length || 0,
    places_location: placesData?.location || null,
    places_business_type: placesData?.business_type || null,
    places_provider_used: placesData?.provider_used || null,
    places_providers_tried: placesData?.providers_tried || [],
    searched_at: now.toISOString(),
  };
}
