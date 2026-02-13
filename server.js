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

if (!SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.warn("⚠️ Falta SHEET_ID o GOOGLE_SERVICE_ACCOUNT_JSON en env vars");
}

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn(
    "⚠️ No se encontraron TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. " +
      "No se podrán enviar mensajes salientes a otros números (clientes)."
  );
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
// Sesiones (hoja SESIONES)
// ==========================

const STATE_PROM_MENU = "PROM_MENU";

// Asistencia
const STATE_ASIS_MENU = "ASIS_MENU";
const STATE_ASIS_ELEGIR_TIENDA = "ASIS_ELEGIR_TIENDA";
const STATE_ASIS_ENTRADA_FOTO = "ASIS_ENTRADA_FOTO";
const STATE_ASIS_ENTRADA_UBIC = "ASIS_ENTRADA_UBIC";
const STATE_ASIS_SALIDA_FOTO = "ASIS_SALIDA_FOTO";
const STATE_ASIS_SALIDA_UBIC = "ASIS_SALIDA_UBIC";

// Evidencias anaquel
const STATE_EVID_MARCA = "EVID_MARCA";
const STATE_EVID_TIPO = "EVID_TIPO";
const STATE_EVID_PRODUCTO_INPUT = "EVID_PRODUCTO_INPUT";
const STATE_EVID_PRODUCTO_LISTA = "EVID_PRODUCTO_LISTA";
const STATE_EVID_FOTO = "EVID_FOTO";
const STATE_EVID_DESC = "EVID_DESC";

// Supervisor
const STATE_SUP_MENU = "SUP_MENU";

async function findSessionRow(telefono) {
  const rows = await getSheetValues("SESIONES!A2:C");
  if (!rows.length) return null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if ((r[0] || "").trim() === telefono.trim()) {
      const estado_actual = r[1] || STATE_PROM_MENU;
      let data_json = {};
      try {
        data_json = r[2] ? JSON.parse(r[2]) : {};
      } catch (err) {
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
    [telefono, STATE_PROM_MENU, JSON.stringify({})],
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
// Catálogos básicos
// ==========================

// PROMOTORES: telefono, promotor_id, nombre, region, cadena_principal, activo, telefono_supervisor
async function getPromotorPorTelefono(telefono) {
  const rows = await getSheetValues("PROMOTORES!A2:G");
  for (const r of rows) {
    if ((r[0] || "").trim() === telefono.trim()) {
      const activo =
        (r[5] || "").toString().toUpperCase() === "TRUE" ||
        (r[5] || "").toString().toUpperCase() === "VERDADERO";
      return {
        telefono: r[0],
        promotor_id: r[1],
        nombre: r[2],
        region: r[3],
        cadena_principal: r[4],
        activo,
        telefono_supervisor: r[6] || "",
      };
    }
  }
  return null;
}

// SUPERVISORES: telefono, supervisor_id, nombre, region, nivel, activo
async function getSupervisorPorTelefono(telefono) {
  const rows = await getSheetValues("SUPERVISORES!A2:F");
  for (const r of rows) {
    if ((r[0] || "").trim() === telefono.trim()) {
      const activo =
        (r[5] || "").toString().toUpperCase() === "TRUE" ||
        (r[5] || "").toString().toUpperCase() === "VERDADERO";
      if (!activo) return null;
      return {
        telefono: r[0],
        supervisor_id: r[1],
        nombre: r[2],
        region: r[3],
        nivel: r[4],
        activo,
      };
    }
  }
  return null;
}

// PROMOTORES de un supervisor
async function getPromotoresDeSupervisor(telefonoSupervisor) {
  const rows = await getSheetValues("PROMOTORES!A2:G");
  const list = [];
  for (const r of rows) {
    const telSup = (r[6] || "").trim();
    const activo =
      (r[5] || "").toString().toUpperCase() === "TRUE" ||
      (r[5] || "").toString().toUpperCase() === "VERDADERO";
    if (activo && telSup === telefonoSupervisor) {
      list.push({
        telefono: (r[0] || "").trim(),
        promotor_id: r[1] || "",
        nombre: r[2] || "",
        region: r[3] || "",
        cadena_principal: r[4] || "",
      });
    }
  }
  return list;
}

// TIENDAS: tienda_id, nombre_tienda, cadena, ciudad, region, activa
async function getTiendasParaPromotor(promotor) {
  const rows = await getSheetValues("TIENDAS!A2:F");
  if (!rows.length) return [];
  const activas = rows.filter((r) => {
    const act =
      (r[5] || "").toString().toUpperCase() === "TRUE" ||
      (r[5] || "").toString().toUpperCase() === "VERDADERO";
    return act;
  });

  let filtradas = activas;
  if (promotor) {
    filtradas = activas.filter((r) => {
      const region = r[4];
      const cadena = r[2];
      const okRegion =
        promotor.region &&
        region &&
        region.toString().toUpperCase() === promotor.region.toString().toUpperCase();
      const okCadena =
        promotor.cadena_principal &&
        cadena &&
        cadena.toString().toUpperCase() ===
          promotor.cadena_principal.toString().toUpperCase();
      return okRegion || okCadena;
    });
    if (!filtradas.length) filtradas = activas;
  }

  const top = filtradas.slice(0, 8);
  return top.map((r) => ({
    tienda_id: r[0],
    nombre_tienda: r[1],
    cadena: r[2],
    ciudad: r[3],
    region: r[4],
  }));
}

// MARCAS y TIENDA_MARCA
async function getMarcasParaTienda(tienda_id) {
  const tmRows = await getSheetValues("TIENDA_MARCA!A2:D");
  const marcaRows = await getSheetValues("MARCAS!A2:D");

  const marcaMap = {};
  for (const m of marcaRows) {
    const id = m[0] || "";
    if (!id) continue;
    const activo =
      (m[3] || "").toString().toUpperCase() === "TRUE" ||
      (m[3] || "").toString().toUpperCase() === "VERDADERO";
    marcaMap[id] = {
      marca_id: id,
      nombre_marca: m[1] || "",
      cliente: m[2] || "",
      activo,
    };
  }

  const result = [];
  for (const r of tmRows) {
    const tId = r[0] || "";
    const mId = r[1] || "";
    const prioridad = Number(r[2] || 0);
    const activo =
      (r[3] || "").toString().toUpperCase() === "TRUE" ||
      (r[3] || "").toString().toUpperCase() === "VERDADERO";
    if (tId === tienda_id && activo && marcaMap[mId] && marcaMap[mId].activo) {
      result.push({
        marca_id: mId,
        nombre_marca: marcaMap[mId].nombre_marca,
        cliente: marcaMap[mId].cliente,
        prioridad,
      });
    }
  }

  result.sort((a, b) => (a.prioridad || 999) - (b.prioridad || 999));
  return result;
}

// PRODUCTOS por marca
async function getProductosPorMarca(marca_id) {
  const rows = await getSheetValues("PRODUCTOS!A2:G");
  if (!rows.length) return [];

  const foco = rows.filter(
    (r) =>
      (r[4] || "") === marca_id &&
      ((r[5] || "").toString().toUpperCase() === "TRUE" ||
        (r[5] || "").toString().toUpperCase() === "VERDADERO")
  );
  const listaBase = foco.length ? foco : rows.filter((r) => (r[4] || "") === marca_id);

  return listaBase.map((r) => ({
    producto_id: r[0],
    sku_barcode: r[1],
    nombre_producto: r[2],
    categoria: r[3],
    marca_id: r[4],
    es_foco:
      (r[5] || "").toString().toUpperCase() === "TRUE" ||
      (r[5] || "").toString().toUpperCase() === "VERDADERO",
    precio_sugerido: r[6],
  }));
}

// PRODUCTO por código de barras
async function getProductoPorBarcode(barcode) {
  const rows = await getSheetValues("PRODUCTOS!A2:G");
  for (const r of rows) {
    if ((r[1] || "").toString().trim() === barcode.trim()) {
      return {
        producto_id: r[0],
        sku_barcode: r[1],
        nombre_producto: r[2],
        categoria: r[3],
        marca_id: r[4],
        es_foco:
          (r[5] || "").toString().toUpperCase() === "TRUE" ||
          (r[5] || "").toString().toUpperCase() === "VERDADERO",
        precio_sugerido: r[6],
      };
    }
  }
  return null;
}

// TIENDAS lookup
async function getTiendasMap() {
  const rows = await getSheetValues("TIENDAS!A2:F");
  const map = {};
  for (const r of rows) {
    const id = r[0] || "";
    if (!id) continue;
    map[id] = {
      tienda_id: id,
      nombre_tienda: r[1] || "",
      cadena: r[2] || "",
      ciudad: r[3] || "",
      region: r[4] || "",
    };
  }
  return map;
}

// MARCAS lookup
async function getMarcasMap() {
  const rows = await getSheetValues("MARCAS!A2:D");
  const map = {};
  for (const r of rows) {
    const id = r[0] || "";
    if (!id) continue;
    map[id] = {
      marca_id: id,
      nombre_marca: r[1] || "",
      cliente: r[2] || "",
    };
  }
  return map;
}

// PRODUCTOS lookup
async function getProductosMap() {
  const rows = await getSheetValues("PRODUCTOS!A2:G");
  const map = {};
  for (const r of rows) {
    const id = r[0] || "";
    if (!id) continue;
    map[id] = {
      producto_id: id,
      nombre_producto: r[2] || "",
      sku_barcode: r[1] || "",
    };
  }
  return map;
}

// ==========================
// Jornadas (asistencia por tienda)
// JORNADAS: A jornada_id, B tel, C promotor_id,
// D tienda_id, E fecha, F hora_entrada, G lat_entrada, H lon_entrada,
// I foto_entrada_url, J hora_salida, K lat_salida, L lon_salida,
// M foto_salida_url, N estado
// ==========================

async function findJornadaById(jornada_id) {
  const rows = await getSheetValues("JORNADAS!A2:N");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if ((r[0] || "") === jornada_id) {
      return { rowIndex: i + 2, row: r };
    }
  }
  return null;
}

async function getJornadaAbiertaPorTelefono(telefono) {
  const rows = await getSheetValues("JORNADAS!A2:N");
  let found = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tel = (r[1] || "").trim();
    const estado = (r[13] || "").toString().toUpperCase();
    const horaSalida = r[9];
    if (tel === telefono.trim() && estado !== "CERRADA" && !horaSalida) {
      found = {
        rowIndex: i + 2,
        jornada_id: r[0],
        telefono: r[1],
        promotor_id: r[2],
        tienda_id: r[3],
        fecha: r[4],
        hora_entrada: r[5],
        lat_entrada: r[6],
        lon_entrada: r[7],
        foto_entrada_url: r[8],
        hora_salida: r[9],
        lat_salida: r[10],
        lon_salida: r[11],
        foto_salida_url: r[12],
        estado: r[13],
      };
      // nos quedamos con la última encontrada
    }
  }
  return found;
}

async function crearJornadaEntrada(telefono, promotor_id, tienda_id) {
  const jornada_id = "J-" + Date.now();
  const now = new Date();
  const fecha = now.toISOString().slice(0, 10);
  const hora_entrada = now.toISOString();
  await appendSheetValues("JORNADAS!A2:N", [
    [
      jornada_id,
      telefono,
      promotor_id || "",
      tienda_id || "",
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
  const range = `JORNADAS!I${j.rowIndex}:I${j.rowIndex}`;
  await updateSheetValues(range, [[fotoUrl]]);
}

async function actualizarEntradaUbicacion(jornada_id, lat, lon) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = `JORNADAS!G${j.rowIndex}:H${j.rowIndex}`;
  await updateSheetValues(range, [[lat, lon]]);
}

async function registrarSalidaHora(jornada_id) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const ahora = new Date().toISOString();
  const range = `JORNADAS!J${j.rowIndex}:J${j.rowIndex}`;
  await updateSheetValues(range, [[ahora]]);
}

async function actualizarSalidaFoto(jornada_id, fotoUrl) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const range = `JORNADAS!M${j.rowIndex}:M${j.rowIndex}`;
  await updateSheetValues(range, [[fotoUrl]]);
}

async function actualizarSalidaUbicacionYCerrar(jornada_id, lat, lon) {
  const j = await findJornadaById(jornada_id);
  if (!j) return;
  const rangePos = `JORNADAS!K${j.rowIndex}:L${j.rowIndex}`;
  await updateSheetValues(rangePos, [[lat, lon]]);
  const rangeEstado = `JORNADAS!N${j.rowIndex}:N${j.rowIndex}`;
  await updateSheetValues(rangeEstado, [["CERRADA"]]);
}

// ==========================
// Puntos (PUNTOS)
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
  for (const r of rows) {
    if ((r[1] || "").trim() === telefono.trim()) {
      const tipo = r[2] || "";
      const pts = Number(r[4] || 0);
      if (tipo === "OPERACION") operacion += pts;
      if (tipo === "CAPACITACION") capacitacion += pts;
    }
  }
  return { operacion, capacitacion, total: operacion + capacitacion };
}

