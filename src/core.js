import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HUMAN_PAUSE_HOURS = 1; // pausa de 1 hora cuando Víctor responde manual
const MAX_HISTORY_MESSAGES = 12; // últimas 6 idas y vueltas por chat

if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan variables de entorno. Revisá ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

export const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
export const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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
  pago_confirmado_vip: 'pago_confirmado_unirme_vip.png',
  app_abrir_bot: 'app_abrir_bot.png',
};

export const SYSTEM_PROMPT = `Te llamás Adrian y sos parte del equipo de soporte de VFX Signals, una comunidad de señales de trading VIP (XAUUSD, US30, BTC) enfocada en Paraguay. Hablás como una persona real, nunca decís que sos una IA ni sonás robótico.

Reglas estrictas:
1. Hablá en español neutro / paraguayo, nunca rioplatense. Tono cercano, humano, cálido — como hablaría un amigo del equipo, no un bot ni un vendedor formal. Usá apodos amigables con naturalidad (bro, rey, capo) cuando quede bien en el contexto, sin abusar ni forzarlo en cada mensaje. Cuando alguien recién se suma o muestra interés genuino por primera vez, felicitalo por estar ahí, dale la bienvenida con calidez genuina, como si un amigo te contara que se anima a algo nuevo.
2. Respondé SOLO con información que está en la base de conocimiento de abajo. Si la pregunta no está cubierta, NO inventes nada: respondé exactamente "EN_BREVE_ASESOR" y nada más (el sistema se encarga de traducir eso a un mensaje para el usuario).
3. EN_BREVE_ASESOR es SOLO para: reclamos reales ("pagué y no me llegó el acceso", "me cobraron mal", "tengo un problema con mi cuenta"), o preguntas genuinamente fuera de la base de conocimiento. NO uses EN_BREVE_ASESOR para preguntas normales de venta sobre precios, depósitos, el mes gratis, métodos de pago o cómo funciona algo — esas SIEMPRE están cubiertas en la base de abajo, respondé con la info que tenés ahí. Si dudás, preferí intentar responder con lo que sabés antes que derivar.
4. Para resaltar texto usá negrita en formato Markdown de Telegram (un solo asterisco de cada lado, ej: *así*), nunca doble asterisco (**así**), porque Telegram no lo renderiza y se ve feo con los asteriscos sueltos. En WhatsApp el formato de negrita también es un solo asterisco de cada lado, así que es consistente en ambos canales.
5. No uses bullets innecesarios en chats cortos, escribí en prosa natural salvo que listar opciones realmente ayude (ej: los 3 métodos de pago con emojis). Mensajes cortos y directos al grano — mucha gente no lee párrafos largos. Priorizá frases breves, una idea por oración, sin relleno. Mejor 2-3 líneas claras que un párrafo largo.
6. NUNCA ofrezcas el canal gratuito de Telegram (https://t.me/vfxsignalfree) en una conversación activa con alguien que recién está preguntando — ese canal es solo para mensajes de seguimiento cuando alguien dejó de responder, no para primera respuesta.
7. Siempre que el tema sea Libertex (registro, depósito, bono del 50%, "no puedo registrarme"), incluí el link de afiliado exacto: https://go.libertex-affiliates.com/visit/?bta=69222&nci=22420&afp=VFX — sin este link específico el registro no genera la relación correcta con VFX.
8. Para pagos de membresía: ANTES de mandar cualquier link, preguntá si la persona ya tiene cuenta en VFX o sería su primera vez (mucha gente ya tiene cuenta sin saberlo, por ejemplo si se registró antes por el flujo del broker). Nunca mandes los dos links juntos. Si no está registrado, mandalo a https://vfxsignals.com/registro (ahí elige entre tarjeta, USDT o transferencia, y es paso obligatorio para acceder al canal VIP). Si ya está registrado, mandalo a https://vfxsignals.com/app a entrar con usuario y clave y comprar/renovar desde "Mi cuenta". Si alguien ya completó el registro antes (o dice "ya hice esto"), NUNCA lo mandes a registrarse de nuevo — siempre es entrar a vfxsignals.com/app, y si no recuerda la contraseña, restablecerla desde ahí (ver sección 7.1 de la base).
9. Nunca compartas datos sensibles que no estén en la base de conocimiento (no inventes wallets, links o números).
10. Sos un vendedor, no solo soporte, pero eso no significa interrogar a la persona después de cada mensaje. Terminá con una pregunta de avance SOLO cuando tiene sentido (después de dar info clave como precio o pasos, cuando el usuario está indeciso, o cuando claramente espera que vos sigas la conversación). Si la persona te agradece, dice "ya lo hago", "dale", "ahí voy" o cierra el intercambio de forma natural, dejalo así — no le agregues otra pregunta encima, dejá que sea ella la que retome cuando quiera. Ver sección 19 de la base de conocimiento para las técnicas exactas de cierre y cuándo aplican.
11. Si alguien pregunta cómo entrar gratis o por una promo de mes gratis, preguntá si ya tuvo alguna membresía antes (sección 5 de la base) SOLO la primera vez que surge el tema en la conversación. Una vez que el usuario contestó (nuevo o no nuevo), nunca más se lo vuelvas a preguntar en ese chat — usá esa respuesta para todo lo que sigue, incluso si cambian de tema y vuelven a hablar de depósitos más adelante.
12. NUNCA menciones "TCT" ni "The Circle Traders" en una respuesta. De cara al usuario todo es marca VFX Signals únicamente (ej: decí "la Academia" o "Academia de VFX", nunca "Academia TCT").
13. Tenés imágenes disponibles para mandar cuando realmente ayuden a entender algo visual. Para mandar una, escribí el tag exacto en tu respuesta (en cualquier parte del texto, se va a quitar antes de enviar):
- [IMG:planes_deposito] → tabla de planes por depósito
- [IMG:libertex_pasos] → paso a paso de registro y verificación en Libertex
- [IMG:libertex_id_mt5] → dónde encontrar el número de cuenta/ID de MT5 dentro de la app de Libertex
- [IMG:tabla_lotaje] → tabla de lotaje recomendado por activo
- [IMG:trade_us30] → cómo tomar el trade en US30
- [IMG:trade_xauusd] → cómo tomar el trade en XAUUSD
- [IMG:trade_btc] → cómo tomar el trade en BTC/USD
- [IMG:pago_confirmado_vip] → pantalla de "¡Pago confirmado!" con botón "Unirme al grupo VIP" (mandar SIEMPRE después de pago confirmado)
- [IMG:app_abrir_bot] → pantalla del dashboard con botón "Abrir bot" (mandar cuando no le aparece nada en Telegram)
Si el usuario manda una imagen que parece un comprobante de pago o transferencia bancaria: confirmale que se ve bien, y si es nuevo mandalo a https://vfxsignals.com/registro-broker para registrar ese depósito (sección 7.0 de la base). Usalas con criterio — solo cuando el usuario está en ese paso puntual. La imagen siempre se manda ANTES que tu texto, así que referenciala con 👆, nunca 👇.
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

// Marca que un humano (Víctor, escribiendo desde su propio celular) respondió este chat.
// A partir de acá, isHumanActive() va a devolver true por 24hs y el bot no va a responder ese chat.
export async function markHumanReply(chatKey) {
  await supabase.from('chat_status').upsert({
    chat_id: String(chatKey),
    last_human_reply_at: new Date().toISOString(),
  });
}

// ---------- Generar respuesta con Claude ----------
export async function generateReply(chatKey, userMessage) {
  const history = getHistory(chatKey);
  const maxRetries = 4; // antes 2 — el error de red tipo "premature close" es intermitente y a veces
                          // necesita más de dos intentos para pescar una conexión sana.

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        // Prompt caching: la base de conocimiento es la misma en cada mensaje, así que Anthropic
        // la cachea y no la vuelve a "cobrar" completa cada vez — ayuda a no pegarle al límite de uso.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [...history, { role: 'user', content: userMessage }],
      });

      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    } catch (err) {
      const isRateLimit = err?.error?.error?.type === 'rate_limit_error' || err?.status === 429 || err?.headers?.['retry-after'] !== undefined;
      const isNetworkErr = err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.code === 'ECONNRESET' || err?.message?.includes('premature close') || err?.message?.includes('fetch');
      if ((isRateLimit || isNetworkErr) && attempt < maxRetries) {
        const retryAfter = err?.headers?.['retry-after'] || err?.headers?.get?.('retry-after');
        // Backoff progresivo para los errores de red (1.5s, 3s, 4.5s, 6s) en vez de siempre 3s fijo —
        // le da más margen a la conexión de recuperarse si el problema persiste un par de segundos.
        const waitMs = isRateLimit
          ? (retryAfter ? Number(retryAfter) * 1000 : 15000)
          : 1500 * (attempt + 1);
        console.error(`[Claude] Error (${isRateLimit ? 'rate limit' : 'red'}). Reintentando en ${waitMs / 1000}s (intento ${attempt + 1}/${maxRetries})...`);
        await sleep(waitMs);
        continue;
      }
      throw err; // se lo pasamos al caller para que mande el mensaje de fallback
    }
  }
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

// ---------- Transcripción de audios con Whisper (OpenAI) ----------
export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  if (!openai) {
    console.warn('[Audio] OPENAI_API_KEY no configurada, no se puede transcribir.');
    return null;
  }
  try {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'ogg';
    const tmpPath = path.join('/tmp', `audio_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, audioBuffer);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'es',
    });
    fs.unlinkSync(tmpPath); // limpiamos el archivo temporal
    return transcription.text?.trim() || null;
  } catch (err) {
    console.error('[Audio] Error transcribiendo:', err.message);
    return null;
  }
}

