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
// tirar abajo todo el proceso.
process.on('unhandledRejection', (err) => {
    console.error('[WhatsApp] unhandledRejection:', err?.message || 'Error desconocido');
});
process.on('uncaughtException', (err) => {
    console.error('[WhatsApp] uncaughtException:', err?.message || 'Error desconocido');
});

// ---------- Estado global de conexión ----------
let latestQrDataUrl = null;
let connectionStatus = 'Iniciando...';
let isConnected = false;

// ---------- Servidor web: /qr con auto-refresh y botón de reset ----------
const server = http.createServer(async (req, res) => {

                                   // POST /reset-session → borra la carpeta de auth y reinicia el proceso
                                   if (req.method === 'POST' && req.url === '/reset-session') {
                                         // Protección mínima: solo aceptamos si el bot NO está conectado, o si se pasa ?force=1
      const force = req.url.includes('force=1') || !isConnected;
                                         if (!force) {
                                                 res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                                                 res.end('El bot está conectado. Usá /reset-session?force=1 para forzar el reset igual.');
                                                 return;
                                         }
                                         try {
                                                 fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                                                 fs.mkdirSync(AUTH_DIR, { recursive: true });
                                                 console.log('[WhatsApp] Sesión reseteada desde /reset-session. Reiniciando...');
                                                 latestQrDataUrl = null;
                                                 isConnected = false;
                                                 connectionStatus = 'Sesión reseteada. Generando nuevo QR...';
                                                 res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                                                 res.end('OK — sesión borrada. El bot va a generar un QR nuevo en segundos. Refrescá /qr.');
                                                 // Reiniciamos la conexión de WhatsApp
                                           setTimeout(() => startWhatsApp(), 2000);
                                         } catch (e) {
                                                 res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                                                 res.end('Error al borrar la sesión: ' + e.message);
                                         }
                                         return;
                                   }

                                   // GET /qr → muestra el QR o el estado de conexión
                                   if (req.url === '/qr' || req.url === '/') {
                                         res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (isConnected) {
              // Ya conectado: mostrar estado verde y botón de reset por si hay que re-vincular
                                           res.end(`<!DOCTYPE html>
                                           <html lang="es">
                                           <head>
                                             <meta charset="utf-8">
                                               <meta name="viewport" content="width=device-width, initial-scale=1">
                                                 <title>VFX Bot – Estado</title>
                                                   <style>
                                                       body { font-family: sans-serif; text-align: center; padding: 40px 20px; background: #0d1117; color: #e6edf3; }
                                                           h1 { font-size: 2rem; color: #3fb950; }
                                                               p { color: #8b949e; margin: 8px 0; }
                                                                   .btn-reset {
                                                                         display: inline-block; margin-top: 30px; padding: 12px 24px;
                                                                               background: #da3633; color: white; border: none; border-radius: 8px;
                                                                                     font-size: 1rem; cursor: pointer; text-decoration: none;
                                                                                         }
                                                                                             .btn-reset:hover { background: #b91c1c; }
                                                                                                 .info { background: #161b22; border-radius: 10px; padding: 20px; margin: 20px auto; max-width: 400px; }
                                                                                                   </style>
                                                                                                   </head>
                                                                                                   <body>
                                                                                                     <h1>✅ Bot conectado y funcionando</h1>
                                                                                                       <div class="info">
                                                                                                           <p>Estado: <strong>${connectionStatus}</strong></p>
                                                                                                               <p>No hace falta escanear nada.</p>
                                                                                                                 </div>
                                                                                                                   <p style="color:#8b949e; font-size:0.85rem;">¿Necesitás volver a vincular el número? Usá el botón de abajo para resetear la sesión y generar un QR nuevo.</p>
                                                                                                                     <form method="POST" action="/reset-session?force=1" onsubmit="return confirm('¿Seguro? Esto va a desconectar el bot y vas a tener que escanear un QR nuevo.')">
                                                                                                                         <button type="submit" class="btn-reset">🔄 Resetear sesión y generar QR nuevo</button>
                                                                                                                           </form>
                                                                                                                           </body>
                                                                                                                           </html>`);
              return;
      }

      if (latestQrDataUrl) {
              // Hay QR listo para escanear — auto-refresh cada 20s (los QR de WA duran ~60s)
                                           res.end(`<!DOCTYPE html>
                                           <html lang="es">
                                           <head>
                                             <meta charset="utf-8">
                                               <meta name="viewport" content="width=device-width, initial-scale=1">
                                                 <meta http-equiv="refresh" content="20">
                                                   <title>VFX Bot – Escanear QR</title>
                                                     <style>
                                                         body { font-family: sans-serif; text-align: center; padding: 20px; background: #0d1117; color: #e6edf3; }
                                                             h1 { font-size: 1.5rem; color: #f0f6fc; }
                                                                 p { color: #8b949e; }
                                                                     img { border: 4px solid #3fb950; border-radius: 12px; margin: 16px auto; display: block; }
                                                                         .steps { background: #161b22; border-radius: 10px; padding: 16px; margin: 20px auto; max-width: 360px; text-align: left; }
                                                                             .steps ol { margin: 0; padding-left: 20px; }
                                                                                 .steps li { margin: 6px 0; color: #c9d1d9; }
                                                                                     .timer { color: #f0b429; font-size: 0.85rem; margin-top: 8px; }
                                                                                       </style>
                                                                                       </head>
                                                                                       <body>
                                                                                         <h1>📱 Escaneá este QR desde WhatsApp</h1>
                                                                                           <img src="${latestQrDataUrl}" width="300" height="300" alt="QR de WhatsApp" />
                                                                                             <p class="timer">⏱ Esta página se refresca sola cada 20 segundos con un QR nuevo.</p>
                                                                                               <div class="steps">
                                                                                                   <ol>
                                                                                                         <li>Abrí WhatsApp en el celular de Víctor</li>
                                                                                                               <li>Configuración → <strong>Dispositivos vinculados</strong></li>
                                                                                                                     <li>Tocá <strong>"Vincular un dispositivo"</strong></li>
                                                                                                                           <li>Apuntá la cámara a este QR</li>
                                                                                                                               </ol>
                                                                                                                                 </div>
                                                                                                                                 </body>
                                                                                                                                 </html>`);
              return;
      }

      // Sin QR todavía — auto-refresh cada 5s esperando que aparezca
      res.end(`<!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="refresh" content="5">
              <title>VFX Bot – Iniciando</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #0d1117; color: #e6edf3; }
                        h2 { color: #f0b429; }
                            p { color: #8b949e; }
                                .spinner { font-size: 2rem; animation: spin 1.5s linear infinite; display: inline-block; }
                                    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                                      </style>
                                      </head>
                                      <body>
                                        <div class="spinner">⏳</div>
                                          <h2>${connectionStatus}</h2>
                                            <p>Esta página se refresca sola cada 5 segundos...</p>
                                              <p style="font-size:0.8rem; color:#555;">Si tarda más de 30 segundos, revisá los logs del servicio en Railway.</p>
                                              </body>
                                              </html>`);
                                         return;
                                   }

                                   // Cualquier otra ruta
                                   res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Estado: ${connectionStatus}. Visitá /qr para ver el código QR o el estado de conexión.`);
});

server.listen(PORT, () => {
    console.log(`[WhatsApp] Servidor web en puerto ${PORT}. Visitá /qr en el dominio público del servicio.`);
});

function chatKey(jid) {
    return `wa:${jid}`;
}

// IDs de los mensajes que el BOT mismo envió.
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
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['VFX Signals Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

                 if (qr) {
                         console.log('📱 Nuevo QR generado. Andá a /qr para escanearlo.');
                         connectionStatus = 'Esperando que escanees el QR';
                         isConnected = false;
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
                         isConnected = false;
                         connectionStatus = `Conexión cerrada (${statusCode}). ${shouldReconnect ? 'Reintentando...' : 'Sesión cerrada — hay que escanear el QR de nuevo.'}`;
                         if (shouldReconnect) {
                                   setTimeout(() => startWhatsApp(), 5000);
                         } else {
                                   console.log('[WhatsApp] Sesión cerrada (logout). Hay que volver a escanear el QR.');
                         }
                 } else if (connection === 'open') {
                         console.log('VFX Support Bot (WhatsApp) corriendo ✅');
                         isConnected = true;
                         connectionStatus = '✅ Conectado y funcionando. No hace falta escanear nada.';
                         latestQrDataUrl = null;
                 }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

                 for (const msg of messages) {
                         if (!msg.message) continue;

          const jid = msg.key.remoteJid;
                         if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

          const key = chatKey(jid);

          if (msg.key.fromMe) {
                    if (botSentMessageIds.has(msg.key.id)) {
                                botSentMessageIds.delete(msg.key.id);
                    } else {
                                console.log(`[WhatsApp] Víctor respondió manualmente en ${jid}. Pausando el bot 24hs ahí.`);
                                await markHumanReply(key);
                                cancelFollowUp(key);
                    }
                    continue;
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
                                       messageForAI = caption
                                         ? `El usuario mandó una imagen con este texto: "${caption}". Respondé de forma natural y breve, como si fueras una persona real que recibió la foto. Preguntale qué necesita o en qué parte del proceso está, sin revelar que sos un bot ni que no podés ver la imagen.`
                                                     : `El usuario mandó una imagen sin texto. Respondé de forma natural y breve, como si fueras una persona real que recibió la foto y quiere saber de qué se trata. Ejemplo: "Joya, la veo 👌 ¿Es el comprobante del depósito?" o "Dale, ¿qué me estás mostrando?" — elegí el tono según el contexto de la conversación.`;
                           } else if (audioMsg && !text) {
                                       messageForAI = 'El usuario mandó un audio. Respondé de forma natural como si fuera una persona real: pedile que te escriba lo que necesita porque en este momento no podés escuchar audios, pero de forma amigable y sin sonar a bot. Ej: "Bro, estoy en modo texto ahora 😅 ¿Me escribís lo que necesitás?"';
                           }

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

                           const messageChunks = splitIntoMessageChunks(cleanReply);
                    for (let i = 0; i < messageChunks.length; i++) {
                                if (i > 0) {
                                              await sock.sendPresenceUpdate('composing', jid);
                                              await sleep(randomDelayMs(1, 3));
                                }
                                trackBotMessage(await sock.sendMessage(jid, { text: messageChunks[i] }));
                    }

                           if (wantsVipLink && detectedEmail) {
                                       const vip = await generateVipLink(detectedEmail);
                                       if (vip?.invite_link) {
                                                     await sleep(randomDelayMs(1, 3));
                                                     trackBotMessage(await sock.sendMessage(jid, {
                                                                     text: `🚀 Acá tenés el acceso al canal VIP (válido ${vip.expires_in_hours}h, uso único):\n${vip.invite_link}`,
                                                     }));
                                       } else {
                                                     console.error(`[WhatsApp] No se pudo generar link VIP para ${detectedEmail}`);
                                                     await markUrgent(key, `Falló generación de link VIP para ${detectedEmail}`);
                                       }
                           }

                           await sock.sendPresenceUpdate('paused', jid);

                           scheduleFollowUp(key, async (followUpText) => {
                                       await sock.sendPresenceUpdate('composing', jid);
                                       await sleep(randomDelayMs(2, 5));
                                       trackBotMessage(await sock.sendMessage(jid, { text: followUpText }));
                                       await sock.sendPresenceUpdate('paused', jid);
                           });
          } catch (err) {
                    console.error('[WhatsApp] Error procesando mensaje:', err?.message || 'Error desconocido');
                    trackBotMessage(await sock.sendMessage(jid, { text: FALLBACK_MESSAGE }));
                    await markUrgent(key, text);
          }
                 }
  });

  return sock;
}

startWhatsApp();
