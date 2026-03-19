const axios = require('axios');

// ============================================
// WEB SEARCH SERVICE
// Uses Serper.dev (Google Search API)
// Free tier: 2,500 searches/month
// ============================================

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPER_ENDPOINT = 'https://google.serper.dev/search';

// ============================================
// SEARCH INTENT DETECTION
// Determines if a prompt needs web search
// ============================================

const SEARCH_TRIGGERS = {
  // Explicit search requests
  explicit: [
    /\b(search|google|look\s*up|find\s+(?:me|out))\b/i,
    /\b(search\s+(?:for|about|the\s+web))\b/i,
    /\bwhat'?s\s+(?:the\s+)?(?:latest|newest|recent|current)\b/i,
    /\b(?:latest|recent|current|today'?s?)\s+(?:news|update|price|score|result)/i,
  ],

  // Time-sensitive queries
  timeSensitive: [
    /\b(?:today|tonight|yesterday|this\s+week|this\s+month|right\s+now)\b/i,
    /\b(?:2024|2025|2026)\b/i,
    /\b(?:upcoming|schedule|release\s+date|when\s+(?:is|does|will))\b/i,
    /\b(?:stock\s+price|exchange\s+rate|weather\s+(?:in|for|today))\b/i,
    /\b(?:score|match|game|tournament)\s+(?:today|tonight|yesterday)\b/i,
  ],

  // Factual queries that may need fresh data
  factual: [
    /\bwho\s+(?:is|was|are)\s+(?:the\s+)?(?:current|new|latest)\b/i,
    /\bhow\s+(?:much|many)\s+(?:does|do|is|are)\b.*\b(?:cost|worth|earn)\b/i,
    /\b(?:population|gdp|revenue|market\s+cap)\s+of\b/i,
    /\b(?:ceo|president|leader|founder)\s+of\b/i,
    /\bwhat\s+happened\s+(?:to|in|at|with)\b/i,
  ],

  // Tech/product queries
  tech: [
    /\b(?:best|top|recommended)\s+\w+\s+(?:in\s+)?(?:2024|2025|2026)\b/i,
    /\b(?:alternative|competitor|vs|versus|compared?\s+to)\b/i,
    /\b(?:review|rating|benchmark|specs?|specification)\s+(?:of|for)\b/i,
    /\b(?:how\s+to\s+(?:install|setup|configure|use|fix))\b/i,
  ],
};

// Topics the AI likely knows well (skip search)
const SKIP_SEARCH_PATTERNS = [
  /\b(?:write|create|generate|make)\s+(?:a|an|me|the)\s+(?:code|program|script|function|class)/i,
  /\b(?:explain|describe|define|what\s+is)\s+(?:a\s+)?(?:variable|function|loop|array|object|class|algorithm)/i,
  /\b(?:tell\s+me\s+a\s+(?:joke|story|poem))\b/i,
  /\b(?:translate|convert)\b/i,
  /\b(?:solve|calculate|compute|simplify)\b/i,
  /^(?:hi|hello|hey|thanks|thank\s+you|bye|goodbye)\s*[.!?]*$/i,
  /\b(?:summarize|paraphrase|rewrite)\s+(?:this|the\s+following)\b/i,
];

/**
 * Detects if a prompt needs web search.
 * Returns { needsSearch: boolean, reason: string, searchQuery: string }
 */
const detectSearchIntent = (prompt) => {
  const trimmed = prompt.trim();

  // Skip very short prompts
  if (trimmed.split(/\s+/).length <= 2) {
    return { needsSearch: false, reason: 'too_short' };
  }

  // Skip if it's clearly a coding/creative/math task
  for (const pattern of SKIP_SEARCH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { needsSearch: false, reason: 'known_topic' };
    }
  }

  // Check explicit triggers
  for (const pattern of SEARCH_TRIGGERS.explicit) {
    if (pattern.test(trimmed)) {
      return {
        needsSearch: true,
        reason: 'explicit_request',
        searchQuery: extractSearchQuery(trimmed),
      };
    }
  }

  // Check time-sensitive triggers
  for (const pattern of SEARCH_TRIGGERS.timeSensitive) {
    if (pattern.test(trimmed)) {
      return {
        needsSearch: true,
        reason: 'time_sensitive',
        searchQuery: extractSearchQuery(trimmed),
      };
    }
  }

  // Check factual triggers
  for (const pattern of SEARCH_TRIGGERS.factual) {
    if (pattern.test(trimmed)) {
      return {
        needsSearch: true,
        reason: 'factual_query',
        searchQuery: extractSearchQuery(trimmed),
      };
    }
  }

  // Check tech triggers
  for (const pattern of SEARCH_TRIGGERS.tech) {
    if (pattern.test(trimmed)) {
      return {
        needsSearch: true,
        reason: 'tech_query',
        searchQuery: extractSearchQuery(trimmed),
      };
    }
  }

  return { needsSearch: false, reason: 'no_trigger' };
};

