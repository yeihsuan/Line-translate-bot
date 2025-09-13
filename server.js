// server.js  (LINE Bot × LibreTranslate × /tran × 雙向翻譯 × 防呆/分段回覆)
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

/** ========= LINE 基本設定 ========= **/
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

/** ========= LibreTranslate 設定 ========= **/
const LT_BASE = process.env.LT_ENDPOINT || 'https://libretranslate.de'; // 可換成自架節點
const DETECT_URL = `${LT_BASE}/detect`;
const TRANSLATE_URL = `${LT_BASE}/translate`;

// 支援語言（可自行擴充）
const SUPPORTED = ['zh', 'en', 'ja', 'th', 'ko', 'vi', 'fr', 'de', 'es'];

// 以 userId 暫存語言配對（正式可改 Redis/DB 持久化）
const userPairs = new Map(); // userId -> { mine:'zh', friend:'en' }

/** ========= 小工具：分段與安全回覆 ========= **/
function chunkText(str, size = 900) {
  // LINE 單則訊息上限 ~2000字，保守切 900，避免多語多位元造成截斷
  const out = [];
  let i = 0;
  while (i < str.length) {
    out.push(str.slice(i, i + size));
    i += size;
  }
  return out.length ? out : [''];
}

async function replyText(client, replyToken, text) {
  const chunks = chunkText(text);
  const messages = chunks.map((t) => ({ type: 'text', text: t || ' ' })); // 避免空字串
  return client.replyMessage(replyToken, messages);
}

/** ========= Quick Reply（20字以內） ========= **/
function langQuickReply() {
  const presets = [
    ['中↔英', 'zh', 'en'],
    ['中↔日', 'zh', 'ja'],
    ['中↔泰', 'zh', 'th'],
    ['中↔韓', 'zh', 'ko'],
    ['中↔越', 'zh', 'vi'],
    ['英↔日', 'en', 'ja'],
  ];
  return {
    items: presets.map(([label, a, b]) => ({
      type: 'action',
      action: { type: 'message', label, text: `/tran ${a} ${b}` },
    })),
  };
}

/** ========= 語言偵測與翻譯 ========= **/
async function detectLang(text) {
  const resp = await axios.post(
    DETECT_URL,
    { q: text },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const list = resp.data;
  return Array.isArray(list) && list.length ? list[0].language : 'auto';
}

async function translate(text, source, target) {
  const resp = await axios.post(
    TRANSLATE_URL,
    { q: text, source, target, format: 'text' },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return resp.data?.translatedText || '';
}

/** ========= 說明訊息（中英雙語） ========= **/
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

/** ========= Webhook ========= **/
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  const results = await Promise.all(events.map(handleEvent));
  res.json(results);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

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
          '不支援的語言代碼。支援 / Supported: ' +
          SUPPORTED.join(', ') +
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
    const src = await detectLang(text);
    let target;
    if (src === pair.mine) target = pair.friend;
    else if (src === pair.friend) target = pair.mine;
    else target = pair.friend; // 偵測不明時，預設翻給朋友

    // 若語言相同則直接回原文，避免無意義翻譯
    if (src === target) return replyText(client, event.replyToken, text);

    const out = await translate(text, 'auto', target);

    // 保底：翻譯結果為空 → 回原文（避免 400: messages[0].text may not be empty）
    let finalText = (out && out.trim()) ? out : text;
    if (!finalText || !finalText.trim()) {
      finalText = '（翻譯結果為空 / Empty translation）';
    }

    return replyText(client, event.replyToken, finalText);
  } catch (e) {
    console.error('translate error:', e?.response?.data || e.message);
    return replyText(
      client,
      event.replyToken,
      '⚠️ 翻譯服務暫時無法使用，已回覆原文。\n' +
        'Translation service temporarily unavailable. Original text below:\n' +
        text
    );
  }
}

/** ========= 健康檢查與啟動 ========= **/
app.get('/', (_, res) => res.send('LINE translator bot is running.'));
app.listen(process.env.PORT || 3000, () => {
  console.log('Bot running on port ' + (process.env.PORT || 3000));
});
