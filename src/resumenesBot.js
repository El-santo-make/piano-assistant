import TelegramBot from 'node-telegram-bot-api';

const TELEGRAM_TOKEN_RESUMENES = process.env.TELEGRAM_TOKEN_RESUMENES;
const TELEGRAM_MY_ID            = process.env.TELEGRAM_MY_ID;
const GEMINI_KEY                = process.env.GEMINI_API_KEY;

// Hora diaria: 14:00 Bolivia = 18:00 UTC
const SUMMARY_HOUR_UTC = 18;

// chatId → [ {sender, text, time} ]
export const chatBuffer = new Map();
// chatId → nombre legible (se llena cuando llegan mensajes)
const chatNames = new Map();

export const resumenesBotTelegram = new TelegramBot(TELEGRAM_TOKEN_RESUMENES, { polling: true });

// ─── GEMINI ───────────────────────────────────────────────────────────────────
async function geminiSummarize(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Sin contenido.';
}

// ─── REGISTRAR NOMBRE DE CHAT ─────────────────────────────────────────────────
export function registerChatName(chatId, name) {
  if (!chatNames.has(chatId)) chatNames.set(chatId, name);
}

// ─── RESUMIR UN CHAT ──────────────────────────────────────────────────────────
async function summarizeChat(chatId) {
  const messages = chatBuffer.get(chatId);
  if (!messages || messages.length === 0) return null;

  const label = chatNames.get(chatId) || chatId;
  const transcript = messages.map(m => `[${m.time}] ${m.sender}: ${m.text}`).join('\n');

  const prompt =
    `Eres un asistente que resume conversaciones de WhatsApp para Santiago, un joven universitario boliviano.\n\n` +
    `Resume la conversación del chat "${label}" de forma clara y concisa.\n` +
    `Destaca: temas principales, decisiones, preguntas sin responder, cosas que requieren acción de Santiago.\n` +
    `Máximo 5 puntos. Si no hay nada importante, dilo en una línea.\n\n` +
    `CONVERSACIÓN:\n${transcript}`;

  const summary = await geminiSummarize(prompt);
  chatBuffer.set(chatId, []); // limpiar después de resumir
  return { label, count: messages.length, summary };
}

// ─── ENVIAR TODOS LOS RESÚMENES ───────────────────────────────────────────────
async function sendAllSummaries() {
  const activos = [...chatBuffer.entries()].filter(([, msgs]) => msgs.length > 0);

  if (activos.length === 0) {
    resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, '📋 No hay mensajes acumulados para resumir.').catch(() => {});
    return;
  }

  const hora = new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz', hour: '2-digit', minute: '2-digit' });
  await resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, `📋 *Resumen diario — ${hora}*`, { parse_mode: 'Markdown' });

  for (const [chatId] of activos) {
    try {
      const result = await summarizeChat(chatId);
      if (!result) continue;
      await resumenesBotTelegram.sendMessage(
        TELEGRAM_MY_ID,
        `*${result.label}* (${result.count} mensajes)\n\n${result.summary}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, `❌ Error en "${chatNames.get(chatId) || chatId}": ${e.message}`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

// ─── PROGRAMAR RESUMEN DIARIO ─────────────────────────────────────────────────
let scheduled = false;
export function scheduleDailySummary() {
  if (scheduled) return;
  scheduled = true;

  function msUntilNext() {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(SUMMARY_HOUR_UTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const ms = msUntilNext();
    console.log(`[Resumen] Próximo resumen automático en ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      await sendAllSummaries();
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}

// ─── COMANDOS DEL BOT DE RESÚMENES ───────────────────────────────────────────
resumenesBotTelegram.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_MY_ID)) return;
  const text = (msg.text || '').trim();
  if (!text) return;

  // /ayuda
  if (text === '/ayuda') {
    resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID,
      `📋 *Bot de Resúmenes WhatsApp*\n\n` +
      `*/chats* — lista todos los chats con mensajes acumulados\n` +
      `*/resumen* — resumen de todos los chats ahora\n` +
      `*/resumen [nombre]* — resumen de un chat específico\n` +
      `*/limpiar* — borra todo el buffer sin resumir\n\n` +
      `El resumen automático llega todos los días a las 2:00 PM.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // /chats — listar chats activos
  if (text === '/chats') {
    const activos = [...chatBuffer.entries()].filter(([, msgs]) => msgs.length > 0);
    if (activos.length === 0) {
      resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, '📭 No hay mensajes acumulados todavía.');
      return;
    }
    const lista = activos
      .map(([chatId, msgs]) => `• *${chatNames.get(chatId) || chatId}* — ${msgs.length} mensajes`)
      .join('\n');
    resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, `*Chats con mensajes:*\n\n${lista}`, { parse_mode: 'Markdown' });
    return;
  }

  // /resumen — todos
  if (text === '/resumen') {
    await sendAllSummaries();
    return;
  }

  // /resumen [nombre] — chat específico
  if (text.toLowerCase().startsWith('/resumen ')) {
    const query = text.slice(9).trim().toLowerCase();
    // buscar chat cuyo nombre contenga el query
    const match = [...chatNames.entries()].find(([, name]) => name.toLowerCase().includes(query));
    if (!match) {
      resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID,
        `❌ No encontré un chat con ese nombre. Usa */chats* para ver los disponibles.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const [chatId] = match;
    const msgs = chatBuffer.get(chatId) || [];
    if (msgs.length === 0) {
      resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, `📭 No hay mensajes nuevos en *${chatNames.get(chatId)}*.`, { parse_mode: 'Markdown' });
      return;
    }
    try {
      const result = await summarizeChat(chatId);
      if (result) {
        resumenesBotTelegram.sendMessage(
          TELEGRAM_MY_ID,
          `*${result.label}* (${result.count} mensajes)\n\n${result.summary}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, `❌ Error: ${e.message}`);
    }
    return;
  }

  // /limpiar
  if (text === '/limpiar') {
    chatBuffer.clear();
    resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, '🗑️ Buffer limpiado.');
    return;
  }

  resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, '❓ Escribe /ayuda para ver los comandos.');
});
