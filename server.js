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
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
} = process.env;

// Cliente REST de Twilio (para reenviar fotos al cliente)
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn(
    "⚠️ No se encontraron TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN en variables de entorno. " +
      "El reenvío de fotos al cliente estará deshabilitado."
  );
}

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

// ======================================================
// Helpers: SUPERVISORES, PROMOTORES, GRUPOS_CLIENTE,
// EVIDENCIAS y TIENDAS/VISITAS
// ======================================================

async function getSupervisorPorTelefono(telefono) {
  const rows = await getSheetValues("SUPERVISORES!A2:F");
  if (!rows || !rows.length) return null;

  for (const r of rows) {
    const tel = (r[0] || "").trim();
    const supervisor_id = r[1] || "";
    const nombre = r[2] || "";
    const region = r[3] || "";
    const nivel = (r[4] || "").toUpperCase();
    const activo = (r[5] || "").toString().toUpperCase() === "TRUE";
    if (tel === telefono && activo) {
      return {
        telefono: tel,
        supervisor_id,
        nombre,
        region,
        nivel,
        activo,
      };
    }
  }
  return null;
}

async function getPromotoresDeSupervisor(telefonoSupervisor) {
  // PROMOTORES: [0] telefono, [1] promotor_id, [2] nombre, [3] region,
  // [4] cadena_principal, [5] activo, [6] telefono_supervisor
  const rows = await getSheetValues("PROMOTORES!A2:G");
  if (!rows || !rows.length) return [];

  return rows
    .filter((r) => {
      const telSup = (r[6] || "").trim();
      const activo = (r[5] || "").toString().toUpperCase() === "TRUE";
      return telSup === telefonoSupervisor && activo;
    })
    .map((r) => ({
      telefono: (r[0] || "").trim(),
      promotor_id: r[1] || "",
      nombre: r[2] || "",
      region: r[3] || "",
      cadena_principal: r[4] || "",
    }));
}

async function getGruposClienteActivos() {
  // GRUPOS_CLIENTE: [0] grupo_id, [1] nombre_grupo, [2] cliente, [3] telefonos_csv, [4] activo
  const rows = await getSheetValues("GRUPOS_CLIENTE!A2:E");
  if (!rows || !rows.length) return [];

  return rows
    .filter((r) => (r[4] || "").toString().toUpperCase() === "TRUE")
    .map((r) => {
      const telefonosRaw = r[3] || "";
      const telefonos = telefonosRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t);
      return {
        grupo_id: r[0] || "",
        nombre_grupo: r[1] || "",
        cliente: r[2] || "",
        telefonos,
      };
    });
}

// Mapeo de fila de EVIDENCIAS a objeto
function mapEvidRow(r) {
  return {
    evidencia_id: r[0] || "",
    telefono: (r[1] || "").trim(),
    fecha_hora: r[2] || "",
    tipo_evento: r[3] || "",
    origen: r[4] || "",
    jornada_id: r[5] || "",
    visita_id: r[6] || "",
    url_foto: r[7] || "",
    lat: r[8] || "",
    lon: r[9] || "",
    resultado_ai: r[10] || "",
    score_confianza: Number(r[11] || 0),
    riesgo: (r[12] || "BAJO").toUpperCase(),
  };
}

// Evidencias sólo del día de hoy (por fecha YYYY-MM-DD)
async function getEvidenciasHoy() {
  const rows = await getSheetValues("EVIDENCIAS!A2:M");
  if (!rows || !rows.length) return [];
  const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return rows
    .map(mapEvidRow)
    .filter((ev) => (ev.fecha_hora || "").slice(0, 10) === hoy);
}

// Opcionales: para enriquecer el texto hacia el cliente
async function getVisitaPorId(visitaId) {
  if (!visitaId) return null;
  const rows = await getSheetValues("VISITAS!A2:G");
  if (!rows || !rows.length) return null;

  for (const r of rows) {
    if ((r[0] || "") === visitaId) {
      return {
        visita_id: r[0] || "",
        promotor_id: r[1] || "",
        tienda_id: r[2] || "",
        fecha: r[3] || "",
        hora_inicio: r[4] || "",
        hora_fin: r[5] || "",
      };
    }
  }
  return null;
}

async function getTiendaPorId(tiendaId) {
  if (!tiendaId) return null;
  const rows = await getSheetValues("TIENDAS!A2:F");
  if (!rows || !rows.length) return null;

  for (const r of rows) {
    if ((r[0] || "") === tiendaId) {
      return {
        tienda_id: r[0] || "",
        nombre_tienda: r[1] || "",
        cadena: r[2] || "",
        ciudad: r[3] || "",
        region: r[4] || "",
      };
    }
  }
  return null;
}