// ==========================
// Evidencias (EVIDENCIAS)
// ==========================

function demoAnalisisPorTipo(tipo_evento, tipo_evidencia) {
  if (tipo_evento === "ENTRADA_TIENDA") {
    return {
      resultado_ai: "Foto de entrada en punto de venta (demo).",
      score_confianza: 0.95,
      riesgo: "BAJO",
    };
  }
  if (tipo_evento === "SALIDA_TIENDA") {
    return {
      resultado_ai: "Foto de salida de la tienda coherente (demo).",
      score_confianza: 0.94,
      riesgo: "BAJO",
    };
  }
  if (tipo_evento === "EVID_ANAQUEL") {
    if (tipo_evidencia === "ANTES") {
      return {
        resultado_ai:
          "Foto ANTES del acomodo detectada. Productos visibles en anaquel (demo).",
        score_confianza: 0.92,
        riesgo: "BAJO",
      };
    }
    if (tipo_evidencia === "DESPUES") {
      return {
        resultado_ai:
          "Foto DESPUÉS del acomodo. Exhibición ordenada y frontal (demo).",
        score_confianza: 0.94,
        riesgo: "BAJO",
      };
    }
    return {
      resultado_ai: "Evidencia de anaquel registrada (demo).",
      score_confianza: 0.9,
      riesgo: "BAJO",
    };
  }
  return {
    resultado_ai: "Evidencia registrada (demo).",
    score_confianza: 0.9,
    riesgo: "BAJO",
  };
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
  marca_id = "",
  producto_id = "",
  tipo_evidencia = "",
  descripcion = "",
}) {
  const evidencia_id = "EV-" + Date.now();
  const fecha_hora = new Date().toISOString();

  const { resultado_ai, score_confianza, riesgo } = demoAnalisisPorTipo(
    tipo_evento,
    tipo_evidencia
  );

  await appendSheetValues("EVIDENCIAS!A2:Q", [
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
      marca_id,
      producto_id,
      tipo_evidencia,
      descripcion,
    ],
  ]);

  return { evidencia_id, resultado_ai, score_confianza, riesgo };
}

