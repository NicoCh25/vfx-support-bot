# VFX Support Bot

Bot de soporte con IA para VFX Signals (Telegram, primera versión).

## Setup

1. Crear las tablas en Supabase: correr el contenido de `supabase_setup.sql` en el SQL Editor de tu proyecto Supabase.
2. Cargar las variables de entorno en Railway (Settings → Variables del servicio):
   - `TELEGRAM_BOT_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
3. Subir este código al repo conectado a Railway (rama `main`). Railway va a instalar dependencias (`npm install`) y correr `npm start` automáticamente.

## ⚠️ Punto importante a resolver: la regla de las 24hs en Telegram

En Telegram, los mensajes que vos mandás a un usuario desde TU cuenta personal NO pasan por este bot — son completamente independientes. El bot solo "ve" lo que la gente le escribe directamente a él.

Esto significa que, tal como está ahora, el bot no tiene forma automática de saber que "vos" respondiste manualmente, porque tu chat personal con un usuario y el chat de ese usuario con el bot son dos cosas distintas.

Opciones para resolver esto:
- **A)** Vos atendés soporte siempre a través de este mismo bot (no desde tu Telegram personal) — así el sistema sabe perfecto cuándo respondiste vos.
- **B)** Armamos un comando manual, ej. `/pausar` que vos le mandás al bot indicando el chat a pausar, cuando respondiste por fuera.
- **C)** Dejamos la regla de 24hs solo para cuando migremos a WhatsApp Business API (ahí si se puede detectar fácil quién mandó cada mensaje, vos o el bot, porque comparten el mismo número).

Para la versión de prueba en Telegram, sugiero la opción A: que el soporte por Telegram se atienda 100% a través de este bot (vos podés ver las conversaciones igual, y si querés intervenir, usamos la opción B).

## Conectar WhatsApp (Baileys — conexión no oficial)

⚠️ Importante: esta conexión usa el mismo número que ya usás en tu celular (vía "Dispositivos vinculados", igual que WhatsApp Web), no la API oficial de Meta. Revisar la sección 20 de `knowledge_base.md` para las reglas anti-baneo que ya están integradas en el código (delay humano antes de responder, nunca iniciar conversación).

### Pasos en Railway

1. **Creá un segundo servicio** en el mismo proyecto de Railway (o uno nuevo), conectado al mismo repo de GitHub.
2. En ese servicio, andá a **Settings → Deploy** y cambiá el **Start Command** a:
   ```
   npm run start:whatsapp
   ```
3. **Agregá un Volume** (disco persistente) a este servicio: Railway → el servicio → pestaña **Volumes** → "New Volume" → montalo en una ruta, por ejemplo `/data`.
4. Agregá la variable de entorno `WHATSAPP_AUTH_DIR` con el valor `/data/whatsapp-auth` (para que la sesión de login se guarde en el disco persistente y no se pierda en cada redeploy).
5. Las demás variables (`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) son las mismas que ya tenés cargadas — copialas a este servicio nuevo también.
6. Hacé deploy y andá a la pestaña **Console** o **Deploy Logs** del servicio: ahí va a aparecer un código QR en texto (ASCII).
7. Desde el celular de Víctor: WhatsApp → Configuración → **Dispositivos vinculados** → "Vincular un dispositivo" → escanear ese QR.
8. Una vez vinculado, el log va a mostrar "VFX Support Bot (WhatsApp) corriendo ✅" y el bot ya está activo en ese número.

### Si hay que volver a vincular
Si el servicio pierde la sesión (por ejemplo, si Víctor cierra la sesión desde el celular, o se borra el Volume), simplemente hay que volver a escanear un QR nuevo que va a aparecer solo en los logs.

## Próximos pasos
- Probar el bot con preguntas reales del día a día.
- Revisar y completar la base de conocimiento (`src/knowledge_base.md`) a medida que aparezcan casos nuevos.
- Evaluar migrar a la API oficial de Meta (o un inbox tipo Chatwoot) si el volumen crece, para bajar el riesgo de baneo y tener una bandeja prolija donde Víctor también pueda responder manual.
