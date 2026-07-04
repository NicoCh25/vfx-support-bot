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
  extractPasswordResetRequest,
  splitIntoMessageChunks,
  extractEmail,
  cacheEmail,
  getCachedEmail,
  checkClienteStatus,
  buildClienteStatusContext,
  resetPassword,
  fetchNextCampaignMessage,
  markCampaignSent,
  fetchNextRenewalReminder,
  markRenewalReminderSent,
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

// ---------- Alertas a Nicolás por Telegram (independiente de WhatsApp, para que llegue aunque
// la sesión de WhatsApp esté rota) ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_TELEGRAM_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID; // ej: 537747411
if (!TELEGRAM_BOT_TOKEN || !OWNER_TELEGRAM_CHAT_ID) {
  console.warn('[Alertas] Faltan TELEGRAM_BOT_TOKEN / OWNER_TELEGRAM_CHAT_ID — no se van a poder mandar alertas de problemas.');
}

let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // no mandar más de una alerta cada 15 min, para no saturar

async function sendOwnerAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !OWNER_TELEGRAM_CHAT_ID) return;
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return; // ya se mandó una alerta hace poco, no repetir
  lastAlertAt = now;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) {
    console.error('[Alertas] No se pudo mandar la alerta por Telegram:', err.message);
  }
}

// ---------- Detección de ráfagas de errores de sesión (posible corrupción de Baileys) ----------
// Estos errores ("Failed to decrypt...", "MessageCounterError", "Bad MAC") los imprime Baileys
// internamente por su cuenta, sin pasar por nuestro código — por eso interceptamos console.error
// para poder contarlos igual, sin cambiar cómo se ven en los logs de Railway.
const originalConsoleError = console.error.bind(console);
let decryptErrorTimestamps = [];
const DECRYPT_ERROR_WINDOW_MS = 30 * 1000; // ventana de 30s
const DECRYPT_ERROR_THRESHOLD = 8; // si hay 8+ errores de este tipo en esa ventana, algo está mal

console.error = (...args) => {
  originalConsoleError(...args);
  const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  if (/Failed to decrypt|MessageCounterError|Bad MAC/.test(text)) {
    const now = Date.now();
    decryptErrorTimestamps.push(now);
    decryptErrorTimestamps = decryptErrorTimestamps.filter((t) => now - t < DECRYPT_ERROR_WINDOW_MS);
    if (decryptErrorTimestamps.length >= DECRYPT_ERROR_THRESHOLD) {
      sendOwnerAlert(
        '⚠️ El bot de WhatsApp está teniendo errores de sesión seguidos (probable sesión corrupta, tipo "Bad MAC"/"MessageCounterError"). Puede que no esté respondiendo mensajes. Revisá los Deploy Logs en Railway — probablemente haya que re-vincular el WhatsApp (botón "Resetear sesión" en /qr).'
      );
    }
  }
};

// ---------- Detección de bucle de reconexión (QR que se regenera solo, sin que nadie escanee) ----------
let closeEventTimestamps = [];
const RECONNECT_LOOP_WINDOW_MS = 3 * 60 * 1000; // 3 minutos
const RECONNECT_LOOP_THRESHOLD = 5; // 5+ desconexiones en ese tiempo = bucle

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
let currentSock = null; // referencia al socket activo, para poder cerrarlo desde el botón de reset

