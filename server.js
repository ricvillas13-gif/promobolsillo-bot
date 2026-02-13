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
      "El reenvío de fotos al cliente desde modo supervisor estará deshabilitado."
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
// Helpers para SUPERVISORES, PROMOTORES, GRUPOS CLIENTE
// y EVIDENCIAS (modo supervisor)
// ======================================================

async function getSupervisorPorTelefono(telefono) {
  const rows = await getSheetValues("SUPERVISORES!A2:F");
  if (!rows || !rows.length) return null;

  const fromRaw = (telefono || "").trim();
  const fromDigits = fromRaw.replace(/[^\d]/g, "");

  for (const r of rows) {
    const colRaw = (r[0] || "").trim();
    if (!colRaw) continue;

    const colDigits = colRaw.replace(/[^\d]/g, "");
    const matchExacto = colRaw === fromRaw;
    const matchPorFinal = colDigits && fromDigits.endsWith(colDigits);

    const activo = (r[5] || "").toString().toUpperCase() === "TRUE";
    if ((matchExacto || matchPorFinal) && activo) {
      return {
        telefono: colRaw,
        supervisor_id: r[1] || "",
        nombre: r[2] || "",
        region: r[3] || "",
        nivel: (r[4] || "").toUpperCase(),
        activo: true,
      };
    }
  }
  return null;
}

async function getPromotoresDeSupervisor(telefonoSupervisor) {
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

// Evidencias solo del día de hoy (por fecha YYYY-MM-DD)
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
          tiendaTexto = `${tienda.nombre_tienda}${
            tienda.ciudad ? " (" + tienda.ciudad + ")" : ""
          }`;
        }
      }
    }
  } catch (err) {
    console.error("Error buscando tienda por visita:", err);
  }

  const textoBase =
    "🏪 *Evidencia en punto de venta*\n" +
    (grupo.cliente ? `👤 Cliente: ${grupo.cliente}\n` : "") +
    (tiendaTexto ? `🏬 Tienda: ${tiendaTexto}\n` : "") +
    `🧑‍💼 Promotor: ${nombrePromotor}\n` +
    (evidence.fecha_hora ? `📅 Fecha: ${evidence.fecha_hora}\n` : "") +
    `🎯 Tipo: ${evidence.tipo_evento}\n` +
    `🧠 EVIDENCIA+ (demo) – Riesgo: ${evidence.riesgo}\n`;

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
// Menú y flujo para SUPERVISOR
// ===============================

function buildSupervisorMenu(supervisor) {
  const nombre = supervisor?.nombre || "Supervisor";
  return (
    `👋 Hola, *${nombre}* (Supervisor).\n\n` +
    "¿Qué quieres hacer hoy?\n" +
    "1️⃣ Ver fotos de *hoy* por promotor\n" +
    "2️⃣ Ver fotos de *hoy* con riesgo MEDIO/ALTO 🧠📸\n" +
    "3️⃣ Ver asistencia de mi equipo 🕒\n" +
    "4️⃣ Ver menú estándar de promotor (demo)\n\n" +
    "Escribe el número de la opción o *menu* en cualquier momento."
  );
}

// ==========================
// Estados de conversación
// ==========================
const STATE_MENU = "MENU_PRINCIPAL";

// Mi día de trabajo
const STATE_DIA_MENU = "DIA_MENU";
const STATE_JORNADA_FOTO_SUBEVENTO = "JORNADA_FOTO_SUBEVENTO";
const STATE_JORNADA_UBICACION_SUBEVENTO = "JORNADA_UBICACION_SUBEVENTO";

// Supervisor
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";
const STATE_SUP_ASIST_PROM_LIST = "SUP_ASIST_PROM_LIST";

// Operación en tienda
const STATE_OPER_MENU = "OPER_MENU";
const STATE_OPER_ELEGIR_TIENDA = "OPER_ELEGIR_TIENDA";
const STATE_OPER_VISITA_MENU = "OPER_VISITA_MENU";
const STATE_OPER_INV_PROD = "OPER_INV_PROD";
const STATE_OPER_COMP_COMPETIDOR = "OPER_COMP_COMPETIDOR";
const STATE_OPER_COMP_ACTIVIDAD = "OPER_COMP_ACTIVIDAD";
const STATE_OPER_VENTA = "OPER_VENTA";

// Academia
const STATE_ACAD_MENU = "ACAD_MENU";
const STATE_ACAD_RETO = "ACAD_RETO";

// Auditoría de fotos
const STATE_EVIDENCIA_FOTO = "EVIDENCIA_FOTO";

// Set de estados de supervisor
const SUP_STATES = new Set([
  STATE_SUP_MENU,
  STATE_SUP_PROMOTOR_LIST,
  STATE_SUP_FOTOS_LIST,
  STATE_SUP_ELEGIR_GRUPO,
  STATE_SUP_ASIST_PROM_LIST,
]);

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
// Helpers de catálogo
// ==========================

