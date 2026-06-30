-- Tabla para la regla de pausa de 24hs
create table if not exists chat_status (
  chat_id text primary key,
  last_human_reply_at timestamptz
);

-- Tabla para los chats marcados como urgentes (el bot no supo responder o detectó un reclamo)
create table if not exists urgent_chats (
  chat_id text primary key,
  last_message text,
  flagged_at timestamptz,
  resolved boolean default false
);
