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
  markHumanReply,
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
  scheduleFollowUp,
  cancelFollowUp,
} from './core.js';

// Carpeta donde se guarda la sesión de WhatsApp (login). DEBE vivir en un Volume persistente
// de Railway (ver README) — si no, hay que volver a escanear el QR en cada redeploy.
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), 'whatsapp-auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;

// Resguardo: errores de sesión/cifrado de Baileys (común tras reconexiones forzadas) no deberían
// tirar abajo todo el proceso. Los logueamos y seguimos andando.
// OJO: nunca dejar que el fallback caiga en imprimir "err" completo — algunos errores de Baileys
// llevan la sesión criptográfica pegada adentro. Siempre logueamos solo el mensaje de texto.
process.on('unhandledRejection', (err) => {
  console.error('[WhatsApp] unhandledRejection (no debería crashear el proceso):', err?.message || 'Error desconocido');
});
process.on('uncaughtException', (err) => {
  console.error('[WhatsApp] uncaughtException (no debería crashear el proceso):', err?.message || 'Error desconocido');
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

      const imageMsg = msg.message.imageMessage;
      const audioMsg = msg.message.audioMessage || msg.message.pttMessage;

      if (!text && !imageMsg && !audioMsg) continue;

      cancelFollowUp(key);

      try {
        const paused = await isHumanActive(key);
        if (paused) {
          console.log(`[WhatsApp] Chat ${jid} pausado (respuesta humana reciente). No responde el bot.`);
          continue;
        }

        await sock.sendPresenceUpdate('composing', jid);
        await sleep(randomDelayMs(5, 12));

        let messageForAI = text;

        if (imageMsg && !text) {
          const caption = imageMsg.caption || '';
          // No descargamos la imagen — le pedimos a Claude que responda de forma natural
          // como si fuera una persona que recibió una foto y quiere entender el contexto
          messageForAI = caption
            ? `El usuario mandó una imagen con este texto: "${caption}". Respondé de forma natural y breve, como si fueras una persona real que recibió la foto. Preguntale qué necesita o en qué parte del proceso está, sin revelar que sos un bot ni que no podés ver la imagen.`
            : `El usuario mandó una imagen sin texto. Respondé de forma natural y breve, como si fueras una persona real que recibió la foto y quiere saber de qué se trata. Ejemplo: "Joya, la veo 👌 ¿Es el comprobante del depósito?" o "Dale, ¿qué me estás mostrando?" — elegí el tono según el contexto de la conversación.`;
        } else if (audioMsg && !text) {
          messageForAI = 'El usuario mandó un audio. Respondé de forma natural como si fuera una persona real: pedile que te escriba lo que necesita porque en este momento no podés escuchar audios, pero de forma amigable y sin sonar a bot. Ej: "Bro, estoy en modo texto ahora 😅 ¿Me escribís lo que necesitás?"';
        }

        // Si el usuario mandó un mail, consultamos su estado real en la plataforma VFX
        // y se lo pasamos a Claude como contexto verificado (ver regla 17 del prompt).
        const detectedEmail = extractEmail(text);
        if (detectedEmail) {
          const status = await checkClienteStatus(detectedEmail);
          const context = buildClienteStatusContext(status);
          if (context) messageForAI = `${context}\n\n${messageForAI}`;
        }

        const reply = await generateReply(key, messageForAI);
        pushToHistory(key, 'user', text || (imageMsg ? '[imagen]' : '[audio]'));
        pushToHistory(key, 'assistant', reply);

        if (reply.includes('EN_BREVE_ASESOR')) {
          trackBotMessage(await sock.sendMessage(jid, { text: FALLBACK_MESSAGE }));
          await markUrgent(key, text);
          continue;
        }

        const { imageTags, cleanReply: replyWithoutImages } = extractImagesAndCleanText(reply);
        const { wantsVipLink, cleanReply } = extractVipLinkRequest(replyWithoutImages);

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

        // Mandamos la respuesta partida en varios mensajes (uno por párrafo), simulando que
        // Adrian está escribiendo y mandando de a poco, como una persona real en el chat.
        const messageChunks = splitIntoMessageChunks(cleanReply);
        for (let i = 0; i < messageChunks.length; i++) {
          if (i > 0) {
            await sock.sendPresenceUpdate('composing', jid);
            await sleep(randomDelayMs(1, 3)); // pausa corta entre mensaje y mensaje
          }
          trackBotMessage(await sock.sendMessage(jid, { text: messageChunks[i] }));
        }

        // Si Adrian pidió el link VIP (usuario con membresía activa que no le abre el grupo),
        // lo generamos y lo mandamos como mensaje aparte, justo después del texto.
        if (wantsVipLink && detectedEmail) {
          const vip = await generateVipLink(detectedEmail);
          if (vip?.invite_link) {
            await sleep(randomDelayMs(1, 3));
            trackBotMessage(await sock.sendMessage(jid, {
              text: `🚀 Acá tenés el acceso al canal VIP (válido ${vip.expires_in_hours}h, uso único):\n${vip.invite_link}`,
            }));
          } else {
            console.error(`[WhatsApp] No se pudo generar link VIP para ${detectedEmail}`);
            // No le mandamos nada raro al cliente — si falla, queda como si el bot no hubiera
            // podido resolverlo solo; mejor que Víctor lo revise a mano.
            await markUrgent(key, `Falló generación de link VIP para ${detectedEmail}`);
          }
        }

        await sock.sendPresenceUpdate('paused', jid);

        // Programamos un seguimiento único por si la persona no vuelve a escribir (sección 19.7)
        scheduleFollowUp(key, async (followUpText) => {
          await sock.sendPresenceUpdate('composing', jid);
          await sleep(randomDelayMs(2, 5));
          trackBotMessage(await sock.sendMessage(jid, { text: followUpText }));
          await sock.sendPresenceUpdate('paused', jid);
        });
      } catch (err) {
        // OJO: nunca loguear el objeto "err" completo acá — los errores de decriptado de Baileys
        // (ej. "Failed to decrypt message", "MessageCounterError") a veces traen la sesión
        // criptográfica completa pegada adentro (privKey, rootKey, etc.), y terminaría expuesta
        // en los logs de Railway. Solo logueamos el mensaje de texto del error.
        console.error('[WhatsApp] Error procesando mensaje:', err?.message || 'Error desconocido');
        trackBotMessage(await sock.sendMessage(jid, { text: FALLBACK_MESSAGE }));
        await markUrgent(key, text);
      }
    }
  });

  return sock;
}

startWhatsApp();
