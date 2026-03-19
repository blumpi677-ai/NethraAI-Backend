const axios = require('axios');

// ============================================
// MODEL CONFIGURATION
// ============================================
const MODELS = {
  router: {
    id: 'deepseek-ai/deepseek-r1-distill-llama-8b',
    apiKey: process.env.NVIDIA_ROUTER_API_KEY,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    maxTokens: 16,
  },
  speed: {
    id: 'nvidia/nemotron-3-nano-30b-a3b',
    apiKey: process.env.NVIDIA_SPEED_API_KEY,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    maxTokens: 4096,
  },
  brain: {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    apiKey: process.env.NVIDIA_BRAIN_API_KEY,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    maxTokens: 8192,
  },
  vision: {
    id: 'nvidia/nemotron-nano-12b-v2-vl',
    apiKey: process.env.NVIDIA_VISION_API_KEY,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    maxTokens: 4096,
  },
  image: {
    id: 'black-forest-labs/flux.2-klein-4b',
    apiKey: process.env.NVIDIA_IMAGE_API_KEY,
    endpoint:
      'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b',
  },
};

// ============================================
// CONTEXT-AWARE SYSTEM PROMPTS
// ============================================
const SYSTEM_PROMPTS = {
  default: `You are Nethra, an advanced AI assistant built for intelligent, helpful conversations. Be accurate, concise, and friendly. Use markdown formatting when appropriate.

CONVERSATION AWARENESS — CRITICAL RULES:
- You have access to the full conversation history in the messages above. ALWAYS reference it.
- When the user says "it", "that", "this", "the above", "you said", "earlier", "previous", "before", or similar pronouns/references, look at the prior messages to understand what they mean.
- If the user asks you to modify, expand, fix, improve, or continue something from an earlier message, find that specific content in the history and work from it.
- Maintain consistency with your own previous answers — never contradict what you said earlier unless correcting a mistake (and say so).
- Don't repeat information you've already provided unless the user explicitly asks for it again.
- Build naturally upon the established context — each response should feel like a continuation of the same coherent conversation.
- If the user changes topic, smoothly transition without forcing references to unrelated prior messages.
- For follow-up questions ("why?", "how?", "explain more", "what about X?"), respond in the direct context of what was just discussed.`,

  thinking: `You are Nethra in deep-thinking mode. Provide thorough, well-reasoned, comprehensive responses. Break down complex topics step by step. Use markdown formatting.

CONVERSATION AWARENESS — CRITICAL RULES:
- Carefully review ALL previous messages in this conversation before responding.
- Connect your analysis to relevant points discussed earlier — show the user you remember the full context.
- If this is a follow-up question, build upon your previous explanations rather than starting from scratch.
- Reference specific things you or the user said earlier when they're relevant to the current question.
- Maintain logical and factual consistency across the entire conversation — your 5th response should not contradict your 2nd.
- When the user deepens a topic ("tell me more about X"), go deeper into that specific aspect without re-explaining the basics you already covered.
- If the user changes direction, acknowledge the shift and adapt.`,

  vision: `You are Nethra Vision. Analyze images with great detail and accuracy. Describe what you see, identify objects, text, patterns, and provide insightful observations.

CONVERSATION AWARENESS — CRITICAL RULES:
- If previous images were discussed in this conversation, you may reference or compare them.
- Use any context from earlier messages to understand what the user is looking for in this image.
- If the user asks follow-up questions about an image you already analyzed, refer back to your prior analysis — don't re-describe everything from scratch.
- If the user says "what about the X in that image" or "look at the top-left", focus your response on that specific aspect.`,
};

// ============================================
// AI ROUTER — Context-Aware Prompt Classification
// ============================================

