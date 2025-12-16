import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ==========================
// Config básica
// ==========================
const {
  PORT = 10000,
  SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
} = process.env;

if (!SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.warn("⚠️ Falta SHEET_ID o GOOGLE_SERVICE_ACCOUNT_JSON en env vars");
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const MessagingResponse = twilio.twiml.MessagingResponse;

// ==========================
// Google Sheets client
// ==========================
let sheets = null;

async function getSheetsClient() {
  if (sheets) return sheets;
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  sheets = google.sheets({ version: "v4", auth: client });
  return sheets;
}

async function getSheetValues(range) {
  const s = await getSheetsClient();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function appendSheetValues(range, values) {
  const s = await getSheetsClient();
  await s.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

async function updateSheetValues(range, values) {
  const s = await getSheetsClient();
  await s.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

// ==========================
// Estados de conversación
// ==========================
const STATE_MENU       = "MENU_PRINCIPAL";
const STATE_OPER_MENU  = "OPER_MENU";
const STATE_OPER_VENTA = "OPER_VENTA";
const STATE_ACAD_MENU  = "ACADEMIA_MENU";
const STATE_ACAD_RETO  = "ACADEMIA_RETO";

// ==========================
// Sesiones (hoja SESIONES)
// A: telefono, B: estado_actual, C: data_json
// ==========================
async function findSessionRow(telefono) {
  const rows = await getSheetValues("SESIONES!A2:C");
  if (!rows.length) return null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === telefono) {
      const estado_actual = row[1] || STATE_MENU;
      let data_json = {};
      try {
        data_json = row[2] ? JSON.parse(row[2]) : {};
      } catch {
        data_json = {};
      }
      return { rowIndex: i + 2, estado_actual, data_json };
    }
  }
  return null;
}

async function getSession(telefono) {
  let sesion = await findSessionRow(telefono);
  if (sesion) return sesion;

  await appendSheetValues("SESIONES!A2:C", [
    [telefono, STATE_MENU, JSON.stringify({})],
  ]);
  sesion = await findSessionRow(telefono);
  return sesion;
}

async function setSession(telefono, estado_actual, data_json = {}) {
  const sesion = await findSessionRow(telefono);
  const dataStr = JSON.stringify(data_json || {});
  if (!sesion) {
    await appendSheetValues("SESIONES!A2:C", [
      [telefono, estado_actual, dataStr],
    ]);
  } else {
    const range = `SESIONES!A${sesion.rowIndex}:C${sesion.rowIndex}`;
    await updateSheetValues(range, [[telefono, estado_actual, dataStr]]);
  }
}

// ==========================
// Puntos (hoja PUNTOS)
// A: fecha_hora, B: telefono, C: tipo, D: origen, E: puntos
// ==========================
async function addPuntos(telefono, tipo, origen, puntos) {
  const fecha_hora = new Date().toISOString();
  await appendSheetValues("PUNTOS!A2:E", [
    [fecha_hora, telefono, tipo, origen, puntos],
  ]);
}

async function getResumenPuntos(telefono) {
  const rows = await getSheetValues("PUNTOS!A2:E");
  let operacion = 0;
  let capacitacion = 0;
  for (const row of rows) {
    const tel = row[1];
    const tipo = row[2];
    const pts  = Number(row[4] || 0);
    if (tel === telefono) {
      if (tipo === "OPERACION")    operacion    += pts;
      if (tipo === "CAPACITACION") capacitacion += pts;
    }
  }
  return {
    operacion,
    capacitacion,
    total: operacion + capacitacion,
  };
}

// ==========================
// Lógica principal
// ==========================
async function handleIncoming(telefono, body) {
  const text  = (body || "").trim();
  const lower = text.toLowerCase();

  // Comandos globales
  if (lower === "menu") {
    await setSession(telefono, STATE_MENU, {});
    return (
      "👋 Hola, soy *Promobolsillo*.\n\n" +
      "¿Qué quieres hacer?\n" +
      "1️⃣ Operación en tienda\n" +
      "2️⃣ Academia (capacitaciones)\n" +
      "3️⃣ Ver mis puntos"
    );
  }

  if (lower === "puntos") {
    const { operacion, capacitacion, total } = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos actuales*\n" +
      `🟦 Operación: ${operacion}\n` +
      `🟨 Capacitación: ${capacitacion}\n` +
      `🎯 Total: ${total}\n\n` +
      "Escribe *menu* para volver al inicio."
    );
  }

  const sesion = await getSession(telefono);
  const estado = sesion.estado_actual;
  const data   = sesion.data_json || {};

  switch (estado) {
    case STATE_MENU:
      return await handleMenuPrincipal(telefono, text);
    case STATE_OPER_MENU:
    case STATE_OPER_VENTA:
      return await handleOperacion(telefono, estado, text, data);
    case STATE_ACAD_MENU:
    case STATE_ACAD_RETO:
      return await handleAcademia(telefono, estado, text, data);
    default:
      await setSession(telefono, STATE_MENU, {});
      return (
        "Reinicié tu sesión 🔄\n\n" +
        "¿Qué quieres hacer?\n" +
        "1️⃣ Operación en tienda\n" +
        "2️⃣ Academia (capacitaciones)\n" +
        "3️⃣ Ver mis puntos"
      );
  }
}

// ==========================
// Menú principal
// ==========================
async function handleMenuPrincipal(telefono, text) {
  if (!["1", "2", "3"].includes(text)) {
    await setSession(telefono, STATE_MENU, {});
    return (
      "👋 Hola, soy *Promobolsillo*.\n\n" +
      "¿Qué quieres hacer?\n" +
      "1️⃣ Operación en tienda\n" +
      "2️⃣ Academia (capacitaciones)\n" +
      "3️⃣ Ver mis puntos\n\n" +
      "También puedes escribir *menu* en cualquier momento."
    );
  }

  if (text === "1") {
    await setSession(telefono, STATE_OPER_MENU, {});
    return (
      "🧰 *Operación en tienda*\n" +
      "1️⃣ Nueva visita (demo)\n" +
      "2️⃣ Volver al menú principal"
    );
  }

  if (text === "2") {
    await setSession(telefono, STATE_ACAD_MENU, {});
    return (
      "🎓 *Academia de Bolsillo*\n" +
      "1️⃣ Reto del día (demo)\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  if (text === "3") {
    const { operacion, capacitacion, total } = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos actuales*\n" +
      `🟦 Operación: ${operacion}\n` +
      `🟨 Capacitación: ${capacitacion}\n` +
      `🎯 Total: ${total}\n\n` +
      "Escribe *menu* para volver al inicio."
    );
  }
}

// ==========================
// Operación (demo)
// ==========================
async function handleOperacion(telefono, estado, text, data) {
  if (estado === STATE_OPER_MENU) {
    if (text === "1") {
      const visitaId = "V-" + Date.now();
      await setSession(telefono, STATE_OPER_VENTA, { visitaId });
      return (
        "🛒 *Visita demo abierta*\n" +
        "Vamos a registrar una venta rápida.\n\n" +
        "Producto demo: *Modelo X 128GB*\n" +
        "Escribe cuántas unidades vendiste hoy de este producto (solo número)."
      );
    }
    if (text === "2") {
      await setSession(telefono, STATE_MENU, {});
      return (
        "Volviendo al menú principal…\n\n" +
        "1️⃣ Operación en tienda\n" +
        "2️⃣ Academia (capacitaciones)\n" +
        "3️⃣ Ver mis puntos"
      );
    }
    return (
      "🧰 *Operación en tienda*\n" +
      "1️⃣ Nueva visita (demo)\n" +
      "2️⃣ Volver al menú principal"
    );
  }

  if (estado === STATE_OPER_VENTA) {
    const unidades = Number(text);
    if (Number.isNaN(unidades) || unidades < 0) {
      return "Por favor escribe solo el número de unidades vendidas (ej. 3).";
    }

    const fecha      = new Date().toISOString();
    const productoId = "PROD_X"; // demo

    await appendSheetValues("VENTAS!A2:D", [
      [fecha, telefono, productoId, unidades],
    ]);

    await addPuntos(telefono, "OPERACION", "VENTA_DEMO", 10);
    await setSession(telefono, STATE_OPER_MENU, {});

    return (
      "✅ Venta registrada.\n" +
      "Producto: *Modelo X 128GB*\n" +
      `Unidades: *${unidades}*\n\n` +
      "🎯 Ganaste *10 puntos de operación*.\n" +
      "¿Qué quieres hacer ahora?\n" +
      "1️⃣ Nueva visita (demo)\n" +
      "2️⃣ Volver al menú principal"
    );
  }

  await setSession(telefono, STATE_OPER_MENU, {});
  return (
    "🧰 *Operación en tienda*\n" +
    "1️⃣ Nueva visita (demo)\n" +
    "2️⃣ Volver al menú principal"
  );
}

// ==========================
// Academia (demo)
// ==========================
async function handleAcademia(telefono, estado, text, data) {
  if (estado === STATE_ACAD_MENU) {
    if (text === "1") {
      const rows = await getSheetValues("RETOS!A2:H");
      if (!rows.length) {
        return "Por ahora no hay retos configurados. 📭";
      }
      const [reto_id, pregunta, opcion_1, opcion_2, opcion_3] = rows[0];
      await setSession(telefono, STATE_ACAD_RETO, { reto_id });
      return (
        "🎓 *Reto del día*\n\n" +
        `${pregunta}\n\n` +
        `1️⃣ ${opcion_1}\n` +
        `2️⃣ ${opcion_2}\n` +
        `3️⃣ ${opcion_3}\n\n` +
        "Responde con 1, 2 o 3."
      );
    }
    if (text === "2") {
      const { operacion, capacitacion, total } = await getResumenPuntos(telefono);
      return (
        "📊 *Tus puntos de capacitación*\n" +
        `🟨 Capacitación: ${capacitacion}\n` +
        `🟦 Operación (referencia): ${operacion}\n` +
        `🎯 Total: ${total}\n\n` +
        "Escribe *menu* para volver al inicio."
      );
    }
    if (text === "3") {
      await setSession(telefono, STATE_MENU, {});
      return (
        "Volviendo al menú principal…\n\n" +
        "1️⃣ Operación en tienda\n" +
        "2️⃣ Academia (capacitaciones)\n" +
        "3️⃣ Ver mis puntos"
      );
    }
    return (
      "🎓 *Academia de Bolsillo*\n" +
      "1️⃣ Reto del día (demo)\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  if (estado === STATE_ACAD_RETO) {
    if (!["1", "2", "3"].includes(text)) {
      return "Responde solo con 1, 2 o 3 😉";
    }

    const { reto_id } = data;
    const rows = await getSheetValues("RETOS!A2:H");
    const retoRow = rows.find(r => r[0] === reto_id);
    if (!retoRow) {
      await setSession(telefono, STATE_ACAD_MENU, {});
      return "Ocurrió un problema con el reto. Intenta de nuevo más tarde 🙏";
    }

    const [
      _id,
      pregunta,
      opcion_1,
      opcion_2,
      opcion_3,
      opcion_correcta,
      puntos_ok,
      puntos_error,
    ] = retoRow;

    const correctaNum = Number(opcion_correcta);
    const respuestaNum = Number(text);
    const es_correcta = correctaNum === respuestaNum;
    const pts = es_correcta ? Number(puntos_ok || 0) : Number(puntos_error || 0);

    const fecha_hora = new Date().toISOString();
    await appendSheetValues("RESPUESTAS_RETOS!A2:F", [
      [
        fecha_hora,
        telefono,
        reto_id,
        respuestaNum,
        es_correcta ? "TRUE" : "FALSE",
        pts,
      ],
    ]);

    if (pts !== 0) {
      await addPuntos(telefono, "CAPACITACION", `RETO_${reto_id}`, pts);
    }

    await setSession(telefono, STATE_ACAD_MENU, {});

    const feedback = es_correcta
      ? "✅ ¡Correcto!"
      : `❌ La respuesta correcta era la opción ${opcion_correcta}.`;

    return (
      `${feedback}\n\n` +
      `Pregunta: ${pregunta}\n` +
      `1) ${opcion_1}\n` +
      `2) ${opcion_2}\n` +
      `3) ${opcion_3}\n\n` +
      `🎯 Ganaste *${pts} puntos de capacitación*.\n\n` +
      "¿Qué quieres hacer ahora?\n" +
      "1️⃣ Reto del día (demo)\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú principal\n\n" +
      "O escribe *menu* para ir al inicio."
    );
  }

  await setSession(telefono, STATE_ACAD_MENU, {});
  return (
    "🎓 *Academia de Bolsillo*\n" +
    "1️⃣ Reto del día (demo)\n" +
    "2️⃣ Ver mis puntos de capacitación\n" +
    "3️⃣ Volver al menú principal"
  );
}

// ==========================
// Rutas Express
// ==========================
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  console.log("Mensaje entrante:", from, body);

  let respuesta;
  try {
    respuesta = await handleIncoming(from, body);
  } catch (err) {
    console.error("Error en handleIncoming:", err);
    respuesta =
      "Ocurrió un error procesando tu mensaje. Intenta de nuevo más tarde 🙏";
  }

  const twiml = new MessagingResponse();
  twiml.message(respuesta);

  res.type("text/xml");
  res.send(twiml.toString());
});

// Ruta raíz para probar en navegador
app.get("/", (req, res) => {
  res.send("Promobolsillo bot está vivo ✅ (Sheets conectado)");
});

app.listen(PORT, () => {
  console.log(`🚀 Promobolsillo bot escuchando en puerto ${PORT}`);
});
