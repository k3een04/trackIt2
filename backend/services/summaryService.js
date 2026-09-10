// Google Generative AI SDK Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// BSIT Curriculum Knowledge Base
const BSIT_CURRICULUM = {
  'Software Development': [
    {
      course: 'CITE1003/1006',
      courseName: 'Computer Programming',
      keywords: ['programming', 'coding', 'variables', 'functions', 'loops', 'conditionals', 'algorithms', 'debugging'],
    },
    {
      course: 'COSC1003',
      courseName: 'Data Structures & Algorithms',
      keywords: ['array', 'linked list', 'tree', 'graph', 'sorting', 'searching', 'hash', 'complexity', 'recursion'],
    },
    {
      course: 'INTE1044',
      courseName: 'Object-Oriented Programming',
      keywords: ['class', 'inheritance', 'polymorphism', 'encapsulation', 'abstraction', 'object', 'method', 'property'],
    },
    {
      course: 'INTE1083/1084',
      courseName: 'Web/Mobile Systems',
      keywords: ['web', 'mobile', 'frontend', 'backend', 'api', 'responsive', 'user interface', 'framework'],
    },
  ],
  'Systems & Architecture': [
    {
      course: 'CITE1011',
      courseName: 'Information Management',
      keywords: ['database', 'data management', 'sql', 'query', 'schema', 'indexing', 'backup', 'recovery'],
    },
    {
      course: 'INTE1021/1056',
      courseName: 'Systems Integration and Architecture',
      keywords: ['architecture', 'system design', 'integration', 'microservices', 'cloud', 'scalability', 'performance'],
    },
    {
      course: 'INTE1006',
      courseName: 'Systems Administration',
      keywords: ['server', 'administration', 'maintenance', 'user management', 'permissions', 'deployment', 'monitoring'],
    },
  ],
  'Networking & Infrastructure': [
    {
      course: 'INTE1005/1030',
      courseName: 'Network Technology',
      keywords: ['network', 'tcp/ip', 'routing', 'switching', 'wan', 'lan', 'bandwidth', 'protocol', 'firewall'],
    },
    {
      course: 'INTE1025',
      courseName: 'Data Communications',
      keywords: ['communication', 'transmission', 'signal', 'bandwidth', 'latency', 'throughput', 'modulation', 'encoding'],
    },
  ],
  'Security & Assurance': [
    {
      course: 'INSY1010',
      courseName: 'Information Assurance and Security',
      keywords: ['security', 'encryption', 'authentication', 'authorization', 'vulnerability', 'threat', 'cyber', 'compliance'],
    },
    {
      course: 'INSY1005',
      courseName: 'Data Privacy',
      keywords: ['privacy', 'gdpr', 'data protection', 'consent', 'confidentiality', 'pii', 'legal', 'regulation'],
    },
  ],
  'Management & Design': [
    {
      course: 'INTE1039',
      courseName: 'IT Service Management',
      keywords: ['service', 'itsm', 'incident', 'change management', 'support', 'ticketing', 'helpdesk', 'sla'],
    },
    {
      course: 'COSC1007',
      courseName: 'Human-Computer Interaction',
      keywords: ['ui', 'ux', 'usability', 'design', 'interface', 'accessibility', 'user experience', 'interaction'],
    },
    {
      course: 'INTE1020',
      courseName: 'Quantitative Methods',
      keywords: ['analytics', 'statistics', 'metrics', 'measurement', 'data analysis', 'reporting', 'decision making'],
    },
  ],
};

/**
 * Check whether the OpenRouter API is available/initialized
 */
function initializeGoogleAI() {
  if (!OPENROUTER_API_KEY) {
    console.warn('OPENROUTER_API_KEY not set in environment variables');
    return false;
  }
  return true;
}

/**
 * Extract IT theories and practices from OJT narrative using keyword matching
 * @param {String} narrative - The trainee's journal narrative
 * @returns {Array} Array of identified theories with course mapping
 */
function extractTheoriesLocally(narrative) {
  const normalizedNarrative = String(narrative).toLowerCase();
  const matches = [];

  Object.entries(BSIT_CURRICULUM).forEach(([category, courses]) => {
    courses.forEach((course) => {
      const matchedKeywords = course.keywords.filter((keyword) =>
        normalizedNarrative.includes(keyword.toLowerCase())
      );

      if (matchedKeywords.length > 0) {
        matches.push({
          course: course.course,
          courseName: course.courseName,
          category,
          theory: `Applied ${matchedKeywords.slice(0, 3).join(', ')} in the OJT activity`,
          matchCount: matchedKeywords.length,
        });
      }
    });
  });

  return matches
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, 5)
    .map(({ matchCount, ...theory }) => theory);
}