// Map row -> evidencia obj (sin resolver nombres)
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
    riesgo: (r[12] || "").toString().toUpperCase(),
    marca_id: r[13] || "",
    producto_id: r[14] || "",
    tipo_evidencia: r[15] || "",
    descripcion: r[16] || "",
  };
}

// ==========================
// Menús
// ==========================

function buildPromotorMenu() {
  return (
    "👋 Hola, soy *Promobolsillo+*.\n\n" +
    "¿Qué quieres hacer?\n" +
    "1️⃣ Asistencia en tienda (entrada / salida – foto + ubicación)\n" +
    "2️⃣ Capturar evidencias en anaquel por marca 📸\n" +
    "3️⃣ Ver historial de mis asistencias 🕒\n\n" +
    "Comandos rápidos:\n" +
    "• *fotos hoy* → ver tus fotos de hoy en bloque\n" +
    "• *menu* → volver a este menú\n"
  );
}

function buildSupervisorMenu(supervisor) {
  const nombre = supervisor?.nombre || "Supervisor";
  return (
    `👋 Hola, *${nombre}* (Supervisor).\n\n` +
    "¿Qué quieres revisar hoy?\n" +
    "1️⃣ Fotos de hoy de mi equipo 📸\n" +
    "2️⃣ Solo fotos de hoy con riesgo MEDIO/ALTO 🧠📸\n" +
    "3️⃣ Asistencias de hoy de mi equipo 🕒\n" +
    "4️⃣ Volver al menú de promotor\n\n" +
    "Comandos rápidos:\n" +
    "• *sup* → ver este menú\n" +
    "• *menu* → menú de promotor\n"
  );
}

// ==========================
// Helpers para fotos "hoy" (promotor y supervisor)
// ==========================

async function buildFotoMessagesPromotorHoy(telefono) {
  const hoy = new Date().toISOString().slice(0, 10);
  const evRows = await getSheetValues("EVIDENCIAS!A2:Q");
  const jornadasRows = await getSheetValues("JORNADAS!A2:N");
  const tiendasMap = await getTiendasMap();
  const marcasMap = await getMarcasMap();
  const productosMap = await getProductosMap();

  const jornadaTiendas = {};
  for (const r of jornadasRows) {
    const jId = r[0] || "";
    if (!jId) continue;
    jornadaTiendas[jId] = r[3] || ""; // tienda_id
  }

  const grupos = {}; // key -> { tienda, marca, evidencias[] }

  for (const r of evRows) {
    const ev = mapEvidRow(r);
    if (ev.telefono !== telefono) continue;
    if (!ev.fecha_hora) continue;
    if (ev.fecha_hora.slice(0, 10) !== hoy) continue;
    if (!ev.url_foto) continue;

    const tienda_id = jornadaTiendas[ev.jornada_id] || "";
    const tiendaInfo = tiendasMap[tienda_id] || {};
    const marcaInfo = marcasMap[ev.marca_id] || {};
    const prodInfo = productosMap[ev.producto_id] || {};

    const tiendaNombre =
      tiendaInfo.nombre_tienda ||
      (tienda_id ? `Tienda ${tienda_id}` : "Sin tienda");
    const marcaNombre =
      marcaInfo.nombre_marca || (ev.marca_id ? ev.marca_id : "Sin marca");
    const productoNombre =
      prodInfo.nombre_producto ||
      (ev.producto_id ? ev.producto_id : "Producto no identificado");

    const key = `${tiendaNombre} | ${marcaNombre}`;
    if (!grupos[key]) {
      grupos[key] = {
        tiendaNombre,
        marcaNombre,
        evidencias: [],
      };
    }

    const hora = ev.fecha_hora.substring(11, 16);
    const tipoE = ev.tipo_evidencia || ev.tipo_evento || "";
    const desc = ev.descripcion || "";

    const caption =
      `🏪 ${tiendaNombre}\n` +
      `🧴 Marca: ${marcaNombre}\n` +
      `🛒 Producto: ${productoNombre}\n` +
      (tipoE ? `🎯 Tipo evidencia: ${tipoE}\n` : "") +
      (hora ? `⏰ ${hora}\n` : "") +
      (desc ? `✏️ ${desc}\n` : "") +
      (ev.riesgo ? `⚠️ Riesgo: ${ev.riesgo} (demo EVIDENCIA+)\n` : "");

    grupos[key].evidencias.push({
      url_foto: ev.url_foto,
      caption,
    });
  }

  const groupKeys = Object.keys(grupos);
  if (!groupKeys.length) {
    return {
      messages: [
        {
          body: "Hoy no has registrado evidencias con foto 📭\n\nEscribe *2* para capturar una nueva evidencia en anaquel.",
        },
      ],
    };
  }

  const messages = [];
  messages.push({
    body:
      "📸 *Tus fotos de hoy*\n" +
      "Te las envío agrupadas por *tienda | marca* para revisión rápida.\n",
  });

  for (const key of groupKeys) {
    const g = grupos[key];
    messages.push({
      body: `📍 ${g.tiendaNombre} | 🧴 ${g.marcaNombre}`,
    });
    for (const ev of g.evidencias) {
      messages.push({
        body: ev.caption,
        mediaUrl: ev.url_foto,
      });
    }
  }

  messages.push({
    body:
      "Fin de tus fotos de hoy ✅\n" +
      "Puedes reenviar desde aquí al cliente o capturar más evidencias con *2*.",
  });

  return { messages };
}