// ---------- Análisis de imágenes con Claude Vision ----------
export async function analyzeImage(imageBuffer, mimeType = 'image/jpeg', contextText = '') {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Comprimir la imagen antes de mandarla a Claude para evitar errores de red con imágenes grandes
      let processedBuffer = imageBuffer;
      try {
        processedBuffer = await sharp(imageBuffer)
          .resize({ width: 1024, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        mimeType = 'image/jpeg';
      } catch (sharpErr) {
        console.warn('[Imagen] No se pudo comprimir, usando original:', sharpErr.message);
      }
      const base64 = processedBuffer.toString('base64');
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            {
              type: 'text',
              text: contextText
                ? `El usuario mandó esta imagen y dijo: "${contextText}". Respondé en base a lo que ves y a la base de conocimiento.`
                : 'El usuario mandó esta imagen sin texto. Describí brevemente lo que ves y respondé si es relevante para VFX Signals (ej: comprobante de pago, captura de error, ID de cuenta, etc.).',
            },
          ],
        }],
      });
      return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    } catch (err) {
      const isNetworkErr = err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.code === 'ECONNRESET' || err?.message?.includes('premature close');
      if (isNetworkErr && attempt < maxRetries) {
        console.error(`[Imagen] Error de red. Reintentando en 3s (intento ${attempt + 1}/${maxRetries})...`);
        await sleep(3000);
        continue;
      }
      console.error('[Imagen] Error analizando:', err.message);
      return null;
    }
  }
  return null;
}

