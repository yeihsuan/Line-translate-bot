// server.js  (Google Translate → LibreTranslate fallback → /tran → 雙向翻譯)
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

/** ==== Google 翻譯設定（優先） ==== **/
const GOOGLE_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';
const G_API = 'https://translation.googleapis.com/language/translate/v2';
const G_DETECT = 'https://translation.googleapis.com/language/translate/v2/detect';

/** ==== LibreTranslate 設定（備援） ==== **/
const LT_BASE = process.env.LT_ENDPOINT || 'https://libretranslate.de';
const LT_DETECT = `${LT_BASE}/detect`;
const LT_TRANSLATE = `${LT_BASE}/translate`;

/** ==== Bot 支援語言（可自行擴充） ==== **/
const SUPPORTED = ['zh','en','ja','th','ko','vi','fr','de','es','pt'];

/** ==== 暫存使用者語言配對（正式建議用 DB/Redis） ==== **/
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

/** ==== 語言偵測（優先用 Google，失敗改 LT） ==== **/
async function detectLang(text) {
  // Google detect
  if (GOOGLE_KEY) {
    try {
      const resp = await axios.post(`${G_DETECT}?key=${GOOGLE_KEY}`, { q: text }, { timeout: 12000 });
      const det = resp.data?.data?.detections?.[0]?.[0]?.language;
      if (det) return det;
    } catch (_) {}
  }
  // LT detect 備援
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

/** ==== Google 翻譯（優先） ==== **/
async function translateWithGoogle(text, src, tgt) {
  if (!GOOGLE_KEY) return null;
  // v2 API：source 可省略讓 Google 自動偵測（但我們已先偵測過）
  const params = { q: text, target: tgt, format: 'text' };
  if (src && src !== 'auto') params.source = src;

  try {
    const resp = await axios.post(`${G_API}?key=${GOOGLE_KEY}`, params, { timeout: 15000 });
    const out = resp.data?.data?.translations?.[0]?.translatedText || '';
    return out && out.trim() ? out : null;
  } catch (e) {
    // 額度用盡常見 429 / 403，或 4xx/5xx 皆視為失敗
    const status = e?.response?.status;
    if (status) console.warn('Google Translate error status:', status);
    return null;
  }
}

/** ==== LibreTranslate 翻譯（備援，含英文跳板） ==== **/
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
async function translateWithLT(text, src, tgt) {
  const source = SUPPORTED.includes(src) ? src : 'auto';
  // 直翻
  let out = await ltTranslateOnce(text, source, tgt);
  if (out && out.trim() && out.trim() !== text.trim()) return out;
  // 英文跳板
  if (src !== tgt) {
    const mid = await ltTranslateOnce(text, source, 'en');
    if (mid && mid.trim() && mid.trim() !== text.trim()) {
      const out2 = await ltTranslateOnce(mid, 'en', tgt);
      if (out2 && out2.trim()) return out2;
    }
  }
  return '';
}

/** ==== 高層封裝：Google 優先 → 失敗/額度 → LT ==== **/
async function smartTranslate(text, src, tgt) {
  const g = await translateWithGoogle(text, src, tgt);
  if (g && g.trim()) return g;

  const lt = await translateWithLT(text, src, tgt);
  if (lt && lt.trim()) return lt;

  return '';
}

/** ==== 說明（雙語） ==== **/
const HELP = [
  '🧭 使用方式 / How to use:',
  '1) 先設定語言配對：/tran <我的語言> <朋友的語言>',
  '   例：/tran zh en',
  '   支援：zh(中) en(日) ja(日) th(泰) ko(韓) vi(越) fr(法) de(德) es(西) pt(葡)',
  '2) 之後直接聊天，我會自動雙向翻譯（優先 Google，額度用完改 LibreTranslate）。',
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
        `Translation pair set: you=${mine}, friend=${friend}\n開始聊天吧！Start chatting!`,
    });