/**
 * Cleans user prompt into a better search query.
 * Removes filler words, commands, etc.
 */
const extractSearchQuery = (prompt) => {
  let query = prompt
    // Remove common command prefixes
    .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:search\s+(?:for|about|the\s+web\s+for)\s*)/i, '')
    .replace(/^(?:look\s+up|find\s+(?:me|out)\s*(?:about)?)\s*/i, '')
    .replace(/^(?:google|search)\s*/i, '')
    .replace(/^(?:what'?s?\s+(?:the\s+)?)/i, '')
    // Remove trailing filler
    .replace(/[?!.]+$/, '')
    .trim();

  // Limit query length
  if (query.length > 150) {
    query = query.slice(0, 150).trim();
  }

  // If query is too short after cleaning, use original
  if (query.length < 5) {
    query = prompt.replace(/[?!.]+$/, '').trim().slice(0, 150);
  }

  return query;
};

/**
 * Performs web search via Serper.dev
 * Returns formatted search results
 */
const searchWeb = async (query, numResults = 5) => {
  if (!SERPER_API_KEY) {
    console.warn('⚠️ No SERPER_API_KEY — web search disabled');
    return null;
  }

  try {
    const startTime = Date.now();

    const response = await axios({
      method: 'POST',
      url: SERPER_ENDPOINT,
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      data: {
        q: query,
        num: numResults,
      },
      timeout: 8000,
    });

    const elapsed = Date.now() - startTime;
    const data = response.data;

    console.log(
      `🔍 Web search: "${query.slice(0, 50)}..." → ${
        (data.organic?.length || 0) + (data.answerBox ? 1 : 0)
      } results (${elapsed}ms)`
    );

    return formatSearchResults(data);
  } catch (err) {
    console.error('❌ Web search failed:', err.message);
    return null;
  }
};

/**
 * Formats Serper.dev response into a clean context string
 * for injection into the AI prompt
 */
const formatSearchResults = (data) => {
  if (!data) return null;

  const parts = [];

  // Answer box (featured snippet)
  if (data.answerBox) {
    const ab = data.answerBox;
    if (ab.answer) {
      parts.push(`**Featured Answer:** ${ab.answer}`);
    } else if (ab.snippet) {
      parts.push(`**Featured Snippet:** ${ab.snippet}`);
    }
    if (ab.title) {
      parts.push(`Source: ${ab.title}`);
    }
  }

  // Knowledge graph
  if (data.knowledgeGraph) {
    const kg = data.knowledgeGraph;
    const kgParts = [];
    if (kg.title) kgParts.push(`**${kg.title}**`);
    if (kg.type) kgParts.push(`Type: ${kg.type}`);
    if (kg.description) kgParts.push(kg.description);

    // Attributes
    if (kg.attributes) {
      for (const [key, value] of Object.entries(kg.attributes).slice(0, 5)) {
        kgParts.push(`${key}: ${value}`);
      }
    }

    if (kgParts.length) {
      parts.push(kgParts.join('\n'));
    }
  }

  // Organic results
  if (data.organic?.length) {
    const results = data.organic.slice(0, 5).map((r, i) => {
      const lines = [`[${i + 1}] **${r.title}**`];
      if (r.snippet) lines.push(r.snippet);
      if (r.link) lines.push(`URL: ${r.link}`);
      if (r.date) lines.push(`Date: ${r.date}`);
      return lines.join('\n');
    });

    parts.push('**Web Results:**\n' + results.join('\n\n'));
  }

  // "People also ask"
  if (data.peopleAlsoAsk?.length) {
    const related = data.peopleAlsoAsk
      .slice(0, 3)
      .map((q) => {
        let line = `- ${q.question}`;
        if (q.snippet) line += `\n  ${q.snippet}`;
        return line;
      })
      .join('\n');

    parts.push('**Related Questions:**\n' + related);
  }

  if (!parts.length) return null;

  return parts.join('\n\n');
};

/**
 * Builds the system prompt injection for search results.
 * This gets prepended to the conversation context.
 */
const buildSearchContext = (searchResults, query) => {
  if (!searchResults) return null;

  return `[WEB SEARCH RESULTS for "${query}"]
The following are real-time web search results. Use this information to provide an accurate, up-to-date answer. 
Cite sources when possible. If the search results don't fully answer the question, say so and provide what you know.
Do NOT make up information that isn't in the search results or your training data.

${searchResults}

[END OF SEARCH RESULTS]
`;
};

module.exports = {
  detectSearchIntent,
  searchWeb,
  buildSearchContext,
  extractSearchQuery,
  formatSearchResults,
};