// ---------- Seguimiento automático espaciado (sección 19.7 de la base de conocimiento) ----------
// Si el bot respondió y la persona no vuelve a escribir en un rato, se manda UN solo mensaje
// corto de seguimiento. Se cancela si la persona escribe de nuevo o si responde un humano.
const followUpTimers = new Map(); // chatKey -> timeoutId
const FOLLOW_UP_DELAY_MS = 17 * 60 * 1000; // ~17 min (dentro del rango 15-20 que pidió Nicolás)

const FOLLOW_UP_MESSAGES = [
  '¿Cómo te fue con eso? ¿Pudiste avanzar?',
  '¿Todo bien con el registro? Cualquier cosa avisame.',
  'Che, ¿lograste hacerlo o te trabaste en algún paso?',
  '¿Cómo vas con eso? Acá ando si necesitás una mano.',
];

export function scheduleFollowUp(chatKey, sendFn) {
  cancelFollowUp(chatKey); // si había uno pendiente, lo reseteamos
  const timeoutId = setTimeout(async () => {
    followUpTimers.delete(chatKey);
    const stillPaused = await isHumanActive(chatKey);
    if (stillPaused) return; // si un humano ya tomó el chat, no mandamos nada
    const message = FOLLOW_UP_MESSAGES[Math.floor(Math.random() * FOLLOW_UP_MESSAGES.length)];
    pushToHistory(chatKey, 'assistant', message);
    await sendFn(message);
  }, FOLLOW_UP_DELAY_MS);
  followUpTimers.set(chatKey, timeoutId);
}

export function cancelFollowUp(chatKey) {
  const existing = followUpTimers.get(chatKey);
  if (existing) {
    clearTimeout(existing);
    followUpTimers.delete(chatKey);
  }
}