/**
 * @deprecated Use extractTheoriesFromNarrative instead
 * Legacy function for backward compatibility
 */
async function summarizeText(text, maxLength = 50, concepts = []) {
  console.warn('[SummaryService] summarizeText() is deprecated. Use extractTheoriesFromNarrative() instead.');
  return extractTheoriesFromNarrative(text);
}

/**
 * Call OpenRouter to generate a completion for the given prompt
 * @param {String} prompt
 * @returns {Promise<String>} The model's response text
 */
async function callOpenRouter(prompt, maxTokens) {
  const budget = maxTokens || parseInt(process.env.OPENROUTER_MAX_TOKENS, 10) || 512;
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5000',
      'X-Title': 'TrackIt3 OJT Journal',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'You are an expert BSIT (Bachelor of Science in Information Technology) curriculum advisor. Always respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: budget,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const responseText = data?.choices?.[0]?.message?.content;
  if (!responseText) {
    throw new Error('Empty response text from OpenRouter');
  }
  return responseText;
}

/**
 * Extract IT theories and practices from OJT narrative using OpenRouter AI
 * @param {String} narrative - The trainee's journal narrative
 * @returns {Promise<Array>} Array of identified theories with course mapping
 */
async function extractTheoriesFromNarrative(narrative) {
  if (!narrative || narrative.trim().length === 0) {
    return [];
  }

  const localTheories = extractTheoriesLocally(narrative);
  if (!initializeGoogleAI()) {
    console.warn('[TheoryExtractionService] OpenRouter unavailable; using local curriculum matching');
    return localTheories;
  }

  try {
    // Compact curriculum context to keep prompt tokens low (critical for low-credit accounts)
    const compactCurriculum = {};
    Object.entries(BSIT_CURRICULUM).forEach(([category, courses]) => {
      compactCurriculum[category] = courses.map((c) => ({
        course: c.course,
        courseName: c.courseName,
        keywords: c.keywords.slice(0, 3),
      }));
    });
    const curriculumContext = JSON.stringify(compactCurriculum);

    const prompt = `Analyze this OJT journal narrative and identify IT theories/practices applied, mapped to BSIT courses below.

Courses: ${curriculumContext}

Narrative: "${narrative}"

Identify 2-5 theories. Return ONLY a JSON array (no other text):
[{"course":"CITE1003","courseName":"Computer Programming","category":"Software Development","theory":"brief specific description"}]

Return [] if none identified.`;

    console.log(`[TheoryExtractionService] Calling OpenRouter (${OPENROUTER_MODEL}) to extract theories`);

    let responseText;
    try {
      responseText = await callOpenRouter(prompt);
    } catch (firstError) {
      // If credits limit the completion budget, retry once with the affordable token count
      const affordMatch = (firstError.message || '').match(/can only afford (\d+)/);
      if (affordMatch) {
        const affordable = Math.max(64, parseInt(affordMatch[1], 10) - 10);
        console.warn(`[TheoryExtractionService] 402 credit limit; retrying with max_tokens=${affordable}`);
        responseText = await callOpenRouter(prompt, affordable);
      } else {
        throw firstError;
      }
    }

    if (!responseText) {
      throw new Error('Empty response text from Google GenAI');
    }

    // Parse JSON response
    let theories = [];
    try {
      // Extract JSON from response (in case AI adds extra text)
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        theories = JSON.parse(jsonMatch[0]);
      } else {
        theories = JSON.parse(responseText);
      }
    } catch (parseError) {
      console.warn('[TheoryExtractionService] Failed to parse AI response as JSON:', responseText);
      return [];
    }

    if (!Array.isArray(theories)) {
      console.warn('[TheoryExtractionService] AI response is not an array');
      return [];
    }

    console.log(`[TheoryExtractionService] Successfully extracted ${theories.length} theories`);
    return theories;
  } catch (error) {
    console.error('[TheoryExtractionService] Error extracting theories:', error.message);
    console.warn('[TheoryExtractionService] Falling back to local curriculum matching');
    return localTheories;
  }
}

module.exports = {
  initializeGoogleAI,
  summarizeText, // deprecated
  extractTheoriesFromNarrative,
  extractTheoriesLocally,
  BSIT_CURRICULUM,
};

