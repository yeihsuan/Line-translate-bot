// server.js  (LibreTranslate + 雙向翻譯 + /tran 指令 + 中英雙語系統訊息)
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

// LINE config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// LibreTranslate endpoint
const LT_BASE = process.env.LT_ENDPOINT || 'https://libretranslate.de';
const DETECT_URL = `${LT_BASE}/detect`;
const TRANSLATE_URL = `${LT_BASE}/translate`;

// 支援語言
const SUPPORTED = ['zh', 'en', 'ja', 'th', 'ko', 'vi', 'fr', 'de', 'es'];

// 以 userId 暫存語言配對（若要長期保存，建議換 DB/Redis）
const userPairs = new Map(); // userId -> { mine:'zh', friend:'en' }

// Quick Reply 選單（按了會直接送出 /tran 指令）
function langQuickReply() {
  const presets = [
    ['中文↔英文 Chinese↔English', 'zh', 'en'],
    ['中文↔日文 Chinese↔Japanese', 'zh', 'ja'],
    ['中文↔泰文 Chinese↔Thai', 'zh', 'th'],
    ['中文↔韓文 Chinese↔Korean', 'zh', 'ko'],
    ['中文↔越南 Chinese↔Vietnamese', 'zh', 'vi'],
    ['英文↔日文 English↔Japanese', 'en', 'ja'],
  ];
  return {
    items: presets.map(([label, a, b]) => ({
      type: 'action',
      action: { type: 'message', label, text: `/tran ${a} ${b}` },
    })),
  };
}

// 偵測語言
async function detectLang(text) {
  const resp = await axios.post(
    DETECT_URL,
    { q: text },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const list = resp.data;
  return Array.isArray(list) && list.length ? list[0].language : 'auto';
}

// 翻譯
async function translate(text, source, target) {
  const resp = await axios.post(
    TRANSLATE_URL,
    { q: text, source, target, format: 'text' },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return resp.data?.translatedText || '';
}

// 幫助訊息（雙語）
const HELP = [
  '🧭 使用方式 / How to use:',
  '1) 先設定語言配對：/tran <我的語言> <朋友的語言>',
  '   例：/tran zh en',
  '   zh=中文, en=英文, ja=日文, th=泰文, ko=韓文, vi=越南文, fr=法文, de=德文, es=西文',
  '2) 之後直接聊天，我會自動雙向翻譯。',
  '3) 指令 / Commands:',
  '   /tran <mine> <friend>  例：/tran zh en',
  '   /my  查看目前語言配對  / show current pair',
  '   /help  顯示說明  / show help',
].join('\n');

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  const results = await Promise.all(events.map(handleEvent));
  res.json(results);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text.trim();

  // /help
  if (text === '/help') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: HELP,
      quickReply: langQuickReply(),
    });
  }

  // /my
  if (text === '/my') {
    const pair = userPairs.get(userId);
    const msg = pair
      ? `目前語言配對：你/You=${pair.mine}，朋友/Friend=${pair.friend}\n` +
        `Current pair: you=${pair.mine}, friend=${pair.friend}`
      : '尚未設定語言配對，請輸入 /tran zh en 或點擊下方選單。\n' +
        'Pair not set. Please send /tran zh en or tap a button below.';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: msg,
      quickReply: langQuickReply(),
    });
  }

  // /tran 指令：/tran zh en
  const m = text.match(/^\/tran\s+(\w+)\s+(\w+)$/i);
  if (m) {
    const mine = m[1].toLowerCase();
    const friend = m[2].toLowerCase();
    if (!SUPPORTED.includes(mine) || !SUPPORTED.includes(friend)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          '不支援的語言代碼。支援 / Supported: ' + SUPPORTED.join(', ') +
          '\n例如 / Example: /tran zh en',
        quickReply: langQuickReply(),
      });
    }
    userPairs.set(userId, { mine, friend });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `已設定語言配對：你/You=${mine}，朋友/Friend=${friend}\n` +
        `Translation pair set: you=${mine}, friend=${friend}\n` +
        `開始聊天吧！Start chatting!`,
    });
  }

  // 尚未設定配對 → 提示
  const pair = userPairs.get(userId);
  if (!pair) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '第一次使用請先設定語言配對（你↔朋友）。\n' +
        'Please set your translation pair first (you ↔ friend).\n' +
        '範例 / Example: /tran zh en',
      quickReply: langQuickReply(),
    });
  }

  // 雙向翻譯
  try {
    const src = await detectLang(text); // 偵測是誰的語言
    let target;
    if (src === pair.mine) target = pair.friend;
    else if (src === pair.friend) target = pair.mine;
    else target = pair.friend; // 無法判斷時預設翻給朋友

    const out = await translate(text, 'auto', target);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: out,
    });
  } catch (e) {
    console.error('translate error:', e?.response?.data || e.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '⚠️ 翻譯暫時無法使用，稍後再試。\n' +
        'Translation service temporarily unavailable. Please try again later.',
    });
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot running on port ' + (process.env.PORT || 3000));
});