async function buildFotoMessagesSupervisorEquipoHoy(supervisor) {
  const hoy = new Date().toISOString().slice(0, 10);
  const promotores = await getPromotoresDeSupervisor(supervisor.telefono);
  if (!promotores.length) {
    return {
      messages: [
        {
          body:
            "⚠️ No tengo promotores asociados a tu número en la hoja PROMOTORES.\n" +
            "Verifica la columna *telefono_supervisor*.",
        },
      ],
    };
  }

  const telSet = new Set(promotores.map((p) => (p.telefono || "").trim()));
  const nombreMap = {};
  promotores.forEach((p) => {
    nombreMap[p.telefono.trim()] = p.nombre || p.telefono;
  });

  const evRows = await getSheetValues("EVIDENCIAS!A2:Q");
  const jornadasRows = await getSheetValues("JORNADAS!A2:N");
  const tiendasMap = await getTiendasMap();
  const marcasMap = await getMarcasMap();
  const productosMap = await getProductosMap();

  const jornadaTiendas = {};
  for (const r of jornadasRows) {
    const jId = r[0] || "";
    if (!jId) continue;
    jornadaTiendas[jId] = r[3] || ""; // tienda_id
  }

  const grupos = {}; // key -> { promotor, tienda, marca, evidencias[] }

  for (const r of evRows) {
    const ev = mapEvidRow(r);
    if (!telSet.has(ev.telefono)) continue;
    if (!ev.fecha_hora) continue;
    if (ev.fecha_hora.slice(0, 10) !== hoy) continue;
    if (!ev.url_foto) continue;

    const tienda_id = jornadaTiendas[ev.jornada_id] || "";
    const tiendaInfo = tiendasMap[tienda_id] || {};
    const marcaInfo = marcasMap[ev.marca_id] || {};
    const prodInfo = productosMap[ev.producto_id] || {};

    const promNom = nombreMap[ev.telefono] || ev.telefono;
    const tiendaNombre =
      tiendaInfo.nombre_tienda ||
      (tienda_id ? `Tienda ${tienda_id}` : "Sin tienda");
    const marcaNombre =
      marcaInfo.nombre_marca || (ev.marca_id ? ev.marca_id : "Sin marca");
    const productoNombre =
      prodInfo.nombre_producto ||
      (ev.producto_id ? ev.producto_id : "Producto no identificado");

    const key = `${promNom} | ${tiendaNombre} | ${marcaNombre}`;
    if (!grupos[key]) {
      grupos[key] = {
        promotor: promNom,
        tiendaNombre,
        marcaNombre,
        evidencias: [],
      };
    }

    const hora = ev.fecha_hora.substring(11, 16);
    const tipoE = ev.tipo_evidencia || ev.tipo_evento || "";
    const desc = ev.descripcion || "";

    const caption =
      `🧑‍💼 ${promNom}\n` +
      `🏪 ${tiendaNombre}\n` +
      `🧴 Marca: ${marcaNombre}\n` +
      `🛒 Producto: ${productoNombre}\n` +
      (tipoE ? `🎯 Tipo evidencia: ${tipoE}\n` : "") +
      (hora ? `⏰ ${hora}\n` : "") +
      (desc ? `✏️ ${desc}\n` : "") +
      (ev.riesgo ? `⚠️ Riesgo: ${ev.riesgo} (demo EVIDENCIA+)\n` : "");

    grupos[key].evidencias.push({
      url_foto: ev.url_foto,
      caption,
    });
  }

  const groupKeys = Object.keys(grupos);
  if (!groupKeys.length) {
    return {
      messages: [
        {
          body:
            "Hoy no tengo fotos con evidencia registradas para tu equipo 📭\n" +
            "Pídeles que usen la opción 2️⃣ (evidencias en anaquel) y luego vuelve a consultar.",
        },
      ],
    };
  }

  const messages = [];
  messages.push({
    body:
      "📸 *Fotos de hoy de tu equipo*\n" +
      "Te las envío agrupadas por *promotor | tienda | marca*.\n",
  });

  for (const key of groupKeys) {
    const g = grupos[key];
    messages.push({
      body:
        `🧑‍💼 ${g.promotor} | 🏪 ${g.tiendaNombre} | 🧴 ${g.marcaNombre}`,
    });
    for (const ev of g.evidencias) {
      messages.push({
        body: ev.caption,
        mediaUrl: ev.url_foto,
      });
    }
  }

  messages.push({
    body:
      "Fin de las fotos de hoy de tu equipo ✅\n" +
      "Puedes reenviar desde aquí al cliente o pedir más detalle a tus promotores.",
  });

  return { messages };
}

async function buildFotoMessagesSupervisorRiesgo(supervisor) {
  const hoy = new Date().toISOString().slice(0, 10);
  const promotores = await getPromotoresDeSupervisor(supervisor.telefono);
  if (!promotores.length) {
    return {
      messages: [
        {
          body:
            "⚠️ No tengo promotores asociados a tu número en la hoja PROMOTORES.\n" +
            "Verifica la columna *telefono_supervisor*.",
        },
      ],
    };
  }

  const telSet = new Set(promotores.map((p) => (p.telefono || "").trim()));
  const nombreMap = {};
  promotores.forEach((p) => {
    nombreMap[p.telefono.trim()] = p.nombre || p.telefono;
  });

  const evRows = await getSheetValues("EVIDENCIAS!A2:Q");
  const jornadasRows = await getSheetValues("JORNADAS!A2:N");
  const tiendasMap = await getTiendasMap();
  const marcasMap = await getMarcasMap();
  const productosMap = await getProductosMap();

  const jornadaTiendas = {};
  for (const r of jornadasRows) {
    const jId = r[0] || "";
    if (!jId) continue;
    jornadaTiendas[jId] = r[3] || ""; // tienda_id
  }

  const list = [];

  for (const r of evRows) {
    const ev = mapEvidRow(r);
    if (!telSet.has(ev.telefono)) continue;
    if (!ev.fecha_hora) continue;
    if (ev.fecha_hora.slice(0, 10) !== hoy) continue;
    if (!ev.url_foto) continue;
    if (!(ev.riesgo === "MEDIO" || ev.riesgo === "ALTO")) continue;

    const tienda_id = jornadaTiendas[ev.jornada_id] || "";
    const tiendaInfo = tiendasMap[tienda_id] || {};
    const marcaInfo = marcasMap[ev.marca_id] || {};
    const prodInfo = productosMap[ev.producto_id] || {};

    const promNom = nombreMap[ev.telefono] || ev.telefono;
    const tiendaNombre =
      tiendaInfo.nombre_tienda ||
      (tienda_id ? `Tienda ${tienda_id}` : "Sin tienda");
    const marcaNombre =
      marcaInfo.nombre_marca || (ev.marca_id ? ev.marca_id : "Sin marca");
    const productoNombre =
      prodInfo.nombre_producto ||
      (ev.producto_id ? ev.producto_id : "Producto no identificado");

    const hora = ev.fecha_hora.substring(11, 16);
    const tipoE = ev.tipo_evidencia || ev.tipo_evento || "";
    const desc = ev.descripcion || "";

    const caption =
      `🧠📸 *Riesgo ${ev.riesgo}*\n` +
      `🧑‍💼 ${promNom}\n` +
      `🏪 ${tiendaNombre}\n` +
      `🧴 Marca: ${marcaNombre}\n` +
      `🛒 Producto: ${productoNombre}\n` +
      (tipoE ? `🎯 Tipo evidencia: ${tipoE}\n` : "") +
      (hora ? `⏰ ${hora}\n` : "") +
      (desc ? `✏️ ${desc}\n` : "") +
      "EVIDENCIA+ (demo)\n";

    list.push({
      url_foto: ev.url_foto,
      caption,
    });
  }

  if (!list.length) {
    return {
      messages: [
        {
          body:
            "🧠📸 Hoy no hay fotos con riesgo MEDIO/ALTO registradas para tu equipo.\n" +
            "Buena señal 😉",
        },
      ],
    };
  }

  const messages = [];
  messages.push({
    body:
      `🧠📸 *Fotos con riesgo MEDIO/ALTO de hoy* (${list.length} evidencia(s))\n`,
  });
  for (const ev of list) {
    messages.push({
      body: ev.caption,
      mediaUrl: ev.url_foto,
    });
  }
  messages.push({
    body:
      "Fin de las fotos con riesgo MEDIO/ALTO de hoy ✅\n" +
      "Puedes pedir correcciones a tus promotores desde este chat.",
  });
  return { messages };
}

// ==========================
// Historial asistencias promotor
// ==========================

async function buildHistorialAsistenciasPromotor(telefono) {
  const rows = await getSheetValues("JORNADAS!A2:N");
  if (!rows.length) {
    return (
      "Aún no tengo asistencias registradas para tu número 🕒\n" +
      "Usa la opción 1️⃣ del menú para registrar tu primera asistencia."
    );
  }
  const tiendasMap = await getTiendasMap();
  const hoy = new Date().toISOString().slice(0, 10);

  const propias = rows
    .filter((r) => (r[1] || "").trim() === telefono.trim())
    .map((r) => {
      const tienda_id = r[3] || "";
      const tiendaInfo = tiendasMap[tienda_id] || {};
      const fecha = r[4] || "";
      const horaEnt = (r[5] || "").substring(11, 16);
      const horaSal = (r[9] || "").substring(11, 16);
      return {
        fecha,
        hoy: fecha === hoy,
        tiendaNombre:
          tiendaInfo.nombre_tienda || (tienda_id ? `Tienda ${tienda_id}` : "Sin tienda"),
        hora_entrada: horaEnt || "",
        hora_salida: horaSal || "",
        estado: r[13] || "",
      };
    })
    .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0))
    .slice(0, 8);

  if (!propias.length) {
    return (
      "Aún no tengo asistencias registradas para tu número 🕒\n" +
      "Usa la opción 1️⃣ del menú para registrar tu primera asistencia."
    );
  }

  let msg = "🕒 *Tus últimas asistencias*\n\n";
  propias.forEach((j) => {
    const etiquetaFecha = j.hoy ? `*${j.fecha} (HOY)*` : j.fecha;
    msg += `${etiquetaFecha} – ${j.tiendaNombre}\n`;
    msg += `   Entrada: ${j.hora_entrada || "-"} | Salida: ${
      j.hora_salida || "pendiente"
    } | Estado: ${j.estado || ""}\n\n`;
  });

  msg += "Escribe *menu* para volver al menú principal.";
  return msg;
}

