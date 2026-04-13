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

  const { niche, site_url } = req.body || {};
  if (!niche) return res.status(400).json({ error: 'niche is required.' });

  // Rate limit
  const rateKey = `${site_url || 'unknown'}_${new Date().getHours()}`;
  const count = rateLimitStore.get(rateKey) || 0;
  if (count >= RATE_LIMIT) return res.status(429).json({ error: 'Rate limit exceeded.' });
  rateLimitStore.set(rateKey, count + 1);

  try {
    // Run all 5 sources in parallel
    const [suggest, datamuse, wiki, reddit] = await Promise.all([
      fetchGoogleSuggest(niche),
      fetchDatamuse(niche),
      fetchWikipedia(niche),
      fetchReddit(niche),
    ]);

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
async function fetchGoogleSuggest(query) {
  const variations = [
    query,
    'best ' + query,
    'how to ' + query,
    query + ' for',
    query + ' vs',
    'why ' + query,
    'what is ' + query,
  ];

  const allSuggestions = [];
  for (const v of variations) {
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(v)}`;
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
// Source 2: Datamuse (semantic word clusters)
// ============================================================
async function fetchDatamuse(query) {
  try {
    // ml = "means like" — semantically related words
    const url = `https://api.datamuse.com/words?ml=${encodeURIComponent(query)}&max=20&md=f`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map(d => ({ word: d.word, freq: d.tags ? parseFreq(d.tags) : 0 }));
  } catch {
    return [];
  }
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
  const secondary = [];
  for (const s of suggest) {
    const phrase = (s || '').toLowerCase().trim();
    if (!phrase || seen.has(phrase)) continue;
    if (phrase.length < 6 || phrase.length > 80) continue;
    // Must contain the niche or a piece of it (sanity filter)
    const nicheParts = nicheLower.split(/\s+/).filter(w => w.length > 3);
    const overlaps = nicheParts.some(w => phrase.includes(w));
    if (!overlaps) continue;
    seen.add(phrase);
    secondary.push(phrase);
    if (secondary.length >= 7) break;
  }

  // LSI keywords — semantic single-word terms from Datamuse.
  // 8-10 best fits, deduplicated against secondary phrases.
  const lsi = [];
  const secondaryWords = new Set();
  secondary.forEach(s => s.split(/\s+/).forEach(w => secondaryWords.add(w)));
  for (const d of datamuse) {
    const word = (d.word || '').toLowerCase().trim();
    if (!word || word.length < 4 || word.length > 30) continue;
    if (seen.has(word) || secondaryWords.has(word)) continue;
    // Skip exact-match niche words
    if (nicheLower.includes(word)) continue;
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