// PROMOTORES: [telefono, promotor_id, nombre, region, cadena_principal, activo, telefono_supervisor]
async function getPromotorPorTelefono(telefono) {
  const rows = await getSheetValues("PROMOTORES!A2:F");
  for (const row of rows) {
    if (row[0] === telefono) {
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

// TIENDAS: [tienda_id, nombre_tienda, cadena, ciudad, region, activa]
async function getTiendasParaPromotor(promotor) {
  const rows = await getSheetValues("TIENDAS!A2:F");
  if (!rows.length) return [];

  const activas = rows.filter(
    (r) => (r[5] || "").toString().toUpperCase() === "TRUE"
  );

  let filtradas = activas;
  if (promotor) {
    filtradas = activas.filter((r) => {
      const region = r[4];
      const cadena = r[2];
      const okRegion =
        promotor.region && region && region.toString() === promotor.region;
      const okCadena =
        promotor.cadena_principal &&
        cadena &&
        cadena.toString() === promotor.cadena_principal;
      return okRegion || okCadena;
    });
    if (!filtradas.length) filtradas = activas;
  }

  const top = filtradas.slice(0, 6);
  return top.map((r) => ({
    tienda_id: r[0],
    nombre_tienda: r[1],
    cadena: r[2],
    ciudad: r[3],
    region: r[4],
  }));
}

// PRODUCTOS: [producto_id, sku_barcode, nombre_producto, categoria, marca, es_foco, precio_sugerido]
async function getProductosFoco() {
  const rows = await getSheetValues("PRODUCTOS!A2:G");
  if (!rows.length) return [];
  const foco = rows.filter(
    (r) => (r[5] || "").toString().toUpperCase() === "TRUE"
  );
  const lista = (foco.length ? foco : rows).slice(0, 6);
  return lista.map((r) => ({
    producto_id: r[0],
    sku_barcode: r[1],
    nombre_producto: r[2],
    categoria: r[3],
    marca: r[4],
    es_foco: (r[5] || "").toString().toUpperCase() === "TRUE",
    precio_sugerido: r[6],
  }));
}

// ACTIVIDADES_COMPETENCIA: [actividad_id, competidor, tipo_actividad, descripcion_corta, puntos]
async function getCompetidoresCatalogo() {
  const rows = await getSheetValues("ACTIVIDADES_COMPETENCIA!A2:E");
  const set = new Set();
  for (const r of rows) {
    const comp = (r[1] || "").toString().trim();
    if (comp) set.add(comp);
  }
  return Array.from(set);
}

async function getActividadesPorCompetidor(competidor) {
  const rows = await getSheetValues("ACTIVIDADES_COMPETENCIA!A2:E");
  const filtradas = rows.filter((r) => (r[1] || "").toString() === competidor);
  return filtradas.map((r) => ({
    actividad_id: r[0],
    competidor: r[1],
    tipo_actividad: r[2],
    descripcion_corta: r[3],
    puntos: Number(r[4] || 0),
  }));
}

// ==========================
// JORNADAS (sólo entrada/salida día)
// Hoja JORNADAS:
// [0] jornada_id, [1] telefono, [2] promotor_id, [3] fecha,
// [4] hora_entrada, [5] lat_entrada, [6] lon_entrada, [7] foto_entrada_url,
// [8] hora_salida, [9] lat_salida, [10] lon_salida, [11] foto_salida_url,
// [12] estado
// ==========================
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
  const range = `JORNADAS!H${j.rowIndex}:H${j.rowIndex}`;
  await updateSheetValues(range, [[fotoUrl]]);
}

async function actualizarEntradaUbicacion(jornada_id, lat, lon) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = `JORNADAS!F${j.rowIndex}:G${j.rowIndex}`;
  await updateSheetValues(range, [[lat, lon]]);
}

async function registrarSalidaHora(jornada_id) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const ahora = new Date().toISOString();
  const range = `JORNADAS!I${j.rowIndex}:I${j.rowIndex}`;
  await updateSheetValues(range, [[ahora]]);
}

async function actualizarSalidaFoto(jornada_id, fotoUrl) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = `JORNADAS!L${j.rowIndex}:L${j.rowIndex}`;
  await updateSheetValues(range, [[fotoUrl]]);
}

async function actualizarSalidaUbicacionYCerrar(jornada_id, lat, lon) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const rangePos = `JORNADAS!J${j.rowIndex}:K${j.rowIndex}`;
  await updateSheetValues(rangePos, [[lat, lon]]);
  const rangeEstado = `JORNADAS!M${j.rowIndex}:M${j.rowIndex}`;
  await updateSheetValues(rangeEstado, [["CERRADA"]]);
}

