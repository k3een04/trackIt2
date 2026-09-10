require('dotenv').config();
const { extractTheoriesFromNarrative } = require('./services/summaryService');

async function test() {
  console.log('Testing theory extraction via OpenRouter...');
  console.log('API Key:', process.env.OPENROUTER_API_KEY ? 'SET' : 'NOT SET');
  console.log('Model:', process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it (default)');

  try {
    const narrative =
      'Today I learned about Node.js and Express.js. I built a REST API endpoint and handled error cases. I also configured database indexes in MongoDB and reviewed SQL queries with my supervisor.';
    const theories = await extractTheoriesFromNarrative(narrative);
    console.log('✅ Success! Extracted theories:');
    console.log(JSON.stringify(theories, null, 2));
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

test();
