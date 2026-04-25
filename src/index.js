import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_MY_ID = process.env.TELEGRAM_MY_ID;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

const MAMAS = {
  '59177662545': { nombre: 'Elisa',  hijo: 'Elías',  edad: 12 },
  '59169086993': { nombre: 'Pilar',  hijo: 'Héctor', edad: 12 },
};

// ─── ESTADO EN MEMORIA ────────────────────────────────────────────────────────
const pendingMap = new Map();
const historyMap = new Map();
let waSock = null;

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
const telegram = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(mamaInfo) {
  return `Eres el asistente de Santiago, profesor de piano en su iglesia.
Santiago le da clases de piano a niños de la iglesia. Es joven, cercano, cariñoso y respetuoso con las mamás.

Contexto del alumno:
- Alumno: ${mamaInfo.hijo}, ${mamaInfo.edad} años
- Mamá: ${mamaInfo.nombre}
- Relación: son miembros de la misma iglesia, se tratan con cariño y respeto
- Tema de conversación: únicamente clases de piano (horarios, pagos, progreso del niño en casa)

Tu tarea es redactar UNA respuesta de WhatsApp en nombre de Santiago.
La respuesta debe:
- Sonar natural, cálida y breve (como hablaría un joven profe de iglesia)
- Responder directamente lo que preguntó la mamá
- Usar "tú" de forma cercana pero respetuosa
- NO usar emojis en exceso, máximo 1 o 2 si van al caso
- NO inventar información que no tienes (horarios exactos, fechas de pago) — en ese caso di que lo confirmas pronto
- Ser concisa, no más de 3-4 líneas

Devuelve SOLO el texto de la respuesta, sin comillas, sin explicaciones.`;
}

// ─── GENERAR SUGERENCIA CON CLAUDE ────────────────────────────────────────────
async function generateSuggestion(waId, mamaInfo, incomingMsg) {
  if (!historyMap.has(waId)) historyMap.set(waId, []);
  const history = historyMap.get(waId);

  history.push({ role: 'user', content: incomingMsg });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    system: buildSystemPrompt(mamaInfo),
    messages: history,
  });

  const suggestion = response.content[0].text.trim();
  history.push({ role: 'assistant', content: suggestion });

  if (history.length > 20) history.splice(0, 2);

  return suggestion;
}

