// OpenRouter API Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL = 'google/gemma-4-31b-it:free';

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

function initializeOpenRouter() {
  if (!OPENROUTER_API_KEY) {
    console.warn('OPENROUTER_API_KEY not set in environment variables');
    return false;
  }
  return true;
}

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
 * Extract IT theories and practices from OJT narrative using AI and curriculum mapping
 * @param {String} narrative - The trainee's journal narrative
 * @returns {Promise<Array>} Array of identified theories with course mapping
 */
async function extractTheoriesFromNarrative(narrative) {
  if (!narrative || narrative.trim().length === 0) {
    return [];
  }

  const localTheories = extractTheoriesLocally(narrative);
  if (!initializeOpenRouter()) {
    console.warn('[TheoryExtractionService] OpenRouter unavailable; using local curriculum matching');
    return localTheories;
  }

  try {

    const curriculumContext = JSON.stringify(BSIT_CURRICULUM, null, 2);

    const prompt = `You are an expert BSIT (Bachelor of Science in Information Technology) curriculum advisor. 
Analyze the following OJT (On-The-Job Training) journal entry and identify which IT theories, concepts, and practices were applied.

BSIT Curriculum Reference:
${curriculumContext}

Journal Narrative:
"${narrative}"

Your task:
1. Identify 2-5 key IT theories or practices mentioned or demonstrated in the narrative
2. For each theory, map it to one of the BSIT courses above
3. Return a JSON array with the following structure (return ONLY the JSON array, no other text):
[
  {
    "course": "CITE1003",
    "courseName": "Computer Programming",
    "category": "Software Development",
    "theory": "Used conditional statements to implement business logic"
  }
]

If no clear IT theories are identified, return an empty array: []

Remember: Be specific, match to actual curriculum courses, and extract real learning outcomes from the narrative.`;

    console.log('[TheoryExtractionService] Calling OpenRouter to extract theories');

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5000'),
        'X-Title': 'TrackIT Theory Extractor',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 2048,
        temperature: 0.5, // Lower temperature for more consistent structured output
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();

    if (!data.choices || data.choices.length === 0) {
      throw new Error('Invalid response structure from OpenRouter');
    }

    const messageContent = data.choices[0].message.content;
    const responseText = Array.isArray(messageContent)
      ? messageContent.map((part) => part.text || '').join('')
      : messageContent;
    if (!responseText) {
      throw new Error('Empty response text from OpenRouter');
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
  initializeOpenRouter,
  summarizeText, // deprecated
  extractTheoriesFromNarrative,
  extractTheoriesLocally,
  BSIT_CURRICULUM,
};

