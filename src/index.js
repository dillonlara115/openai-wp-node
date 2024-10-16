require('dotenv').config();
const express = require('express');
const { Configuration, OpenAIApi } = require('openai');
const axios = require('axios');

const app = express();
const port = 3000;

// Middleware to parse JSON requests
app.use(express.json());

// Endpoint to handle requests from the WordPress plugin
app.post('/api/send-message', async (req, res) => {
  try {
    const { message, assistantId, threadId, apiKeyName } = req.body;

    // Ensure required fields are provided
    if (!message || !assistantId || !apiKeyName) {
      return res.status(400).json({ error: 'Missing required fields: message, assistantId, or apiKeyName' });
    }

    // Retrieve the API key from WordPress plugin
    let apiKey;
    try {
      const response = await axios.post('https://your-wordpress-site.com/wp-admin/admin-ajax.php', new URLSearchParams({
        action: 'gpt_chat_get_api_key',
        api_key_name: apiKeyName
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      if (response.data && response.data.success) {
        apiKey = response.data.api_key;
      } else {
        throw new Error('API key not found.');
      }
    } catch (error) {
      return res.status(500).json({ error: 'Failed to retrieve API key from WordPress plugin.' });
    }

    // Set up OpenAI configuration with the retrieved API key
    const configuration = new Configuration({
      apiKey,
    });
    const openai = new OpenAIApi(configuration);

    // Set headers for streaming response
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Create or continue thread
    let currentThreadId = threadId;
    if (!currentThreadId) {
      const thread = await openai.createThread({});
      currentThreadId = thread.data.id;
      res.write(JSON.stringify({ status: 'thread_created', threadId: currentThreadId }) + '\n');
    }

    // Add user message to the thread
    await openai.createMessage(currentThreadId, {
      role: 'user',
      content: message,
    });

    // Create a new run
    const run = await openai.createRun(currentThreadId, { assistant_id: assistantId });
    res.write(JSON.stringify({ status: 'run_created', runId: run.data.id }) + '\n');

    // Poll run status
    let attempts = 0;
    const maxAttempts = 60;
    while (attempts < maxAttempts) { 
      const runStatus = await openai.retrieveRun(currentThreadId, run.data.id);
      res.write(JSON.stringify({ status: runStatus.data.status }) + '\n');

      if (runStatus.data.status === 'completed') {
        // Retrieve the assistant's response
        const messages = await openai.listMessages(currentThreadId, {
          limit: 1,
          order: 'desc',
        });

        if (messages.data && messages.data.length > 0 && messages.data[0].role === 'assistant') {
          const content = messages.data[0].content;
          res.write(JSON.stringify({ type: 'message', content }) + '\n');
        }
        break;
      } else if (['failed', 'cancelled', 'expired'].includes(runStatus.data.status)) {
        throw new Error(`Run failed with status: ${runStatus.data.status}`);
      }

      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 0.5 seconds
    }

    if (attempts >= maxAttempts) {
      throw new Error('Run did not complete within the expected time.');
    }

    // End response stream
    res.end();
  } catch (error) {
    res.write(JSON.stringify({ error: `Error communicating with OpenAI: ${error.message}` }) + '\n');
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});