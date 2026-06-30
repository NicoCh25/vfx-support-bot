import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import {
  imageMap,
  IMAGES_DIR,
  FALLBACK_MESSAGE,
  getHistory,
  pushToHistory,
  isHumanActive,
  markUrgent,
  generateReply,
  extractImagesAndCleanText,
} from './core.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('Falta TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function chatKey(chatId) {
  return `tg:${chatId}`; // prefijo para no mezclar con chats de WhatsApp en Supabase/historial
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const key = chatKey(chatId);
  const text = msg.text;

  if (!text) return; // ignoramos audios/imágenes por ahora

  try {
    const paused = await isHumanActive(key);
    if (paused) {
      console.log(`[Telegram] Chat ${chatId} pausado (respuesta humana reciente). No responde el bot.`);
      return;
    }

    const reply = await generateReply(key, text);

    pushToHistory(key, 'user', text);
    pushToHistory(key, 'assistant', reply);

    if (reply.includes('EN_BREVE_ASESOR')) {
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
      await markUrgent(key, text);
      return;
    }

    const { imageTags, cleanReply } = extractImagesAndCleanText(reply);

    for (const tag of imageTags) {
      const fileName = imageMap[tag];
      if (!fileName) continue;
      const filePath = path.join(IMAGES_DIR, fileName);
      if (fs.existsSync(filePath)) {
        try {
          await bot.sendPhoto(chatId, fs.createReadStream(filePath));
        } catch (imgErr) {
          console.error(`[Telegram] Error enviando imagen "${tag}":`, imgErr.message);
        }
      } else {
        console.error(`[Telegram] Imagen no encontrada para el tag "${tag}": ${filePath}`);
      }
    }

    try {
      await bot.sendMessage(chatId, cleanReply, { parse_mode: 'Markdown' });
    } catch (sendErr) {
      console.error('[Telegram] Fallo el envío con Markdown, reintentando en texto plano:', sendErr.message);
      await bot.sendMessage(chatId, cleanReply.replace(/\*/g, ''));
    }
  } catch (err) {
    console.error('[Telegram] Error procesando mensaje:', err);
    await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    await markUrgent(key, text);
  }
});

console.log('VFX Support Bot (Telegram) corriendo ✅');