const ROUTER_SYSTEM_PROMPT = `You are a prompt classifier. Your ONLY job is to decide if a user's message needs a SIMPLE or COMPLEX response.

Reply with exactly one word: SPEED or BRAIN

SPEED = simple questions, greetings, short answers, translations, quick facts, casual chat, simple math, definitions, yes/no questions, single-step tasks, acknowledgments like "thanks" or "ok"
BRAIN = complex analysis, detailed explanations, code writing, essays, multi-step reasoning, comparisons, debugging, architecture design, research, creative writing over 200 words, anything needing deep thought

CONTEXT-AWARE RULES (when conversation history is provided):
- A short follow-up like "why?", "explain more", "how?", "what about X?" AFTER a complex/technical discussion → BRAIN
- "can you fix that?", "modify it", "add error handling", "change X to Y" referencing prior complex work → BRAIN
- Continuing or deepening an in-depth technical/analytical topic → BRAIN, even if the new message is very short
- Simple acknowledgments ("thanks", "ok", "got it", "nice") → SPEED regardless of prior context
- A new simple question unrelated to prior complex context → SPEED
- "tell me more", "go deeper", "elaborate" → BRAIN

Examples:
"hi" → SPEED
"what is 2+2" → SPEED
"translate hello to french" → SPEED
"what's the weather like" → SPEED
"define photosynthesis" → SPEED
"write a haiku" → SPEED
"tell me a joke" → SPEED
"summarize this in one line" → SPEED
"thanks" → SPEED
"ok got it" → SPEED
"explain quantum entanglement in detail with examples" → BRAIN
"write a python web scraper with error handling" → BRAIN
"compare React vs Vue vs Angular pros and cons" → BRAIN
"debug this code: [code]" → BRAIN
"write an essay about climate change" → BRAIN
"design a database schema for an e-commerce app" → BRAIN
"explain how transformers work in ML step by step" → BRAIN
"analyze the economic impact of AI on jobs" → BRAIN
"why?" (after complex explanation) → BRAIN
"explain more" (after technical discussion) → BRAIN
"can you add tests to that?" (after code was written) → BRAIN
"what about security?" (after architecture discussion) → BRAIN

Reply ONLY with: SPEED or BRAIN`;

// ============================================
// FOLLOW-UP DETECTION
// ============================================

/**
 * Detects if a message is likely a follow-up to previous conversation.
 * Used by both the router and the context builder.
 */
const isFollowUpMessage = (prompt) => {
  const lower = prompt.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;

  // Very short messages (1-3 words) — check common follow-up patterns
  if (wordCount <= 3) {
    const shortFollowUps = [
      'why',
      'how',
      'when',
      'where',
      'what',
      'which',
      'who',
      'explain',
      'elaborate',
      'continue',
      'go on',
      'more',
      'details',
      'example',
      'examples',
      'fix',
      'modify',
      'change',
      'update',
      'edit',
      'really',
      'seriously',
      'and',
      'also',
      'but',
      'however',
      'next',
      'then',
      'now what',
      'so',
      'meaning',
    ];
    return shortFollowUps.some((p) => lower.includes(p));
  }

  // Explicit references to prior conversation
  const contextReferences = [
    // Direct references to AI's previous output
    'you said',
    'you mentioned',
    'you wrote',
    'you explained',
    'you suggested',
    'you recommended',
    'your answer',
    'your response',
    'your code',
    'your example',
    'your solution',
    'your explanation',
    'as you said',
    'as you mentioned',
    // Temporal references
    'earlier',
    'above',
    'previous',
    'before',
    'last time',
    'just now',
    'a moment ago',
    // Demonstrative references
    'that code',
    'that example',
    'that approach',
    'that solution',
    'that function',
    'that method',
    'the above',
    'the same',
    'the one you',
    'the code you',
    // Continuation requests
    'can you also',
    'what about',
    'how about',
    'and what',
    'but what',
    'but how',
    'but why',
    'tell me more',
    'more about',
    'expand on',
    'go deeper',
    'in more detail',
    'elaborate on',
    'explain further',
    'explain that',
    // Modification requests
    'can you fix',
    'can you modify',
    'can you change',
    'can you update',
    'can you add',
    'can you remove',
    'can you improve',
    'can you refactor',
    'can you optimize',
    'make it',
    'change it',
    'fix it',
    'update it',
    'modify it',
    'improve it',
    'do it',
    'try it',
    'run it',
    // Conditional follow-ups
    'what if',
    'instead',
    'alternatively',
    'another way',
    'different approach',
    'based on that',
    'following that',
    'in that case',
    'from that',
    'with that',
    'like that',
    'similar to',
    // Comparison/continuation
    'compared to',
    'versus',
    'now do',
    'now show',
    'now explain',
    'next step',
    'after that',
    'following up',
  ];

  return contextReferences.some((ref) => lower.includes(ref));
};

// ============================================
// ROUTER CONTEXT BUILDER
// ============================================

/**
 * Builds a compact summary of recent conversation for the router.
 * Helps the router understand if a short message is a follow-up
 * to something complex (and should therefore go to BRAIN).
 */