// Envío real vía Twilio a los teléfonos del grupo del cliente
async function enviarFotoAGrupoCliente(evidence, grupo) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.warn(
      "⚠️ No hay twilioClient o TWILIO_WHATSAPP_FROM. No se puede reenviar la foto al cliente."
    );
    return { ok: false, enviados: 0 };
  }

  // Obtener nombre del promotor a partir de PROMOTORES
  let nombrePromotor = evidence.promotor_nombre || evidence.telefono;
  try {
    const promRows = await getSheetValues("PROMOTORES!A2:C"); // tel, id, nombre
    for (const r of promRows) {
      const tel = (r[0] || "").trim();
      if (tel === evidence.telefono) {
        nombrePromotor = r[2] || nombrePromotor;
        break;
      }
    }
  } catch (err) {
    console.error("Error buscando nombre de promotor:", err);
  }

  // Obtener tienda (si viene de visita)
  let tiendaTexto = "";
  try {
    if (evidence.visita_id) {
      const visita = await getVisitaPorId(evidence.visita_id);
      if (visita && visita.tienda_id) {
        const tienda = await getTiendaPorId(visita.tienda_id);
        if (tienda) {
          tiendaTexto = tienda.nombre_tienda;
          if (tienda.ciudad) {
            tiendaTexto += " (" + tienda.ciudad + ")";
          }
        }
      }
    }
  } catch (err) {
    console.error("Error buscando tienda por visita:", err);
  }

  const textoBase =
    "🏪 *Evidencia en punto de venta*\n" +
    (grupo.cliente ? "👤 Cliente: " + grupo.cliente + "\n" : "") +
    (tiendaTexto ? "🏬 Tienda: " + tiendaTexto + "\n" : "") +
    "🧑‍💼 Promotor: " +
    nombrePromotor +
    "\n" +
    (evidence.fecha_hora ? "📅 Fecha: " + evidence.fecha_hora + "\n" : "") +
    "🎯 Tipo: " +
    evidence.tipo_evento +
    "\n" +
    "🧠 EVIDENCIA+ (demo) – Riesgo: " +
    evidence.riesgo +
    "\n";

  let enviados = 0;
  for (const telDestino of grupo.telefonos) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: telDestino,
        body: textoBase,
        mediaUrl: evidence.url_foto ? [evidence.url_foto] : undefined,
      });
      enviados++;
    } catch (err) {
      console.error("Error enviando mensaje a cliente:", telDestino, err);
    }
  }

  return { ok: enviados > 0, enviados };
}

// ===============================
// JORNADAS (asistencia) helpers
// Hoja JORNADAS:
// [0] jornada_id, [1] telefono, [2] promotor_id, [3] fecha,
// [4] hora_entrada, [5] lat_entrada, [6] lon_entrada, [7] foto_entrada_url,
// [8] hora_salida, [9] lat_salida, [10] lon_salida, [11] foto_salida_url,
// [12] estado
// ===============================
async function findJornadaById(jornada_id) {
  const rows = await getSheetValues("JORNADAS!A2:M");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[0] === jornada_id) {
      return { rowIndex: i + 2, row: r };
    }
  }
  return null;
}

async function getJornadaAbiertaPorTelefono(telefono) {
  const rows = await getSheetValues("JORNADAS!A2:M");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tel = r[1];
    const estado = (r[12] || "").toString().toUpperCase();
    const horaSalida = r[8];
    if (tel === telefono && estado !== "CERRADA" && !horaSalida) {
      return {
        rowIndex: i + 2,
        jornada_id: r[0],
        telefono: r[1],
        promotor_id: r[2],
        fecha: r[3],
        hora_entrada: r[4],
        lat_entrada: r[5],
        lon_entrada: r[6],
        foto_entrada_url: r[7],
        hora_salida: r[8],
        lat_salida: r[9],
        lon_salida: r[10],
        foto_salida_url: r[11],
        estado: r[12] || "",
      };
    }
  }
  return null;
}

async function crearJornadaEntrada(telefono, promotor_id) {
  const jornada_id = "J-" + Date.now();
  const now = new Date();
  const fecha = now.toISOString().slice(0, 10);
  const hora_entrada = now.toISOString();

  await appendSheetValues("JORNADAS!A2:M", [
    [
      jornada_id,
      telefono,
      promotor_id || "",
      fecha,
      hora_entrada,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "ABIERTA",
    ],
  ]);

  return jornada_id;
}

async function actualizarEntradaFoto(jornada_id, fotoUrl) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = "JORNADAS!H" + j.rowIndex + ":H" + j.rowIndex;
  await updateSheetValues(range, [[fotoUrl]]);
}

async function actualizarEntradaUbicacion(jornada_id, lat, lon) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = "JORNADAS!F" + j.rowIndex + ":G" + j.rowIndex;
  await updateSheetValues(range, [[lat, lon]]);
}

async function registrarSalidaHora(jornada_id) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const ahora = new Date().toISOString();
  const range = "JORNADAS!I" + j.rowIndex + ":I" + j.rowIndex;
  await updateSheetValues(range, [[ahora]]);
}

async function actualizarSalidaFoto(jornada_id, fotoUrl) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = "JORNADAS!L" + j.rowIndex + ":L" + j.rowIndex;
  await updateSheetValues(range, [[fotoUrl]]);
}

async function actualizarSalidaUbicacionYCerrar(jornada_id, lat, lon) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const rangePos = "JORNADAS!J" + j.rowIndex + ":K" + j.rowIndex;
  await updateSheetValues(rangePos, [[lat, lon]]);
  const rangeEstado = "JORNADAS!M" + j.rowIndex + ":M" + j.rowIndex;
  await updateSheetValues(rangeEstado, [["CERRADA"]]);
}

// Jornadas de hoy por equipo (para supervisor)
async function getJornadasHoyPorEquipo(promotores) {
  const rows = await getSheetValues("JORNADAS!A2:M");
  if (!rows || !rows.length) return {};
  const hoy = new Date().toISOString().slice(0, 10);
  const telSet = new Set(
    promotores.map((p) => ((p.telefono || "").trim()))
  );
  const mapa = {};
  for (const r of rows) {
    const tel = (r[1] || "").trim();
    const fecha = (r[3] || "").slice(0, 10);
    if (!telSet.has(tel)) continue;
    if (fecha !== hoy) continue;
    // Último registro del día será el vigente
    mapa[tel] = r;
  }
  return mapa;
}

// ==========================
// EVIDENCIAS (hoja EVIDENCIAS)
// ==========================
function demoAnalisisPorTipo(tipo_evento) {
  switch (tipo_evento) {
    case "ENTRADA_DIA":
      return {
        resultado_ai: "Foto de entrada en punto de venta (demo).",
        score_confianza: 0.95,
        riesgo: "BAJO",
      };
    case "SALIDA_DIA":
      return {
        resultado_ai: "Foto de salida coherente con el contexto de tienda (demo).",
        score_confianza: 0.94,
        riesgo: "BAJO",
      };
    case "FOTO_EXHIBICION":
      return {
        resultado_ai: "Exhibición / anaquel detectado, producto frontal visible (demo).",
        score_confianza: 0.93,
        riesgo: "BAJO",
      };
    case "AUDITORIA_DIRECTA":
      return {
        resultado_ai: "Evidencia en punto de venta analizada (demo).",
        score_confianza: 0.9,
        riesgo: "BAJO",
      };
    default:
      return {
        resultado_ai: "Evidencia registrada (demo).",
        score_confianza: 0.9,
        riesgo: "BAJO",
      };
  }
}

