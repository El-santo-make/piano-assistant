import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_MY_ID = process.env.TELEGRAM_MY_ID;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

export const MAMAS = {
  '59177662545': { nombre: 'Elisa',  hijo: 'Elías',  edad: 12 },
  '59169086993': { nombre: 'Pilar',  hijo: 'Héctor', edad: 12 },
};

const pendingMap = new Map();
const historyMap = new Map();

export const pianoBotTelegram = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

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

export async function generateSuggestion(waId, mamaInfo, incomingMsg) {
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

async function sendWhatsApp(waId, text, waSock) {
  await waSock.sendMessage(`${waId}@s.whatsapp.net`, { text });
}

export async function handlePianoMessage(waId, mamaInfo, text, waSock) {
  const suggestion = await generateSuggestion(waId, mamaInfo, text);

  const msgText =
    `📱 *Mensaje de ${mamaInfo.nombre}* (mamá de ${mamaInfo.hijo})\n\n` +
    `_"${text}"_\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `💬 *Sugerencia:*\n${suggestion}\n\n` +
    `✅ *ok* — enviar\n` +
    `✏️ *editar: [texto]* — tu versión\n` +
    `🔄 *regenerar* — otra sugerencia`;

  const sent = await pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, msgText, { parse_mode: 'Markdown' });
  pendingMap.set(sent.message_id, { waId, waMsg: text, mamaInfo, suggestion, waSock });
}

// Escuchar respuestas del bot de piano
pianoBotTelegram.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_MY_ID)) return;
  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/ayuda') {
    pianoBotTelegram.sendMessage(TELEGRAM_MY_ID,
      `🎹 *Bot de Clases de Piano*\n\n` +
      `Cuando llegue un mensaje de las mamás te sugiero una respuesta.\n\n` +
      `• *ok* — enviar la sugerencia\n` +
      `• *editar: [texto]* — enviar tu versión\n` +
      `• *regenerar* — nueva sugerencia`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let pending = null;
  if (msg.reply_to_message) {
    pending = pendingMap.get(msg.reply_to_message.message_id);
  } else {
    const entries = [...pendingMap.entries()];
    if (entries.length > 0) pending = entries[entries.length - 1][1];
  }

  if (!pending) {
    pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, '⚠️ No hay mensajes pendientes.');
    return;
  }

  const lower = text.toLowerCase();

  if (lower === 'ok') {
    await sendWhatsApp(pending.waId, pending.suggestion, pending.waSock);
    pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, `✅ Enviado a ${pending.mamaInfo.nombre}.`);
    if (msg.reply_to_message) pendingMap.delete(msg.reply_to_message.message_id);

  } else if (lower.startsWith('editar:')) {
    const customText = text.slice(7).trim();
    if (!customText) { pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, '⚠️ Escribe el texto después de "editar:"'); return; }
    await sendWhatsApp(pending.waId, customText, pending.waSock);
    pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, `✅ Enviado a ${pending.mamaInfo.nombre} con tu versión.`);
    if (msg.reply_to_message) pendingMap.delete(msg.reply_to_message.message_id);

  } else if (lower === 'regenerar') {
    const history = historyMap.get(pending.waId) || [];
    if (history.length >= 2) history.splice(-2, 2);
    try {
      const newSuggestion = await generateSuggestion(pending.waId, pending.mamaInfo, pending.waMsg);
      pending.suggestion = newSuggestion;
      await handlePianoMessage(pending.waId, pending.mamaInfo, pending.waMsg, pending.waSock);
      pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, '🔄 Nueva sugerencia generada arriba.');
    } catch (e) {
      pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, `❌ Error: ${e.message}`);
    }

  } else {
    pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, '❓ No entendí. Escribe /ayuda.');
  }
});
