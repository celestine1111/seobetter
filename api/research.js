/**
 * SEOBetter Cloud API — Real-Time Trend Research Endpoint
 *
 * POST /api/research
 *
 * Searches Reddit + Hacker News + web for recent data on a keyword.
 * Returns structured data (stats, quotes, sources) for article enrichment.
 *
 * No Python needed — pure Node.js using public APIs.
 */

const rateLimitStore = new Map();
const RATE_LIMIT = 10; // requests per hour per site

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const { keyword, site_url } = req.body || {};

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
    // Run searches in parallel
    const [redditData, hnData] = await Promise.all([
      searchReddit(keyword),
      searchHackerNews(keyword),
    ]);

    // Combine and structure the results
    const result = buildResearchResult(keyword, redditData, hnData);

    return res.status(200).json(result);
  } catch (err) {
    console.error('Research error:', err);
    return res.status(500).json({ error: 'Research failed: ' + err.message });
  }
}

/**
 * Search Reddit for recent posts about the keyword.
 */
async function searchReddit(keyword) {
  const url = `https://old.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=month&limit=15`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SEOBetter/1.0 (Research Bot)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return { posts: [], error: `Reddit ${resp.status}` };

    const data = await resp.json();
    const posts = (data?.data?.children || []).map(c => ({
      title: c.data.title,
      score: c.data.score,
      comments: c.data.num_comments,
      subreddit: c.data.subreddit,
      url: `https://reddit.com${c.data.permalink}`,
      created: new Date(c.data.created_utc * 1000).toISOString().split('T')[0],
      selftext: (c.data.selftext || '').substring(0, 200),
    }));

    return { posts: posts.slice(0, 10) };
  } catch (err) {
    return { posts: [], error: err.message };
  }
}

/**
 * Search Hacker News for recent stories about the keyword.
 */
async function searchHackerNews(keyword) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=10`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return { posts: [], error: `HN ${resp.status}` };

    const data = await resp.json();
    const posts = (data?.hits || []).map(h => ({
      title: h.title,
      points: h.points || 0,
      comments: h.num_comments || 0,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      created: h.created_at?.split('T')[0] || '',
      author: h.author || '',
    }));

    return { posts };
  } catch (err) {
    return { posts: [], error: err.message };
  }
}

/**
 * Build structured research result from Reddit + HN data.
 */
function buildResearchResult(keyword, reddit, hn) {
  const now = new Date();
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const stats = [];
  const quotes = [];
  const sources = [];
  const trends = [];

  // Extract stats from Reddit
  if (reddit.posts?.length) {
    const totalUpvotes = reddit.posts.reduce((s, p) => s + (p.score || 0), 0);
    const totalComments = reddit.posts.reduce((s, p) => s + (p.comments || 0), 0);
    const topSubreddits = [...new Set(reddit.posts.map(p => p.subreddit))].slice(0, 3);

    stats.push(`${reddit.posts.length} Reddit discussions about "${keyword}" in the last month with ${totalComments.toLocaleString()} total comments (Reddit, ${monthYear})`);

    if (totalUpvotes > 100) {
      stats.push(`Reddit community engagement shows ${totalUpvotes.toLocaleString()} total upvotes across discussions about ${keyword} (Reddit, ${monthYear})`);
    }

    // Top Reddit posts as trends
    reddit.posts.slice(0, 3).forEach(p => {
      trends.push(`"${p.title}" — ${p.score} upvotes, ${p.comments} comments in r/${p.subreddit}`);
      sources.push(p.url);
    });

    // Extract quotes from post text
    reddit.posts.forEach(p => {
      if (p.selftext && p.selftext.length > 30) {
        const clean = p.selftext.replace(/\n/g, ' ').trim();
        if (clean.length > 30 && clean.length < 200) {
          quotes.push({
            text: clean,
            source: `Reddit user in r/${p.subreddit}`,
          });
        }
      }
    });
  }

  // Extract stats from Hacker News
  if (hn.posts?.length) {
    const totalPoints = hn.posts.reduce((s, p) => s + (p.points || 0), 0);
    const hnComments = hn.posts.reduce((s, p) => s + (p.comments || 0), 0);

    if (totalPoints > 50) {
      stats.push(`Hacker News community discussed "${keyword}" with ${totalPoints} points and ${hnComments} comments in recent stories (Hacker News, ${monthYear})`);
    }

    // Top HN stories as trends
    hn.posts.slice(0, 3).forEach(p => {
      trends.push(`"${p.title}" — ${p.points} points on Hacker News (${p.created})`);
      if (p.url) sources.push(p.url);
      sources.push(p.hn_url);
    });
  }

  // Build the for_prompt string (what gets injected into article generation)
  const promptParts = [];
  promptParts.push(`REAL-TIME RESEARCH DATA (${monthYear}):`);
  promptParts.push(`Topic: "${keyword}" — researched across Reddit and Hacker News\n`);

  if (stats.length) {
    promptParts.push('Recent statistics (verified from real sources):');
    stats.forEach(s => promptParts.push(`- ${s}`));
  }

  if (quotes.length) {
    promptParts.push('\nReal quotes from community discussions:');
    quotes.slice(0, 3).forEach(q => promptParts.push(`- "${q.text}" — ${q.source}`));
  }

  if (trends.length) {
    promptParts.push('\nTrending discussions:');
    trends.slice(0, 5).forEach(t => promptParts.push(`- ${t}`));
  }

  if (sources.length) {
    promptParts.push('\nSources to cite:');
    [...new Set(sources)].slice(0, 5).forEach(s => promptParts.push(`- ${s}`));
  }

  return {
    success: true,
    source: 'vercel_research',
    keyword,
    stats,
    quotes: quotes.slice(0, 5),
    sources: [...new Set(sources)].slice(0, 10),
    trends,
    for_prompt: promptParts.join('\n'),
    reddit_count: reddit.posts?.length || 0,
    hn_count: hn.posts?.length || 0,
    searched_at: now.toISOString(),
  };
}