// ─── ENVIAR NOTIFICACIÓN A TELEGRAM ───────────────────────────────────────────
async function notifyTelegram(waId, mamaInfo, incomingMsg, suggestion) {
  const text =
    `📱 *Mensaje de ${mamaInfo.nombre}* (mamá de ${mamaInfo.hijo})\n\n` +
    `_"${incomingMsg}"_\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `💬 *Sugerencia de respuesta:*\n${suggestion}\n\n` +
    `Responde con:\n` +
    `✅ *ok* — enviar tal cual\n` +
    `✏️ *editar: [tu texto]* — enviar tu versión\n` +
    `🔄 *regenerar* — pedir otra sugerencia`;

  const sent = await telegram.sendMessage(TELEGRAM_MY_ID, text, {
    parse_mode: 'Markdown',
  });

  pendingMap.set(sent.message_id, { waId, waMsg: incomingMsg, mamaInfo, suggestion });
}

// ─── ENVIAR MENSAJE POR WHATSAPP ──────────────────────────────────────────────
async function sendWhatsApp(waId, text) {
  const jid = `${waId}@s.whatsapp.net`;
  await waSock.sendMessage(jid, { text });
  console.log(`[WA] Enviado a ${waId}: ${text}`);
}

// ─── MANEJAR RESPUESTAS DESDE TELEGRAM ───────────────────────────────────────
telegram.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_MY_ID)) return;

  const text = (msg.text || '').trim();
  if (!text) return;

  let pending = null;
  if (msg.reply_to_message) {
    pending = pendingMap.get(msg.reply_to_message.message_id);
  } else {
    const entries = [...pendingMap.entries()];
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      pending = last[1];
    }
  }

  if (!pending) {
    telegram.sendMessage(TELEGRAM_MY_ID, '⚠️ No hay mensajes pendientes de aprobar.');
    return;
  }

  const lower = text.toLowerCase();

  if (lower === 'ok') {
    await sendWhatsApp(pending.waId, pending.suggestion);
    telegram.sendMessage(TELEGRAM_MY_ID, `✅ Enviado a ${pending.mamaInfo.nombre}.`);
    if (msg.reply_to_message) pendingMap.delete(msg.reply_to_message.message_id);

  } else if (lower.startsWith('editar:')) {
    const customText = text.slice(7).trim();
    if (!customText) {
      telegram.sendMessage(TELEGRAM_MY_ID, '⚠️ Escribe el texto después de "editar:"');
      return;
    }
    const history = historyMap.get(pending.waId) || [];
    if (history.length > 0) history[history.length - 1] = { role: 'assistant', content: customText };
    await sendWhatsApp(pending.waId, customText);
    telegram.sendMessage(TELEGRAM_MY_ID, `✅ Enviado a ${pending.mamaInfo.nombre} con tu versión.`);
    if (msg.reply_to_message) pendingMap.delete(msg.reply_to_message.message_id);

  } else if (lower === 'regenerar') {
    const history = historyMap.get(pending.waId) || [];
    if (history.length >= 2) history.splice(-2, 2);
    try {
      const newSuggestion = await generateSuggestion(pending.waId, pending.mamaInfo, pending.waMsg);
      pending.suggestion = newSuggestion;
      await notifyTelegram(pending.waId, pending.mamaInfo, pending.waMsg, newSuggestion);
      telegram.sendMessage(TELEGRAM_MY_ID, '🔄 Nueva sugerencia generada arriba.');
    } catch (e) {
      telegram.sendMessage(TELEGRAM_MY_ID, `❌ Error al regenerar: ${e.message}`);
    }

  } else {
    telegram.sendMessage(
      TELEGRAM_MY_ID,
      '❓ No entendí. Usa:\n• *ok*\n• *editar: [texto]*\n• *regenerar*',
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── CONECTAR WHATSAPP ────────────────────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
  });

  waSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 Escanea el QR de arriba con WhatsApp en tu celular\n');
      telegram.sendMessage(TELEGRAM_MY_ID, '⚠️ WhatsApp desconectado. Revisa los logs para escanear el QR.').catch(() => {});
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('[WA] Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000);
    }
    if (connection === 'open') {
      console.log('[WA] ✅ WhatsApp conectado');
      telegram.sendMessage(TELEGRAM_MY_ID, '✅ WhatsApp conectado y listo.').catch(() => {});
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const waId = msg.key.remoteJid.replace('@s.whatsapp.net', '');
      const mamaInfo = MAMAS[waId];
      if (!mamaInfo) continue;

      const incomingMsg =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '[mensaje no textual]';

      if (incomingMsg === '[mensaje no textual]') {
        telegram.sendMessage(
          TELEGRAM_MY_ID,
          `📎 ${mamaInfo.nombre} envió un archivo o audio. Revísalo manualmente.`
        ).catch(() => {});
        continue;
      }

      console.log(`[WA] Mensaje de ${mamaInfo.nombre}: ${incomingMsg}`);

      try {
        const suggestion = await generateSuggestion(waId, mamaInfo, incomingMsg);
        await notifyTelegram(waId, mamaInfo, incomingMsg, suggestion);
      } catch (e) {
        console.error('[Error]', e);
        telegram.sendMessage(TELEGRAM_MY_ID, `❌ Error procesando mensaje de ${mamaInfo.nombre}: ${e.message}`).catch(() => {});
      }
    }
  });
}

// ─── ARRANCAR ─────────────────────────────────────────────────────────────────
console.log('🎹 Asistente de Clases de Piano arrancando...');
connectWhatsApp();
