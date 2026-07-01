import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import {
  imageMap,
  IMAGES_DIR,
  FALLBACK_MESSAGE,
  pushToHistory,
  isHumanActive,
  markUrgent,
  markHumanReply,
  generateReply,
  extractImagesAndCleanText,
  randomDelayMs,
  sleep,
  scheduleFollowUp,
  cancelFollowUp,
  transcribeAudio,
  analyzeImage,
} from './core.js';

// Carpeta donde se guarda la sesión de WhatsApp (login). DEBE vivir en un Volume persistente
// de Railway (ver README) — si no, hay que volver a escanear el QR en cada redeploy.
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), 'whatsapp-auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;

// Resguardo: errores de sesión/cifrado de Baileys (común tras reconexiones forzadas) no deberían
// tirar abajo todo el proceso. Los logueamos y seguimos andando.
process.on('unhandledRejection', (err) => {
  console.error('[WhatsApp] unhandledRejection (no debería crashear el proceso):', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[WhatsApp] uncaughtException (no debería crashear el proceso):', err?.message || err);
});

// ---------- Servidor web: muestra el QR como imagen para escanear fácil desde el celular ----------
let latestQrDataUrl = null;
let connectionStatus = 'Iniciando...';

const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (!latestQrDataUrl) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;"><h2>${connectionStatus}</h2><p>Si ya estaba conectado, no hace falta escanear nada. Si esperabas un QR, refrescá esta página en unos segundos.</p></body></html>`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding-top:30px;">
          <h2>Escaneá este QR desde WhatsApp</h2>
          <p>Configuración → Dispositivos vinculados → Vincular un dispositivo</p>
          <img src="${latestQrDataUrl}" style="width:300px;height:300px;" />
          <p style="color:#888;">Esta página se actualiza sola si el QR vence — refrescá si pasaron más de 30 segundos.</p>
        </body>
      </html>
    `);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Estado: ${connectionStatus}. Visitá /qr para ver el código QR.`);
});

server.listen(PORT, () => {
  console.log(`[WhatsApp] Servidor web corriendo en el puerto ${PORT}. Visitá /qr en el dominio público de este servicio para escanear.`);
});

function chatKey(jid) {
  return `wa:${jid}`; // prefijo para no mezclar con chats de Telegram en Supabase/historial
}