// ==========================
// Asistencia (promotor)
// ==========================

async function handleAsistencia(telefono, estado, text, data, inbound) {
  const numMedia = parseInt(inbound?.NumMedia || "0", 10);
  const mediaUrl0 = inbound?.MediaUrl0 || "";
  const lat = inbound?.Latitude || inbound?.Latitude0 || "";
  const lon = inbound?.Longitude || inbound?.Longitude0 || "";

  const jornada = await getJornadaAbiertaPorTelefono(telefono);

  // ===== Menú asistencia =====
  if (estado === STATE_ASIS_MENU) {
    if (!jornada) {
      // No hay jornada abierta
      if (text === "1") {
        const promotor = await getPromotorPorTelefono(telefono);
        const tiendas = await getTiendasParaPromotor(promotor);
        if (!tiendas.length) {
          await setSession(telefono, STATE_PROM_MENU, {});
          return (
            "No tengo tiendas configuradas para ti 🏪\n" +
            "Revisa la hoja *TIENDAS* y tus datos en *PROMOTORES*.\n\n" +
            buildPromotorMenu()
          );
        }
        await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA, {
          tiendas,
          promotor_id: promotor ? promotor.promotor_id : "",
        });

        let msg = "🏪 *¿En qué tienda estás?*\n";
        tiendas.forEach((t, idx) => {
          msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena} (${t.ciudad})\n`;
        });
        msg += "\nResponde con el número de la tienda.";
        return msg;
      }

      if (text === "2") {
        await setSession(telefono, STATE_PROM_MENU, {});
        return buildPromotorMenu();
      }

      return (
        "🕒 *Asistencia en tienda*\n" +
        "No tienes ninguna asistencia abierta hoy.\n\n" +
        "1️⃣ Registrar entrada en una tienda\n" +
        "2️⃣ Volver al menú"
      );
    } else {
      // Jornada abierta
      const tiendasMap = await getTiendasMap();
      const tiendaInfo = tiendasMap[jornada.tienda_id] || {};
      const tiendaNombre =
        tiendaInfo.nombre_tienda ||
        (jornada.tienda_id ? `Tienda ${jornada.tienda_id}` : "Sin tienda");
      const horaEnt = (jornada.hora_entrada || "").substring(11, 16);
      if (!text) {
        return (
          "🕒 *Asistencia en tienda*\n" +
          `Tienes una asistencia abierta en *${tiendaNombre}* desde las *${horaEnt}*.\n\n` +
          "1️⃣ Registrar salida de esta tienda\n" +
          "2️⃣ Ver detalles de esta asistencia\n" +
          "3️⃣ Volver al menú"
        );
      }

      if (text === "1") {
        await registrarSalidaHora(jornada.jornada_id);
        await setSession(telefono, STATE_ASIS_SALIDA_FOTO, {
          jornada_id: jornada.jornada_id,
          tienda_id: jornada.tienda_id,
        });
        return (
          "🚪 *Salida de tienda*\n" +
          `📸 Envía una foto de salida (por ejemplo, frente de *${tiendaNombre}*).`
        );
      }

      if (text === "2") {
        const horaSal = (jornada.hora_salida || "").substring(11, 16);
        return (
          "📋 *Detalle de tu asistencia abierta*\n" +
          `🏪 Tienda: *${tiendaNombre}*\n` +
          `📅 Fecha: ${jornada.fecha || ""}\n` +
          `🕒 Entrada: ${horaEnt || "-"}\n` +
          `🚪 Salida: ${horaSal || "pendiente"}\n\n` +
          "1️⃣ Registrar salida\n" +
          "3️⃣ Volver al menú"
        );
      }

      if (text === "3") {
        await setSession(telefono, STATE_PROM_MENU, {});
        return buildPromotorMenu();
      }

      return (
        "🕒 *Asistencia en tienda*\n" +
        `Tienes una asistencia abierta en *${tiendaNombre}*.\n\n` +
        "1️⃣ Registrar salida de esta tienda\n" +
        "2️⃣ Ver detalles de esta asistencia\n" +
        "3️⃣ Volver al menú"
      );
    }
  }

  // ===== Elegir tienda para entrada =====
  if (estado === STATE_ASIS_ELEGIR_TIENDA) {
    const tiendas = data.tiendas || [];
    const n = parseInt(text, 10);
    if (
      Number.isNaN(n) ||
      n < 1 ||
      n > tiendas.length
    ) {
      let msg = "Elige una opción válida:\n\n";
      tiendas.forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena} (${t.ciudad})\n`;
      });
      msg += "\nResponde con el número de la tienda.";
      return msg;
    }

    const tienda = tiendas[n - 1];
    const promotor_id = data.promotor_id || "";
    const jornada_id = await crearJornadaEntrada(
      telefono,
      promotor_id,
      tienda.tienda_id
    );

    await setSession(telefono, STATE_ASIS_ENTRADA_FOTO, {
      jornada_id,
      tienda_id: tienda.tienda_id,
    });

    return (
      "🕒 *Entrada a tienda*\n" +
      `🏪 Tienda: *${tienda.nombre_tienda}*\n\n` +
      "📸 Envía una *foto de entrada* (selfie en piso, acceso, etc.)."
    );
  }

  // ===== Entrada: foto =====
  if (estado === STATE_ASIS_ENTRADA_FOTO) {
    const { jornada_id, tienda_id } = data;
    if (!numMedia || !mediaUrl0) {
      return (
        "Necesito una *foto de entrada* para registrar tu asistencia.\n" +
        "Adjunta una imagen y vuelve a enviar."
      );
    }

    await actualizarEntradaFoto(jornada_id, mediaUrl0);
    await setSession(telefono, STATE_ASIS_ENTRADA_UBIC, {
      jornada_id,
      tienda_id,
      fotoUrl: mediaUrl0,
    });

    return (
      "✅ Foto de entrada recibida.\n\n" +
      "📍 Ahora envía tu *ubicación* desde WhatsApp o escribe una breve descripción (ej. \"acceso principal\", \"piso de ventas\")."
    );
  }

  // ===== Entrada: ubicación + evidencia =====
  if (estado === STATE_ASIS_ENTRADA_UBIC) {
    const { jornada_id, tienda_id, fotoUrl } = data;
    const latUse = lat || "";
    const lonUse = lon || "";
    if (latUse || lonUse) {
      await actualizarEntradaUbicacion(jornada_id, latUse, lonUse);
    }

    await registrarEvidencia({
      telefono,
      tipo_evento: "ENTRADA_TIENDA",
      origen: "JORNADA",
      jornada_id,
      visita_id: "",
      fotoUrl,
      lat: latUse,
      lon: lonUse,
      marca_id: "",
      producto_id: "",
      tipo_evidencia: "",
      descripcion: "",
    });

    await addPuntos(
      telefono,
      "OPERACION",
      `ENTRADA_TIENDA_${jornada_id}`,
      3
    );

    await setSession(telefono, STATE_PROM_MENU, {});
    return (
      "✅ Asistencia registrada correctamente (entrada a tienda).\n" +
      "🎯 Ganaste *3 puntos* por registrar tu entrada completa.\n\n" +
      buildPromotorMenu()
    );
  }

  // ===== Salida: foto =====
  if (estado === STATE_ASIS_SALIDA_FOTO) {
    const { jornada_id, tienda_id } = data;
    if (!numMedia || !mediaUrl0) {
      return (
        "Necesito una *foto de salida* para cerrar tu asistencia.\n" +
        "Adjunta una imagen y vuelve a enviar."
      );
    }

    await actualizarSalidaFoto(jornada_id, mediaUrl0);
    await setSession(telefono, STATE_ASIS_SALIDA_UBIC, {
      jornada_id,
      tienda_id,
      fotoUrl: mediaUrl0,
    });

    return (
      "✅ Foto de salida recibida.\n\n" +
      "📍 Ahora envía tu *ubicación* desde WhatsApp o escribe una breve descripción (ej. \"salida principal\")."
    );
  }

  // ===== Salida: ubicación + evidencia =====
  if (estado === STATE_ASIS_SALIDA_UBIC) {
    const { jornada_id, tienda_id, fotoUrl } = data;
    const latUse = lat || "";
    const lonUse = lon || "";
    if (latUse || lonUse) {
      await actualizarSalidaUbicacionYCerrar(jornada_id, latUse, lonUse);
    } else {
      // aun así cerramos la jornada
      await actualizarSalidaUbicacionYCerrar(jornada_id, "", "");
    }

    await registrarEvidencia({
      telefono,
      tipo_evento: "SALIDA_TIENDA",
      origen: "JORNADA",
      jornada_id,
      visita_id: "",
      fotoUrl,
      lat: latUse,
      lon: lonUse,
      marca_id: "",
      producto_id: "",
      tipo_evidencia: "",
      descripcion: "",
    });

    await addPuntos(
      telefono,
      "OPERACION",
      `SALIDA_TIENDA_${jornada_id}`,
      3
    );

    await setSession(telefono, STATE_PROM_MENU, {});
    return (
      "✅ Asistencia cerrada correctamente (salida de tienda).\n" +
      "🎯 Ganaste *3 puntos* adicionales.\n\n" +
      buildPromotorMenu()
    );
  }

  // Fallback
  await setSession(telefono, STATE_ASIS_MENU, {});
  return (
    "🕒 *Asistencia en tienda*\n" +
    "1️⃣ Registrar entrada en una tienda\n" +
    "2️⃣ Volver al menú"
  );
}