// Historico de jornadas por teléfono (últimas N)
async function getJornadasPorTelefono(telefono, max = 10) {
  const rows = await getSheetValues("JORNADAS!A2:M");
  if (!rows || !rows.length) return [];

  const lista = [];

  for (const r of rows) {
    const tel = (r[1] || "").trim();
    if (tel !== telefono) continue;

    const fecha = r[3] || "";
    const hora_entrada = r[4] || "";
    const hora_salida = r[8] || "";

    lista.push({
      jornada_id: r[0] || "",
      telefono: tel,
      fecha,
      hora_entrada,
      hora_salida,
    });
  }

  // Ordenar por fecha+hora_entrada descendente (más reciente primero)
  lista.sort((a, b) => {
    const kA = (a.fecha || "") + (a.hora_entrada || "");
    const kB = (b.fecha || "") + (b.hora_entrada || "");
    if (kA < kB) return 1;
    if (kA > kB) return -1;
    return 0;
  });

  return lista.slice(0, max);
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
        resultado_ai: "Foto de salida del día coherente con tienda (demo).",
        score_confianza: 0.94,
        riesgo: "BAJO",
      };
    case "SALIDA_COMIDA":
      return {
        resultado_ai: "Salida a comer registrada (demo). Fondo de pasillo / salida.",
        score_confianza: 0.9,
        riesgo: "BAJO",
      };
    case "REGRESO_COMIDA":
      return {
        resultado_ai: "Regreso de comida, contexto de tienda (demo).",
        score_confianza: 0.92,
        riesgo: "BAJO",
      };
    case "FOTO_EXHIBICION":
      return {
        resultado_ai:
          "Exhibición secundaria detectada, producto frontal visible (demo).",
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
// Menú principal
// ==========================
function buildMenuPrincipal() {
  return (
    "👋 Hola, soy *Promobolsillo+*.\n\n" +
    "¿Qué quieres hacer?\n" +
    "1️⃣ Mi día de trabajo (entrada, comida, salida – foto + geo)\n" +
    "2️⃣ Operación en tienda 🏪\n" +
    "3️⃣ Academia de bolsillo 🎓\n" +
    "4️⃣ Auditoría de fotos 🧠📸\n" +
    "5️⃣ Ver mis puntos 🎯\n\n" +
    "Puedes escribir *menu* en cualquier momento."
  );
}

// ===============================
// Flujo SUPERVISOR (usa estados SUP_*)
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
      "⚠️ Tu número ya no aparece como supervisor. Escribe *menu* para usar el bot como promotor."
    );
  }

  // -------- MENÚ PRINCIPAL SUPERVISOR --------
  if (estado === STATE_SUP_MENU) {
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
        msg += `${idx + 1}) ${p.nombre} – ${cuenta} foto(s)\n`;
      });
      msg +=
        "\nResponde con el *número* del promotor para ver el detalle.\n" +
        "O escribe *menu* para volver.";

      await setSession(telefonoSupervisor, STATE_SUP_PROMOTOR_LIST, {
        promotores,
      });

      return msg;
    }

    if (lower === "2" || lower === "2️⃣") {
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Pide que te asignen promotores con la columna *telefono_supervisor*."
        );
      }

      const telefonosEquipo = new Set(promotores.map((p) => p.telefono));
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

      let msg = "🧠📸 *Fotos de hoy con riesgo MEDIO/ALTO*\n\n";
      filtradas.forEach((ev, idx) => {
        msg += `${idx + 1}) ${ev.tipo_evento} – ${ev.promotor_nombre} – riesgo ${ev.riesgo}\n`;
      });
      msg +=
        "\nEscribe por ejemplo:\n" +
        "• `ver 2`  → para ver la foto 2\n" +
        "• `enviar 2` → para reenviarla al cliente\n" +
        "• `menu` → volver al menú de supervisor";

      await setSession(telefonoSupervisor, STATE_SUP_FOTOS_LIST, {
        modo: "RIESGO",
        listado: filtradas,
      });

      return msg;
    }

    if (lower === "3" || lower === "3️⃣") {
      // Asistencia de mi equipo
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Pide que te asignen promotores con la columna *telefono_supervisor*."
        );
      }

      const jornadas = await getSheetValues("JORNADAS!A2:M");
      const mapa = {}; // tel -> { total, ultimaFecha }

      promotores.forEach((p) => {
        mapa[p.telefono] = { total: 0, ultimaFecha: "" };
      });

      for (const r of jornadas) {
        const tel = (r[1] || "").trim();
        if (!mapa[tel]) continue;
        const fecha = r[3] || "";
        mapa[tel].total++;
        if (!mapa[tel].ultimaFecha || fecha > mapa[tel].ultimaFecha) {
          mapa[tel].ultimaFecha = fecha;
        }
      }

      let msg = "🕒 *Asistencia de tu equipo (últimas jornadas)*\n\n";
      promotores.forEach((p, idx) => {
        const res = mapa[p.telefono] || { total: 0, ultimaFecha: "" };
        msg += `${idx + 1}) ${p.nombre} – ${res.total} jornada(s)`;
        if (res.ultimaFecha) msg += ` (última: ${res.ultimaFecha})`;
        msg += "\n";
      });
      msg +=
        "\nResponde con el *número* del promotor para ver el detalle de sus asistencias,\n" +
        "o escribe *menu* para volver.";

      await setSession(telefonoSupervisor, STATE_SUP_ASIST_PROM_LIST, {
        promotores,
      });

      return msg;
    }

    if (lower === "4" || lower === "4️⃣") {
      await setSession(telefonoSupervisor, STATE_MENU, {});
      return "Has vuelto al menú estándar. Escribe *menu* para ver las opciones como promotor.";
    }

    return buildSupervisorMenu(supervisor);
  }

  // -------- ASISTENCIA: detalle por promotor --------
  if (estado === STATE_SUP_ASIST_PROM_LIST) {
    if (lower === "menu" || lower === "inicio") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const promotores = data.promotores || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > promotores.length) {
      let msg = "Elige un número válido de promotor:\n\n";
      promotores.forEach((p, idx) => {
        msg += `${idx + 1}) ${p.nombre}\n`;
      });
      msg += "\nO escribe *menu* para volver.";
      return msg;
    }

    const prom = promotores[n - 1];
    const jornadas = await getJornadasPorTelefono(prom.telefono, 10);

    if (!jornadas.length) {
      return (
        `⚠️ No tengo asistencias registradas para *${prom.nombre}*.\n` +
        "Escribe *menu* para volver al menú de supervisor."
      );
    }

    let msg =
      `🕒 *Historial de asistencia de ${prom.nombre}* (últimas ${jornadas.length} jornadas)\n\n`;
    jornadas.forEach((j) => {
      const fecha = j.fecha || "(sin fecha)";
      const ent = j.hora_entrada ? j.hora_entrada.substring(11, 16) : "--:--";
      const sal = j.hora_salida ? j.hora_salida.substring(11, 16) : "—";
      msg += `• ${fecha} – Entrada ${ent} – Salida ${sal}\n`;
    });
    msg += "\nEscribe *menu* para volver al menú de supervisor.";

    return msg;
  }

  // -------- ELECCIÓN DE PROMOTOR (fotos) --------
  if (estado === STATE_SUP_PROMOTOR_LIST) {
    if (lower === "menu" || lower === "inicio") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const promotores = data.promotores || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > promotores.length) {
      let msg = "Elige un número válido de promotor:\n\n";
      promotores.forEach((p, idx) => {
        msg += `${idx + 1}) ${p.nombre}\n`;
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
        `⚠️ Hoy no hay fotos registradas para *${prom.nombre}*.\n` +
        "Escribe *menu* para volver al menú de supervisor."
      );
    }

    let msg = `📷 *Fotos de hoy de ${prom.nombre}*\n\n`;
    listado.forEach((ev, idx) => {
      msg += `${idx + 1}) ${ev.tipo_evento} – riesgo ${ev.riesgo}\n`;
    });
    msg +=
      "\nEscribe por ejemplo:\n" +
      "• `ver 1`  → para ver la foto 1\n" +
      "• `enviar 1` → para reenviarla al cliente\n" +
      "• `menu` → volver al menú de supervisor";

    await setSession(telefonoSupervisor, STATE_SUP_FOTOS_LIST, {
      modo: "POR_PROMOTOR",
      promotor_nombre: prom.nombre,
      promotor_telefono: prom.telefono,
      listado,
    });

    return msg;
  }

  // -------- LISTADO DE FOTOS (ver / enviar) --------
  if (estado === STATE_SUP_FOTOS_LIST) {
    const listado = data.listado || [];

    if (lower === "menu" || lower === "inicio") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const verMatch = lower.match(/^ver\s+(\d+)/);
    const enviarMatch = lower.match(/^enviar\s+(\d+)/);

    if (verMatch) {
      const idx = parseInt(verMatch[1], 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= listado.length) {
        return (
          "⚠️ Número inválido. Usa por ejemplo `ver 1` o `enviar 1`, o escribe *menu* para volver."
        );
      }
      const ev = listado[idx];

      const texto =
        `🧾 *Detalle de foto ${idx + 1}*\n` +
        (ev.promotor_nombre ? `👤 Promotor: ${ev.promotor_nombre}\n` : "") +
        (ev.fecha_hora ? `📅 Fecha: ${ev.fecha_hora}\n` : "") +
        `🎯 Tipo: ${ev.tipo_evento}\n` +
        `🧠 EVIDENCIA+ (demo): ${
          ev.resultado_ai || "Evidencia registrada."
        }\n` +
        `⚠️ Riesgo: ${ev.riesgo}\n\n` +
        "Puedes escribir:\n" +
        `• \`enviar ${idx + 1}\` → para reenviar esta foto al cliente\n` +
        "• `menu` → volver al menú de supervisor";

      return {
        text: texto,
        mediaUrl: ev.url_foto || null,
      };
    }

    if (enviarMatch) {
      const idx = parseInt(enviarMatch[1], 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= listado.length) {
        return (
          "⚠️ Número inválido. Usa por ejemplo `ver 1` o `enviar 1`, o escribe *menu* para volver."
        );
      }

      const ev = listado[idx];
      const grupos = await getGruposClienteActivos();
      if (!grupos.length) {
        return (
          "⚠️ No hay grupos de cliente activos en la hoja GRUPOS_CLIENTE.\n" +
          "Da de alta al menos un grupo antes de usar esta opción."
        );
      }

      let msg =
        "📤 *Enviar foto al cliente*\n\n¿A qué grupo quieres enviarla?\n\n";
      grupos.forEach((g, i) => {
        msg += `${i + 1}) ${g.nombre_grupo}`;
        if (g.cliente) msg += ` – ${g.cliente}`;
        msg += "\n";
      });
      msg += "\nResponde con el *número* del grupo o escribe *menu* para cancelar.";

      await setSession(telefonoSupervisor, STATE_SUP_ELEGIR_GRUPO, {
        evidenciaSeleccionada: ev,
        grupos,
      });

      return msg;
    }

    return (
      "⚠️ No entendí tu respuesta.\n" +
      "Usa por ejemplo `ver 1`, `enviar 1` o escribe *menu* para volver."
    );
  }

  // -------- ELECCIÓN DE GRUPO PARA ENVÍO --------
  if (estado === STATE_SUP_ELEGIR_GRUPO) {
    const grupos = data.grupos || [];
    const ev = data.evidenciaSeleccionada;

    if (lower === "menu" || lower === "cancelar" || lower === "no") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > grupos.length) {
      let msg = "⚠️ Número inválido. Elige uno de los siguientes grupos:\n\n";
      grupos.forEach((g, i) => {
        msg += `${i + 1}) ${g.nombre_grupo}`;
        if (g.cliente) msg += ` – ${g.cliente}`;
        msg += "\n";
      });
      msg += "\nO escribe *menu* para cancelar.";
      return msg;
    }

    const grupo = grupos[n - 1];
    const resultado = await enviarFotoAGrupoCliente(ev, grupo);

    await setSession(telefonoSupervisor, STATE_SUP_MENU, {});

    if (!resultado.ok) {
      return (
        "⚠️ No se pudo enviar la foto al cliente. Revisa que las variables de entorno de Twilio estén configuradas.\n" +
        "Escribe *menu* para volver al menú de supervisor."
      );
    }

    return (
      `✅ Foto enviada al grupo *${grupo.nombre_grupo}* (${resultado.enviados} contacto(s)).\n\n` +
      "Escribe *menu* para volver al menú de supervisor."
    );
  }

  await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
  return buildSupervisorMenu(supervisor);
}

