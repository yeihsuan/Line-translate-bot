// server.js  (LINE Bot × LibreTranslate + MyMemory 級聯 × /tran × 雙向翻譯)
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

/** ========= LibreTranslate 設定（可加更多節點） ========= **/
const LT_BASES = [
  process.env.LT_ENDPOINT || 'https://libretranslate.de',
  // 'https://translate.astian.org',
  // 'https://libretranslate.com',
];
const SUPPORTED = ['zh', 'en', 'ja', 'th', 'ko', 'vi', 'fr', 'de', 'es'];
const lt = (base, path) => `${base}${path}`;

/** ========= MyMemory（免費備援） ========= **/
async function myMemoryTranslate(text, source, target) {
  // MyMemory 支援 source=auto
  const src = source === 'auto' ? 'auto' : source;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(target)}`;
  const resp = await axios.get(url, { timeout: 15000 });
  // 主要結果在 responseData.translatedText
  const out = resp?.data?.responseData?.translatedText || '';
  return out;
}

/** ========= 小工具：分段與安全回覆 ========= **/
function chunkText(str, size = 900) {
  const out = [];
  let i = 0;
  while (i < str.length) { out.push(str.slice(i, i + size)); i += size; }
  return out.length ? out : [''];
}
async function replyText(client, replyToken, text) {
  const chunks = chunkText(text);
  const messages = chunks.map(t => ({ type: 'text', text: t || ' ' }));
  return client.replyMessage(replyToken, messages);
}
function sameMeaning(a, b) {
  if (!a || !b) return false;
  const na = a.trim().replace(/\s+/g, ' ');
  const nb = b.trim().replace(/\s+/g, ' ');
  return na === nb;
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

/** ========= 語言偵測（LibreTranslate 節點輪詢） ========= **/
async function detectLang(text) {
  for (const base of LT_BASES) {
    try {
      const resp = await axios.post(
        lt(base, '/detect'),
        { q: text },
        { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
      );
      const list = resp.data;
      return Array.isArray(list) && list.length ? list[0].language : 'auto';
    } catch (_) { /* 換下一個節點 */ }
  }
  return 'auto';
}

/** ========= 供應商 1：LibreTranslate ========= **/
async function ltTranslateOnce(base, text, source, target) {
  const resp = await axios.post(
    lt(base, '/translate'),
    { q: text, source, target, format: 'text' },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return resp.data?.translatedText || '';
}
async function ltTranslateSmart(text, src, target) {
  const source = SUPPORTED.includes(src) ? src : 'auto';
  for (const base of LT_BASES) {
    try {
      // 直翻
      let out = await ltTranslateOnce(base, text, source, target);
      if (out && out.trim() && !sameMeaning(out, text)) return out;

      // 英文跳板
      if (src !== target) {
        const mid = await ltTranslateOnce(base, text, source, 'en');
        if (mid && mid.trim() && !sameMeaning(mid, text)) {
          const out2 = await ltTranslateOnce(base, mid, 'en', target);
          if (out2 && out2.trim() && !sameMeaning(out2, text)) return out2;
        }
      }
    } catch (_) { /* 換下一個節點 */ }
  }
  return ''; // 讓上層試 MyMemory
}

/** ========= 供應商 2：MyMemory（備援） ========= **/
async function mmTranslateSmart(text, src, target) {
  const source = SUPPORTED.includes(src) ? src : 'auto';

  // 直翻
  try {
    const out = await myMemoryTranslate(text, source, target);
    if (out && out.trim() && !sameMeaning(out, text)) return out;
  } catch (_) {}

  // 英文跳板
  if (src !== target) {
    try {
      const mid = await myMemoryTranslate(text, source, 'en');
      if (mid && mid.trim() && !sameMeaning(mid, text)) {
        const out2 = await myMemoryTranslate(mid, 'en', target);
        if (out2 && out2.trim() && !sameMeaning(out2, text)) return out2;
      }
    } catch (_) {}
  }
  return '';
}

/** ========= 高層封裝：多供應商級聯 ========= **/
async function smartTranslate(text, src, target) {
  // 1) 先 LibreTranslate
  let out = await ltTranslateSmart(text, src, target);
  if (out && out.trim() && !sameMeaning(out, text)) return out;

  // 2) 再 MyMemory
  out = await mmTranslateSmart(text, src, target);
  if (out && out.trim() && !sameMeaning(out, text)) return out;

  // 全失敗 → 空字串（讓上層做保底）
  return '';
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

/** ========= 暫存配對 ========= **/
const userPairs = new Map(); // userId -> { mine, friend }

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

    const out = await smartTranslate(text, src, target);

    // 保底：翻譯結果為空 → 回原文，避免 400 空訊息
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