const buildRouterContext = (messages, limit = 4) => {
  if (!messages || messages.length === 0) return '';

  const recent = messages
    .filter((m) => m.role !== 'system')
    .slice(-(limit * 2)); // last N exchanges (user + assistant pairs)

  if (recent.length === 0) return '';

  return recent
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'AI';
      const content = (m.content || '')
        .slice(0, 150)
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `${role}: ${content}${(m.content || '').length > 150 ? '...' : ''}`;
    })
    .join('\n');
};

/**
 * Estimates conversation complexity from recent messages.
 * Returns 'complex', 'moderate', or 'simple'.
 */
const estimateConversationComplexity = (messages) => {
  if (!messages || messages.length === 0) return 'simple';

  const recentAssistant = messages
    .filter((m) => m.role === 'assistant')
    .slice(-3);

  if (recentAssistant.length === 0) return 'simple';

  // Check average response length — longer responses = more complex conversation
  const avgLength =
    recentAssistant.reduce((sum, m) => sum + (m.content || '').length, 0) /
    recentAssistant.length;

  // Check for code blocks, tables, or structured content
  const hasComplexContent = recentAssistant.some(
    (m) =>
      (m.content || '').includes('```') ||
      (m.content || '').includes('|') ||
      (m.content || '').split('\n').length > 10
  );

  if (avgLength > 1000 || hasComplexContent) return 'complex';
  if (avgLength > 300) return 'moderate';
  return 'simple';
};

// ============================================
// AI ROUTER — Context-Aware Version
// ============================================

/**
 * Uses DeepSeek R1 8B to intelligently route prompts.
 * Now accepts conversation context for better follow-up routing.
 * Returns 'speed' or 'brain'.
 */
const routeWithAI = async (prompt, contextSummary = '') => {
  const config = MODELS.router;

  if (!config.apiKey) {
    console.log('⚠️ No router API key — using keyword fallback');
    return routeByKeywords(prompt, contextSummary);
  }

  try {
    const startTime = Date.now();

    const messages = [{ role: 'system', content: ROUTER_SYSTEM_PROMPT }];

    // Add conversation context so the router can judge follow-ups correctly
    if (contextSummary) {
      messages.push({
        role: 'system',
        content: `RECENT CONVERSATION CONTEXT (use this to judge if the next message is a complex follow-up):\n${contextSummary}`,
      });
    }

    messages.push({ role: 'user', content: prompt.slice(0, 500) });

    const response = await axios({
      method: 'POST',
      url: config.endpoint,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        model: config.id,
        messages,
        max_tokens: 16,
        temperature: 0,
        stream: false,
      },
      timeout: 5000,
    });

    const elapsed = Date.now() - startTime;
    const raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
    const decision = parseRouterDecision(raw);

    console.log(
      `🧭 AI Router: "${prompt.slice(0, 50)}..." → ${decision.toUpperCase()} (${elapsed}ms, hasContext: ${!!contextSummary})`
    );

    return decision;
  } catch (err) {
    console.warn(
      `⚠️ AI Router failed (${err.message}) — using keyword fallback`
    );
    return routeByKeywords(prompt, contextSummary);
  }
};

/**
 * Parses the router model's response into 'speed' or 'brain'.
 */
const parseRouterDecision = (raw) => {
  if (!raw) return 'speed';

  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[^a-zA-Z]/g, ' ')
    .trim()
    .toLowerCase();

  if (cleaned.includes('brain')) return 'brain';
  if (cleaned.includes('complex')) return 'brain';
  if (cleaned.includes('speed')) return 'speed';
  if (cleaned.includes('simple')) return 'speed';

  return 'speed';
};

/**
 * Keyword-based routing fallback — now context-aware.
 */
