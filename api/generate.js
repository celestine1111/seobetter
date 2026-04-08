/**
 * SEOBetter Cloud API — Content Generation Endpoint
 *
 * POST /api/generate
 *
 * Proxies AI content generation requests from the SEOBetter WordPress plugin
 * for users who don't have their own API keys.
 *
 * Default provider: Groq (free, fast, Llama 3.3 70B)
 * Fallback: Anthropic Claude (if ANTHROPIC_API_KEY is set)
 *
 * Rate limiting: 5 requests/month per site_url (free), unlimited for Pro license keys
 */

// In-memory rate limiting store (resets on cold start — fine for testing)
// For production, replace with Vercel KV or Upstash Redis
const usageStore = new Map();

const FREE_MONTHLY_LIMIT = 50;

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const {
    prompt,
    system_prompt = '',
    max_tokens = 4096,
    temperature = 0.7,
    site_url = '',
    license_key = '',
    plugin_version = '',
  } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'Missing required field: prompt' });
  }

  // --- Rate Limiting ---
  const isPro = isValidProKey(license_key);

  if (!isPro) {
    const monthKey = getMonthKey(site_url);
    const usage = usageStore.get(monthKey) || 0;

    if (usage >= FREE_MONTHLY_LIMIT) {
      return res.status(429).json({
        error: `Monthly free limit reached (${FREE_MONTHLY_LIMIT} articles). Connect your own API key in SEOBetter Settings, or upgrade to Pro for unlimited.`,
      });
    }

    // Increment usage
    usageStore.set(monthKey, usage + 1);
  }

  // --- Forward to AI Provider ---
  try {
    let result;

    // Try Groq first (free), fall back to Anthropic
    if (process.env.GROQ_API_KEY) {
      result = await callGroq(prompt, system_prompt, max_tokens, temperature);
    } else if (process.env.ANTHROPIC_API_KEY) {
      result = await callAnthropic(prompt, system_prompt, max_tokens, temperature);
    } else if (process.env.OPENAI_API_KEY) {
      result = await callOpenAI(prompt, system_prompt, max_tokens, temperature);
    } else {
      return res.status(500).json({
        error: 'No AI provider configured on SEOBetter Cloud. Please connect your own API key in plugin settings.',
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('SEOBetter Cloud generation error:', err.message);

    // Rollback usage count on failure
    if (!isPro) {
      const monthKey = getMonthKey(site_url);
      const usage = usageStore.get(monthKey) || 1;
      usageStore.set(monthKey, Math.max(0, usage - 1));
    }

    return res.status(500).json({ error: `AI provider error: ${err.message}` });
  }
}

// --- AI Provider Functions ---

async function callGroq(prompt, system_prompt, max_tokens, temperature) {
  const messages = [];
  if (system_prompt) {
    messages.push({ role: 'system', content: system_prompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: Math.min(max_tokens, 8192),
      temperature,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Groq API error');
  }

  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || 'llama-3.3-70b-versatile',
  };
}

async function callAnthropic(prompt, system_prompt, max_tokens, temperature) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: Math.min(max_tokens, 8192),
    temperature,
    messages: [{ role: 'user', content: prompt }],
  };

  if (system_prompt) {
    body.system = system_prompt;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Anthropic API error');
  }

  return {
    content: data.content?.[0]?.text || '',
    model: data.model || 'claude-sonnet-4-6',
  };
}

async function callOpenAI(prompt, system_prompt, max_tokens, temperature) {
  const messages = [];
  if (system_prompt) {
    messages.push({ role: 'system', content: system_prompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: Math.min(max_tokens, 8192),
      temperature,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'OpenAI API error');
  }

  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || 'gpt-4o-mini',
  };
}

// --- Helpers ---

function isValidProKey(key) {
  if (!key) return false;

  const proKeys = (process.env.SEOBETTER_PRO_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);

  // If no pro keys configured, no one is pro
  if (proKeys.length === 0) return false;

  return proKeys.includes(key);
}

function getMonthKey(siteUrl) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Normalize site URL
  const normalized = (siteUrl || 'unknown').replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  return `usage:${normalized}:${month}`;
}
