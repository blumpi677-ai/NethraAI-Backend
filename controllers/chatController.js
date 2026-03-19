const Conversation = require('../models/Chat');
const axios = require('axios');
const {
  streamTextModel,
  generateImage,
  resolveModel,
  MODELS,
  isFollowUpMessage,
  estimateConversationComplexity,
} = require('../services/nvidiaService');
const {
  detectSearchIntent,
  searchWeb,
  buildSearchContext,
} = require('../services/webSearchService');

// ============================================
// GET CONVERSATIONS
// ============================================
const getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({ userId: req.user.id })
      .select('title lastMode createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
    return res.json({ conversations });
  } catch (error) {
    console.error('Get Conversations Error:', error);
    return res.status(500).json({ message: 'Failed to load conversations' });
  }
};

// ============================================
// GET SINGLE CONVERSATION
// ============================================
const getConversation = async (req, res) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      userId: req.user.id,
    }).lean();
    if (!conversation)
      return res.status(404).json({ message: 'Conversation not found' });
    return res.json({ conversation });
  } catch (error) {
    console.error('Get Conversation Error:', error);
    return res.status(500).json({ message: 'Failed to load conversation' });
  }
};

// ============================================
// DELETE CONVERSATION
// ============================================
const deleteConversation = async (req, res) => {
  try {
    const result = await Conversation.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!result)
      return res.status(404).json({ message: 'Conversation not found' });
    return res.json({ message: 'Conversation deleted' });
  } catch (error) {
    console.error('Delete Conversation Error:', error);
    return res.status(500).json({ message: 'Failed to delete conversation' });
  }
};

// ============================================
// RENAME CONVERSATION
// ============================================
const renameConversation = async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim())
      return res.status(400).json({ message: 'Title is required' });

    const conversation = await Conversation.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { title: title.trim().slice(0, 100) },
      { new: true }
    );
    if (!conversation)
      return res.status(404).json({ message: 'Conversation not found' });

    return res.json({
      conversation: { _id: conversation._id, title: conversation.title },
    });
  } catch (error) {
    console.error('Rename Conversation Error:', error);
    return res.status(500).json({ message: 'Failed to rename conversation' });
  }
};