const routeByKeywords = (prompt, contextSummary = '') => {
  const lower = prompt.toLowerCase();
  const wordCount = prompt.split(/\s+/).length;

  const hasContext = !!contextSummary;
  const followUp = hasContext && isFollowUpMessage(prompt);
  const complexity = hasContext
    ? contextSummary.length > 400
      ? 'complex'
      : contextSummary.length > 150
      ? 'moderate'
      : 'simple'
    : 'simple';

  // Simple acknowledgments — always SPEED
  const ackPatterns = [
    'thanks',
    'thank you',
    'ok',
    'okay',
    'got it',
    'understood',
    'cool',
    'nice',
    'great',
    'perfect',
    'awesome',
    'good',
    'fine',
    'alright',
    'sure',
    'yep',
    'yes',
    'no',
    'nope',
    'bye',
    'goodbye',
  ];
  if (
    wordCount <= 4 &&
    ackPatterns.some((a) => lower === a || lower.startsWith(a + ' ') || lower.startsWith(a + '!') || lower.startsWith(a + '.'))
  ) {
    return 'speed';
  }

  // Follow-up to a complex conversation → brain
  if (followUp && complexity === 'complex') return 'brain';

  const brainIndicators = [
    'explain in detail',
    'step by step',
    'comprehensive',
    'analyze',
    'compare',
    'pros and cons',
    'in depth',
    'elaborate',
    'write an essay',
    'write code',
    'implement',
    'algorithm',
    'architecture',
    'debug',
    'refactor',
    'optimize',
    'design a',
    'build a',
    'create a full',
    'how does .* work',
    'why does',
    'differences between',
    'write a program',
    'write a script',
    'write a function',
    'review this code',
    'explain this code',
  ];

  const speedIndicators = [
    'hi',
    'hello',
    'hey',
    'what is',
    'who is',
    'define',
    'translate',
    'yes or no',
    'true or false',
    'how much',
    'what time',
    'when is',
    'where is',
    'tell me a joke',
    'give me a fact',
  ];

  // Short messages without context — speed
  if (wordCount <= 5 && !followUp) {
    const isSimpleGreeting = speedIndicators.some((s) => lower.includes(s));
    if (isSimpleGreeting || wordCount <= 3) return 'speed';
  }

  // Check brain indicators
  const needsBrain = brainIndicators.some((indicator) => {
    if (indicator.includes('.*')) {
      return new RegExp(indicator).test(lower);
    }
    return lower.includes(indicator);
  });

  if (needsBrain) return 'brain';

  // Follow-ups to moderate conversations — brain (they need context)
  if (followUp && complexity === 'moderate') return 'brain';

  // Long prompts (40+ words)
  if (wordCount > 40) return 'brain';

  // Follow-ups in general lean towards brain for better context handling
  if (followUp) return 'brain';

  return 'speed';
};

// ============================================
// IMAGE INTENT DETECTION
// ============================================
const detectImageIntent = (prompt, hasImage) => {
  const lower = prompt.toLowerCase();

  const analyzeKeywords = [
    'analyze',
    'describe',
    'what is',
    'what are',
    'identify',
    'explain this',
    'look at',
    'tell me about',
    'what do you see',
    'read',
    'extract',
    'ocr',
    'transcribe',
  ];

  if (analyzeKeywords.some((k) => lower.includes(k))) return 'analyze';
  return hasImage ? 'analyze' : 'generate';
};

// ============================================
// RESOLVE MODEL — Context-Aware
// ============================================
const resolveModel = async (
  mode,
  prompt,
  hasImage,
  conversationHistory = []
) => {
  switch (mode) {
    case 'fast':
      return { modelKey: 'speed', intent: 'chat', routedBy: 'user' };

    case 'thinking':
      return { modelKey: 'brain', intent: 'chat', routedBy: 'user' };

    case 'image': {
      const intent = detectImageIntent(prompt, hasImage);
      return intent === 'analyze'
        ? { modelKey: 'vision', intent: 'analyze', routedBy: 'user' }
        : { modelKey: 'image', intent: 'generate', routedBy: 'user' };
    }

    case 'normal':
    default: {
      // Build context summary from conversation history for smarter routing
      const contextSummary = buildRouterContext(conversationHistory);
      const modelKey = await routeWithAI(prompt, contextSummary);
      return { modelKey, intent: 'chat', routedBy: 'ai' };
    }
  }
};

