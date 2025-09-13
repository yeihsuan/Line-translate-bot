// server.js
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  const results = await Promise.all(events.map(handleEvent));
  res.json(results);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const prompt = `請將下列句子翻譯為繁體中文：\n\n${event.message.text}`;

  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const translatedText = response.data.choices?.[0]?.message?.content || '⚠️ 翻譯失敗';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: translatedText,
    });
  } catch (error) {
    console.error('DeepSeek API error:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 系統錯誤，請稍後再試',
    });
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot is running on port 3000');
});