// ============================================
// SEND MESSAGE — Context-Aware with Web Search
// ============================================
const sendMessage = async (req, res) => {
  let nvidiaAbort = null;
  let isClosed = false;
  let flushTimer = null;

  req.on('close', () => {
    isClosed = true;
    if (nvidiaAbort) nvidiaAbort.abort();
    if (flushTimer) clearInterval(flushTimer);
  });

  try {
    const { conversationId, prompt, mode = 'normal', image } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ message: 'Prompt is required' });
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (data) => {
      if (!isClosed) {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          isClosed = true;
        }
      }
    };

    // Load or create conversation
    let conversation;
    if (conversationId) {
      conversation = await Conversation.findOne({
        _id: conversationId,
        userId: req.user.id,
      });
    }

    if (!conversation) {
      conversation = new Conversation({
        userId: req.user.id,
        title:
          prompt.trim().slice(0, 60) + (prompt.length > 60 ? '...' : ''),
        messages: [],
        lastMode: mode,
      });
    }

    // ── Capture existing conversation history BEFORE adding new message ──
    // This is what we pass to the router for context-aware routing
    const existingHistory = [...conversation.messages];

    // Add user message
    conversation.messages.push({
      role: 'user',
      content: prompt.trim(),
      mode,
      imageUrl: image || '',
      timestamp: new Date(),
    });
    conversation.lastMode = mode;

    // ── AI-POWERED MODEL ROUTING (context-aware) ──
    if (mode === 'normal') {
      sendEvent({ type: 'routing', status: 'analyzing' });
    }

    const hasImage = !!image;

    // Pass existing conversation history to the resolver
    // so it can route follow-ups to the right model
    const { modelKey, intent, routedBy } = await resolveModel(
      mode,
      prompt,
      hasImage,
      existingHistory
    );
    const modelId = MODELS[modelKey]?.id || 'unknown';

    // Detect if this is a follow-up for logging
    const isFollowUp =
      existingHistory.length > 0 && isFollowUpMessage(prompt.trim());
    if (isFollowUp) {
      console.log(
        `🔄 Follow-up detected: "${prompt.slice(0, 40)}..." → ${modelKey} (conversation has ${existingHistory.length} prior messages)`
      );
    }

    sendEvent({ type: 'model', model: modelKey, modelId, routedBy });

    // ============================================
    // IMAGE GENERATION
    // ============================================
    if (intent === 'generate') {
      try {
        nvidiaAbort = new AbortController();
        sendEvent({ type: 'token', token: '🎨 Preparing your image...' });

        const result = await generateImage(prompt.trim(), nvidiaAbort.signal);
        if (isClosed) return;

        let responseText = 'Here is your generated image:';
        if (result.sanitization?.wasModified) {
          if (result.sanitization.warning) {
            responseText = `⚠️ ${result.sanitization.warning}\n\nHere is the generated image:`;
          } else if (result.sanitization.modifications?.length) {
            responseText =
              '✨ Your prompt was optimized for best results.\n\nHere is your generated image:';
          }
        }

        sendEvent({ type: 'clear' });

        conversation.messages.push({
          role: 'assistant',
          content: responseText,
          mode,
          model: modelId,
          imageUrl: result.imageUrl,
          timestamp: new Date(),
        });
        await conversation.save();

        sendEvent({ type: 'image', imageUrl: result.imageUrl });
        sendEvent({ type: 'token', token: responseText });
        sendEvent({
          type: 'done',
          conversationId: conversation._id,
          model: modelKey,
        });
        return res.end();
      } catch (err) {
        if (isClosed) return;
        let errorMsg = 'Failed to generate image. ';
        if (err.message.includes('authentication'))
          errorMsg += 'API key issue.';
        else if (err.message.includes('credits'))
          errorMsg += 'API credits exhausted.';
        else if (err.message.includes('Rate limited'))
          errorMsg += 'Too many requests.';
        else if (err.message.includes('content filter'))
          errorMsg += 'Content restrictions.';
        else errorMsg += 'Please try again.';
        sendEvent({ type: 'error', message: errorMsg });
        return res.end();
      }
    }

    // ============================================
    // WEB SEARCH — detect + execute if needed
    // ============================================
    let searchContext = null;

    if (intent === 'chat' && mode !== 'image') {
      const searchIntent = detectSearchIntent(prompt.trim());

      if (searchIntent.needsSearch) {
        console.log(
          `🔍 Search triggered (${searchIntent.reason}): "${searchIntent.searchQuery?.slice(0, 50)}..."`
        );

        sendEvent({
          type: 'searching',
          query: searchIntent.searchQuery,
        });

        const searchResults = await searchWeb(searchIntent.searchQuery);

        if (searchResults) {
          searchContext = buildSearchContext(
            searchResults,
            searchIntent.searchQuery
          );

          sendEvent({
            type: 'searchDone',
            hasResults: true,
          });
        } else {
          sendEvent({
            type: 'searchDone',
            hasResults: false,
          });
        }
      }
    }

    // ============================================
    // TEXT STREAMING — Context-Aware Message Building
    // ============================================

    // ── Smart history window ──
    // For follow-ups or complex conversations, include more history
    const conversationComplexity =
      estimateConversationComplexity(existingHistory);
    const historyLimit =
      conversationComplexity === 'complex'
        ? 30
        : conversationComplexity === 'moderate'
        ? 24
        : 20;

    const recentMessages = conversation.messages
      .filter((m) => m.role !== 'system')
      .slice(-historyLimit)
      .map((m) => {
        if (m.role === 'user' && m.imageUrl && modelKey === 'vision') {
          return {
            role: 'user',
            content: [
              { type: 'text', text: m.content },
              { type: 'image_url', image_url: { url: m.imageUrl } },
            ],
          };
        }
        return { role: m.role, content: m.content };
      });

    // ── Inject context-awareness hint for follow-up messages ──
    // This nudges the AI to explicitly connect to prior conversation
    if (
      existingHistory.length > 0 &&
      isFollowUp &&
      recentMessages.length > 1
    ) {
      const lastAssistantMsg = existingHistory
        .filter((m) => m.role === 'assistant')
        .slice(-1)[0];

      const contextHint = lastAssistantMsg
        ? `CONTEXT: The user's next message is a follow-up to this conversation. Your most recent response discussed: "${(lastAssistantMsg.content || '').slice(0, 200)}${(lastAssistantMsg.content || '').length > 200 ? '...' : ''}". Address their follow-up in direct relation to what was discussed. Don't restart explanations from scratch — build upon what you already said.`
        : `CONTEXT: The user's next message is a follow-up to this conversation. Reference the prior messages and respond in context.`;

      // Insert just before the last user message
      const lastIdx = recentMessages.length - 1;
      recentMessages.splice(lastIdx, 0, {
        role: 'system',
        content: contextHint,
      });
    }

    // ── Inject search context ──
    if (searchContext) {
      const lastUserMsgIndex = recentMessages.length - 1;
      recentMessages.splice(lastUserMsgIndex, 0, {
        role: 'system',
        content: searchContext,
      });
    }

    let fullResponse = '';

    try {
      nvidiaAbort = new AbortController();
      const stream = await streamTextModel(
        modelKey,
        recentMessages,
        nvidiaAbort.signal
      );

      let parseBuffer = '';
      let tokenBuffer = '';
      let tokenCount = 0;
      let lastFlushTime = Date.now();
      const FLUSH_INTERVAL = 30;
      const FLUSH_THRESHOLD = 5;

      const flushTokenBuffer = () => {
        if (tokenBuffer && !isClosed) {
          sendEvent({ type: 'token', token: tokenBuffer });
          tokenBuffer = '';
          tokenCount = 0;
          lastFlushTime = Date.now();
        }
      };

      flushTimer = setInterval(() => {
        if (tokenBuffer) flushTokenBuffer();
      }, FLUSH_INTERVAL);

      stream.on('data', (chunk) => {
        if (isClosed) {
          stream.destroy();
          return;
        }

        parseBuffer += chunk.toString();
        const lines = parseBuffer.split('\n');
        parseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              fullResponse += token;
              tokenBuffer += token;
              tokenCount++;
              if (
                tokenCount >= FLUSH_THRESHOLD ||
                Date.now() - lastFlushTime >= FLUSH_INTERVAL
              ) {
                flushTokenBuffer();
              }
            }
          } catch {}
        }
      });

      await new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      if (isClosed) return;

      if (parseBuffer.trim()) {
        const remaining = parseBuffer.trim();
        if (
          remaining.startsWith('data: ') &&
          remaining.slice(6) !== '[DONE]'
        ) {
          try {
            const token = JSON.parse(remaining.slice(6)).choices?.[0]?.delta
              ?.content;
            if (token) {
              fullResponse += token;
              tokenBuffer += token;
            }
          } catch {}
        }
      }

      flushTokenBuffer();

      conversation.messages.push({
        role: 'assistant',
        content: fullResponse,
        mode,
        model: modelId,
        timestamp: new Date(),
      });
      await conversation.save();

      sendEvent({
        type: 'done',
        conversationId: conversation._id,
        model: modelKey,
      });
      return res.end();
    } catch (err) {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }

      if (
        isClosed ||
        err.name === 'CanceledError' ||
        err.code === 'ERR_CANCELED'
      ) {
        if (fullResponse) {
          conversation.messages.push({
            role: 'assistant',
            content: fullResponse + '\n\n*[Response interrupted]*',
            mode,
            model: modelId,
            timestamp: new Date(),
          });
          await conversation.save().catch(() => {});
        }
        return;
      }
      console.error('Stream Error:', err.message);
      sendEvent({
        type: 'error',
        message: 'An error occurred while generating the response.',
      });
      return res.end();
    }
  } catch (error) {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    console.error('Send Message Error:', error);
    if (!isClosed) {
      try {
        if (!res.headersSent)
          return res.status(500).json({ message: 'Server error' });
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: 'Server error',
          })}\n\n`
        );
        res.end();
      } catch {}
    }
  }
};

// ============================================
// ENHANCE PROMPT — ULTIMATE VERSION
// ============================================
const enhancePrompt = async (req, res) => {
  try {
    const { prompt, mode } = req.body;
    if (!prompt || !prompt.trim())
      return res.status(400).json({ message: 'Prompt is required' });

    const config = MODELS.speed;
    if (!config.apiKey)
      return res
        .status(500)
        .json({ message: 'Enhancement service unavailable' });

    const strategies = {
      image: {
        system: `You are a world-class AI image prompt architect. Transform basic descriptions into breathtaking, hyper-detailed prompts that produce gallery-worthy visuals.

