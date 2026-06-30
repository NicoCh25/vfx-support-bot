import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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

const PORT = process.env.PORT || 3000;

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
