import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import {
  imageMap,
  IMAGES_DIR,
  FALLBACK_MESSAGE,
  pushToHistory,
  isHumanActive,
  markUrgent,
  generateReply,
  extractImagesAndCleanText,
  randomDelayMs,
  sleep,
} from './core.js';

// Carpeta donde se guarda la sesión de WhatsApp (login). DEBE vivir en un Volume persistente
// de Railway (ver README) — si no, hay que volver a escanear el QR en cada redeploy.
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), 'whatsapp-auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

function chatKey(jid) {
  return `wa:${jid}`; // prefijo para no mezclar con chats de Telegram en Supabase/historial
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // bajamos el ruido de logs de Baileys; cambiar a 'info' para debug
    printQRInTerminal: false, // lo manejamos manualmente abajo para loguearlo más claro
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Escaneá este QR desde WhatsApp (Dispositivos vinculados) para conectar el bot:');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Conexión cerrada.', statusCode, '¿Reconectar?', shouldReconnect);
      if (shouldReconnect) startWhatsApp();
      else console.log('[WhatsApp] Sesión cerrada (logout). Hay que volver a escanear el QR.');
    } else if (connection === 'open') {
      console.log('VFX Support Bot (WhatsApp) corriendo ✅');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue; // ignoramos mensajes propios y vacíos

      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue; // ignoramos grupos, solo chats 1 a 1

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        null;

      if (!text) continue; // ignoramos audios/imágenes/stickers por ahora

      const key = chatKey(jid);

      try {
        const paused = await isHumanActive(key);
        if (paused) {
          console.log(`[WhatsApp] Chat ${jid} pausado (respuesta humana reciente). No responde el bot.`);
          continue;
        }

        // Regla anti-baneo: simular tiempo humano de respuesta antes de contestar (sección 20 de la base)
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(randomDelayMs(2, 6));

        const reply = await generateReply(key, text);

        pushToHistory(key, 'user', text);
        pushToHistory(key, 'assistant', reply);

        if (reply.includes('EN_BREVE_ASESOR')) {
          await sock.sendMessage(jid, { text: FALLBACK_MESSAGE });
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
              await sock.sendMessage(jid, { image: fs.readFileSync(filePath) });
            } catch (imgErr) {
              console.error(`[WhatsApp] Error enviando imagen "${tag}":`, imgErr.message);
            }
          } else {
            console.error(`[WhatsApp] Imagen no encontrada para el tag "${tag}": ${filePath}`);
          }
        }

        await sock.sendMessage(jid, { text: cleanReply });
        await sock.sendPresenceUpdate('paused', jid);
      } catch (err) {
        console.error('[WhatsApp] Error procesando mensaje:', err);
        await sock.sendMessage(jid, { text: FALLBACK_MESSAGE });
        await markUrgent(key, text);
      }
    }
  });

  return sock;
}

startWhatsApp();