async function registrarEvidencia({
  telefono,
  tipo_evento,
  origen,
  jornada_id = "",
  visita_id = "",
  fotoUrl = "",
  lat = "",
  lon = "",
}) {
  const evidencia_id = "EV-" + Date.now();
  const fecha_hora = new Date().toISOString();
  const { resultado_ai, score_confianza, riesgo } =
    demoAnalisisPorTipo(tipo_evento);

  await appendSheetValues("EVIDENCIAS!A2:M", [
    [
      evidencia_id,
      telefono,
      fecha_hora,
      tipo_evento,
      origen,
      jornada_id,
      visita_id,
      fotoUrl,
      lat,
      lon,
      resultado_ai,
      score_confianza,
      riesgo,
    ],
  ]);

  return { evidencia_id, resultado_ai, score_confianza, riesgo };
}

// ==========================
// PUNTOS (hoja PUNTOS)
// ==========================
// PUNTOS: [A] fecha_hora, [B] telefono, [C] tipo, [D] origen, [E] puntos
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
    const pts = Number(row[4] || 0);
    if (tel === telefono) {
      if (tipo === "OPERACION") operacion += pts;
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
// Helpers de catálogo: PROMOTORES
// ==========================
async function getPromotorPorTelefono(telefono) {
  const rows = await getSheetValues("PROMOTORES!A2:F");
  for (const row of rows) {
    if ((row[0] || "").trim() === telefono) {
      const activo = (row[5] || "").toString().toUpperCase() === "TRUE";
      return {
        telefono: row[0],
        promotor_id: row[1],
        nombre: row[2],
        region: row[3],
        cadena_principal: row[4],
        activo,
      };
    }
  }
  return null;
}

// ==========================
// Historial de asistencias (promotor)
// ==========================
async function getHistorialAsistenciasTexto(telefono, limite) {
  const rows = await getSheetValues("JORNADAS!A2:M");
  if (!rows || !rows.length) {
    return (
      "🕒 *Historial de asistencias*\n" +
      "Aún no tengo registros de asistencia tuyos.\n\n" +
      "Usa la opción 1️⃣ del menú para registrar tu próxima entrada."
    );
  }

  const lista = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const tel = (r[1] || "").trim();
    if (tel !== telefono) continue;
    lista.push(r);
    if (lista.length >= (limite || 5)) break;
  }

  if (!lista.length) {
    return (
      "🕒 *Historial de asistencias*\n" +
      "Aún no tengo registros de asistencia tuyos.\n\n" +
      "Usa la opción 1️⃣ del menú para registrar tu próxima entrada."
    );
  }

  let msg = "🕒 *Tus últimas asistencias*\n\n";
  lista.forEach((r, idx) => {
    const fecha = r[3] || "";
    const horaEntrada = r[4] || "";
    const horaSalida = r[8] || "";
    const estado = r[12] || "";
    const entradaCorta = horaEntrada ? horaEntrada.substring(11, 16) : "—";
    const salidaCorta = horaSalida ? horaSalida.substring(11, 16) : "—";
    msg +=
      (idx + 1) +
      ") " +
      fecha +
      " – Entrada: " +
      entradaCorta +
      " – Salida: " +
      salidaCorta +
      " – Estado: " +
      (estado || "SIN ESTADO") +
      "\n";
  });

  msg += "\nEscribe *menu* para volver al inicio.";
  return msg;
}

// ==========================
// Estados de conversación
// ==========================
const STATE_MENU = "MENU_PRINCIPAL";

// Asistencia (promotor)
const STATE_DIA_MENU = "DIA_MENU";
const STATE_JORNADA_FOTO_SUBEVENTO = "JORNADA_FOTO_SUBEVENTO";
const STATE_JORNADA_UBICACION_SUBEVENTO = "JORNADA_UBICACION_SUBEVENTO";

// Supervisor
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";

// Evidencia directa
const STATE_EVIDENCIA_FOTO = "EVIDENCIA_FOTO";

// ==========================
// Sesiones (hoja SESIONES)
// A: telefono, B: estado_actual, C: data_json
// ==========================
async function findSessionRow(telefono) {
  const rows = await getSheetValues("SESIONES!A2:C");
  if (!rows.length) return null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if ((row[0] || "").trim() === telefono) {
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
    const range = "SESIONES!A" + sesion.rowIndex + ":C" + sesion.rowIndex;
    await updateSheetValues(range, [[telefono, estado_actual, dataStr]]);
  }
}

// ==========================
// Menús y ayuda
// ==========================
function buildMenuPrincipal() {
  return (
    "👋 Hola, soy *Promobolsillo+*.\n\n" +
    "¿Qué quieres hacer?\n" +
    "1️⃣ Registrar asistencia (entrada/salida con foto + ubicación)\n" +
    "2️⃣ Registrar evidencias de anaquel (foto + auditoría EVIDENCIA+ demo)\n" +
    "3️⃣ Ver mi historial de asistencias\n" +
    "4️⃣ Ayuda\n\n" +
    "Puedes escribir *menu* en cualquier momento."
  );
}

function buildAyudaPromotor() {
  return (
    "🤖 *Ayuda Promobolsillo+ – Promotor*\n\n" +
    "Comandos rápidos:\n" +
    "• *menu* → volver al inicio\n" +
    "• *ayuda* → ver esta ayuda\n" +
    "• *sup* → abrir menú de supervisor (si tu número está dado de alta como supervisor)\n\n" +
    "Menú principal:\n" +
    "1️⃣ Registrar asistencia (entrada/salida con foto + ubicación)\n" +
    "2️⃣ Registrar evidencias de anaquel (foto + auditoría EVIDENCIA+ demo)\n" +
    "3️⃣ Ver mi historial de asistencias\n" +
    "4️⃣ Ayuda\n"
  );
}

