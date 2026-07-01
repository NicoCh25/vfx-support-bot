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
  extractVipLinkRequest,
  splitIntoMessageChunks,
  extractEmail,
  checkClienteStatus,
  buildClienteStatusContext,
  generateVipLink,
  randomDelayMs,
  sleep,
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

    // Simular que "está escribiendo" antes de responder
    await bot.sendChatAction(chatId, 'typing');
    await sleep(randomDelayMs(5, 12));

    // Si el usuario mandó un mail, consultamos su estado real en la plataforma VFX
    // y se lo pasamos a Claude como contexto verificado (ver regla 17 del prompt).
    let messageForAI = text;
    const detectedEmail = extractEmail(text);
    if (detectedEmail) {
      const status = await checkClienteStatus(detectedEmail);
      const context = buildClienteStatusContext(status);
      if (context) messageForAI = `${context}\n\n${messageForAI}`;
    }

    const reply = await generateReply(key, messageForAI);

    pushToHistory(key, 'user', text);
    pushToHistory(key, 'assistant', reply);

    if (reply.includes('EN_BREVE_ASESOR')) {
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
      await markUrgent(key, text);
      return;
    }

    const { imageTags, cleanReply: replyWithoutImages } = extractImagesAndCleanText(reply);
    const { wantsVipLink, cleanReply } = extractVipLinkRequest(replyWithoutImages);

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

    // Mandamos la respuesta partida en varios mensajes (uno por párrafo), simulando que
    // Adrian está escribiendo y mandando de a poco, como una persona real en el chat.
    const messageChunks = splitIntoMessageChunks(cleanReply);
    for (let i = 0; i < messageChunks.length; i++) {
      if (i > 0) {
        await bot.sendChatAction(chatId, 'typing');
        await sleep(randomDelayMs(1, 3)); // pausa corta entre mensaje y mensaje
      }
      try {
        await bot.sendMessage(chatId, messageChunks[i], { parse_mode: 'Markdown' });
      } catch (sendErr) {
        console.error('[Telegram] Fallo el envío con Markdown, reintentando en texto plano:', sendErr.message);
        await bot.sendMessage(chatId, messageChunks[i].replace(/\*/g, ''));
      }
    }

    // Si Adrian pidió el link VIP (usuario con membresía activa que no le abre el grupo),
    // lo generamos y lo mandamos como mensaje aparte, justo después del texto.
    if (wantsVipLink && detectedEmail) {
      const vip = await generateVipLink(detectedEmail);
      if (vip?.invite_link) {
        await sleep(randomDelayMs(1, 3));
        await bot.sendMessage(chatId, `🚀 Acá tenés el acceso al canal VIP (válido ${vip.expires_in_hours}h, uso único):\n${vip.invite_link}`);
      } else {
        console.error(`[Telegram] No se pudo generar link VIP para ${detectedEmail}`);
        await markUrgent(key, `Falló generación de link VIP para ${detectedEmail}`);
      }
    }
  } catch (err) {
    console.error('[Telegram] Error procesando mensaje:', err?.message || 'Error desconocido');
    await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    await markUrgent(key, text);
  }
});

console.log('VFX Support Bot (Telegram) corriendo ✅');