// ==========================
// Lógica principal
// ==========================
async function handleIncoming(telefono, body, inbound) {
  const text = (body || "").trim();
  const lower = text.toLowerCase();

  const sesion = await getSession(telefono);
  const estado = sesion.estado_actual;
  const data = sesion.data_json || {};
  const supervisor = await getSupervisorPorTelefono(telefono);
  const isSupervisorState = SUP_STATES.has(estado);

  // Comando global puntos
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

  // Comando global de supervisor
  if (lower === "sup") {
    if (!supervisor) {
      return (
        "⚠️ Tu número no está dado de alta como supervisor en la hoja SUPERVISORES.\n" +
        "Verifica con administración."
      );
    }
    await setSession(telefono, STATE_SUP_MENU, {});
    return buildSupervisorMenu(supervisor);
  }

  // Comando global menu
  if (lower === "menu" || lower === "inicio") {
    if (supervisor && isSupervisorState) {
      await setSession(telefono, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }
    await setSession(telefono, STATE_MENU, {});
    return buildMenuPrincipal();
  }

  // Si está en modo supervisor, delegamos a handleSupervisor
  if (isSupervisorState) {
    return await handleSupervisor(telefono, supervisor, estado, text, data, inbound);
  }

  // Flujo promotor / estándar
  switch (estado) {
    case STATE_MENU:
      return await handleMenuPrincipal(telefono, text, inbound);

    case STATE_DIA_MENU:
    case STATE_JORNADA_FOTO_SUBEVENTO:
    case STATE_JORNADA_UBICACION_SUBEVENTO:
      return await handleDia(telefono, estado, text, data, inbound);

    case STATE_OPER_MENU:
    case STATE_OPER_ELEGIR_TIENDA:
    case STATE_OPER_VISITA_MENU:
    case STATE_OPER_INV_PROD:
    case STATE_OPER_COMP_COMPETIDOR:
    case STATE_OPER_COMP_ACTIVIDAD:
    case STATE_OPER_VENTA:
      return await handleOperacion(telefono, estado, text, data);

    case STATE_ACAD_MENU:
    case STATE_ACAD_RETO:
      return await handleAcademia(telefono, estado, text, data);

    case STATE_EVIDENCIA_FOTO:
      return await handleEvidenciaDirecta(telefono, estado, text, data, inbound);

    default:
      await setSession(telefono, STATE_MENU, {});
      return "Reinicié tu sesión 🔄.\n\n" + buildMenuPrincipal();
  }
}

// ==========================
// Menú principal handler
// ==========================
async function handleMenuPrincipal(telefono, text, inbound) {
  if (!["1", "2", "3", "4", "5"].includes(text)) {
    await setSession(telefono, STATE_MENU, {});
    return buildMenuPrincipal();
  }

  const jornada = await getJornadaAbiertaPorTelefono(telefono);
  const tieneJornada = !!jornada;

  // 1) Mi día de trabajo
  if (text === "1") {
    await setSession(telefono, STATE_DIA_MENU, {});
    return await handleDia(telefono, STATE_DIA_MENU, "", {}, inbound || {});
  }

  // 2) Operación en tienda
  if (text === "2") {
    if (!tieneJornada) {
      return (
        "Antes de operar en tienda registra tu *entrada del día* en la opción 1️⃣ *Mi día de trabajo*.\n\n" +
        buildMenuPrincipal()
      );
    }
    await setSession(telefono, STATE_OPER_MENU, {});
    return (
      "🧰 *Operación en tienda*\n" +
      "1️⃣ Iniciar visita en tienda\n" +
      "2️⃣ Registrar venta rápida (demo Modelo X)\n" +
      "3️⃣ Volver al menú"
    );
  }

  // 3) Academia
  if (text === "3") {
    await setSession(telefono, STATE_ACAD_MENU, {});
    return (
      "🎓 *Academia de bolsillo*\n" +
      "1️⃣ Reto del día\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú"
    );
  }

  // 4) Auditoría de fotos directa
  if (text === "4") {
    await setSession(telefono, STATE_EVIDENCIA_FOTO, {
      modo: "AUDITORIA_DIRECTA",
    });
    return (
      "🧠📸 *Auditoría de fotos (EVIDENCIA+ demo)*\n\n" +
      "Envíame una foto de:\n" +
      "- Exhibición\n" +
      "- Material POP\n" +
      "- Promotor en piso\n\n" +
      "y te doy un dictamen rápido."
    );
  }

  // 5) Ver mis puntos
  if (text === "5") {
    const { operacion, capacitacion, total } = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos actuales*\n" +
      `🟦 Operación: ${operacion}\n` +
      `🟨 Capacitación: ${capacitacion}\n` +
      `🎯 Total: ${total}\n\n` +
      "Escribe *menu* para volver al inicio."
    );
  }

  return buildMenuPrincipal();
}

