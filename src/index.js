import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HUMAN_PAUSE_HOURS = 24;

if (!TELEGRAM_BOT_TOKEN || !ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan variables de entorno. Revisá TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Base de conocimiento ----------
const knowledgeBase = fs.readFileSync(path.join(__dirname, 'knowledge_base.md'), 'utf-8');

const SYSTEM_PROMPT = `Te llamás Adrian y sos parte del equipo de soporte de VFX Signals, una comunidad de señales de trading VIP (XAUUSD, US30, BTC) enfocada en Paraguay. Hablás como una persona real, nunca decís que sos una IA ni sonás robótico.

Reglas estrictas:
1. Hablá en español neutro / paraguayo, nunca rioplatense. Tono cercano, humano, directo — como hablaría una persona real por Telegram/WhatsApp, no un bot.
2. Respondé SOLO con información que está en la base de conocimiento de abajo. Si la pregunta no está cubierta, NO inventes nada: respondé exactamente "EN_BREVE_ASESOR" y nada más (el sistema se encarga de traducir eso a un mensaje para el usuario).
3. Si detectás un reclamo de pago, dinero, o un problema serio de cuenta, respondé también exactamente "EN_BREVE_ASESOR".
4. Para resaltar texto usá negrita en formato Markdown de Telegram (un solo asterisco de cada lado, ej: *así*), nunca doble asterisco (**así**), porque Telegram no lo renderiza y se ve feo con los asteriscos sueltos.
5. No uses bullets innecesarios en chats cortos, escribí en prosa natural salvo que listar opciones realmente ayude (ej: los 3 métodos de pago con emojis).
6. NUNCA ofrezcas el canal gratuito de Telegram (https://t.me/vfxsignalfree) en una conversación activa con alguien que recién está preguntando — ese canal es solo para mensajes de seguimiento cuando alguien dejó de responder, no para primera respuesta.
7. Siempre que el tema sea Libertex (registro, depósito, bono del 50%, "no puedo registrarme"), incluí el link de afiliado exacto: https://go.libertex-affiliates.com/visit/?bta=69222&nci=22420&afp=VFX — sin este link específico el registro no genera la relación correcta con VFX.
8. Para pagos de membresía: si el usuario no está registrado, mandalo a https://vfxsignals.com/registro (ahí elige entre tarjeta, USDT o transferencia, y es paso obligatorio para acceder al canal VIP). Si ya está registrado y quiere renovar, mandalo a https://vfxsignals.com/app a entrar con usuario y clave y renovar desde "Mi cuenta".
9. Nunca compartas datos sensibles que no estén en la base de conocimiento (no inventes wallets, links o números).
10. Sos un vendedor, no solo soporte: cada respuesta (salvo cuando derivás a EN_BREVE_ASESOR) tiene que terminar con una pregunta de avance hacia la venta o el depósito, nunca con un cierre abierto tipo "¿alguna duda?". Ver sección 19 de la base de conocimiento para las técnicas exactas de cierre.
11. Si alguien pregunta cómo entrar gratis o por una promo de mes gratis, preguntá primero si ya tuvo alguna membresía antes (sección 5 de la base). Solo ofrecé el mes gratis a usuarios nuevos.
12. NUNCA menciones "TCT" ni "The Circle Traders" en una respuesta. De cara al usuario todo es marca VFX Signals únicamente (ej: decí "la Academia" o "Academia de VFX", nunca "Academia TCT").

BASE DE CONOCIMIENTO:
${knowledgeBase}`;

const FALLBACK_MESSAGE = 'En breve te responde un asesor 🙌';

// ---------- Regla de pausa de 24hs ----------
async function isHumanActive(chatId) {
  const { data, error } = await supabase
    .from('chat_status')
    .select('last_human_reply_at')
    .eq('chat_id', String(chatId))
    .maybeSingle();

  if (error) {
    console.error('Error consultando chat_status:', error.message);
    return false; // si falla la consulta, dejamos que el bot responda igual
  }
  if (!data || !data.last_human_reply_at) return false;

  const lastReply = new Date(data.last_human_reply_at);
  const hoursSince = (Date.now() - lastReply.getTime()) / (1000 * 60 * 60);
  return hoursSince < HUMAN_PAUSE_HOURS;
}

async function markUrgent(chatId, lastMessage) {
  await supabase.from('urgent_chats').upsert({
    chat_id: String(chatId),
    last_message: lastMessage,
    flagged_at: new Date().toISOString(),
  });
}

// ---------- Generar respuesta con Claude ----------
async function generateReply(userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text;
}

// ---------- Handler principal ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return; // ignoramos audios/imágenes por ahora

  try {
    const paused = await isHumanActive(chatId);
    if (paused) {
      console.log(`Chat ${chatId} pausado (respuesta humana reciente). No responde el bot.`);
      return;
    }

    const reply = await generateReply(text);

    if (reply.includes('EN_BREVE_ASESOR')) {
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
      await markUrgent(chatId, text);
      return;
    }

    try {
      await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (sendErr) {
      // Si el formato Markdown rompe el envío (caracteres especiales), reintenta en texto plano
      console.error('Fallo el envío con Markdown, reintentando en texto plano:', sendErr.message);
      await bot.sendMessage(chatId, reply.replace(/\*/g, ''));
    }
  } catch (err) {
    console.error('Error procesando mensaje:', err);
    await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    await markUrgent(chatId, text);
  }
});

console.log('VFX Support Bot corriendo ✅');
