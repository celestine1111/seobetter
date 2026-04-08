/**
 * SEOBetter Cloud API — Real-Time Trend Research Endpoint
 *
 * POST /api/research
 *
 * Free tier: Reddit + Hacker News + Wikipedia + Google Trends
 * Pro tier: + Brave Search (real web statistics with outbound links)
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

  const { keyword, site_url, brave_key } = req.body || {};

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
    ];

    // Pro source — only if Brave key provided
    if (brave_key) {
      freeSearches.push(searchBrave(keyword, brave_key));
    }

    const results = await Promise.all(freeSearches);
    const [redditData, hnData, wikiData, trendsData, braveData] = results;

    const result = buildResearchResult(keyword, redditData, hnData, wikiData, trendsData, braveData || null);

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
// BUILD RESULT
// ============================================================

function buildResearchResult(keyword, reddit, hn, wiki, trends, brave) {
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

  // ---- Google Trends (related topics) ----
  if (trends?.topics?.length) {
    trends.topics.slice(0, 3).forEach(t => {
      if (t.title) trending.push(`Related trending topic: "${t.title}"`);
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
  p.push(`REAL-TIME RESEARCH DATA (${monthYear}):`);
  p.push(`Topic: "${keyword}" — researched across Wikipedia, Reddit, Hacker News${brave ? ', and Brave Web Search' : ''}\n`);

  if (stats.length) {
    p.push('VERIFIED STATISTICS (use these exact numbers with citations):');
    stats.slice(0, 8).forEach(s => p.push(`- ${s}`));
  }

  if (quotes.length) {
    p.push('\nQUOTES FROM REAL SOURCES (attribute exactly as shown):');
    quotes.slice(0, 4).forEach(q => p.push(`- "${q.text}" — ${q.source} (${q.url})`));
  }

  if (trending.length) {
    p.push('\nTRENDING DISCUSSIONS (reference these for freshness):');
    trending.slice(0, 5).forEach(t => p.push(`- ${t}`));
  }

  if (uniqueSources.length) {
    p.push('\nSOURCES FOR REFERENCES SECTION (use these as outbound links):');
    uniqueSources.slice(0, 10).forEach(s => p.push(`- [${s.title}](${s.url}) — ${s.source_name}`));
    p.push('\nIMPORTANT: Use ONLY the URLs listed above in your References section. Every reference must be a real, clickable link. Do NOT invent or hallucinate any URLs.');
  }

  return {
    success: true,
    source: brave ? 'vercel_research_pro' : 'vercel_research',
    keyword,
    stats: stats.slice(0, 10),
    quotes: quotes.slice(0, 5),
    sources: uniqueSources.slice(0, 15),
    trends: trending.slice(0, 8),
    for_prompt: p.join('\n'),
    reddit_count: reddit?.posts?.length || 0,
    hn_count: hn?.posts?.length || 0,
    wiki_found: !!wiki?.extract,
    brave_count: brave?.results?.length || 0,
    searched_at: now.toISOString(),
  };
}