// Borra todo lo que haya en la carpeta de sesión y fuerza una reconexión desde cero.
// Ya no hace falta ir a Railway a cambiar WHATSAPP_AUTH_DIR a mano cada vez que la sesión se
// corrompe — con este botón en /qr alcanza, y siempre usa la MISMA carpeta (no acumula v2, v3, v4...).
async function resetSession() {
  stopCampaignLoop();
  stopRenewalReminderLoop();
  try {
    const files = fs.readdirSync(AUTH_DIR);
    for (const f of files) {
      fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
    }
    console.log('[WhatsApp] Carpeta de sesión vaciada por reset manual desde /qr.');
  } catch (err) {
    console.error('[WhatsApp] Error borrando la carpeta de sesión:', err.message);
  }

  latestQrDataUrl = null;
  connectionStatus = 'Sesión reseteada. Generando QR nuevo...';

  if (currentSock) {
    // Esto dispara el 'close' del socket, que ya tiene su propio manejo de reconexión
    // automática (ver connection.update más abajo) — no hace falta duplicar ese llamado acá.
    try {
      currentSock.end(new Error('Reset manual solicitado desde /qr'));
    } catch (err) {
      console.error('[WhatsApp] Error cerrando el socket viejo:', err.message);
      setTimeout(() => startWhatsApp(), 1000); // resguardo por si end() falla silenciosamente
    }
  } else {
    setTimeout(() => startWhatsApp(), 1000); // todavía no había conexión armada, arrancamos directo
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/qr/reset' && req.method === 'POST') {
    await resetSession();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/qr') {
    if (!latestQrDataUrl) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <body style="font-family:sans-serif;text-align:center;padding-top:50px;">
            <h2>${connectionStatus}</h2>
            <p>Si ya estaba conectado, no hace falta escanear nada. Si esperabas un QR, esta página se refresca sola.</p>
            <button onclick="resetSesion()" style="margin-top:30px;padding:12px 20px;background:#c0392b;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer;">Resetear sesión y generar QR nuevo</button>
            <p style="color:#888;font-size:13px;margin-top:10px;">Usar solo si la sesión está fallando (errores de "Bad MAC" en los logs) y no vinieron mensajes nuevos hace rato.</p>
            <script>
              function resetSesion() {
                if (!confirm('¿Seguro? Esto corta la sesión actual y vas a tener que escanear un QR nuevo.')) return;
                fetch('/qr/reset', { method: 'POST' }).then(() => {
                  document.body.innerHTML = '<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">Reseteando... refrescá en unos segundos</h2>';
                  setTimeout(() => location.reload(), 4000);
                });
              }
              setTimeout(() => location.reload(), 15000); // auto-refresh mientras espera el QR
            </script>
          </body>
        </html>
      `);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding-top:30px;">
          <h2>Escaneá este QR desde WhatsApp</h2>
          <p>Configuración → Dispositivos vinculados → Vincular un dispositivo</p>
          <img src="${latestQrDataUrl}" style="width:300px;height:300px;" />
          <p style="color:#888;">Esta página se actualiza sola si el QR vence — no hace falta refrescar a mano.</p>
          <script>setTimeout(() => location.reload(), 15000);</script>
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

// ---------- CRM de prospección: goteo de campañas ----------
// Corre DENTRO de este mismo proceso porque comparte el mismo socket/sesión de WhatsApp que
// usa Adrian para soporte — no se puede tener una segunda conexión de Baileys en paralelo.
// El intervalo entre chequeos NO es el espaciado real entre mensajes (eso ya lo define
// build_campaign_queue en la base de datos, con jitter random) — esto solo pregunta cada 2 min
// "¿hay algo vencido para mandar ya?" y manda como máximo UNO por chequeo, para no ráfaguear.
const CAMPAIGN_POLL_MS = 2 * 60 * 1000; // cada 2 minutos
let campaignInterval = null;

function startCampaignLoop(sock) {
  if (campaignInterval) return; // ya está corriendo, no duplicar
  campaignInterval = setInterval(async () => {
    try {
      const next = await fetchNextCampaignMessage();
      if (!next) return; // nada vencido ahora mismo

      const jid = next.whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
      await sock.sendPresenceUpdate('composing', jid);
      await sleep(randomDelayMs(3, 8)); // igual de "humano" que una respuesta de soporte
      const result = await sock.sendMessage(jid, { text: next.mensaje });
      trackBotMessage(result);
      await sock.sendPresenceUpdate('paused', jid);
      await markCampaignSent(next.recipientId, true);
      console.log(`[Campañas] Mensaje de goteo enviado a ${next.whatsapp}`);
    } catch (err) {
      console.error('[Campañas] Error en el ciclo de goteo:', err?.message || 'Error desconocido');
    }
  }, CAMPAIGN_POLL_MS);
}

function stopCampaignLoop() {
  if (campaignInterval) {
    clearInterval(campaignInterval);
    campaignInterval = null;
  }
}

// ---------- Recordatorio automático de vencimiento (5 días antes, y de nuevo 1 día antes) ----------
// Mismo mecanismo que el goteo de arriba: preguntamos cada rato "¿hay alguien por vencer que
// todavía no avisamos?" y mandamos como máximo uno por chequeo. Esto es proactivo (el bot
// inicia la conversación), pero es hacia gente que YA es cliente activo — no es outreach en frío,
// así que no choca con la regla anti-baneo de nunca escribirle primero a un desconocido.
//
// El espaciado entre CADA mensaje enviado es de 15-20 minutos random (no un intervalo fijo) —
// si hay mucha gente por avisar en el mismo día, tarda lo que tenga que tardar (puede llevar
// horas o un día entero); la prioridad es nunca sonar a bot mandando en ráfaga, no la velocidad.
let renewalTimeoutId = null;
let renewalLoopActive = false;

function scheduleNextRenewalCheck(sock) {
  if (!renewalLoopActive) return;
  const delayMs = randomDelayMs(15 * 60, 20 * 60); // 15 a 20 minutos, en segundos como base
  renewalTimeoutId = setTimeout(() => runRenewalReminderCheck(sock), delayMs);
}

async function runRenewalReminderCheck(sock) {
  try {
    const next = await fetchNextRenewalReminder();
    if (next) {
      const jid = next.whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
      const primerNombre = (next.nombre || '').split(' ')[0] || '';
      const saludo = primerNombre ? `Hola ${primerNombre}! 👋` : 'Hola! 👋';

      const mensaje = next.tipo === '1d'
        ? `${saludo} Te escribo porque mañana (*${next.venceFmt}*) se te vence la membresía de VFX Signals.\n\nSi todavía no sumaste el mes, podés hacerlo ahora mismo entrando a vfxsignals.com/app → "Mi cuenta" — así seguís sin cortes en el canal VIP y las señales 🙌`
        : `${saludo} Te escribo porque tu membresía de VFX Signals vence el *${next.venceFmt}* (en ${next.diasRestantes} día${next.diasRestantes === 1 ? '' : 's'}).\n\nSi querés, ya podés sumar tiempo desde ahora entrando a vfxsignals.com/app → "Mi cuenta" — así no se te corta el acceso al canal VIP ni a las señales. Cualquier duda, escribime 🙌`;

      const imageFileName = imageMap['sumar_mes'];
      if (imageFileName) {
        const filePath = path.join(IMAGES_DIR, imageFileName);
        if (fs.existsSync(filePath)) {
          try {
            trackBotMessage(await sock.sendMessage(jid, { image: fs.readFileSync(filePath) }));
          } catch (imgErr) {
            console.error('[Recordatorios] Error enviando imagen de recordatorio:', imgErr.message);
          }
        }
      }

      await sock.sendPresenceUpdate('composing', jid);
      await sleep(randomDelayMs(3, 8));
      trackBotMessage(await sock.sendMessage(jid, { text: mensaje }));
      await sock.sendPresenceUpdate('paused', jid);
      await markRenewalReminderSent(next.referidoId, next.vence, next.tipo);
      console.log(`[Recordatorios] Aviso (${next.tipo}) enviado a ${next.whatsapp} (vence ${next.venceFmt})`);
    }
  } catch (err) {
    console.error('[Recordatorios] Error en el ciclo de recordatorios:', err?.message || 'Error desconocido');
  }
  scheduleNextRenewalCheck(sock); // programamos el próximo chequeo pase lo que pase
}

function startRenewalReminderLoop(sock) {
  if (renewalLoopActive) return; // ya está corriendo, no duplicar
  renewalLoopActive = true;
  scheduleNextRenewalCheck(sock);
}

function stopRenewalReminderLoop() {
  renewalLoopActive = false;
  if (renewalTimeoutId) {
    clearTimeout(renewalTimeoutId);
    renewalTimeoutId = null;
  }
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
  currentSock = sock; // referencia global, usada por el botón de reset en /qr

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
      stopCampaignLoop(); // no seguir intentando mandar goteo mientras no hay conexión
      stopRenewalReminderLoop();

      // Detectar bucle de reconexión (se cae y arranca de nuevo una y otra vez sin asentarse)
      const now = Date.now();
      closeEventTimestamps.push(now);
      closeEventTimestamps = closeEventTimestamps.filter((t) => now - t < RECONNECT_LOOP_WINDOW_MS);
      if (closeEventTimestamps.length >= RECONNECT_LOOP_THRESHOLD) {
        sendOwnerAlert(
          '🔁 El bot de WhatsApp está en un bucle de reconexión (se desconecta y reconecta varias veces seguidas sin asentarse). Probablemente necesite que entres a revisarlo manualmente en Railway.'
        );
      }

      if (!shouldReconnect) {
        sendOwnerAlert('🔒 El WhatsApp del bot se desvinculó (logout). Hay que entrar a /qr y escanear un código nuevo para volver a conectarlo.');
      }

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 5000); // esperamos 5s antes de reintentar
      } else {
        console.log('[WhatsApp] Sesión cerrada (logout). Hay que volver a escanear el QR.');
      }
    } else if (connection === 'open') {
      console.log('VFX Support Bot (WhatsApp) corriendo ✅');
      connectionStatus = '✅ Conectado y funcionando. No hace falta escanear nada.';
      latestQrDataUrl = null;
      closeEventTimestamps = []; // la conexión se asentó bien, reseteamos el contador de bucle
      startCampaignLoop(sock);
      startRenewalReminderLoop(sock);
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

        // Antes: mostrábamos "escribiendo..." y esperábamos 5-12 segundos — eso es un patrón
        // clarísimo de bot (ninguna persona ve un mensaje y contesta siempre así de rápido).
        // Ahora: nos quedamos en silencio 1-3 minutos (como alguien que vio el mensaje y todavía
        // no pudo/quiso contestar), y recién en los últimos segundos mostramos "escribiendo...".
        // Mostrar "escribiendo" continuo durante los 1-3 minutos sería igual de raro que
        // responder al toque, así que el typing indicator se reserva para el final nomás.
        await sleep(randomDelayMs(60, 180));
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(randomDelayMs(3, 8));

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

        // Si el usuario mandó un mail (ahora o en algún mensaje anterior de este chat),
        // consultamos su estado real en la plataforma VFX y se lo pasamos a Claude como
        // contexto verificado (ver regla 17 del prompt). El mail queda "pegado" al chat para
        // que funcione incluso en mensajes posteriores donde no lo vuelve a escribir.
        const emailInMessage = extractEmail(text);
        if (emailInMessage) cacheEmail(key, emailInMessage);
        const detectedEmail = emailInMessage || getCachedEmail(key);
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
        const { wantsPasswordReset, cleanReply } = extractPasswordResetRequest(replyWithoutImages);

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

        // Si Adrian pidió resetear la contraseña (usuario con membresía activa que no le abre
        // el grupo VIP o perdió el acceso), la generamos y la mandamos como mensaje aparte.
        if (wantsPasswordReset && detectedEmail) {
          const reset = await resetPassword(detectedEmail);
          if (reset?.new_password) {
            await sleep(randomDelayMs(1, 3));
            trackBotMessage(await sock.sendMessage(jid, {
              text: `🔑 Te generé una clave nueva: *${reset.new_password}*\n\nEntrá a vfxsignals.com/app con tu mail (${detectedEmail}) y esa clave, y ahí tocá el botón "Abrir bot" para reconectar tu Telegram y volver a acceder al canal VIP 👌`,
            }));
          } else {
            console.error(`[WhatsApp] No se pudo resetear la contraseña para ${detectedEmail}`);
            // No le mandamos nada raro al cliente — si falla, queda como si el bot no hubiera
            // podido resolverlo solo; mejor que Víctor lo revise a mano.
            await markUrgent(key, `Falló el reseteo de contraseña para ${detectedEmail}`);
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