// ==========================
// 1) Mi día de trabajo
// ==========================
async function handleDia(telefono, estado, text, data, inbound) {
  const numMedia = parseInt(inbound?.NumMedia || "0", 10);
  const mediaUrl0 = inbound?.MediaUrl0 || "";
  const lat = inbound?.Latitude || inbound?.Latitude0 || "";
  const lon = inbound?.Longitude || inbound?.Longitude0 || "";

  const jornada = await getJornadaAbiertaPorTelefono(telefono);

  // ====== MENÚ "MI DÍA" ======
  if (estado === STATE_DIA_MENU) {
    if (!jornada) {
      // No hay jornada abierta
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
          "🕒 *Inicio de jornada*\n" +
          "📸 Envía una *foto de entrada* (selfie en tienda / punto de venta)."
        );
      }

      if (text === "2") {
        // Historial de asistencias
        const jornadas = await getJornadasPorTelefono(telefono, 10);
        if (!jornadas.length) {
          return (
            "📚 Aún no tengo asistencias históricas registradas para ti.\n" +
            "Registra tu primera entrada con la opción 1️⃣.\n\n" +
            "Escribe *menu* para volver al inicio."
          );
        }

        let msg =
          "📚 *Historial de asistencias (últimas " +
          jornadas.length +
          " jornadas)*\n\n";
        jornadas.forEach((j) => {
          const fecha = j.fecha || "(sin fecha)";
          const ent = j.hora_entrada
            ? j.hora_entrada.substring(11, 16)
            : "--:--";
          const sal = j.hora_salida
            ? j.hora_salida.substring(11, 16)
            : "—";
          msg += `• ${fecha} – Entrada ${ent} – Salida ${sal}\n`;
        });
        msg += "\nEscribe *menu* para volver al inicio.";
        return msg;
      }

      if (text === "3") {
        await setSession(telefono, STATE_MENU, {});
        return buildMenuPrincipal();
      }

      return (
        "🕒 *Mi día de trabajo*\n" +
        "No tengo registrada tu jornada de hoy.\n\n" +
        "1️⃣ Registrar entrada al día (foto + ubicación)\n" +
        "2️⃣ Ver historial de mis asistencias\n" +
        "3️⃣ Volver al menú"
      );
    } else {
      // Jornada abierta
      if (text === "1") {
        await setSession(telefono, STATE_JORNADA_FOTO_SUBEVENTO, {
          jornada_id: jornada.jornada_id,
          subtipo: "SALIDA_COMIDA",
        });
        return (
          "🍽️ *Salida a comer*\n" +
          "📸 Envía una *foto* antes de salir a comer."
        );
      }
      if (text === "2") {
        await setSession(telefono, STATE_JORNADA_FOTO_SUBEVENTO, {
          jornada_id: jornada.jornada_id,
          subtipo: "REGRESO_COMIDA",
        });
        return (
          "🍽️ *Regreso de comida*\n" +
          "📸 Envía una *foto* al regresar a piso / tienda."
        );
      }
      if (text === "3") {
        await registrarSalidaHora(jornada.jornada_id);
        await setSession(telefono, STATE_JORNADA_FOTO_SUBEVENTO, {
          jornada_id: jornada.jornada_id,
          subtipo: "SALIDA_DIA",
        });
        return (
          "🚪 *Salida del día*\n" +
          "📸 Envía una *foto de salida* (frente de tienda / salida)."
        );
      }
      if (text === "4") {
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
          "📋 *Detalle de tu jornada de hoy*\n" +
          `📅 Fecha: *${fecha || "(sin fecha)"}*\n` +
          (horaLocal ? `🕒 Entrada: *${horaLocal}*\n` : "") +
          `🚪 Salida: *${salidaLocal}*\n` +
          (jornada.lat_entrada && jornada.lon_entrada
            ? `📍 Entrada: lat ${jornada.lat_entrada}, lon ${jornada.lon_entrada}\n`
            : "") +
          (jornada.lat_salida && jornada.lon_salida
            ? `📍 Salida: lat ${jornada.lat_salida}, lon ${jornada.lon_salida}\n`
            : "") +
          "\nEscribe *menu* para volver al inicio."
        );
      }
      if (text === "5") {
        const jornadasHist = await getJornadasPorTelefono(telefono, 10);
        if (!jornadasHist.length) {
          return (
            "📚 Aún no tengo asistencias históricas registradas para ti.\n" +
            "Escribe *menu* para volver al inicio."
          );
        }

        let msg =
          "📚 *Historial de asistencias (últimas " +
          jornadasHist.length +
          " jornadas)*\n\n";
        jornadasHist.forEach((j) => {
          const fecha = j.fecha || "(sin fecha)";
          const ent = j.hora_entrada
            ? j.hora_entrada.substring(11, 16)
            : "--:--";
          const sal = j.hora_salida
            ? j.hora_salida.substring(11, 16)
            : "—";
          msg += `• ${fecha} – Entrada ${ent} – Salida ${sal}\n`;
        });
        msg += "\nEscribe *menu* para volver al inicio.";
        return msg;
      }
      if (text === "6") {
        await setSession(telefono, STATE_MENU, {});
        return buildMenuPrincipal();
      }

      return (
        "🕒 *Mi día de trabajo*\n" +
        "Tienes una jornada abierta hoy.\n\n" +
        "1️⃣ Salida a comer (foto + ubicación)\n" +
        "2️⃣ Regreso de comida (foto + ubicación)\n" +
        "3️⃣ Salida del día (foto + ubicación)\n" +
        "4️⃣ Ver detalles de mi jornada de hoy\n" +
        "5️⃣ Ver historial de mis asistencias\n" +
        "6️⃣ Volver al menú"
      );
    }
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
      "📍 Ahora comparte tu *ubicación* desde WhatsApp (mensaje de ubicación) o escribe una breve descripción del lugar."
    );
  }

  // ====== SUBEVENTOS: UBICACIÓN + EVIDENCIA ======
  if (estado === STATE_JORNADA_UBICACION_SUBEVENTO) {
    const { jornada_id, subtipo, fotoUrl } = data;
    const latUse = lat || "";
    const lonUse = lon || "";

    if (subtipo === "ENTRADA_DIA") {
      await actualizarEntradaUbicacion(jornada_id, latUse, lonUse);
      await registrarEvidencia({
        telefono,
        tipo_evento: "ENTRADA_DIA",
        origen: "JORNADA",
        jornada_id,
        visita_id: "",
        fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(telefono, "OPERACION", `ENTRADA_JORNADA_${jornada_id}`, 3);
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Entrada del día registrada (foto + ubicación).\n" +
        "🎯 Ganaste *3 puntos* por registrar tu entrada completa.\n\n" +
        "Escribe *menu* para seguir con tu día."
      );
    }

    if (subtipo === "SALIDA_DIA") {
      await actualizarSalidaUbicacionYCerrar(jornada_id, latUse, lonUse);
      await registrarEvidencia({
        telefono,
        tipo_evento: "SALIDA_DIA",
        origen: "JORNADA",
        jornada_id,
        visita_id: "",
        fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(telefono, "OPERACION", `SALIDA_JORNADA_${jornada_id}`, 3);
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Jornada cerrada correctamente (foto + ubicación).\n" +
        "🎯 Ganaste *3 puntos* por registrar tu salida.\n\n" +
        "Escribe *menu* para volver al inicio."
      );
    }

    if (subtipo === "SALIDA_COMIDA") {
      await registrarEvidencia({
        telefono,
        tipo_evento: "SALIDA_COMIDA",
        origen: "JORNADA",
        jornada_id,
        visita_id: "",
        fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(telefono, "OPERACION", `SALIDA_COMIDA_${jornada_id}`, 2);
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Salida a comer registrada (foto + ubicación).\n" +
        "🎯 Ganaste *2 puntos*.\n\n" +
        "Escribe *menu* para seguir con tu día."
      );
    }

    if (subtipo === "REGRESO_COMIDA") {
      await registrarEvidencia({
        telefono,
        tipo_evento: "REGRESO_COMIDA",
        origen: "JORNADA",
        jornada_id,
        visita_id: "",
        fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(telefono, "OPERACION", `REGRESO_COMIDA_${jornada_id}`, 2);
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Regreso de comida registrado (foto + ubicación).\n" +
        "🎯 Ganaste *2 puntos*.\n\n" +
        "Escribe *menu* para seguir con tu día."
      );
    }

    await setSession(telefono, STATE_DIA_MENU, {});
    return "Se registró tu evidencia. Escribe *menu* para continuar.";
  }

  await setSession(telefono, STATE_DIA_MENU, {});
  return (
    "🕒 *Mi día de trabajo*\n" +
    "1️⃣ Registrar entrada / eventos del día\n" +
    "2️⃣ Ver historial de mis asistencias\n" +
    "3️⃣ Volver al menú"
  );
}

// ==========================
// 2) Operación en tienda
// ==========================
async function handleOperacion(telefono, estado, text, data) {
  if (estado === STATE_OPER_MENU) {
    if (text === "1") {
      const promotor = await getPromotorPorTelefono(telefono);
      const tiendas = await getTiendasParaPromotor(promotor);

      if (!tiendas.length) {
        return (
          "Por ahora no tengo tiendas configuradas para ti 🏪\n" +
          "Revisa el catálogo en la hoja *TIENDAS*.\n\n" +
          "Escribe *menu* para volver al inicio."
        );
      }

      await setSession(telefono, STATE_OPER_ELEGIR_TIENDA, {
        tiendas,
        promotor_id: promotor ? promotor.promotor_id : "",
      });

      let msg = "🏪 *¿En qué tienda estás hoy?*\n";
      tiendas.forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena} (${t.ciudad})\n`;
      });
      msg += "\nResponde con el número de la tienda.";
      return msg;
    }

    if (text === "2") {
      await setSession(telefono, STATE_OPER_VENTA, {});
      return (
        "🛒 *Venta rápida demo*\n" +
        "Producto: *Modelo X 128GB*\n\n" +
        "¿Cuántas unidades vendiste hoy? (solo número)"
      );
    }

    if (text === "3") {
      await setSession(telefono, STATE_MENU, {});
      return buildMenuPrincipal();
    }

    return (
      "🧰 *Operación en tienda*\n" +
      "1️⃣ Iniciar visita en tienda\n" +
      "2️⃣ Registrar venta rápida (demo Modelo X)\n" +
      "3️⃣ Volver al menú"
    );
  }

  if (estado === STATE_OPER_ELEGIR_TIENDA) {
    const tiendas = data.tiendas || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > tiendas.length) {
      let msg = "Por favor elige una opción válida:\n\n";
      tiendas.forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena} (${t.ciudad})\n`;
      });
      msg += "\nResponde con el número de la tienda.";
      return msg;
    }

    const tienda = tiendas[n - 1];
    const visitaId = "V-" + Date.now();
    const now = new Date();
    const fecha = now.toISOString().slice(0, 10);
    const horaInicio = now.toISOString();

    const promotor_id = data.promotor_id || "";
    await appendSheetValues("VISITAS!A2:G", [
      [visitaId, promotor_id, tienda.tienda_id, fecha, horaInicio, "", ""],
    ]);

    await setSession(telefono, STATE_OPER_VISITA_MENU, {
      visitaId,
      promotor_id,
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      tienda_ciudad: tienda.ciudad,
    });

    return (
      `📝 *Visita iniciada* en *${tienda.nombre_tienda}* (${tienda.ciudad}).\n\n` +
      "1️⃣ Inventario de productos foco\n" +
      "2️⃣ Actividad de la competencia\n" +
      "3️⃣ Foto de exhibición (EVIDENCIA+ demo)\n" +
      "4️⃣ Cerrar visita"
    );
  }

  if (estado === STATE_OPER_VISITA_MENU) {
    if (text === "1") {
      const productos = await getProductosFoco();
      if (!productos.length) {
        return (
          "No hay productos configurados en *PRODUCTOS* 📦\n" +
          "Configura algunos y vuelve a intentar.\n\n" +
          "Escribe *menu* para volver al inicio."
        );
      }

      await setSession(telefono, STATE_OPER_INV_PROD, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id || "",
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
        productos,
        idx: 0,
        contestados: 0,
      });

      const p = productos[0];
      return (
        "📦 *Inventario de productos foco*\n\n" +
        `Producto 1 de ${productos.length}:\n` +
        `*${p.nombre_producto}*\n\n` +
        "¿Cuántas piezas ves en anaquel?\n" +
        "Responde con un número o *s* para saltar."
      );
    }

    if (text === "2") {
      const competidores = await getCompetidoresCatalogo();
      if (!competidores.length) {
        return (
          "No hay actividades de competencia configuradas en *ACTIVIDADES_COMPETENCIA* ⚔️\n" +
          "Configúralas y vuelve a intentar.\n\n" +
          "Escribe *menu* para volver al inicio."
        );
      }

      await setSession(telefono, STATE_OPER_COMP_COMPETIDOR, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id || "",
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
        competidores,
      });

      let msg = "⚔️ *Competencia en piso de venta*\n\n";
      msg += "¿De qué competidor quieres registrar actividad?\n";
      competidores.forEach((c, idx) => {
        msg += `${idx + 1}) ${c}\n`;
      });
      msg += "\nResponde con el número del competidor.";
      return msg;
    }

    if (text === "3") {
      await setSession(telefono, STATE_EVIDENCIA_FOTO, {
        modo: "FOTO_EXHIBICION",
        visitaId: data.visitaId,
      });
      return "📸 Envía una *foto de la exhibición principal* de la marca para auditoría (demo).";
    }

    if (text === "4") {
      const visitaId = data.visitaId;
      const rows = await getSheetValues("VISITAS!A2:G");
      let rowIndex = null;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === visitaId) {
          rowIndex = i + 2;
          break;
        }
      }
      if (rowIndex !== null) {
        const now = new Date().toISOString();
        const range = `VISITAS!F${rowIndex}:F${rowIndex}`;
        await updateSheetValues(range, [[now]]);
      }

      await addPuntos(telefono, "OPERACION", `CIERRE_VISITA_${visitaId}`, 5);
      await setSession(telefono, STATE_OPER_MENU, {});
      return (
        "✅ Visita cerrada.\n" +
        "🎯 Ganaste *5 puntos* por completar la visita.\n\n" +
        "🧰 *Operación en tienda*\n" +
        "1️⃣ Iniciar otra visita\n" +
        "2️⃣ Registrar venta rápida (demo)\n" +
        "3️⃣ Volver al menú"
      );
    }

    return (
      "1️⃣ Inventario de productos foco\n" +
      "2️⃣ Actividad de la competencia\n" +
      "3️⃣ Foto de exhibición (EVIDENCIA+ demo)\n" +
      "4️⃣ Cerrar visita"
    );
  }

  if (estado === STATE_OPER_INV_PROD) {
    const productos = data.productos || [];
    let idx = data.idx || 0;
    let contestados = data.contestados || 0;

    if (!productos.length || idx >= productos.length) {
      await setSession(telefono, STATE_OPER_VISITA_MENU, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id,
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
      });
      return (
        "Terminé el inventario de productos foco.\n\n" +
        "1️⃣ Inventario de productos foco\n" +
        "2️⃣ Actividad de la competencia\n" +
        "3️⃣ Foto de exhibición\n" +
        "4️⃣ Cerrar visita"
      );
    }

    const lower = text.toLowerCase();
    let grabar = false;
    let cantidad = 0;

    if (lower === "s") {
      // saltar
    } else {
      cantidad = Number(text);
      if (Number.isNaN(cantidad) || cantidad < 0) {
        const p = productos[idx];
        return (
          `Escribe un número válido para *${p.nombre_producto}* ` +
          "o *s* para saltar."
        );
      }
      grabar = true;
    }

    const p = productos[idx];

    if (grabar) {
      const fecha = new Date().toISOString().slice(0, 10);
      await appendSheetValues("INVENTARIO!A2:F", [
        [
          data.visitaId,
          data.promotor_id || "",
          data.tienda_id,
          p.producto_id,
          cantidad,
          fecha,
        ],
      ]);
      contestados++;
    }

    idx++;
    if (idx >= productos.length) {
      const pts = contestados > 0 ? contestados * 3 : 0;
      if (pts > 0) {
        await addPuntos(
          telefono,
          "OPERACION",
          `INVENTARIO_VISITA_${data.visitaId}`,
          pts
        );
      }

      await setSession(telefono, STATE_OPER_VISITA_MENU, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id,
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
      });

      return (
        "✅ Inventario registrado.\n" +
        `Productos respondidos: *${contestados}*.\n` +
        (pts > 0 ? `🎯 Ganaste *${pts} puntos*.\n\n` : "\n") +
        "1️⃣ Inventario de productos foco\n" +
        "2️⃣ Actividad de la competencia\n" +
        "3️⃣ Foto de exhibición\n" +
        "4️⃣ Cerrar visita"
      );
    }

    await setSession(telefono, STATE_OPER_INV_PROD, {
      visitaId: data.visitaId,
      promotor_id: data.promotor_id,
      tienda_id: data.tienda_id,
      tienda_nombre: data.tienda_nombre,
      productos,
      idx,
      contestados,
    });

    const siguiente = productos[idx];
    return (
      "📦 *Inventario de productos foco*\n\n" +
      `Producto ${idx + 1} de ${productos.length}:\n` +
      `*${siguiente.nombre_producto}*\n\n` +
      "¿Cuántas piezas ves en anaquel?\n" +
      "Responde con un número o *s* para saltar."
    );
  }

  if (estado === STATE_OPER_COMP_COMPETIDOR) {
    const competidores = data.competidores || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > competidores.length) {
      let msg = "Elige una opción válida:\n\n";
      competidores.forEach((c, idx) => {
        msg += `${idx + 1}) ${c}\n`;
      });
      msg += "\nResponde con el número del competidor.";
      return msg;
    }

    const competidor = competidores[n - 1];
    const actividades = await getActividadesPorCompetidor(competidor);
    if (!actividades.length) {
      await setSession(telefono, STATE_OPER_VISITA_MENU, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id,
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
      });
      return (
        `No hay actividades configuradas para *${competidor}* ⚔️\n\n` +
        "1️⃣ Inventario\n" +
        "2️⃣ Actividad de la competencia\n" +
        "3️⃣ Foto de exhibición\n" +
        "4️⃣ Cerrar visita"
      );
    }

    await setSession(telefono, STATE_OPER_COMP_ACTIVIDAD, {
      visitaId: data.visitaId,
      promotor_id: data.promotor_id,
      tienda_id: data.tienda_id,
      tienda_nombre: data.tienda_nombre,
      competidor,
      actividades,
    });

    let msg = `⚔️ *Actividades de ${competidor}*\n\n`;
    actividades.forEach((a, idx) => {
      msg += `${idx + 1}) ${a.tipo_actividad} – ${a.descripcion_corta}\n`;
    });
    msg += "\nResponde con el número de la actividad que viste.";
    return msg;
  }

  if (estado === STATE_OPER_COMP_ACTIVIDAD) {
    const actividades = data.actividades || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > actividades.length) {
      let msg = `Elige una opción válida de *${data.competidor}*:\n\n`;
      actividades.forEach((a, idx) => {
        msg += `${idx + 1}) ${a.tipo_actividad} – ${a.descripcion_corta}\n`;
      });
      msg += "\nResponde con el número de la actividad.";
      return msg;
    }

    const act = actividades[n - 1];
    const pts = act.puntos || 0;
    if (pts > 0) {
      await addPuntos(
        telefono,
        "OPERACION",
        `COMPETENCIA_${act.actividad_id}_${data.visitaId}`,
        pts
      );
    }

    await setSession(telefono, STATE_OPER_VISITA_MENU, {
      visitaId: data.visitaId,
      promotor_id: data.promotor_id,
      tienda_id: data.tienda_id,
      tienda_nombre: data.tienda_nombre,
    });

    return (
      "✅ Actividad de competencia registrada.\n\n" +
      `Competidor: *${act.competidor}*\n` +
      `Actividad: *${act.tipo_actividad} – ${act.descripcion_corta}*\n` +
      (pts > 0 ? `🎯 Ganaste *${pts} puntos*.\n\n` : "\n") +
      "1️⃣ Inventario\n" +
      "2️⃣ Actividad de la competencia\n" +
      "3️⃣ Foto de exhibición\n" +
      "4️⃣ Cerrar visita"
    );
  }

  if (estado === STATE_OPER_VENTA) {
    const unidades = Number(text);
    if (Number.isNaN(unidades) || unidades < 0) {
      return "Escribe solo el número de unidades vendidas (ej. 3).";
    }

    const fecha = new Date().toISOString();
    const productoId = "PROD_X"; // demo

    await appendSheetValues("VENTAS!A2:D", [[fecha, telefono, productoId, unidades]]);
    await addPuntos(telefono, "OPERACION", "VENTA_DEMO", 10);
    await setSession(telefono, STATE_OPER_MENU, {});

    return (
      "✅ Venta registrada.\n" +
      "Producto: *Modelo X 128GB*\n" +
      `Unidades: *${unidades}*\n\n` +
      "🎯 Ganaste *10 puntos de operación*.\n" +
      "1️⃣ Iniciar visita en tienda\n" +
      "2️⃣ Registrar otra venta rápida\n" +
      "3️⃣ Volver al menú"
    );
  }

  await setSession(telefono, STATE_OPER_MENU, {});
  return (
    "🧰 *Operación en tienda*\n" +
    "1️⃣ Iniciar visita en tienda\n" +
    "2️⃣ Registrar venta rápida (demo Modelo X)\n" +
    "3️⃣ Volver al menú"
  );
}

