// server.js
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();

// LINE 設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// LibreTranslate 端點（可用環境變數覆蓋）
const LT_ENDPOINT = process.env.LT_ENDPOINT || 'https://libretranslate.de';

// 簡單支援的語言清單（可自行擴充）
const SUPPORTED = ['zh', 'en', 'ja', 'th', 'ko', 'vi', 'fr', 'de', 'es'];

// 以使用者 userId 存儲語言配對（記憶體版；若要長期穩定，建議換 Redis/DB）
const userPairs = new Map(); // userId -> { mine: 'zh', friend: 'en' }

// Quick Reply 選單
function langQuickReply() {
  const opts = [
    ['中文↔英文','zh','en'], ['中文↔日文','zh','ja'], ['中文↔泰文','zh','th'],
    ['中文↔韓文','zh','ko'], ['中文↔越南','zh','vi'], ['英文↔日文','en','ja']
  ];
  return {
    items: opts.map(([label,a,b]) => ({
      type: 'action',
      action: { type: 'message', label, text: `/pair ${a} ${b}` }
    }))
  };
}

// 偵測語言
async function detectLang(text) {
  const resp = await axios.post(`${LT_ENDPOINT}/detect`, { q: text }, {
    headers: { 'Content-Type': 'application/json' }
  });
  const list = resp.data;
  // 取置信度最高者
  return Array.isArray(list) && list.length ? list[0].language : 'auto';
}

// 翻譯
async function translate(text, source, target) {
  const resp = await axios.post(`${LT_ENDPOINT}/translate`, {
    q: text, source, target, format: 'text'
  }, { headers: { 'Content-Type': 'application/json' } });
  return resp.data?.translatedText || '';
}

// 說明
const HELP = [
  '🧭 使用方式：',
  '1) 第一次先選語言：點下方選單或輸入 `/pair zh en`',
  '   - zh=中文, en=英文, ja=日文, th=泰文, ko=韓文, vi=越南文, fr=法文, de=德文, es=西文',
  '2) 之後直接聊天，我會自動「雙向翻譯」。',
  '3) 指令：',
  '   /pair <mine> <friend>  例：/pair zh en',
  '   /my  查看目前語言配對',
  '   /help  顯示幫助',
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

  // 指令處理
  if (text === '/help') {
    return client.replyMessage(event.replyToken, {
      type: 'text', text: HELP, quickReply: langQuickReply()
    });
  }

  if (text === '/my') {
    const pair = userPairs.get(userId);
    const msg = pair
      ? `目前語言配對：你=${pair.mine}，朋友=${pair.friend}`
      : '尚未設定語言配對，請輸入 `/pair zh en` 或點選下方選單。';
    return client.replyMessage(event.replyToken, {
      type: 'text', text: msg, quickReply: langQuickReply()
    });
  }

  // /pair 指令：/pair zh en
  const m = text.match(/^\/pair\s+(\w+)\s+(\w+)$/i);
  if (m) {
    const mine = m[1].toLowerCase();
    const friend = m[2].toLowerCase();
    if (!SUPPORTED.includes(mine) || !SUPPORTED.includes(friend)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '不支援的語言代碼。支援：' + SUPPORTED.join(', '),
        quickReply: langQuickReply()
      });
    }
    userPairs.set(userId, { mine, friend });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `已設定語言配對：你=${mine}，朋友=${friend}\n開始聊天吧！`,
    });
  }

  // 若尚未配對，提示設定
  let pair = userPairs.get(userId);
  if (!pair) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '第一次使用請先選語言配對（你↔朋友）。\n例如輸入：`/pair zh en`',
      quickReply: langQuickReply()
    });
  }

  // 雙向翻譯：偵測輸入語言，如果是你的語言→翻成朋友語言；反之亦然
  try {
    const src = await detectLang(text);
    let target;
    if (src === pair.mine) target = pair.friend;
    else if (src === pair.friend) target = pair.mine;
    else {
      // 若偵測不是兩者之一，就假設這是你的語言，翻去朋友語言
      target = pair.friend;
    }

    const out = await translate(text, 'auto', target);
    return client.replyMessage(event.replyToken, { type: 'text', text: out });
  } catch (e) {
    console.error('translate error:', e?.response?.data || e.message);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '⚠️ 翻譯暫時無法使用，稍後再試。輸入 /help 取得說明。'
    });
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Bot running on port ' + (process.env.PORT || 3000));
});