// ==========================
// Evidencias en anaquel (promotoría compartida)
// ==========================

function getTipoEvidenciaCatalogo() {
  return [
    { code: "ANTES", label: "Antes del acomodo del anaquel" },
    { code: "DESPUES", label: "Después del acomodo del anaquel" },
    { code: "EXHIB_SEC", label: "Exhibición secundaria" },
    { code: "POP", label: "Material POP" },
    { code: "OTRO", label: "Otro tipo de evidencia" },
  ];
}

async function handleEvidencias(telefono, estado, text, data, inbound) {
  const numMedia = parseInt(inbound?.NumMedia || "0", 10);
  const mediaUrl0 = inbound?.MediaUrl0 || "";
  const lat = inbound?.Latitude || inbound?.Latitude0 || "";
  const lon = inbound?.Longitude || inbound?.Longitude0 || "";

  // ===== Elegir marca =====
  if (estado === STATE_EVID_MARCA) {
    let { jornada_id, tienda_id, marcas } = data;

    if (!jornada_id || !tienda_id) {
      const j = await getJornadaAbiertaPorTelefono(telefono);
      if (!j) {
        await setSession(telefono, STATE_PROM_MENU, {});
        return (
          "Para capturar evidencias, primero registra tu asistencia en tienda (opción 1️⃣).\n\n" +
          buildPromotorMenu()
        );
      }
      jornada_id = j.jornada_id;
      tienda_id = j.tienda_id;
    }

    if (!marcas || !marcas.length) {
      marcas = await getMarcasParaTienda(tienda_id);
    }

    if (!marcas.length) {
      await setSession(telefono, STATE_PROM_MENU, {});
      return (
        "No tengo marcas configuradas para esta tienda 🧴\n" +
        "Revisa la hoja *TIENDA_MARCA* y *MARCAS*.\n\n" +
        buildPromotorMenu()
      );
    }

    if (!text) {
      let msg = "🧴 *¿Para qué marca vas a capturar evidencia en esta tienda?*\n";
      marcas.forEach((m, idx) => {
        msg += `${idx + 1}) ${m.nombre_marca} (Cliente: ${m.cliente})\n`;
      });
      msg += "\nResponde con el número de la marca.";
      await setSession(telefono, STATE_EVID_MARCA, {
        jornada_id,
        tienda_id,
        marcas,
      });
      return msg;
    }

    const n = parseInt(text, 10);
    if (
      Number.isNaN(n) ||
      n < 1 ||
      n > marcas.length
    ) {
      let msg =
        "Elige una opción válida de marca:\n\n";
      marcas.forEach((m, idx) => {
        msg += `${idx + 1}) ${m.nombre_marca} (Cliente: ${m.cliente})\n`;
      });
      msg += "\nResponde con el número de la marca.";
      return msg;
    }

    const marca = marcas[n - 1];
    const tipos = getTipoEvidenciaCatalogo();

    await setSession(telefono, STATE_EVID_TIPO, {
      jornada_id,
      tienda_id,
      marca_id: marca.marca_id,
      marca_nombre: marca.nombre_marca,
      tipos,
    });

    let msg =
      `🧴 Marca seleccionada: *${marca.nombre_marca}*\n\n` +
      "📸 *¿Qué tipo de evidencia vas a capturar?*\n";
    tipos.forEach((t, idx) => {
      msg += `${idx + 1}) ${t.label}\n`;
    });
    msg += "\nResponde con el número de la opción.";
    return msg;
  }

  // ===== Elegir tipo de evidencia =====
  if (estado === STATE_EVID_TIPO) {
    const { jornada_id, tienda_id, marca_id, marca_nombre, tipos } = data;
    const n = parseInt(text, 10);
    if (
      Number.isNaN(n) ||
      n < 1 ||
      n > tipos.length
    ) {
      let msg = "Elige un tipo de evidencia válido:\n\n";
      tipos.forEach((t, idx) => {
        msg += `${idx + 1}) ${t.label}\n`;
      });
      msg += "\nResponde con el número de la opción.";
      return msg;
    }

    const tipo = tipos[n - 1];
    await setSession(telefono, STATE_EVID_PRODUCTO_INPUT, {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code: tipo.code,
      tipo_evidencia_label: tipo.label,
    });

    return (
      `🎯 Tipo de evidencia: *${tipo.label}*\n\n` +
      "🔢 Envía el *código de barras* del producto (puedes escanearlo con la cámara del celular)\n" +
      "o escribe *lista* para ver un listado de productos de la marca."
    );
  }

  // ===== Producto: código o 'lista' =====
  if (estado === STATE_EVID_PRODUCTO_INPUT) {
    const {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
    } = data;

    const lower = (text || "").trim().toLowerCase();
    if (lower === "lista") {
      const productos = await getProductosPorMarca(marca_id);
      if (!productos.length) {
        await setSession(telefono, STATE_PROM_MENU, {});
        return (
          "No tengo productos configurados para esta marca 📦\n" +
          "Revisa la hoja *PRODUCTOS*.\n\n" +
          buildPromotorMenu()
        );
      }
      await setSession(telefono, STATE_EVID_PRODUCTO_LISTA, {
        jornada_id,
        tienda_id,
        marca_id,
        marca_nombre,
        tipo_evidencia_code,
        tipo_evidencia_label,
        productos,
      });
      let msg =
        `📦 Productos de *${marca_nombre}* (elige uno):\n\n`;
      productos.slice(0, 8).forEach((p, idx) => {
        msg += `${idx + 1}) ${p.nombre_producto} (código: ${p.sku_barcode})\n`;
      });
      msg += "\nResponde con el número del producto.";
      return msg;
    }

    // Intentamos interpretar como código de barras
    const prod = await getProductoPorBarcode(text.trim());
    if (!prod || prod.marca_id !== marca_id) {
      return (
        "No encontré un producto de esta marca con ese código de barras 😕\n" +
        "Envía otro código o escribe *lista* para ver los productos disponibles."
      );
    }

    await setSession(telefono, STATE_EVID_FOTO, {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
      producto_id: prod.producto_id,
      producto_nombre: prod.nombre_producto,
    });

    return (
      `📦 Producto: *${prod.nombre_producto}* (código: ${prod.sku_barcode})\n\n` +
      "📸 Ahora envía la *foto del anaquel* para esta evidencia."
    );
  }

  // ===== Producto: elegir de la lista =====
  if (estado === STATE_EVID_PRODUCTO_LISTA) {
    const {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
      productos,
    } = data;

    const n = parseInt(text, 10);
    if (
      Number.isNaN(n) ||
      n < 1 ||
      n > productos.length
    ) {
      let msg =
        "Elige un producto válido:\n\n";
      productos.slice(0, 8).forEach((p, idx) => {
        msg += `${idx + 1}) ${p.nombre_producto} (código: ${p.sku_barcode})\n`;
      });
      msg += "\nResponde con el número del producto.";
      return msg;
    }

    const prod = productos[n - 1];

    await setSession(telefono, STATE_EVID_FOTO, {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
      producto_id: prod.producto_id,
      producto_nombre: prod.nombre_producto,
    });

    return (
      `📦 Producto: *${prod.nombre_producto}* (código: ${prod.sku_barcode})\n\n` +
      "📸 Ahora envía la *foto del anaquel* para esta evidencia."
    );
  }

  // ===== Foto de evidencia =====
  if (estado === STATE_EVID_FOTO) {
    const {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
      producto_id,
      producto_nombre,
    } = data;

    if (!numMedia || !mediaUrl0) {
      return (
        "Necesito la *foto del anaquel* para esta evidencia.\n" +
        "Adjunta una imagen y vuelve a enviar."
      );
    }

    await setSession(telefono, STATE_EVID_DESC, {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
      producto_id,
      producto_nombre,
      fotoUrl: mediaUrl0,
    });

    return (
      "✅ Foto recibida.\n\n" +
      "✏️ Escribe una breve descripción de esta evidencia (máx. 200 caracteres)\n" +
      "o responde *no* para omitir."
    );
  }

  // ===== Descripción y registro final =====
  if (estado === STATE_EVID_DESC) {
    const {
      jornada_id,
      tienda_id,
      marca_id,
      marca_nombre,
      tipo_evidencia_code,
      tipo_evidencia_label,
      producto_id,
      producto_nombre,
      fotoUrl,
    } = data;

    const lower = (text || "").trim().toLowerCase();
    const descripcion = lower === "no" ? "" : text.trim();
    const latUse = lat || "";
    const lonUse = lon || "";

    const { resultado_ai, score_confianza, riesgo } = await registrarEvidencia({
      telefono,
      tipo_evento: "EVID_ANAQUEL",
      origen: "PROMO",
      jornada_id,
      visita_id: "",
      fotoUrl,
      lat: latUse,
      lon: lonUse,
      marca_id,
      producto_id,
      tipo_evidencia: tipo_evidencia_code,
      descripcion,
    });

    await addPuntos(
      telefono,
      "OPERACION",
      `EVID_ANAQUEL_${jornada_id}_${producto_id}`,
      4
    );

    await setSession(telefono, STATE_PROM_MENU, {});

    return (
      "✅ *Evidencia registrada*\n" +
      `🧴 Marca: ${marca_nombre}\n` +
      `🛒 Producto: ${producto_nombre}\n` +
      `🎯 Tipo evidencia: ${tipo_evidencia_label}\n\n` +
      "🔎 *EVIDENCIA+ (demo)*\n" +
      `✔️ Análisis: ${resultado_ai}\n` +
      `📊 Confianza: ${(score_confianza * 100).toFixed(0)}%\n` +
      `⚠️ Riesgo: ${riesgo}\n\n` +
      "🎯 Ganaste *4 puntos* por esta evidencia.\n\n" +
      "Escribe *2* para capturar otra evidencia, *fotos hoy* para ver lo registrado,\n" +
      "o *menu* para volver al menú principal."
    );
  }

  await setSession(telefono, STATE_PROM_MENU, {});
  return buildPromotorMenu();
}