function buildSupervisorMenu(supervisor) {
  const nombre = supervisor?.nombre || "Supervisor";
  return (
    "👋 Hola, *" +
    nombre +
    "* (Supervisor).\n\n" +
    "¿Qué quieres hacer hoy?\n" +
    "1️⃣ Ver fotos de hoy por promotor\n" +
    "2️⃣ Ver fotos de hoy con riesgo MEDIO/ALTO 🧠📸\n" +
    "3️⃣ Ver asistencia de mi equipo\n" +
    "4️⃣ Usar menú de promotor (demo)\n" +
    "5️⃣ Ayuda\n\n" +
    "Escribe el número de la opción o *menu* en cualquier momento."
  );
}

function buildAyudaSupervisor() {
  return (
    "🤖 *Ayuda Promobolsillo+ – Supervisor*\n\n" +
    "Comandos rápidos:\n" +
    "• *sup* → abrir este menú de supervisor\n" +
    "• *menu* → volver al menú de promotor\n" +
    "• *ayuda* → ver esta ayuda\n\n" +
    "Menú de supervisor:\n" +
    "1️⃣ Ver fotos de hoy por promotor\n" +
    "2️⃣ Ver fotos de hoy con riesgo MEDIO/ALTO\n" +
    "3️⃣ Ver asistencia de mi equipo\n" +
    "4️⃣ Usar menú de promotor (demo)\n" +
    "5️⃣ Ayuda\n\n" +
    "Dentro de listas de fotos puedes usar:\n" +
    "• `ver 2` → ver detalle + foto 2\n" +
    "• `enviar 1` → enviar solo la foto 1\n" +
    "• `enviar 1,3,4` → enviar varias evidencias al cliente\n" +
    "• `enviar todas` → enviar todas las evidencias listadas\n"
  );
}