// ============================================
// PROMPT SANITIZER
// ============================================
const BLOCKED_PATTERNS = {
  realPeople: [
    /\b(elon\s*musk|trump|biden|obama|taylor\s*swift|beyonce|drake)\b/i,
    /\b(kardashian|messi|ronaldo|putin|modi|xi\s*jinping)\b/i,
    /\b(zuckerberg|bezos|gates|oprah|rihanna|kanye)\b/i,
    /\b(celebrity|famous\s*person|real\s*person|public\s*figure)\b/i,
  ],
  copyrighted: [
    /\b(iron\s*man|spider[\s-]*man|batman|superman|wonder\s*woman)\b/i,
    /\b(harry\s*potter|darth\s*vader|yoda|thanos|hulk|thor)\b/i,
    /\b(pikachu|mario|sonic|mickey\s*mouse|donald\s*duck)\b/i,
    /\b(goku|naruto|luffy|spongebob|homer\s*simpson)\b/i,
    /\b(captain\s*america|black\s*panther|deadpool|wolverine)\b/i,
    /\b(elsa|frozen|moana|simba|nemo|shrek|buzz\s*lightyear)\b/i,
  ],
  brands: [
    /\b(nike|adidas|coca[\s-]*cola|pepsi|apple\s*logo|google\s*logo)\b/i,
    /\b(microsoft|amazon|tesla|ferrari|lamborghini|rolex)\b/i,
    /\b(gucci|louis\s*vuitton|chanel|supreme|playboy)\b/i,
  ],
  violence: [
    /\b(gun|rifle|pistol|shotgun|weapon|sword\s*fight)\b/i,
    /\b(blood|gore|violent|murder|kill|dead\s*body|corpse)\b/i,
    /\b(explosion|bomb|grenade|missile|warfare)\b/i,
    /\b(torture|abuse|assault|attack\s*on)\b/i,
  ],
  nsfw: [
    /\b(nude|naked|nsfw|explicit|pornograph|sexual|erotic)\b/i,
    /\b(lingerie|bikini\s*model|seductive|provocative)\b/i,
    /\b(drug|cocaine|heroin|marijuana|smoking\s*weed)\b/i,
  ],
  sensitive: [
    /\b(terrorist|isis|al[\s-]*qaeda|nazi|swastika|confederate\s*flag)\b/i,
    /\b(holocaust|genocide|ethnic\s*cleansing|hate\s*symbol)\b/i,
    /\b(burning\s*cross|kkk|white\s*supremac)\b/i,
  ],
};

const SAFE_ALTERNATIVES = {
  'iron man': 'a futuristic red and gold powered armor suit',
  'spider-man': 'a red and blue masked acrobatic superhero figure',
  spiderman: 'a red and blue masked acrobatic superhero figure',
  batman: 'a dark caped vigilante in a gothic city',
  superman: 'a powerful flying hero in red cape and blue suit',
  'wonder woman': 'an Amazonian warrior princess with golden tiara',
  'harry potter': 'a young wizard student with round glasses and wand',
  'darth vader': 'a dark armored sci-fi villain with glowing red blade',
  yoda: 'a small wise green alien elder',
  thanos: 'a powerful purple cosmic titan',
  hulk: 'a massive green muscular giant',
  thor: 'a Norse thunder god with lightning hammer',
  pikachu: 'a cute small yellow electric creature',
  mario: 'a cheerful mustachioed plumber in red cap',
  sonic: 'a fast blue anthropomorphic hedgehog',
  'mickey mouse': 'a cheerful cartoon mouse with round ears',
  goku: 'a spiky-haired martial arts warrior with energy aura',
  naruto: 'a blond ninja warrior in orange outfit',
  'captain america': 'a patriotic super soldier with round shield',
  deadpool: 'a red masked anti-hero mercenary',
  wolverine: 'a fierce mutant warrior with metal claws',
  elsa: 'an ice queen with platinum blonde braid',
  shrek: 'a large friendly green ogre in a swamp',
  'buzz lightyear': 'a space ranger toy figure in white and green suit',
};

const QUALITY_TAGS = [
  'highly detailed',
  'professional quality',
  '8k resolution',
  'sharp focus',
  'studio lighting',
];

const EXISTING_QUALITY_MARKERS = [
  'detailed',
  '4k',
  '8k',
  'hd',
  'uhd',
  'high quality',
  'photorealistic',
  'hyperrealistic',
  'professional',
  'sharp',
  'resolution',
  'masterpiece',
  'best quality',
  'studio',
  'cinematic',
  'dramatic lighting',
];

const scanPrompt = (prompt) => {
  const lower = prompt.toLowerCase();
  const issues = [];

  for (const [category, patterns] of Object.entries(BLOCKED_PATTERNS)) {
    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (match) {
        issues.push({
          category,
          matched: match[0],
          severity: ['violence', 'nsfw', 'sensitive'].includes(category)
            ? 'hard'
            : 'soft',
        });
      }
    }
  }

  return {
    isClean: issues.length === 0,
    issues,
    hasHardBlock: issues.some((i) => i.severity === 'hard'),
    hasSoftBlock: issues.some((i) => i.severity === 'soft'),
  };
};