// ==========================
// Lógica de supervisor
// ==========================

async function handleSupervisor(
  telefono,
  supervisor,
  estado,
  text,
  data,
  inbound
) {
  const lower = (text || "").trim().toLowerCase();

  if (estado === STATE_SUP_MENU) {
    if (lower === "1") {
      const out = await buildFotoMessagesSupervisorEquipoHoy(supervisor);
      return out;
    }
    if (lower === "2") {
      const out = await buildFotoMessagesSupervisorRiesgo(supervisor);
      return out;
    }
    if (lower === "3") {
      // Asistencias hoy de equipo
      const hoy = new Date().toISOString().slice(0, 10);
      const promotores = await getPromotoresDeSupervisor(supervisor.telefono);
      if (!promotores.length) {
        return (
          "⚠️ No tengo promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Verifica la columna *telefono_supervisor*."
        );
      }
      const telSet = new Set(
        promotores.map((p) => (p.telefono || "").trim())
      );
      const nombreMap = {};
      promotores.forEach((p) => {
        nombreMap[p.telefono.trim()] = p.nombre || p.telefono;
      });

      const jornadas = await getSheetValues("JORNADAS!A2:N");
      const tiendasMap = await getTiendasMap();

      const porPromotor = {};

      for (const r of jornadas) {
        const tel = (r[1] || "").trim();
        if (!telSet.has(tel)) continue;
        const fecha = r[4] || "";
        if (fecha !== hoy) continue;

        const promNom = nombreMap[tel] || tel;
        const tienda_id = r[3] || "";
        const tiendaInfo = tiendasMap[tienda_id] || {};
        const tiendaNombre =
          tiendaInfo.nombre_tienda ||
          (tienda_id ? `Tienda ${tienda_id}` : "Sin tienda");

        const horaEnt = (r[5] || "").substring(11, 16);
        const horaSal = (r[9] || "").substring(11, 16);
        const estadoJ = r[13] || "";

        if (!porPromotor[promNom]) porPromotor[promNom] = [];
        porPromotor[promNom].push({
          tiendaNombre,
          hora_entrada: horaEnt,
          hora_salida: horaSal,
          estado: estadoJ,
        });
      }

      const promNombres = Object.keys(porPromotor);
      if (!promNombres.length) {
        return (
          "🕒 Hoy no hay asistencias registradas para tu equipo.\n" +
          "Pídeles que usen la opción 1️⃣ del menú de promotor."
        );
      }

      let msg = "🕒 *Asistencias de hoy de tu equipo*\n\n";
      promNombres.forEach((nom) => {
        msg += `🧑‍💼 *${nom}*\n`;
        porPromotor[nom].forEach((j) => {
          msg += `   🏪 ${j.tiendaNombre}\n`;
          msg += `      Entrada: ${j.hora_entrada || "-"} | Salida: ${
            j.hora_salida || "pendiente"
          } | Estado: ${j.estado || ""}\n`;
        });
        msg += "\n";
      });

      msg +=
        "Escribe *sup* para ver de nuevo el menú de supervisor o *menu* para ir al menú de promotor.";
      return msg;
    }

    if (lower === "4") {
      await setSession(telefono, STATE_PROM_MENU, {});
      return buildPromotorMenu();
    }

    return buildSupervisorMenu(supervisor);
  }

  // Por ahora no tenemos más estados específicos para supervisor
  await setSession(telefono, STATE_SUP_MENU, {});
  return buildSupervisorMenu(supervisor);
}

