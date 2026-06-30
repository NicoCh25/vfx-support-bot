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

// ---------- Imágenes disponibles ----------
// Adrian puede pedir que se envíe una imagen escribiendo [IMG:tag] en su respuesta.
// El código detecta el tag, manda la foto, y lo quita del texto antes de enviar el mensaje.
const IMAGES_DIR = path.join(__dirname, '..', 'images');
const imageMap = {
  planes_deposito: 'planes_por_deposito.png',
  libertex_pasos: 'libertex_pasos_registro.png',
  libertex_id_mt5: 'libertex_id_mt5.jpeg',
  tabla_lotaje: 'tabla_lotaje.png',
  trade_us30: 'us30_forma_trade.jpg',
  trade_xauusd: 'xauusd_forma_trade.jpg',
  trade_btc: 'btc_forma_trade.jpg',
};

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
13. Tenés imágenes disponibles para mandar cuando realmente ayuden a entender algo visual. Para mandar una, escribí el tag exacto en tu respuesta (en cualquier parte del texto, se va a quitar antes de enviar):
- [IMG:planes_deposito] → tabla de planes por depósito
- [IMG:libertex_pasos] → paso a paso de registro y verificación en Libertex
- [IMG:libertex_id_mt5] → dónde encontrar el número de cuenta/ID de MT5 dentro de la app de Libertex (usar cuando el usuario no sabe cómo encontrar su ID para mandarlo)
- [IMG:tabla_lotaje] → tabla de lotaje recomendado por activo (XAUUSD, US30/YM, BTCUSD) según el riesgo en dólares
- [IMG:trade_us30] → cómo tomar el trade en US30 (las 2 formas: cerrar parcial en TP1 o dejar correr a TP2)
- [IMG:trade_xauusd] → cómo tomar el trade en XAUUSD (colocar la orden y dejar correr)
- [IMG:trade_btc] → cómo tomar el trade en BTC/USD (colocar la orden y dejar correr)
Usalas con criterio, no en cada mensaje — solo cuando el usuario está en ese paso puntual o pregunta algo que la imagen explica mejor que el texto.
14. Tenés el historial de la conversación con esta persona. NUNCA repitas una pregunta que el usuario ya contestó antes en este mismo chat (ej. si ya dijo que es nuevo, no le vuelvas a preguntar si es nuevo). Usá lo que ya sabés de la conversación para avanzar al siguiente paso, no para reiniciar el flujo.

BASE DE CONOCIMIENTO:
${knowledgeBase}`;

const FALLBACK_MESSAGE = 'En breve te responde un asesor 🙌';
const MAX_HISTORY_MESSAGES = 12; // mantiene las últimas 6 idas y vueltas por chat

// ---------- Memoria de conversación (en memoria, por chat) ----------
// Nota: esto vive en RAM. Si Railway reinicia el servicio, se pierde el historial activo,
// pero la regla de pausa de 24hs y los chats urgentes siguen guardados en Supabase.
const conversationHistory = new Map(); // chatId -> [{role, content}, ...]

function getHistory(chatId) {
  return conversationHistory.get(chatId) || [];
}

function pushToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) history.shift();
  conversationHistory.set(chatId, history);
}

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
async function generateReply(chatId, userMessage) {
  const history = getHistory(chatId);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user', content: userMessage }],
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

    const reply = await generateReply(chatId, text);

    // Guardamos el turno en el historial (con el texto crudo del modelo, incluyendo tags de imagen,
    // así Claude recuerda exactamente qué dijo y no se contradice ni repite preguntas ya respondidas)
    pushToHistory(chatId, 'user', text);
    pushToHistory(chatId, 'assistant', reply);

    if (reply.includes('EN_BREVE_ASESOR')) {
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
      await markUrgent(chatId, text);
      return;
    }

    // Detectar tags de imagen tipo [IMG:tag] y enviarlas antes del texto
    const imageTags = [...reply.matchAll(/\[IMG:(\w+)\]/g)].map((m) => m[1]);
    const cleanReply = reply.replace(/\[IMG:\w+\]/g, '').trim();

    for (const tag of imageTags) {
      const fileName = imageMap[tag];
      if (!fileName) continue;
      const filePath = path.join(IMAGES_DIR, fileName);
      if (fs.existsSync(filePath)) {
        try {
          await bot.sendPhoto(chatId, fs.createReadStream(filePath));
        } catch (imgErr) {
          console.error(`Error enviando imagen "${tag}":`, imgErr.message);
        }
      } else {
        console.error(`Imagen no encontrada para el tag "${tag}": ${filePath}`);
      }
    }

    try {
      await bot.sendMessage(chatId, cleanReply, { parse_mode: 'Markdown' });
    } catch (sendErr) {
      // Si el formato Markdown rompe el envío (caracteres especiales), reintenta en texto plano
      console.error('Fallo el envío con Markdown, reintentando en texto plano:', sendErr.message);
      await bot.sendMessage(chatId, cleanReply.replace(/\*/g, ''));
    }
  } catch (err) {
    console.error('Error procesando mensaje:', err);
    await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    await markUrgent(chatId, text);
  }
});

console.log('VFX Support Bot corriendo ✅');