const applySimpleReplacements = (prompt) => {
  let result = prompt;
  for (const [original, replacement] of Object.entries(SAFE_ALTERNATIVES)) {
    const regex = new RegExp(
      `\\b${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'gi'
    );
    result = result.replace(regex, replacement);
  }
  return result;
};

const hasQualityMarkers = (prompt) => {
  const lower = prompt.toLowerCase();
  return EXISTING_QUALITY_MARKERS.some((m) => lower.includes(m));
};

const enhancePromptQuality = (prompt) => {
  if (hasQualityMarkers(prompt)) return prompt;
  const shuffled = [...QUALITY_TAGS].sort(() => 0.5 - Math.random());
  const tags = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));
  return `${prompt}, ${tags.join(', ')}`;
};

const aiRewritePrompt = async (originalPrompt, issues) => {
  const config = MODELS.speed;
  if (!config.apiKey) return null;

  const issueDescriptions = issues
    .map((i) => `"${i.matched}" (${i.category})`)
    .join(', ');

  try {
    const response = await axios({
      method: 'POST',
      url: config.endpoint,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        model: config.id,
        messages: [
          {
            role: 'system',
            content: `You are a prompt engineer for an AI image generator. Rewrite prompts to avoid content policy violations while preserving creative intent. NEVER include real people, copyrighted characters, brands, violence, or NSFW content. Output ONLY the rewritten prompt.`,
          },
          {
            role: 'user',
            content: `Flagged issues: ${issueDescriptions}\n\nOriginal: "${originalPrompt}"\n\nRewrite safely:`,
          },
        ],
        max_tokens: 300,
        temperature: 0.7,
        stream: false,
      },
      timeout: 30000,
    });

    const rewritten = response.data?.choices?.[0]?.message?.content?.trim();
    if (!rewritten || rewritten.length < 10) return null;

    return rewritten
      .replace(/^["']|["']$/g, '')
      .replace(/^Rewritten prompt:\s*/i, '')
      .trim();
  } catch (err) {
    console.error('❌ AI rewrite failed:', err.message);
    return null;
  }
};

const sanitizeImagePrompt = async (prompt) => {
  const original = prompt.trim();
  if (!original)
    return {
      sanitized: original,
      wasModified: false,
      blocked: true,
      reason: 'Empty prompt',
    };

  const scan = scanPrompt(original);

  if (scan.isClean) {
    const enhanced = enhancePromptQuality(original);
    return {
      sanitized: enhanced,
      wasModified: enhanced !== original,
      blocked: false,
      modifications: enhanced !== original ? ['Added quality tags'] : [],
    };
  }

  if (scan.hasHardBlock) {
    const categories = [
      ...new Set(
        scan.issues
          .filter((i) => i.severity === 'hard')
          .map((i) => i.category)
      ),
    ];
    const rewritten = await aiRewritePrompt(original, scan.issues);

    if (rewritten) {
      const reScan = scanPrompt(rewritten);
      if (reScan.isClean) {
        const enhanced = enhancePromptQuality(rewritten);
        return {
          sanitized: enhanced,
          wasModified: true,
          blocked: false,
          modifications: [
            'AI-rewritten to remove restricted content',
            'Quality enhanced',
          ],
          originalIssues: categories,
        };
      }
    }

    return {
      sanitized: `A creative artistic illustration, ${enhancePromptQuality(
        'vibrant colors, imaginative composition, digital art style'
      )}`,
      wasModified: true,
      blocked: false,
      modifications: [
        'Replaced with safe alternative due to content restrictions',
      ],
      originalIssues: categories,
      warning:
        'Your prompt contained restricted content and was significantly modified.',
    };
  }

  let working = applySimpleReplacements(original);
  const reScan = scanPrompt(working);

  if (reScan.isClean) {
    const enhanced = enhancePromptQuality(working);
    return {
      sanitized: enhanced,
      wasModified: true,
      blocked: false,
      modifications: [
        'Replaced copyrighted/branded references',
        'Quality enhanced',
      ],
    };
  }

  const rewritten = await aiRewritePrompt(original, scan.issues);
  if (rewritten) {
    const finalScan = scanPrompt(rewritten);
    if (finalScan.isClean) {
      const enhanced = enhancePromptQuality(rewritten);
      return {
        sanitized: enhanced,
        wasModified: true,
        blocked: false,
        modifications: [
          'AI-rewritten to remove flagged content',
          'Quality enhanced',
        ],
      };
    }
    const doubleFixed = applySimpleReplacements(rewritten);
    const enhanced = enhancePromptQuality(doubleFixed);
    return {
      sanitized: enhanced,
      wasModified: true,
      blocked: false,
      modifications: [
        'AI-rewritten + additional sanitization',
        'Quality enhanced',
      ],
    };
  }

  const enhanced = enhancePromptQuality(working);
  return {
    sanitized: enhanced,
    wasModified: working !== original,
    blocked: false,
    modifications: ['Applied text-level sanitization', 'Quality enhanced'],
  };
};

// ============================================
// STREAM: Text models
// ============================================
const streamTextModel = async (modelKey, messages, abortSignal) => {
  const config = MODELS[modelKey];
  if (!config) throw new Error(`Unknown model: ${modelKey}`);

  const systemPrompt =
    modelKey === 'vision'
      ? SYSTEM_PROMPTS.vision
      : modelKey === 'brain'
      ? SYSTEM_PROMPTS.thinking
      : SYSTEM_PROMPTS.default;

  const response = await axios({
    method: 'POST',
    url: config.endpoint,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    data: {
      model: config.id,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
      max_tokens: config.maxTokens,
      temperature: modelKey === 'brain' ? 0.7 : 0.8,
    },
    responseType: 'stream',
    signal: abortSignal,
    timeout: 120000,
  });

  return response.data;
};

// ============================================
// GENERATE IMAGE
// ============================================
const generateImage = async (prompt, abortSignal) => {
  const config = MODELS.image;
  if (!config.apiKey) throw new Error('NVIDIA_IMAGE_API_KEY is not configured');

  const sanitizeResult = await sanitizeImagePrompt(prompt);
  if (sanitizeResult.blocked)
    throw new Error(sanitizeResult.reason || 'Prompt was blocked');

  let sanitizedPrompt = sanitizeResult.sanitized;
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const seed = Math.floor(Math.random() * 2147483647);

    try {
      const response = await axios({
        method: 'POST',
        url: config.endpoint,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        data: {
          prompt: sanitizedPrompt,
          width: 1024,
          height: 1024,
          seed,
          steps: 4,
        },
        signal: abortSignal,
        timeout: 120000,
        validateStatus: () => true,
      });

      if (response.status === 422) {
        if (attempt === 1) {
          const rewrite = await aiRewritePrompt(sanitizedPrompt, [
            {
              category: 'guardrail',
              matched: 'content filter',
              severity: 'hard',
            },
          ]);
          if (rewrite) sanitizedPrompt = enhancePromptQuality(rewrite);
        }
        lastError = new Error('Content filter triggered');
        continue;
      }

      if (response.status === 401)
        throw new Error('Image API authentication failed.');
      if (response.status === 402)
        throw new Error('Image API credits exhausted.');
      if (response.status === 429)
        throw new Error('Rate limited. Please wait.');
      if (response.status !== 200) {
        lastError = new Error(`Image API returned ${response.status}`);
        continue;
      }

      const data = response.data;
      let base64 =
        data?.artifacts?.[0]?.base64 ||
        data?.artifacts?.[0]?.b64_json ||
        data?.data?.[0]?.b64_json ||
        data?.data?.[0]?.base64 ||
        data?.image ||
        data?.b64_json ||
        (typeof data === 'string' && data.length > 1000 ? data : null);

      if (!base64) {
        lastError = new Error('No image data in response');
        continue;
      }

      const imageUrl = base64.startsWith('data:image')
        ? base64
        : `data:image/png;base64,${base64}`;
      return { imageUrl, sanitization: sanitizeResult };
    } catch (err) {
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED')
        throw err;
      lastError = err;
    }
  }

  throw lastError || new Error('Image generation failed');
};

module.exports = {
  MODELS,
  streamTextModel,
  generateImage,
  resolveModel,
  routeWithAI,
  routeByKeywords,
  detectImageIntent,
  sanitizeImagePrompt,
  scanPrompt,
  isFollowUpMessage,
  buildRouterContext,
  estimateConversationComplexity,
};