// ==========================
// Lógica principal (promotor + supervisor)
// ==========================

async function handlePromotor(telefono, estado, text, data, inbound) {
  const lower = (text || "").trim().toLowerCase();

  // Comando rápido: puntos (no está en menú, pero puede ser útil)
  if (lower === "puntos") {
    const { operacion, capacitacion, total } = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos*\n" +
      `🟦 Operación: ${operacion}\n` +
      `🟨 Capacitación: ${capacitacion}\n` +
      `🎯 Total: ${total}\n\n` +
      "Escribe *menu* para volver al menú."
    );
  }

  // Comando rápido: fotos hoy
  if (lower === "fotos hoy") {
    return await buildFotoMessagesPromotorHoy(telefono);
  }

  if (estado === STATE_PROM_MENU) {
    if (!["1", "2", "3"].includes(text.trim())) {
      await setSession(telefono, STATE_PROM_MENU, {});
      return buildPromotorMenu();
    }

    if (text === "1") {
      await setSession(telefono, STATE_ASIS_MENU, {});
      return await handleAsistencia(
        telefono,
        STATE_ASIS_MENU,
        "",
        {},
        inbound
      );
    }

    if (text === "2") {
      const j = await getJornadaAbiertaPorTelefono(telefono);
      if (!j) {
        return (
          "Para capturar evidencias, primero registra tu asistencia en tienda (opción 1️⃣).\n\n" +
          buildPromotorMenu()
        );
      }
      const marcas = await getMarcasParaTienda(j.tienda_id);
      await setSession(telefono, STATE_EVID_MARCA, {
        jornada_id: j.jornada_id,
        tienda_id: j.tienda_id,
        marcas,
      });
      return await handleEvidencias(
        telefono,
        STATE_EVID_MARCA,
        "",
        {
          jornada_id: j.jornada_id,
          tienda_id: j.tienda_id,
          marcas,
        },
        inbound
      );
    }

    if (text === "3") {
      const msg = await buildHistorialAsistenciasPromotor(telefono);
      await setSession(telefono, STATE_PROM_MENU, {});
      return msg;
    }

    await setSession(telefono, STATE_PROM_MENU, {});
    return buildPromotorMenu();
  }

  // Otros estados de asistencia
  if (
    [
      STATE_ASIS_MENU,
      STATE_ASIS_ELEGIR_TIENDA,
      STATE_ASIS_ENTRADA_FOTO,
      STATE_ASIS_ENTRADA_UBIC,
      STATE_ASIS_SALIDA_FOTO,
      STATE_ASIS_SALIDA_UBIC,
    ].includes(estado)
  ) {
    return await handleAsistencia(telefono, estado, text, data, inbound);
  }

  // Estados de evidencias
  if (
    [
      STATE_EVID_MARCA,
      STATE_EVID_TIPO,
      STATE_EVID_PRODUCTO_INPUT,
      STATE_EVID_PRODUCTO_LISTA,
      STATE_EVID_FOTO,
      STATE_EVID_DESC,
    ].includes(estado)
  ) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
  }

  await setSession(telefono, STATE_PROM_MENU, {});
  return buildPromotorMenu();
}

// Normaliza salida a lista de { body, mediaUrl }
function normalizeOut(result) {
  const normalizeOne = (x) => {
    if (!x && x !== 0) return { body: "" };
    if (typeof x === "string") return { body: x };
    if (typeof x === "object") {
      if (Array.isArray(x.messages)) {
        // Esto se maneja afuera
        return null;
      }
      return {
        body: x.body || x.text || "",
        mediaUrl: x.mediaUrl || x.media || undefined,
      };
    }
    return { body: String(x) };
  };

  if (Array.isArray(result)) {
    return result
      .map(normalizeOne)
      .filter((m) => m && (m.body || m.mediaUrl));
  }

  if (typeof result === "object" && result !== null) {
    if (Array.isArray(result.messages)) {
      return result.messages
        .map(normalizeOne)
        .filter((m) => m && (m.body || m.mediaUrl));
    }
    const single = normalizeOne(result);
    return single ? [single] : [];
  }

  const single = normalizeOne(result);
  return single ? [single] : [];
}

async function handleIncoming(telefono, body, inbound) {
  const text = (body || "").trim();
  const lower = text.toLowerCase();

  const supervisor = await getSupervisorPorTelefono(telefono);
  const sesion = await getSession(telefono);
  let estado = sesion.estado_actual || STATE_PROM_MENU;
  const data = sesion.data_json || {};

  // Comando global: menu
  if (lower === "menu") {
    await setSession(telefono, STATE_PROM_MENU, {});
    return buildPromotorMenu();
  }

  // Comando global: sup (solo si es supervisor)
  if (lower === "sup") {
    if (!supervisor) {
      return (
        "⚠️ Tu número no está dado de alta como supervisor.\n" +
        "Puedes usar el menú de promotor escribiendo *menu*."
      );
    }
    await setSession(telefono, STATE_SUP_MENU, {});
    return buildSupervisorMenu(supervisor);
  }

  // Si el estado actual es de supervisor, delegamos
  if (estado.startsWith("SUP_") && supervisor) {
    return await handleSupervisor(
      telefono,
      supervisor,
      estado,
      text,
      data,
      inbound
    );
  }

  // Caso normal: promotor
  return await handlePromotor(telefono, estado, text, data, inbound);
}

// ==========================
// Rutas Express
// ==========================

app.post("/whatsapp", async (req, res) => {
  const from = (req.body.From || "").trim(); // ej. whatsapp:+52155...
  const body = (req.body.Body || "").trim();

  console.log(
    "Mensaje entrante:",
    from,
    JSON.stringify(body),
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

  const messages = normalizeOut(respuesta);
  const twiml = new MessagingResponse();

  if (!messages.length) {
    twiml.message("No tengo nada que responder en este momento 🤔");
  } else {
    for (const m of messages) {
      const msg = twiml.message();
      if (m.body) msg.body(m.body);
      if (m.mediaUrl) msg.media(m.mediaUrl);
    }
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Ruta raíz para probar en navegador
app.get("/", (req, res) => {
  res.send(
    "Promobolsillo+ demo está vivo ✅ (asistencia por tienda + evidencias anaquel + promotor/supervisor)"
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Promobolsillo+ escuchando en puerto ${PORT}`);
});
