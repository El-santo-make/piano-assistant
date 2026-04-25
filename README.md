# 🎹 Asistente de Clases de Piano

Bot que intercepta mensajes de WhatsApp de las mamás, genera una sugerencia con Claude, te la manda por Telegram y espera tu aprobación antes de responder.

---

## Flujo

```
Mamá escribe en WhatsApp
    → Claude genera respuesta sugerida
        → Te llega por Telegram
            → Tú respondes: "ok" / "editar: [texto]" / "regenerar"
                → Se envía (o no) por WhatsApp
```

---

## Variables de entorno necesarias en Railway

| Variable | Valor |
|---|---|
| `TELEGRAM_TOKEN` | El token que te dio @BotFather |
| `TELEGRAM_MY_ID` | Tu ID de Telegram (`5907065030`) |
| `ANTHROPIC_API_KEY` | Tu API key de Anthropic |

---

## Cómo subir a Railway

### 1. Subir el código a GitHub

```bash
# En la carpeta del proyecto
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/piano-assistant.git
git push -u origin main
```

### 2. Crear proyecto en Railway

1. Ve a railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Selecciona el repo `piano-assistant`
4. Railway lo detecta y lo despliega automáticamente

### 3. Agregar variables de entorno en Railway

1. En tu proyecto de Railway, ve a la pestaña **Variables**
2. Agrega las tres variables de la tabla de arriba

### 4. Conectar WhatsApp (primera vez)

1. Ve a la pestaña **Deployments** en Railway
2. Click en el deployment activo → **View Logs**
3. Verás un QR en los logs
4. Abre WhatsApp en tu celular → Dispositivos vinculados → Vincular dispositivo
5. Escanea el QR
6. Te llegará un mensaje por Telegram: "✅ WhatsApp conectado y listo."

---

## Cómo usar desde Telegram

Cuando llegue un mensaje de una mamá, te llegará esto:

```
📱 Mensaje de Elisa (mamá de Elías)

"Santi, ¿habrá clase el sábado a la misma hora?"

━━━━━━━━━━━━━━
💬 Sugerencia de respuesta:
Sí Elisa, la clase del sábado sigue a la misma hora 😊 Cualquier cambio te aviso con tiempo.

Responde con:
✅ ok — enviar tal cual
✏️ editar: [tu texto] — enviar tu versión
🔄 regenerar — pedir otra sugerencia
```

Tú respondes en Telegram:
- `ok` → se envía la sugerencia exacta
- `editar: Sí, a las 10am como siempre` → se envía tu texto
- `regenerar` → Claude genera otra versión

---

## Notas

- El bot solo responde mensajes de los dos números configurados, ignora todo lo demás
- Si alguna mamá manda audio o imagen, te avisa en Telegram para que lo revises tú manualmente
- El historial de cada conversación se mantiene en memoria para que Claude tenga contexto