// ===============================
// Menú y flujo para SUPERVISOR
// ===============================
async function handleSupervisor(
  telefonoSupervisor,
  supervisor,
  estado,
  text,
  data,
  inbound
) {
  const lower = (text || "").trim().toLowerCase();

  if (!supervisor) {
    await setSession(telefonoSupervisor, STATE_MENU, {});
    return (
      "⚠️ Tu número ya no aparece como supervisor.\n" +
      "Escribe *menu* para usar el bot como promotor."
    );
  }

  // Atajos globales dentro del modo supervisor
  if (lower === "menu" || lower === "inicio") {
    await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
    return buildSupervisorMenu(supervisor);
  }

  if (lower === "ayuda" || lower === "help") {
    return buildAyudaSupervisor();
  }

  // -------- MENÚ PRINCIPAL SUPERVISOR --------
  if (estado === STATE_SUP_MENU) {
    // 1) Ver fotos de hoy por promotor
    if (lower === "1" || lower === "1️⃣") {
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Pide que te asignen promotores con la columna *telefono_supervisor*."
        );
      }

      const evidenciasHoy = await getEvidenciasHoy();
      const conteos = {};
      for (const ev of evidenciasHoy) {
        conteos[ev.telefono] = (conteos[ev.telefono] || 0) + 1;
      }

      let msg = "👀 *Fotos de hoy por promotor*\n\n";
      promotores.forEach((p, idx) => {
        const cuenta = conteos[p.telefono] || 0;
        msg += (idx + 1) + ") " + p.nombre + " – " + cuenta + " foto(s)\n";
      });
      msg +=
        "\nResponde con el *número* del promotor para ver el detalle.\n" +
        "O escribe *menu* para volver.";

      await setSession(telefonoSupervisor, STATE_SUP_PROMOTOR_LIST, {
        promotores,
      });

      return msg;
    }

    // 2) Ver fotos de hoy con riesgo MEDIO/ALTO
    if (lower === "2" || lower === "2️⃣") {
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Pide que te asignen promotores con la columna *telefono_supervisor*."
        );
      }

      const telefonosEquipo = new Set(
        promotores.map((p) => (p.telefono || "").trim())
      );
      const evidenciasHoy = await getEvidenciasHoy();
      const mapTelNombre = {};
      promotores.forEach((p) => {
        mapTelNombre[p.telefono] = p.nombre;
      });

      const filtradas = evidenciasHoy
        .filter(
          (ev) =>
            telefonosEquipo.has(ev.telefono) &&
            (ev.riesgo === "MEDIO" || ev.riesgo === "ALTO")
        )
        .map((ev) => ({
          ...ev,
          promotor_nombre: mapTelNombre[ev.telefono] || ev.telefono,
        }));

      if (!filtradas.length) {
        return (
          "🧠📸 Hoy no hay fotos con riesgo MEDIO/ALTO para tu equipo.\n" +
          "Escribe *menu* para otras opciones."
        );
      }

      let msg =
        "🧠📸 *Fotos de hoy con riesgo MEDIO/ALTO de tu equipo*\n\n";
      filtradas.forEach((ev, idx) => {
        msg +=
          (idx + 1) +
          ") " +
          ev.tipo_evento +
          " – " +
          ev.promotor_nombre +
          " – riesgo " +
          ev.riesgo +
          "\n";
      });
      msg +=
        "\nComandos disponibles:\n" +
        "• `ver 2` → ver detalle + foto 2\n" +
        "• `enviar 1,2,4` → enviar varias evidencias\n" +
        "• `enviar todas` → enviar todas las evidencias listadas\n" +
        "• `menu` → volver al menú de supervisor";

      await setSession(telefonoSupervisor, STATE_SUP_FOTOS_LIST, {
        modo: "RIESGO",
        listado: filtradas,
      });

      return msg;
    }

    // 3) Ver asistencia de mi equipo
    if (lower === "3" || lower === "3️⃣") {
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Pide que te asignen promotores con la columna *telefono_supervisor*."
        );
      }

      const mapa = await getJornadasHoyPorEquipo(promotores);
      let msg = "🕒 *Asistencia de tu equipo hoy*\n\n";
      promotores.forEach((p) => {
        const tel = (p.telefono || "").trim();
        const r = mapa[tel];
        if (!r) {
          msg += "- " + p.nombre + ": sin registro de entrada hoy.\n";
        } else {
          const fecha = r[3] || "";
          const horaEntrada = r[4] || "";
          const horaSalida = r[8] || "";
          const estado = r[12] || "";
          const entradaCorta = horaEntrada
            ? horaEntrada.substring(11, 16)
            : "—";
          const salidaCorta = horaSalida
            ? horaSalida.substring(11, 16)
            : "—";
          msg +=
            "- " +
            p.nombre +
            ": " +
            fecha +
            " – Entrada " +
            entradaCorta +
            " – Salida " +
            salidaCorta +
            " – Estado " +
            (estado || "SIN ESTADO") +
            "\n";
        }
      });

      msg += "\nEscribe *menu* para volver al menú de supervisor.";
      return msg;
    }

    // 4) Usar menú de promotor
    if (lower === "4" || lower === "4️⃣") {
      await setSession(telefonoSupervisor, STATE_MENU, {});
      return (
        "Has vuelto al menú de promotor.\n\n" + buildMenuPrincipal()
      );
    }

    // 5) Ayuda
    if (lower === "5" || lower === "5️⃣") {
      return buildAyudaSupervisor();
    }

    // Cualquier otra cosa: re-mostrar menú
    return buildSupervisorMenu(supervisor);
  }

  // -------- ELECCIÓN DE PROMOTOR --------
  if (estado === STATE_SUP_PROMOTOR_LIST) {
    const promotores = data.promotores || [];

    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > promotores.length) {
      let msg = "Elige un número válido de promotor:\n\n";
      promotores.forEach((p, idx) => {
        msg += (idx + 1) + ") " + p.nombre + "\n";
      });
      msg += "\nO escribe *menu* para volver.";
      return msg;
    }

    const prom = promotores[n - 1];
    const evidenciasHoy = await getEvidenciasHoy();
    const listado = evidenciasHoy
      .filter((ev) => ev.telefono === prom.telefono)
      .map((ev) => ({
        ...ev,
        promotor_nombre: prom.nombre,
      }));

    if (!listado.length) {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return (
        "⚠️ Hoy no hay fotos registradas para *" +
        prom.nombre +
        "*.\n" +
        "Escribe *menu* para volver al menú de supervisor."
      );
    }

    let msg = "📷 *Fotos de hoy de " + prom.nombre + "*\n\n";
    listado.forEach((ev, idx) => {
      msg +=
        (idx + 1) +
        ") " +
        ev.tipo_evento +
        " – riesgo " +
        ev.riesgo +
        "\n";
    });
    msg +=
      "\nEscribe, por ejemplo:\n" +
      "• `ver 1` → para ver la foto 1\n" +
      "• `enviar 1,3` → para enviar varias evidencias\n" +
      "• `enviar todas` → para enviar todas\n" +
      "• `menu` → volver al menú de supervisor";

    await setSession(telefonoSupervisor, STATE_SUP_FOTOS_LIST, {
      modo: "POR_PROMOTOR",
      promotor_nombre: prom.nombre,
      promotor_telefono: prom.telefono,
      listado,
    });

    return msg;
  }

  // -------- LISTADO DE FOTOS (ver / enviar múltiple) --------
  if (estado === STATE_SUP_FOTOS_LIST) {
    const listado = data.listado || [];

    const verMatch = lower.match(/^ver\s+(\d+)/);
    if (verMatch) {
      const idx = parseInt(verMatch[1], 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= listado.length) {
        return (
          "⚠️ Número inválido. Usa por ejemplo `ver 1` o `enviar 1,3`.\n" +
          "Escribe *menu* para volver."
        );
      }
      const ev = listado[idx];

      const texto =
        "🧾 *Detalle de foto " +
        (idx + 1) +
        "*\n" +
        (ev.promotor_nombre
          ? "👤 Promotor: " + ev.promotor_nombre + "\n"
          : "") +
        (ev.fecha_hora ? "📅 Fecha: " + ev.fecha_hora + "\n" : "") +
        "🎯 Tipo: " +
        ev.tipo_evento +
        "\n" +
        "🧠 EVIDENCIA+ (demo): " +
        (ev.resultado_ai || "Evidencia registrada.") +
        "\n" +
        "⚠️ Riesgo: " +
        ev.riesgo +
        "\n\n" +
        "Puedes escribir:\n" +
        "`enviar " +
        (idx + 1) +
        "` → para reenviar esta foto al cliente\n" +
        "`enviar 1,3,4` → para reenviar varias\n" +
        "`enviar todas` → para reenviar todas las evidencias listadas\n" +
        "`menu` → volver al menú de supervisor";

      // Devolvemos texto + mediaUrl para que el bot mande también la foto
      return {
        text: texto,
        mediaUrl: ev.url_foto || null,
      };
    }

    // enviar X / enviar 1,2,4 / enviar todas
    if (lower.startsWith("enviar")) {
      let resto = lower.replace(/^enviar\s+/, "").trim();

      let seleccionadas = [];

      if (resto === "todas" || resto === "todos") {
        seleccionadas = listado.slice();
      } else {
        const partes = resto
          .split(/[, ]+/)
          .map((p) => p.trim())
          .filter((p) => p);
        if (!partes.length) {
          return (
            "⚠️ No entendí qué evidencias quieres enviar.\n" +
            "Ejemplos:\n" +
            "• `enviar 2`\n" +
            "• `enviar 1,3,4`\n" +
            "• `enviar todas`"
          );
        }
        const indices = [];
        for (const parte of partes) {
          const n = parseInt(parte, 10);
          if (Number.isNaN(n) || n < 1 || n > listado.length) {
            return (
              "⚠️ Uno de los números no es válido.\n" +
              "Asegúrate de que estén dentro del rango 1–" +
              listado.length +
              "."
            );
          }
          indices.push(n - 1);
        }
        // Quitar duplicados
        const uniq = Array.from(new Set(indices));
        seleccionadas = uniq.map((i) => listado[i]);
      }

      if (!seleccionadas.length) {
        return "⚠️ No hay evidencias para enviar en esta lista.";
      }

      const grupos = await getGruposClienteActivos();
      if (!grupos.length) {
        return (
          "⚠️ No hay grupos de cliente activos en la hoja GRUPOS_CLIENTE.\n" +
          "Da de alta al menos un grupo antes de usar esta opción."
        );
      }

      let msg =
        "📤 *Enviar evidencias al cliente*\n\n" +
        "Has seleccionado *" +
        seleccionadas.length +
        "* evidencia(s).\n\n" +
        "¿A qué grupo quieres enviarlas?\n\n";
      grupos.forEach((g, i) => {
        msg += (i + 1) + ") " + g.nombre_grupo;
        if (g.cliente) msg += " – " + g.cliente;
        msg += "\n";
      });
      msg +=
        "\nResponde con el *número* del grupo o escribe *menu* para cancelar.";

      await setSession(telefonoSupervisor, STATE_SUP_ELEGIR_GRUPO, {
        evidenciasSeleccionadas: seleccionadas,
        grupos,
      });

      return msg;
    }

    return (
      "⚠️ No entendí tu respuesta.\n" +
      "Usa por ejemplo `ver 1`, `enviar 1,3`, `enviar todas` o escribe *menu* para volver."
    );
  }

  // -------- ELECCIÓN DE GRUPO PARA ENVÍO --------
  if (estado === STATE_SUP_ELEGIR_GRUPO) {
    const grupos = data.grupos || [];
    const evidencias = data.evidenciasSeleccionadas || [];

    if (lower === "menu" || lower === "cancelar" || lower === "no") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > grupos.length) {
      let msg =
        "⚠️ Número inválido. Elige uno de los siguientes grupos:\n\n";
      grupos.forEach((g, i) => {
        msg += (i + 1) + ") " + g.nombre_grupo;
        if (g.cliente) msg += " – " + g.cliente;
        msg += "\n";
      });
      msg += "\nO escribe *menu* para cancelar.";
      return msg;
    }

    const grupo = grupos[n - 1];
    let totalEvidencias = 0;

    for (const ev of evidencias) {
      const resultado = await enviarFotoAGrupoCliente(ev, grupo);
      if (resultado.ok) {
        totalEvidencias++;
      }
    }

    await setSession(telefonoSupervisor, STATE_SUP_MENU, {});

    if (!totalEvidencias) {
      return (
        "⚠️ No se pudo enviar ninguna evidencia al cliente. " +
        "Revisa que las variables de entorno de Twilio estén configuradas.\n" +
        "Escribe *menu* para volver al menú de supervisor."
      );
    }

    return (
      "✅ Se enviaron *" +
      totalEvidencias +
      "* evidencias al grupo *" +
      grupo.nombre_grupo +
      "*.\n\n" +
      "Escribe *menu* para volver al menú de supervisor."
    );
  }

  // Por defecto, regresa al menú de supervisor
  await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
  return buildSupervisorMenu(supervisor);
}

