import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HUMAN_PAUSE_HOURS = 24;
const MAX_HISTORY_MESSAGES = 12; // últimas 6 idas y vueltas por chat

if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan variables de entorno. Revisá ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

export const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Base de conocimiento ----------
export const knowledgeBase = fs.readFileSync(path.join(__dirname, 'knowledge_base.md'), 'utf-8');

// ---------- Imágenes disponibles ----------
export const IMAGES_DIR = path.join(__dirname, '..', 'images');
export const imageMap = {
  planes_deposito: 'planes_por_deposito.png',
  libertex_pasos: 'libertex_pasos_registro.png',
  libertex_id_mt5: 'libertex_id_mt5.jpeg',
  tabla_lotaje: 'tabla_lotaje.png',
  trade_us30: 'us30_forma_trade.jpg',
  trade_xauusd: 'xauusd_forma_trade.jpg',
  trade_btc: 'btc_forma_trade.jpg',
};

export const SYSTEM_PROMPT = `Te llamás Adrian y sos parte del equipo de soporte de VFX Signals, una comunidad de señales de trading VIP (XAUUSD, US30, BTC) enfocada en Paraguay. Hablás como una persona real, nunca decís que sos una IA ni sonás robótico.

Reglas estrictas:
1. Hablá en español neutro / paraguayo, nunca rioplatense. Tono cercano, humano, directo — como hablaría una persona real por Telegram/WhatsApp, no un bot.
2. Respondé SOLO con información que está en la base de conocimiento de abajo. Si la pregunta no está cubierta, NO inventes nada: respondé exactamente "EN_BREVE_ASESOR" y nada más (el sistema se encarga de traducir eso a un mensaje para el usuario).
3. Si detectás un reclamo de pago, dinero, o un problema serio de cuenta, respondé también exactamente "EN_BREVE_ASESOR".
4. Para resaltar texto usá negrita en formato Markdown de Telegram (un solo asterisco de cada lado, ej: *así*), nunca doble asterisco (**así**), porque Telegram no lo renderiza y se ve feo con los asteriscos sueltos. En WhatsApp el formato de negrita también es un solo asterisco de cada lado, así que es consistente en ambos canales.
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
Usalas con criterio, no en cada mensaje — solo cuando el usuario está en ese paso puntual o pregunta algo que la imagen explica mejor que el texto. La imagen siempre se manda ANTES que tu texto, así que si hacés referencia a ella usá un emoji que apunte hacia arriba (👆), nunca hacia abajo (👇).
14. Nunca dejes líneas en blanco dobles ni espacios vacíos largos en el medio de un mensaje — escribí en párrafos cortos y seguidos, como un chat real, no como un documento con saltos de sección.
15. Tenés el historial de la conversación con esta persona. NUNCA repitas una pregunta que el usuario ya contestó antes en este mismo chat (ej. si ya dijo que es nuevo, no le vuelvas a preguntar si es nuevo). Usá lo que ya sabés de la conversación para avanzar al siguiente paso, no para reiniciar el flujo.
16. Si estás operando en el canal de WhatsApp (conexión no oficial), seguí también las reglas anti-baneo de la sección 20 de la base de conocimiento: nunca iniciar conversación salvo el seguimiento del canal gratis, y ese seguimiento siempre con horarios y textos variados entre contacto y contacto, nunca en tanda.

BASE DE CONOCIMIENTO:
${knowledgeBase}`;

export const FALLBACK_MESSAGE = 'En breve te responde un asesor 🙌';

// ---------- Memoria de conversación (en memoria, por chat — compartida entre canales) ----------
// Nota: vive en RAM. Si Railway reinicia el servicio, se pierde el historial activo,
// pero la regla de pausa de 24hs y los chats urgentes siguen guardados en Supabase.
const conversationHistory = new Map(); // chatKey -> [{role, content}, ...]

export function getHistory(chatKey) {
  return conversationHistory.get(chatKey) || [];
}

export function pushToHistory(chatKey, role, content) {
  const history = getHistory(chatKey);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) history.shift();
  conversationHistory.set(chatKey, history);
}

// ---------- Regla de pausa de 24hs ----------
// chatKey tiene que ser único entre canales, ej. "tg:123456" o "wa:59598..." para no mezclar chats.
export async function isHumanActive(chatKey) {
  const { data, error } = await supabase
    .from('chat_status')
    .select('last_human_reply_at')
    .eq('chat_id', String(chatKey))
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

export async function markUrgent(chatKey, lastMessage) {
  await supabase.from('urgent_chats').upsert({
    chat_id: String(chatKey),
    last_message: lastMessage,
    flagged_at: new Date().toISOString(),
  });
}

// ---------- Generar respuesta con Claude ----------
export async function generateReply(chatKey, userMessage) {
  const history = getHistory(chatKey);

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

// ---------- Utilidad: separar tags de imagen del texto limpio ----------
export function extractImagesAndCleanText(reply) {
  const imageTags = [...reply.matchAll(/\[IMG:(\w+)\]/g)].map((m) => m[1]);
  let cleanReply = reply.replace(/\[IMG:\w+\]/g, '').trim();
  cleanReply = cleanReply.replace(/\n{3,}/g, '\n\n'); // colapsar líneas en blanco de más
  return { imageTags, cleanReply };
}

// ---------- Utilidad: delay random tipo "humano" antes de responder (clave para WhatsApp anti-baneo) ----------
export function randomDelayMs(minSeconds = 2, maxSeconds = 6) {
  const min = minSeconds * 1000;
  const max = maxSeconds * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