// IDs de los mensajes que el BOT mismo envió. Sirve para distinguir, entre los mensajes "fromMe"
// que llegan por messages.upsert, cuáles los mandó el bot y cuáles los escribió Víctor a mano
// desde su celular real (mismo número, por eso ambos aparecen como "fromMe" en WhatsApp/Baileys).
const botSentMessageIds = new Set();
function trackBotMessage(sendResult) {
  const id = sendResult?.key?.id;
  if (id) botSentMessageIds.add(id);
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WhatsApp] Usando versión de protocolo: ${version.join('.')}`);

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }), // bajamos el ruido de logs de Baileys; cambiar a 'info' para debug
    printQRInTerminal: false, // lo manejamos manualmente abajo para loguearlo más claro
    browser: ['VFX Signals Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Nuevo QR generado. Andá a la URL pública del servicio + /qr para escanearlo.');
      connectionStatus = 'Esperando que escanees el QR';
      try {
        latestQrDataUrl = await QRCode.toDataURL(qr, { width: 400 });
      } catch (qrErr) {
        console.error('[WhatsApp] Error generando imagen del QR:', qrErr.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Conexión cerrada.', statusCode, '¿Reconectar?', shouldReconnect);
      connectionStatus = `Conexión cerrada (${statusCode}). ${shouldReconnect ? 'Reintentando...' : 'Hay que volver a escanear el QR.'}`;
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 5000); // esperamos 5s antes de reintentar
      } else {
        console.log('[WhatsApp] Sesión cerrada (logout). Hay que volver a escanear el QR.');
      }
    } else if (connection === 'open') {
      console.log('VFX Support Bot (WhatsApp) corriendo ✅');
      connectionStatus = '✅ Conectado y funcionando. No hace falta escanear nada.';
      latestQrDataUrl = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // ignoramos grupos y estados de WA

      const key = chatKey(jid);

      // Si el mensaje es "fromMe" (mismo número), puede ser del bot o de Víctor escribiendo a mano.
      if (msg.key.fromMe) {
        if (botSentMessageIds.has(msg.key.id)) {
          botSentMessageIds.delete(msg.key.id); // ya lo identificamos, limpiamos memoria
        } else {
          // Es Víctor respondiendo manualmente desde su celular: pausamos el bot 24hs en este chat.
          console.log(`[WhatsApp] Víctor respondió manualmente en ${jid}. Pausando el bot 24hs ahí.`);
          await markHumanReply(key);
          cancelFollowUp(key); // si había un seguimiento pendiente, ya no corresponde
        }
        continue; // nunca generamos respuesta a un mensaje que salió de este mismo número
      }

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        null;

      // --- Audio (nota de voz) ---
      const audioMsg = msg.message.audioMessage || msg.message.pttMessage;
      // --- Imagen ---
      const imageMsg = msg.message.imageMessage;

      // Si no hay ningún tipo de contenido soportado, ignoramos
      if (!text && !audioMsg && !imageMsg) continue;

      cancelFollowUp(key); // la persona escribió de nuevo, cualquier seguimiento pendiente ya no aplica

      try {
        const paused = await isHumanActive(key);
        if (paused) {
          console.log(`[WhatsApp] Chat ${jid} pausado (respuesta humana reciente). No responde el bot.`);
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid);
        await sleep(randomDelayMs(5, 12));

        let reply = null;

        if (audioMsg) {
          // Descargamos y transcribimos el audio
          console.log(`[WhatsApp] Audio recibido de ${jid}, transcribiendo...`);
          const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          const transcription = await transcribeAudio(audioBuffer, audioMsg.mimetype || 'audio/ogg');
          if (transcription) {
            console.log(`[WhatsApp] Transcripción: "${transcription}"`);
            reply = await generateReply(key, `[Audio transcripto]: ${transcription}`);
            pushToHistory(key, 'user', `[Audio transcripto]: ${transcription}`);
          } else {
            reply = 'Perdón, no pude escuchar bien el audio. ¿Me lo podés escribir?';
            pushToHistory(key, 'user', '[Audio no transcripto]');
          }
        } else if (imageMsg) {
          // Descargamos y analizamos la imagen con Claude Vision
          console.log(`[WhatsApp] Imagen recibida de ${jid}, analizando...`);
          const imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          const caption = imageMsg.caption || '';
          reply = await analyzeImage(imageBuffer, imageMsg.mimetype || 'image/jpeg', caption);
          pushToHistory(key, 'user', caption ? `[Imagen con texto: "${caption}"]` : '[Imagen sin texto]');
          if (!reply) reply = 'Vi la imagen, pero no pude procesarla bien. ¿Me explicás qué necesitás?';
        } else {
          // Texto normal
          reply = await generateReply(key, text);
          pushToHistory(key, 'user', text);
        }

        pushToHistory(key, 'assistant', reply);

        if (reply.includes('EN_BREVE_ASESOR')) {
          trackBotMessage(await sock.sendMessage(jid, { text: FALLBACK_MESSAGE }));
          await markUrgent(key, text);
          continue;
        }

        const { imageTags, cleanReply } = extractImagesAndCleanText(reply);

        for (const tag of imageTags) {
          const fileName = imageMap[tag];
          if (!fileName) continue;
          const filePath = path.join(IMAGES_DIR, fileName);
          if (fs.existsSync(filePath)) {
            try {
              trackBotMessage(await sock.sendMessage(jid, { image: fs.readFileSync(filePath) }));
            } catch (imgErr) {
              console.error(`[WhatsApp] Error enviando imagen "${tag}":`, imgErr.message);
            }
          } else {
            console.error(`[WhatsApp] Imagen no encontrada para el tag "${tag}": ${filePath}`);
          }
        }

        trackBotMessage(await sock.sendMessage(jid, { text: cleanReply }));
        await sock.sendPresenceUpdate('paused', jid);

        // Programamos un seguimiento único por si la persona no vuelve a escribir (sección 19.7)
        scheduleFollowUp(key, async (followUpText) => {
          await sock.sendPresenceUpdate('composing', jid);
          await sleep(randomDelayMs(2, 5));
          trackBotMessage(await sock.sendMessage(jid, { text: followUpText }));
          await sock.sendPresenceUpdate('paused', jid);
        });
      } catch (err) {
        console.error('[WhatsApp] Error procesando mensaje:', err);
        trackBotMessage(await sock.sendMessage(jid, { text: FALLBACK_MESSAGE }));
        await markUrgent(key, text);
      }
    }
  });

  return sock;
}

startWhatsApp();