MANDATORY ENHANCEMENT LAYERS — apply ALL of these:

1. SUBJECT REFINEMENT: Sharpen the main subject with precise descriptors — species, material, texture, posture, expression, clothing details, age, condition.
2. ENVIRONMENT & SETTING: Ground the scene — location, terrain, architecture, vegetation, surrounding objects, background elements, foreground interest.
3. LIGHTING DESIGN: Specify exact lighting — golden hour, blue hour, volumetric god rays, rim lighting, Rembrandt lighting, neon glow, bioluminescence, caustics, dappled light through foliage.
4. COLOR PALETTE: Name specific colors — cerulean, vermilion, burnt sienna, iridescent, chromatic aberration, complementary color scheme, split-toning.
5. ATMOSPHERE & MOOD: Weather, particles, fog, mist, rain, dust motes, bokeh, lens flare, smoke, fireflies, aurora.
6. COMPOSITION & CAMERA: Angle (low angle, bird's eye, Dutch tilt), lens (85mm portrait, 14mm ultra-wide, macro, tilt-shift), depth of field, rule of thirds, leading lines, symmetry.
7. ART STYLE: Specify medium — hyperrealistic photography, oil painting impasto, Studio Ghibli watercolor, cyberpunk concept art, Renaissance chiaroscuro, Art Nouveau, vaporwave, ukiyo-e.
8. TECHNICAL QUALITY: 8K UHD, octane render, unreal engine 5, ray tracing, subsurface scattering, photogrammetry, HDR, ACES filmic tone mapping.

STRICT RULES:
- NEVER include real people, celebrities, copyrighted characters, brand names, NSFW, violence
- NEVER explain or prefix — output ONLY the enhanced prompt
- Preserve the user's core creative vision
- Maximum 180 words
- Write as a single flowing description, not a tag list
- Make every word count — no filler`,
        temperature: 0.85,
        maxTokens: 600,
      },
      thinking: {
        system: `You are an expert prompt strategist for deep-reasoning AI systems. Your job is to transform simple questions into comprehensive, structured prompts that extract maximum insight and depth.

ENHANCEMENT FRAMEWORK:
1. CONTEXT INJECTION: Add relevant domain context the AI should consider
2. SCOPE DEFINITION: Specify breadth and depth
3. STRUCTURE REQUEST: Specify output format — step-by-step analysis, comparison matrix, pros/cons table, decision framework
4. PERSPECTIVE DIVERSITY: Ask for multiple viewpoints — technical, practical, historical, contrarian
5. EVIDENCE & EXAMPLES: Request concrete examples, case studies, analogies
6. EDGE CASES: Ask about limitations, caveats, trade-offs, common misconceptions
7. ACTIONABILITY: Request practical takeaways, next steps, or implementation guidance

RULES:
- Preserve the original question's intent exactly
- Don't bloat simple factual questions — only enhance where depth adds value
- Output ONLY the enhanced prompt, no explanations, no quotes
- Keep under 150 words
- Use natural language, not robotic template-speak`,
        temperature: 0.65,
        maxTokens: 500,
      },
      fast: {
        system: `You are a prompt precision engineer. Make prompts crystal-clear for fast, accurate AI responses.

RULES:
1. Eliminate ALL ambiguity
2. Add format hint: (one sentence / bullet list / yes-no / number / code snippet)
3. Add scope constraint if open-ended
4. If asking about code: specify language, version, and constraints
5. PRESERVE original intent — never add fluff
6. Output ONLY the enhanced prompt
7. Keep it concise — under 80 words`,
        temperature: 0.5,
        maxTokens: 250,
      },
      normal: {
        system: `You are a prompt clarity architect. Upgrade vague or basic prompts into clear, specific, well-structured messages that get excellent AI responses.

ENHANCEMENT CHECKLIST:
1. CLARIFY: Resolve any vague words ("it", "this", "stuff", "things")
2. SPECIFY: Add what format/length/depth is wanted if unclear
3. CONTEXT: Add domain context if the prompt is too bare
4. CONSTRAINTS: Add useful boundaries (audience level, word count, focus area)
5. STRUCTURE: If complex, suggest the AI organize its response
6. INTENT: Make the actual goal explicit if it's only implied

RULES:
- Don't over-engineer simple greetings or trivial questions
- If the prompt is already excellent, make only minor refinements
- Output ONLY the enhanced prompt, no meta-commentary
- Keep natural conversational tone
- Under 120 words`,
        temperature: 0.6,
        maxTokens: 350,
      },
    };

    const strategy = strategies[mode] || strategies.normal;

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
          { role: 'system', content: strategy.system },
          {
            role: 'user',
            content: `Enhance this prompt:\n\n${prompt.trim()}`,
          },
        ],
        max_tokens: strategy.maxTokens,
        temperature: strategy.temperature,
        stream: false,
      },
      timeout: 30000,
    });

    let enhanced = response.data?.choices?.[0]?.message?.content?.trim();
    if (!enhanced || enhanced.length < 5)
      return res
        .status(500)
        .json({ message: 'Enhancement produced no result' });

    enhanced = enhanced
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(
        /^(improved|enhanced|here'?s?|output|result|prompt)\s*:?\s*/i,
        ''
      )
      .replace(/^(rewritten|optimized|upgraded)\s*:?\s*/i, '')
      .trim();

    if (mode === 'image' && enhanced.length > 20) {
      const qualityTerms = [
        '8k',
        '4k',
        'uhd',
        'detailed',
        'resolution',
        'render',
        'photorealistic',
        'hyperrealistic',
        'unreal engine',
        'octane',
        'ray tracing',
        'masterpiece',
        'professional',
        'studio',
      ];
      const hasQuality = qualityTerms.some((t) =>
        enhanced.toLowerCase().includes(t)
      );
      if (!hasQuality) {
        const qualityBoost = [
          'highly detailed',
          '8K resolution',
          'professional quality',
          'sharp focus',
        ];
        const pick = qualityBoost
          .sort(() => 0.5 - Math.random())
          .slice(0, 2)
          .join(', ');
        enhanced = `${enhanced}, ${pick}`;
      }
    }

    return res.json({ enhanced, mode: mode || 'normal' });
  } catch (error) {
    console.error('Enhance Prompt Error:', error.message);
    return res.status(500).json({ message: 'Failed to enhance prompt.' });
  }
};

// ============================================
// TRANSLATE TEXT — for voice auto-translation
// ============================================
const translateText = async (req, res) => {
  try {
    const { text, sourceLang } = req.body;
    if (!text || !text.trim())
      return res.status(400).json({ message: 'Text is required' });

    const trimmed = text.trim();

    const asciiChars = trimmed.replace(/[^\x00-\x7F]/g, '').length;
    const asciiRatio = asciiChars / trimmed.length;
    if (asciiRatio > 0.92 && /^[a-zA-Z]/.test(trimmed)) {
      return res.json({ translated: trimmed, wasTranslated: false });
    }

    const config = MODELS.speed;
    if (!config.apiKey)
      return res.json({ translated: trimmed, wasTranslated: false });

    const langHint = sourceLang
      ? ` The source language is likely ${sourceLang}.`
      : '';

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
            content: `You are a precise translator. Translate the user's text into natural, fluent English.${langHint}

RULES:
- If the text is already in English, return it exactly as-is
- Preserve the original meaning, tone, and intent
- Use natural English phrasing, not word-for-word translation
- Preserve any technical terms, proper nouns, or code
- Output ONLY the translated text — no quotes, no "Translation:", no explanations
- If the text mixes languages, translate non-English parts and keep English parts`,
          },
          { role: 'user', content: trimmed },
        ],
        max_tokens: 600,
        temperature: 0.2,
        stream: false,
      },
      timeout: 15000,
    });

    let translated = response.data?.choices?.[0]?.message?.content?.trim();
    if (!translated)
      return res.json({ translated: trimmed, wasTranslated: false });

    translated = translated
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^["']+|["']+$/g, '')
      .replace(/^(translation|translated|in english|english)\s*:?\s*/i, '')
      .replace(/^(here'?s?\s*(the)?\s*translation\s*:?\s*)/i, '')
      .trim();

    const wasTranslated =
      translated.toLowerCase() !== trimmed.toLowerCase() &&
      translated.length > 0;

    return res.json({
      translated,
      wasTranslated,
      originalText: wasTranslated ? trimmed : undefined,
      detectedLang: sourceLang || undefined,
    });
  } catch (error) {
    console.error('Translate Error:', error.message);
    return res.json({ translated: text.trim(), wasTranslated: false });
  }
};

module.exports = {
  getConversations,
  getConversation,
  deleteConversation,
  renameConversation,
  sendMessage,
  enhancePrompt,
  translateText,
};