// ==========================
// 3) Academia de bolsillo
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
      return buildMenuPrincipal();
    }

    return (
      "🎓 *Academia de bolsillo*\n" +
      "1️⃣ Reto del día\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú"
    );
  }

  if (estado === STATE_ACAD_RETO) {
    if (!["1", "2", "3"].includes(text)) {
      return "Responde solo con 1, 2 o 3 😉";
    }

    const { reto_id } = data;
    const rows = await getSheetValues("RETOS!A2:H");
    const retoRow = rows.find((r) => r[0] === reto_id);
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
    const pts = es_correcta
      ? Number(puntos_ok || 0)
      : Number(puntos_error || 0);

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
      "1️⃣ Reto del día\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú\n\n" +
      "O escribe *menu* para ir al inicio."
    );
  }

  await setSession(telefono, STATE_ACAD_MENU, {});
  return (
    "🎓 *Academia de bolsillo*\n" +
    "1️⃣ Reto del día\n" +
    "2️⃣ Ver mis puntos de capacitación\n" +
    "3️⃣ Volver al menú"
  );
}

// ==========================
// 4) Auditoría de fotos directa (EVIDENCIA+ demo)
// ==========================
async function handleEvidenciaDirecta(telefono, estado, text, data, inbound) {
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
  let jornada = await getJornadaAbiertaPorTelefono(telefono);
  const jornada_id = jornada ? jornada.jornada_id : "";

  if (modo === "FOTO_EXHIBICION") {
    tipo_evento = "FOTO_EXHIBICION";
    origen = "VISITA";
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

  await addPuntos(telefono, "OPERACION", `EVIDENCIA_${tipo_evento}`, 3);

  await setSession(telefono, STATE_MENU, {});

  return (
    "🔎 *Resultado EVIDENCIA+ (demo)*\n" +
    `✔️ Análisis: ${resultado_ai}\n` +
    `📊 Confianza: ${(score_confianza * 100).toFixed(0)}%\n` +
    `⚠️ Riesgo: ${riesgo}\n\n` +
    "🎯 Ganaste *3 puntos* por enviar esta evidencia.\n\n" +
    "Escribe *menu* para seguir usando el bot."
  );
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
  if (typeof respuesta === "string") {
    twiml.message(respuesta);
  } else if (respuesta && typeof respuesta === "object") {
    const msg = twiml.message(respuesta.text || "");
    if (respuesta.mediaUrl) {
      msg.media(respuesta.mediaUrl);
    }
  } else {
    twiml.message(
      "Ocurrió un error inesperado. Intenta de nuevo más tarde 🙏"
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Ruta raíz para probar en navegador
app.get("/", (req, res) => {
  res.send(
    "Promobolsillo+ demo está vivo ✅ (día + operación + academia + evidencias + supervisor)"
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Promobolsillo+ demo escuchando en puerto ${PORT}`);
});
