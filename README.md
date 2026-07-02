# Qué hay en esta carpeta

## 🤖 Bot (Railway) — subir estos 4 a GitHub, todos juntos en el mismo commit
- `core.js`
- `whatsapp.js`
- `index.js`
- `knowledge_base.md`

## 🖼️ Imágenes nuevas — subir a la carpeta `images/` del repo del bot
- `points_referencia_us30.jpg` ✅ lista
- `points_referencia_xauusd.jpg` ✅ lista
- `points_referencia_btc.jpg` ⚠️ TODAVÍA FALTA — el archivo que mandaste se duplicó con el de US30 (mismo archivo, no es la de Bitcoin). Renombrala antes de volver a mandarla (ver el mensaje anterior) y te la agrego.

Mientras no esté esa imagen, el bot va a intentar mandar `[IMG:points_btc]` y no la va a encontrar — no rompe nada (el código ya tiene un manejo de "imagen no encontrada" que solo lo loguea), pero esa referencia puntual de Bitcoin no se va a ver hasta que la subas.

## 🌐 Plataforma VFX (Lovable/Supabase) — carpeta `plataforma_vfx/`
- `crm_campaigns_and_tags.sql` → correr primero en Supabase (SQL Editor o vía Lovable). Agrega las tablas de etiquetas y campañas de goteo.
- `supabase_functions/` → 4 Edge Functions para subir a Supabase:
  - `bot-cliente-status.ts` → consulta de estado de cuenta por mail
  - `bot-generate-vip-link.ts` → generación de link VIP de Telegram
  - `bot-next-campaign-message.ts` → siguiente mensaje de goteo pendiente
  - `bot-mark-campaign-sent.ts` → marca un envío de campaña como hecho/fallido
- `prompts_lovable/` → 2 prompts para pegarle directo a Lovable:
  - `lovable_prompt_fix_start.md` → arregla el `/start` sin código en el bot de Telegram
  - `lovable_prompt_crm.md` → arma la pestaña "CRM" del admin (etiquetas, plantillas, campañas)

## ⚙️ Variables de entorno pendientes de confirmar
Repasando lo que fuimos armando, estas son las variables que el bot de WhatsApp (`whatsapp.js`) necesita en Railway — confirmá que las tengas todas:
- `WHATSAPP_AUTH_DIR`
- `VFX_PLATFORM_FUNCTIONS_URL` = `https://utevsnyqmzxpgotxaetf.supabase.co/functions/v1`
- `BOT_INTERNAL_SECRET` (la misma que configuraste como secret en Supabase)
- `TELEGRAM_BOT_TOKEN`
- `OWNER_TELEGRAM_CHAT_ID` = `537747411`
