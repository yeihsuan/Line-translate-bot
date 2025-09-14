// server.js  (LINE × LibreTranslate only × /tran × 雙向翻譯 × 分段回覆/保底/英文跳板)
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

/** ==== LINE 設定 ==== **/
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

/** ==== LibreTranslate 設定 ==== **/
const LT_BASE = process.env.LT_ENDPOINT || 'https://libretranslate.de';
const LT_DETECT = `${LT_BASE}/detect`;
const LT_TRANSLATE = `${LT_BASE}/translate`;

/** ==== Bot 支援語言（可擴充） ==== **/
const SUPPORTED = ['zh','en','ja','th','ko','vi','fr','de','es','pt'];

/** ==== 暫存使用者語言配對（正式可改 DB/Redis） ==== **/
const userPairs = new Map(); // userId -> { mine:'zh', friend:'en' }

/** ==== 小工具：分段回覆 & 避免空字串 ==== **/
function chunkText(str, size = 900) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [''];
}
async function replyText(client, replyToken, text) {
  const chunks = chunkText(text);
  const messages = chunks.map(t => ({ type: 'text', text: t || ' ' }));
  return client.replyMessage(replyToken, messages);
}

/** ==== Quick Reply（label 必須 <= 20 字） ==== **/
function langQuickReply() {
  const presets = [
    ['中↔英','zh','en'],
    ['中↔日','zh','ja'],
    ['中↔泰','zh','th'],
    ['中↔韓','zh','ko'],
    ['中↔越','zh','vi'],
    ['英↔日','en','ja'],
  ];
  return {
    items: presets.map(([label,a,b]) => ({
      type: 'action',
      action: { type: 'message', label, text: `/tran ${a} ${b}` },
    })),
  };
}

/** ==== 語言偵測（LT） ==== **/
async function detectLang(text) {
  try {
    const resp = await axios.post(LT_DETECT, { q: text }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 12000
    });
    const list = resp.data;
    return Array.isArray(list) && list.length ? list[0].language : 'auto';
  } catch (_) {
    return 'auto';
  }
}

/** ==== LibreTranslate 翻譯（含英文跳板備援） ==== **/
async function ltTranslateOnce(text, source, target) {
  try {
    const resp = await axios.post(
      LT_TRANSLATE,
      { q: text, source, target, format: 'text' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return resp.data?.translatedText || '';
  } catch (_) {
    return '';
  }
}
async function translateSmart(text, src, tgt) {
  const source = SUPPORTED.includes(src) ? src : 'auto';
  // 直翻
  let out = await ltTranslateOnce(text, source, tgt);
  if (out && out.trim() && out.trim() !== text.trim()) return out;
  // 英文跳板（提升冷門語對成功率）
  if (src !== tgt) {
    const mid = await ltTranslateOnce(text, source, 'en');
    if (mid && mid.trim() && mid.trim() !== text.trim()) {
      const out2 = await ltTranslateOnce(mid, 'en', tgt);
      if (out2 && out2.trim()) return out2;
    }
  }
  return '';
}

/** ==== 說明（雙語） ==== **/
const HELP = [
  '🧭 使用方式 / How to use:',
  '1) 先設定語言配對：/tran <我的語言> <朋友的語言>',
  '   例：/tran zh en',
  '   支援：zh(中) en(英) ja(日) th(泰) ko(韓) vi(越) fr(法) de(德) es(西) pt(葡)',
  '2) 之後直接聊天，我會自動雙向翻譯（只用 LibreTranslate，免金鑰）。',
  '3) 指令 / Commands:',
  '   /tran <mine> <friend>  例：/tran zh en',
  '   /my  查看目前語言配對  / show current pair',
  '   /help  顯示說明  / show help',
].join('\n');

/** ==== Webhook ==== **/
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

  // /tran 指令
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
        `Translation pair set: you=${mine}, friend=${friend}\n開始聊天吧！Start chatting!`,
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
    else target = pair.friend;

    if (src === target) return replyText(client, event.replyToken, text);

    const out = await translateSmart(text, src, target);
    // 保底：翻譯結果為空 → 回原文，避免 400 空訊息
    let finalText = (out && out.trim()) ? out : text;
    if (!finalText.trim()) finalText = '（翻譯結果為空 / Empty translation）';

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

/** ==== 健康檢查與啟動 ==== **/
app.get('/', (_, res) => res.send('LINE translator bot is running.'));
app.listen(process.env.PORT || 3000, () =>
  console.log('Bot running on port ' + (process.env.PORT || 3000))
);
