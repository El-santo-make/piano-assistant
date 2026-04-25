import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import { unlinkSync, existsSync } from 'fs';

import { MAMAS, handlePianoMessage, pianoBotTelegram } from './pianoBot.js';
import { chatBuffer, registerChatName, scheduleDailySummary, resumenesBotTelegram } from './resumenesBot.js';

const TELEGRAM_MY_ID = process.env.TELEGRAM_MY_ID;

// ─── CONECTAR WHATSAPP ────────────────────────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Generando QR...');
      try {
        const qrPath = '/tmp/qr.png';
        await qrcode.toFile(qrPath, qr, { width: 400 });
        await pianoBotTelegram.sendPhoto(TELEGRAM_MY_ID, qrPath, {
          caption: '📱 *Escanea este QR con WhatsApp*\n\nAbre WhatsApp → Dispositivos vinculados → Vincular dispositivo',
          parse_mode: 'Markdown',
        });
        if (existsSync(qrPath)) unlinkSync(qrPath);
      } catch (e) {
        console.error('Error enviando QR:', e.message);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('[WA] Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000);
    }

    if (connection === 'open') {
      console.log('[WA] ✅ Conectado');
      pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, '🎹 *Bot de Piano* conectado y listo.', { parse_mode: 'Markdown' }).catch(() => {});
      resumenesBotTelegram.sendMessage(TELEGRAM_MY_ID, '📋 *Bot de Resúmenes* conectado y listo.\n\nEscribe /ayuda para ver los comandos.', { parse_mode: 'Markdown' }).catch(() => {});
      scheduleDailySummary();
    }
  });

  // ─── TODOS LOS MENSAJES ENTRANTES ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        null;

      // Nombre del emisor
      let senderName = msg.pushName || 'Alguien';
      if (!chatId.endsWith('@g.us')) {
        const num = chatId.replace('@s.whatsapp.net', '');
        senderName = msg.pushName || MAMAS[num]?.nombre || `+${num}`;
      }

      // Nombre legible del chat
      let chatLabel;
      if (chatId.endsWith('@g.us')) {
        chatLabel = msg.key?.participant ? `Grupo ${chatId.split('@')[0].slice(-6)}` : chatId;
        // intentar obtener nombre del grupo si está disponible
        try {
          const meta = await sock.groupMetadata(chatId);
          if (meta?.subject) chatLabel = meta.subject;
        } catch {}
      } else {
        const num = chatId.replace('@s.whatsapp.net', '');
        chatLabel = msg.pushName || MAMAS[num]?.nombre || `+${num}`;
      }
      registerChatName(chatId, chatLabel);

      const timeStr = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        .toLocaleTimeString('es-BO', { timeZone: 'America/La_Paz', hour: '2-digit', minute: '2-digit' });

      // Acumular en buffer para resúmenes
      if (text) {
        if (!chatBuffer.has(chatId)) chatBuffer.set(chatId, []);
        chatBuffer.get(chatId).push({ sender: senderName, text, time: timeStr });
      }

      // Flujo especial para las mamás de piano
      const waId = chatId.replace('@s.whatsapp.net', '');
      const mamaInfo = MAMAS[waId];
      if (mamaInfo && text) {
        try {
          await handlePianoMessage(waId, mamaInfo, text, sock);
        } catch (e) {
          console.error('[Piano Error]', e.message);
          pianoBotTelegram.sendMessage(TELEGRAM_MY_ID, `❌ Error con mensaje de ${mamaInfo.nombre}: ${e.message}`).catch(() => {});
        }
      }
    }
  });
}

// ─── ARRANCAR ─────────────────────────────────────────────────────────────────
console.log('🚀 Arrancando sistema...');
connectWhatsApp();