// ==========================
// 1) Asistencia (promotor)
// ==========================
async function handleDia(telefono, estado, text, data, inbound) {
  const numMedia = parseInt(inbound?.NumMedia || "0", 10);
  const mediaUrl0 = inbound?.MediaUrl0 || "";
  const lat = inbound?.Latitude || inbound?.Latitude0 || "";
  const lon = inbound?.Longitude || inbound?.Longitude0 || "";

  const jornada = await getJornadaAbiertaPorTelefono(telefono);

  // ====== MENÚ "ASISTENCIA" ======
  if (estado === STATE_DIA_MENU) {
    // Sin asistencia abierta
    if (!jornada) {
      if (text === "1") {
        const promotor = await getPromotorPorTelefono(telefono);
        const jornada_id = await crearJornadaEntrada(
          telefono,
          promotor ? promotor.promotor_id : ""
        );
        await setSession(telefono, STATE_JORNADA_FOTO_SUBEVENTO, {
          jornada_id,
          subtipo: "ENTRADA_DIA",
        });
        return (
          "🕒 *Registro de entrada*\n" +
          "📸 Envía una *foto de entrada* (selfie en tienda / punto de venta)."
        );
      }

      if (text === "2") {
        await setSession(telefono, STATE_MENU, {});
        return buildMenuPrincipal();
      }

      return (
        "🕒 *Asistencia en tienda*\n" +
        "No tengo registrada tu entrada de hoy.\n\n" +
        "1️⃣ Registrar entrada (foto + ubicación)\n" +
        "2️⃣ Volver al menú"
      );
    }

    // Con asistencia abierta
    if (text === "1") {
      await registrarSalidaHora(jornada.jornada_id);
      await setSession(telefono, STATE_JORNADA_FOTO_SUBEVENTO, {
        jornada_id: jornada.jornada_id,
        subtipo: "SALIDA_DIA",
      });
      return (
        "🚪 *Registrar salida*\n" +
        "📸 Envía una *foto de salida* (frente de tienda / salida)."
      );
    }

    if (text === "2") {
      const horaEntradaStr = jornada.hora_entrada || "";
      const horaLocal = horaEntradaStr
        ? horaEntradaStr.substring(11, 16)
        : "";
      const fecha = jornada.fecha || "";
      const salidaStr = jornada.hora_salida || "";
      const salidaLocal = salidaStr
        ? salidaStr.substring(11, 16)
        : "Pendiente";

      return (
        "📋 *Detalle de tu asistencia de hoy*\n" +
        "📅 Fecha: *" +
        (fecha || "(sin fecha)") +
        "*\n" +
        (horaLocal ? "🕒 Entrada: *" + horaLocal + "*\n" : "") +
        "🚪 Salida: *" +
        salidaLocal +
        "*\n" +
        (jornada.lat_entrada && jornada.lon_entrada
          ? "📍 Entrada: lat " +
            jornada.lat_entrada +
            ", lon " +
            jornada.lon_entrada +
            "\n"
          : "") +
        (jornada.lat_salida && jornada.lon_salida
          ? "📍 Salida: lat " +
            jornada.lat_salida +
            ", lon " +
            jornada.lon_salida +
            "\n"
          : "") +
        "\nEscribe *menu* para volver al inicio."
      );
    }

    if (text === "3") {
      await setSession(telefono, STATE_MENU, {});
      return buildMenuPrincipal();
    }

    return (
      "🕒 *Asistencia en tienda*\n" +
      "Tienes una asistencia abierta hoy.\n\n" +
      "1️⃣ Registrar salida (foto + ubicación)\n" +
      "2️⃣ Ver detalles de mi asistencia\n" +
      "3️⃣ Volver al menú"
    );
  }

  // ====== SUBEVENTOS: FOTO ======
  if (estado === STATE_JORNADA_FOTO_SUBEVENTO) {
    if (!numMedia || numMedia < 1 || !mediaUrl0) {
      return (
        "Necesito que me envíes una *foto* para este registro.\n" +
        "Adjunta una foto y vuelve a enviar el mensaje."
      );
    }

    const { jornada_id, subtipo } = data;
    if (subtipo === "ENTRADA_DIA") {
      await actualizarEntradaFoto(jornada_id, mediaUrl0);
    } else if (subtipo === "SALIDA_DIA") {
      await actualizarSalidaFoto(jornada_id, mediaUrl0);
    }

    await setSession(telefono, STATE_JORNADA_UBICACION_SUBEVENTO, {
      jornada_id,
      subtipo,
      fotoUrl: mediaUrl0,
    });

    return (
      "✅ Foto recibida.\n\n" +
      "📍 Ahora comparte tu *ubicación* desde WhatsApp (mensaje de ubicación) " +
      "o escribe una breve descripción del lugar."
    );
  }

  // ====== SUBEVENTOS: UBICACIÓN + EVIDENCIA ======
  if (estado === STATE_JORNADA_UBICACION_SUBEVENTO) {
    const { jornada_id, subtipo, fotoUrl } = data;
    const latUse = lat || "";
    const lonUse = lon || "";

    // Entrada del día
    if (subtipo === "ENTRADA_DIA") {
      await actualizarEntradaUbicacion(jornada_id, latUse, lonUse);
      await registrarEvidencia({
        telefono,
        tipo_evento: "ENTRADA_DIA",
        origen: "ASISTENCIA",
        jornada_id,
        visita_id: "",
        fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(telefono, "OPERACION", "ENTRADA_JORNADA_" + jornada_id, 3);
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Entrada registrada (foto + ubicación).\n" +
        "🎯 Ganaste *3 puntos* por registrar tu entrada completa.\n\n" +
        "Escribe *menu* para seguir con tu día."
      );
    }

    // Salida del día
    if (subtipo === "SALIDA_DIA") {
      await actualizarSalidaUbicacionYCerrar(jornada_id, latUse, lonUse);
      await registrarEvidencia({
        telefono,
        tipo_evento: "SALIDA_DIA",
        origen: "ASISTENCIA",
        jornada_id,
        visita_id: "",
        fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(telefono, "OPERACION", "SALIDA_JORNADA_" + jornada_id, 3);
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Asistencia cerrada correctamente (foto + ubicación).\n" +
        "🎯 Ganaste *3 puntos* por registrar tu salida.\n\n" +
        "Escribe *menu* para volver al inicio."
      );
    }

    await setSession(telefono, STATE_DIA_MENU, {});
    return (
      "Se registró tu evidencia de asistencia.\n" +
      "Escribe *menu* para continuar."
    );
  }

  await setSession(telefono, STATE_DIA_MENU, {});
  return (
    "🕒 *Asistencia en tienda*\n" +
    "1️⃣ Registrar entrada (foto + ubicación)\n" +
    "2️⃣ Volver al menú"
  );
}

// ==========================
// 2) Evidencia de fotos directa (EVIDENCIA+ demo)
// ==========================
async function handleEvidenciaDirecta(
  telefono,
  estado,
  text,
  data,
  inbound
) {
  const numMedia = parseInt(inbound?.NumMedia || "0", 10);
  const mediaUrl0 = inbound?.MediaUrl0 || "";
  const lat = inbound?.Latitude || inbound?.Latitude0 || "";
  const lon = inbound?.Longitude || inbound?.Longitude0 || "";

  if (!numMedia || numMedia < 1 || !mediaUrl0) {
    return (
      "Necesito que me envíes una *foto* para la auditoría.\n" +
      "Adjunta una imagen y vuelve a enviar el mensaje."
    );
  }

  const modo = data.modo || "AUDITORIA_DIRECTA";
  let tipo_evento = "AUDITORIA_DIRECTA";
  let origen = "DIRECTO";
  let visita_id = data.visitaId || "";
  const jornada = await getJornadaAbiertaPorTelefono(telefono);
  const jornada_id = jornada ? jornada.jornada_id : "";

  if (modo === "FOTO_EXHIBICION" || modo === "FOTO_ANAQUEL") {
    tipo_evento = "FOTO_EXHIBICION";
    origen = "ANAQUEL";
  }

  const { resultado_ai, score_confianza, riesgo } = await registrarEvidencia({
    telefono,
    tipo_evento,
    origen,
    jornada_id,
    visita_id,
    fotoUrl: mediaUrl0,
    lat,
    lon,
  });

  await addPuntos(telefono, "OPERACION", "EVIDENCIA_" + tipo_evento, 3);

  await setSession(telefono, STATE_MENU, {});

  return (
    "🔎 *Resultado EVIDENCIA+ (demo)*\n" +
    "✔️ Análisis: " +
    resultado_ai +
    "\n" +
    "📊 Confianza: " +
    (score_confianza * 100).toFixed(0) +
    "%\n" +
    "⚠️ Riesgo: " +
    riesgo +
    "\n\n" +
    "🎯 Ganaste *3 puntos* por enviar esta evidencia.\n\n" +
    "Escribe *menu* para seguir usando el bot."
  );
}

// ==========================
// Menú principal handler
// ==========================
async function handleMenuPrincipal(telefono, text, inbound) {
  if (!["1", "2", "3", "4"].includes(text)) {
    await setSession(telefono, STATE_MENU, {});
    return buildMenuPrincipal();
  }

  // 1) Asistencia
  if (text === "1") {
    await setSession(telefono, STATE_DIA_MENU, {});
    return await handleDia(telefono, STATE_DIA_MENU, "", {}, inbound || {});
  }

  // 2) Evidencias de anaquel
  if (text === "2") {
    await setSession(telefono, STATE_EVIDENCIA_FOTO, {
      modo: "FOTO_ANAQUEL",
    });
    return (
      "📸 *Registro de evidencias de anaquel*\n\n" +
      "Envíame una foto de la exhibición / anaquel de la marca.\n" +
      "Puedes añadir comentarios en el mismo mensaje si lo deseas.\n\n" +
      "Cada foto será analizada por *EVIDENCIA+ (demo)*."
    );
  }

  // 3) Historial de asistencias
  if (text === "3") {
    const resumen = await getHistorialAsistenciasTexto(telefono, 5);
    return resumen;
  }

  // 4) Ayuda
  if (text === "4") {
    return buildAyudaPromotor();
  }

  return buildMenuPrincipal();
}

// ==========================
// Lógica principal
// ==========================
async function handleIncoming(telefono, body, inbound) {
  const text = (body || "").trim();
  const lower = text.toLowerCase();

  // Comando global: SUPERVISOR
  if (lower === "sup") {
    const supervisor = await getSupervisorPorTelefono(telefono);
    if (!supervisor) {
      return (
        "⚠️ Tu número no está dado de alta como *supervisor*.\n" +
        "Si eres promotor, usa *menu* para ver tus opciones."
      );
    }
    await setSession(telefono, STATE_SUP_MENU, {});
    return buildSupervisorMenu(supervisor);
  }

  // Comando global: AYUDA
  if (lower === "ayuda" || lower === "help") {
    const supervisor = await getSupervisorPorTelefono(telefono);
    if (supervisor) {
      return buildAyudaSupervisor();
    }
    return buildAyudaPromotor();
  }

  // Comando global: PUNTOS
  if (lower === "puntos") {
    const { operacion, capacitacion, total } = await getResumenPuntos(
      telefono
    );
    return (
      "📊 *Tus puntos actuales*\n" +
      "🟦 Operación: " +
      operacion +
      "\n" +
      "🟨 Capacitación: " +
      capacitacion +
      "\n" +
      "🎯 Total: " +
      total +
      "\n\n" +
      "Escribe *menu* para volver al inicio."
    );
  }

  // Comando global: MENU
  if (lower === "menu" || lower === "inicio") {
    await setSession(telefono, STATE_MENU, {});
    return buildMenuPrincipal();
  }

  const sesion = await getSession(telefono);
  const estado = sesion.estado_actual;
  const data = sesion.data_json || {};

  switch (estado) {
    case STATE_SUP_MENU:
    case STATE_SUP_PROMOTOR_LIST:
    case STATE_SUP_FOTOS_LIST:
    case STATE_SUP_ELEGIR_GRUPO: {
      const supervisor = await getSupervisorPorTelefono(telefono);
      return await handleSupervisor(
        telefono,
        supervisor,
        estado,
        text,
        data,
        inbound
      );
    }

    case STATE_MENU:
      return await handleMenuPrincipal(telefono, text, inbound);

    case STATE_DIA_MENU:
    case STATE_JORNADA_FOTO_SUBEVENTO:
    case STATE_JORNADA_UBICACION_SUBEVENTO:
      return await handleDia(telefono, estado, text, data, inbound);

    case STATE_EVIDENCIA_FOTO:
      return await handleEvidenciaDirecta(
        telefono,
        estado,
        text,
        data,
        inbound
      );

    default:
      await setSession(telefono, STATE_MENU, {});
      return "Reinicié tu sesión 🔄.\n\n" + buildMenuPrincipal();
  }
}

// ==========================
// Rutas Express
// ==========================
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  console.log(
    "Mensaje entrante:",
    from,
    body,
    "NumMedia:",
    req.body.NumMedia
  );

  let respuesta;
  try {
    respuesta = await handleIncoming(from, body, req.body);
  } catch (err) {
    console.error("Error en handleIncoming:", err);
    respuesta =
      "Ocurrió un error procesando tu mensaje. Intenta de nuevo más tarde 🙏";
  }

  const twiml = new MessagingResponse();

  if (respuesta && typeof respuesta === "object" && respuesta.text) {
    const msg = twiml.message(respuesta.text);
    if (respuesta.mediaUrl) {
      if (Array.isArray(respuesta.mediaUrl)) {
        respuesta.mediaUrl.forEach((url) => {
          if (url) msg.media(url);
        });
      } else {
        msg.media(respuesta.mediaUrl);
      }
    }
  } else {
    twiml.message(respuesta || "");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Ruta raíz para probar en navegador
app.get("/", (req, res) => {
  res.send(
    "Promobolsillo+ demo está vivo ✅ (asistencia + evidencias + supervisor)"
  );
});

app.listen(PORT, () => {
  console.log("🚀 Promobolsillo+ demo escuchando en puerto " + PORT);
});
