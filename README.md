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

## Próximos pasos
- Probar el bot con preguntas reales del día a día.
- Revisar y completar la base de conocimiento (`src/knowledge_base.md`) a medida que aparezcan casos nuevos.
- Migrar a WhatsApp Business API cuando esté aprobada.
