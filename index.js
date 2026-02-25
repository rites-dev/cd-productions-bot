// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PPLX_API_KEY = process.env.PPLX_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Simple in-memory store; replace with a real DB later if you want
const savedFiles = [];

// Call Perplexity (Chat Completions API)
async function askPerplexity(prompt) {
  const url = 'https://api.perplexity.ai/chat/completions'; // correct endpoint[web:129][web:222]

  const headers = {
  Authorization: `Bearer ${PPLX_API_KEY}`,
  'Content-Type': 'application/json',
};


  const data = {
    model: 'sonar', // valid Perplexity chat model[web:129][web:126]
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt },
    ],
  };

  try {
    const res = await axios.post(url, data, { headers });
    console.log('Perplexity raw data:', JSON.stringify(res.data, null, 2));
    return res.data.choices?.[0]?.message?.content || 'No response from Perplexity.';
  } catch (err) {
    console.error(
      'Perplexity error:',
      err.response?.data || err.response?.status || err.message || err
    );
    throw err;
  }
}

// Send a message to Telegram
async function sendTelegramMessage(chatId, text) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
    });
    console.log('Telegram send response:', res.data);
  } catch (err) {
    console.error('Telegram send error:', err.response?.data || err.message || err);
    throw err;
  }
}

// Download a Telegram file and save it locally
async function downloadAndSaveTelegramFile(fileId, originalFileName = 'file.bin') {
  try {
    const getFileUrl = `${TELEGRAM_API}/getFile`;
    const fileInfoRes = await axios.get(getFileUrl, {
      params: { file_id: fileId },
    });

    if (!fileInfoRes.data.ok) {
      throw new Error('getFile failed: ' + JSON.stringify(fileInfoRes.data));
    }

    const filePath = fileInfoRes.data.result.file_path;
    console.log('Telegram file_path:', filePath);

    const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    console.log('Download URL:', downloadUrl);

    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir);
    }

    const ext = path.extname(filePath) || path.extname(originalFileName) || '';
    const baseName = path.basename(originalFileName, ext) || 'file';
    const localFileName = `${baseName}-${Date.now()}${ext}`;
    const localFilePath = path.join(downloadsDir, localFileName);

    const response = await axios.get(downloadUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(localFilePath);

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log('Saved file to:', localFilePath);
    return localFilePath;
  } catch (err) {
    console.error(
      'downloadAndSaveTelegramFile error:',
      err.response?.data || err.message || err
    );
    throw err;
  }
}

// Webhook endpoint for Telegram
app.post('/webhook', async (req, res) => {
  try {
    console.log('Incoming update:', JSON.stringify(req.body, null, 2));

    const update = req.body;

    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;

      if (msg.document) {
        const doc = msg.document;
        const fileId = doc.file_id;
        const fileName = doc.file_name || 'file.bin';

        console.log('Received document:', fileName, 'file_id:', fileId);

        savedFiles.push({
          chatId,
          fileId,
          fileName,
          date: new Date().toISOString(),
        });
        console.log('Current savedFiles:', savedFiles);

        try {
          const localPath = await downloadAndSaveTelegramFile(fileId, fileName);
          await sendTelegramMessage(
            chatId,
            `File saved.\nOriginal name: ${fileName}\nStored at: ${localPath}`
          );
        } catch (err) {
          console.error('Error saving file:', err);
          await sendTelegramMessage(chatId, 'Sorry, I could not save your file.');
        }
      } else if (msg.text) {
        const text = msg.text;
        console.log('User text:', text);

        const reply = await askPerplexity(text);
        console.log('Perplexity reply:', reply);

        await sendTelegramMessage(chatId, reply);
        console.log('Sent reply to Telegram');
      } else {
        console.log('Message has no text and no document');
        await sendTelegramMessage(
          chatId,
          'I can handle text messages and document files (like PDFs) right now.'
        );
      }
    } else {
      console.log('No message field in update');
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.response?.data || err.message || err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});
