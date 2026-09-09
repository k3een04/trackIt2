require('dotenv').config();
const { summarizeText } = require('./services/summaryService');

async function test() {
  console.log('Testing summarization with OpenRouter (Gemma 4 31B)...');
  console.log('API Key:', process.env.OPENROUTER_API_KEY ? 'SET' : 'NOT SET');
  
  try {
    const testText = 'Today I learned about Node.js and Express.js. I built a REST API endpoint and handled error cases. I also learned about middleware and how to structure a backend application properly.';
    const summary = await summarizeText(testText);
    console.log('✅ Success!');
    console.log('Summary:', summary);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Full error:', error);
  }
}

test();
