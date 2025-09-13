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

// LibreTranslate 端點（可自訂環境變數，否則用公開免費的）
const LT_ENDPOINT = process.env.LT_ENDPOINT || 'https://libretranslate.de/translate';

// 簡單的語言代碼對照（輸入 /en /ja /th /ko /vi /zh）
const LANG_MAP = new Set(['en', 'ja', 'th', 'ko', 'vi', 'zh', 'fr', 'de', 'es']);

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  const results = await Promise.all(events.map(handleEvent));
  res.json(results);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const raw = event.message.text.trim();
  // 指令：/en 早安  →  翻成英文
  let target = 'zh'; // 預設翻譯成繁中
  let text = raw;

  const m = raw.match(/^\/(\w+)\s+([\s\S]+)/);
  if (m) {
    const code = m[1].toLowerCase();
    if (LANG_MAP.has(code)) {
      target = code;
      text = m[2];
    }
  }

  try {
    const resp = await axios.post(
      LT_ENDPOINT,
      {
        q: text,
        source: 'auto',     // 自動偵測
        target,             // 目標語言
        format: 'text'
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const translated = resp.data?.translatedText || '翻譯失敗，稍後再試。';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: translated
    });
  } catch (err) {
    console.error('LibreTranslate error:', err?.response?.data || err.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 翻譯服務暫時無法使用，請稍後再試。'
    });
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot running on port ' + (process.env.PORT || 3000));
});
