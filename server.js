import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ==========================
// ENV
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
  console.warn("⚠️ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. Reenvío deshabilitado.");
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
const MessagingResponse = twilio.twiml.MessagingResponse;

// ==========================
// Google Sheets
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
// Helpers
// ==========================
function norm(v) { return (v || "").toString().trim(); }
function upper(v) { return norm(v).toUpperCase(); }
function isTrue(v) {
  const t = upper(v);
  return t === "TRUE" || t === "1" || t === "SI" || t === "SÍ";
}
function safeInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }
function riesgoRank(r) {
  const x = upper(r);
  if (x === "ALTO") return 3;
  if (x === "MEDIO") return 2;
  return 1;
}
function maxRiesgo(a, b) {
  return riesgoRank(a) >= riesgoRank(b) ? a : b;
}
function colToA1(n0) {
  let n = n0 + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ==========================
// States
// ==========================
const STATE_MENU = "MENU";

// Asistencia (submenú)
const STATE_ASIS_HOME = "ASIS_HOME";
const STATE_ASIS_ELEGIR_TIENDA_ENTRADA = "ASIS_ELEGIR_TIENDA_ENTRADA";
const STATE_ASIS_CONFIRMAR_ENTRADA = "ASIS_CONFIRMAR_ENTRADA";
const STATE_ASIS_CONFIRMAR_SALIDA = "ASIS_CONFIRMAR_SALIDA";
const STATE_ASIS_FOTO = "ASIS_FOTO";
const STATE_ASIS_UBI = "ASIS_UBI";
const STATE_ASIS_HIST = "ASIS_HIST";
const STATE_ASIS_VER_VISITA = "ASIS_VER_VISITA";
const STATE_ASIS_CAMBIAR_FOTO = "ASIS_CAMBIAR_FOTO"; // entrada/salida, visita_id

// Evidencias (tienda activa)
const STATE_EVID_ELEGIR_VISITA = "EVID_ELEGIR_VISITA";
const STATE_EVID_ELEGIR_MARCA = "EVID_ELEGIR_MARCA";
const STATE_EVID_ELEGIR_TIPO = "EVID_ELEGIR_TIPO";
const STATE_EVID_ELEGIR_FASE = "EVID_ELEGIR_FASE";
const STATE_EVID_FOTOS = "EVID_FOTOS";

// Mis evidencias
const STATE_MY_EVID_LIST = "MY_EVID_LIST";
const STATE_MY_EVID_REHACER = "MY_EVID_REHACER";
const STATE_MY_EVID_RECLASIFICAR_TIENDA = "MY_EVID_RECLAS_TIENDA";
const STATE_MY_EVID_RECLASIFICAR_MARCA = "MY_EVID_RECLAS_MARCA";

// Supervisor (mantener)
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";

// ==========================
// SESIONES
// ==========================
async function findSessionRow(telefono) {
  const rows = await getSheetValues("SESIONES!A2:C");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (norm(r[0]) === telefono) {
      const estado_actual = norm(r[1]) || STATE_MENU;
      let data_json = {};
      try { data_json = r[2] ? JSON.parse(r[2]) : {}; } catch { data_json = {}; }
      return { rowIndex: i + 2, estado_actual, data_json };
    }
  }
  return null;
}
async function getSession(telefono) {
  let ses = await findSessionRow(telefono);
  if (ses) return ses;
  await appendSheetValues("SESIONES!A2:C", [[telefono, STATE_MENU, "{}"]]);
  return await findSessionRow(telefono);
}
async function setSession(telefono, estado_actual, data_json = {}) {
  const ses = await findSessionRow(telefono);
  const dataStr = JSON.stringify(data_json || {});
  if (!ses) {
    await appendSheetValues("SESIONES!A2:C", [[telefono, estado_actual, dataStr]]);
  } else {
    await updateSheetValues(`SESIONES!A${ses.rowIndex}:C${ses.rowIndex}`, [[telefono, estado_actual, dataStr]]);
  }
}

// ==========================
// Headers-based write (EVIDENCIAS flexible)
// ==========================
const headerCache = new Map();
function normalizeHeaderName(h) {
  return norm(h).toLowerCase().replace(/\s+/g, "_").replace(/[^\w]/g, "");
}
async function getHeaderInfo(sheetName, maxCols = 80) {
  const key = `${sheetName}:${maxCols}`;
  if (headerCache.has(key)) return headerCache.get(key);

  const endCol = colToA1(maxCols - 1);
  const headers = await getSheetValues(`${sheetName}!A1:${endCol}1`);
  const row = (headers[0] || []).map(norm);

  let last = row.length - 1;
  while (last >= 0 && !row[last]) last--;
  const used = row.slice(0, last + 1);

  const map = {};
  used.forEach((h, idx) => {
    if (!h) return;
    map[normalizeHeaderName(h)] = idx;
  });

  const info = { headers: used, map, width: Math.max(used.length, 1), endCol };
  headerCache.set(key, info);
  return info;
}
function findHeaderIndex(info, key, synonyms = []) {
  const k = normalizeHeaderName(key);
  if (info.map[k] !== undefined) return info.map[k];
  for (const s of synonyms) {
    const sk = normalizeHeaderName(s);
    if (info.map[sk] !== undefined) return info.map[sk];
  }
  return null;
}
async function appendByHeaders(sheetName, obj) {
  const info = await getHeaderInfo(sheetName, 80);
  const row = new Array(info.width).fill("");

  const synonyms = {
    descripcion: ["comentario", "nota", "observaciones"],
    comentario: ["descripcion", "nota", "observaciones"],
    marca_nombre: ["marca"],
    score_confianza: ["score", "confianza"],
    estatus: ["status", "estado"],
    reemplazada_por: ["reemplazadapor", "replaced_by"],
    actualizado_en: ["updated_at", "fecha_actualizacion"],
  };

  for (const [k, v] of Object.entries(obj)) {
    const idx = findHeaderIndex(info, k, synonyms[k] || []);
    if (idx !== null) row[idx] = v;
  }
  await appendSheetValues(`${sheetName}!A2:${info.endCol}`, [row]);
}
async function updateRowCellsByHeaders(sheetName, rowIndex, obj) {
  const info = await getHeaderInfo(sheetName, 80);
  const synonyms = {
    descripcion: ["comentario", "nota", "observaciones"],
    estatus: ["status", "estado"],
    reemplazada_por: ["reemplazadapor", "replaced_by"],
    actualizado_en: ["updated_at", "fecha_actualizacion"],
  };

  for (const [k, v] of Object.entries(obj)) {
    const idx = findHeaderIndex(info, k, synonyms[k] || []);
    if (idx === null) continue;
    const col = colToA1(idx);
    await updateSheetValues(`${sheetName}!${col}${rowIndex}:${col}${rowIndex}`, [[v]]);
  }
}

// ==========================
// Catálogos
// ==========================
async function getSupervisorPorTelefono(telefono) {
  const rows = await getSheetValues("SUPERVISORES!A2:F");
  for (const r of rows) {
    if (norm(r[0]) === telefono && isTrue(r[5])) {
      return { telefono, supervisor_id: norm(r[1]), nombre: norm(r[2]) };
    }
  }
  return null;
}
async function getPromotorPorTelefono(telefono) {
  const rows = await getSheetValues("PROMOTORES!A2:G");
  for (const r of rows) {
    if (norm(r[0]) === telefono) {
      return {
        telefono,
        promotor_id: norm(r[1]),
        nombre: norm(r[2]),
        activo: isTrue(r[5]),
        telefono_supervisor: norm(r[6]),
      };
    }
  }
  return null;
}
async function getPromotoresDeSupervisor(telefonoSupervisor) {
  const rows = await getSheetValues("PROMOTORES!A2:G");
  return rows
    .filter((r) => isTrue(r[5]) && norm(r[6]) === telefonoSupervisor)
    .map((r) => ({ telefono: norm(r[0]), promotor_id: norm(r[1]), nombre: norm(r[2]) }));
}
async function getTiendaMap() {
  const rows = await getSheetValues("TIENDAS!A2:K");
  const map = {};
  for (const r of rows) {
    const id = norm(r[0]);
    if (!id) continue;
    map[id] = {
      tienda_id: id,
      nombre_tienda: norm(r[1]),
      cadena: norm(r[2]),
      ciudad: norm(r[3]),
      activa: isTrue(r[5]),
    };
  }
  return map;
}
async function getTiendasAsignadas(promotor_id) {
  const rows = await getSheetValues("ASIGNACIONES!A2:D");
  const ids = [];
  for (const r of rows) {
    if (norm(r[0]) === promotor_id && isTrue(r[3] ?? "TRUE")) {
      const tid = norm(r[1]);
      if (tid) ids.push(tid);
    }
  }
  return Array.from(new Set(ids));
}

// ==========================
// VISITAS
// ==========================
async function getVisitsToday(promotor_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const fecha = todayISO();
  return rows
    .filter((r) => norm(r[1]) === promotor_id && norm(r[3]) === fecha)
    .map((r) => ({
      visita_id: norm(r[0]),
      tienda_id: norm(r[2]),
      hora_inicio: norm(r[4]),
      hora_fin: norm(r[5]),
    }));
}
async function getOpenVisitsToday(promotor_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const fecha = todayISO();
  return rows
    .filter((r) => norm(r[1]) === promotor_id && norm(r[3]) === fecha && !norm(r[5]))
    .map((r) => ({ visita_id: norm(r[0]), tienda_id: norm(r[2]) }));
}
async function findOpenVisit(promotor_id, tienda_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const fecha = todayISO();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (norm(r[1]) === promotor_id && norm(r[2]) === tienda_id && norm(r[3]) === fecha && !norm(r[5])) {
      return { visita_id: norm(r[0]) };
    }
  }
  return null;
}
async function createVisit(promotor_id, tienda_id) {
  const visita_id = "V-" + Date.now();
  await appendSheetValues("VISITAS!A2:F", [[visita_id, promotor_id, tienda_id, todayISO(), nowISO(), ""]]);
  return visita_id;
}
async function closeVisitById(visita_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  for (let i = 0; i < rows.length; i++) {
    if (norm(rows[i][0]) === visita_id) {
      const rowIndex = i + 2;
      await updateSheetValues(`VISITAS!F${rowIndex}:F${rowIndex}`, [[nowISO()]]);
      return true;
    }
  }
  return false;
}

// ==========================
// MARCAS / REGLAS
// ==========================
async function getMarcasActivas() {
  const rows = await getSheetValues("MARCAS!A2:D");
  const out = [];
  for (const r of rows) {
    const marca_id = norm(r[0]);
    if (!marca_id) continue;
    const marca_nombre = r.length >= 4 ? norm(r[2]) : norm(r[1]);
    const activa = r.length >= 4 ? isTrue(r[3]) : isTrue(r[2]);
    if (activa) out.push({ marca_id, marca_nombre });
  }
  out.sort((a, b) => a.marca_nombre.localeCompare(b.marca_nombre));
  return out;
}
async function getReglasPorMarca(marca_id) {
  const rows = await getSheetValues("REGLAS_EVIDENCIA!A2:E");
  const reglas = [];
  for (const r of rows) {
    if (norm(r[0]) !== marca_id) continue;
    if (!isTrue(r[4] ?? "TRUE")) continue;
    reglas.push({
      marca_id,
      tipo_evidencia: norm(r[1]),
      fotos_requeridas: safeInt(r[2], 1),
      requiere_antes_despues: isTrue(r[3]),
    });
  }
  return reglas;
}

// ==========================
// EVIDENCIAS: guardar + buscar asistencia + agrupar
// ==========================
function demoAnalisis(tipo_evento) {
  const t = upper(tipo_evento);
  if (t.includes("ENTRADA")) return { resultado_ai: "Entrada validada (demo).", score: 0.93, riesgo: "BAJO" };
  if (t.includes("SALIDA")) return { resultado_ai: "Salida validada (demo).", score: 0.92, riesgo: "BAJO" };
  const r = Math.random();
  if (r < 0.08) return { resultado_ai: "Posible evidencia incompleta (demo).", score: 0.62, riesgo: "ALTO" };
  if (r < 0.20) return { resultado_ai: "Evidencia con dudas leves (demo).", score: 0.78, riesgo: "MEDIO" };
  return { resultado_ai: "Evidencia coherente (demo).", score: 0.90, riesgo: "BAJO" };
}

async function registrarEvidencia(payload) {
  const a = demoAnalisis(payload.tipo_evento);
  await appendByHeaders("EVIDENCIAS", {
    evidencia_id: payload.evidencia_id,
    telefono: payload.telefono,
    fecha_hora: nowISO(),
    tipo_evento: payload.tipo_evento,
    origen: payload.origen,
    jornada_id: "",
    visita_id: payload.visita_id,
    url_foto: payload.url_foto,
    lat: payload.lat || "",
    lon: payload.lon || "",
    resultado_ai: a.resultado_ai,
    score_confianza: a.score,
    riesgo: a.riesgo,
    marca_id: payload.marca_id || "",
    producto_id: payload.producto_id || "",
    tipo_evidencia: payload.tipo_evidencia || "",
    descripcion: payload.descripcion || "",
    tienda_id: payload.tienda_id || "",
    promotor_id: payload.promotor_id || "",
    marca_nombre: payload.marca_nombre || "",
    fase: payload.fase || "NA",
    batch_id: payload.batch_id || "",
    seq: payload.seq || 1,
    estatus: payload.estatus || "ACTIVA",
    reemplazada_por: payload.reemplazada_por || "",
    actualizado_en: payload.actualizado_en || "",
  });
  return a;
}

async function findLastEvidenceRowIndexForAsistencia(visita_id, tipo_evento) {
  // Lee un bloque razonable (piloto) y busca la última coincidencia
  const rows = await getSheetValues("EVIDENCIAS!A2:V");
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const t = norm(r[3]);
    const v = norm(r[6]);
    const origen = upper(r[4]);
    if (v === visita_id && t === tipo_evento && origen === "ASISTENCIA") {
      return { rowIndex: i + 2, evidencia_id: norm(r[0]) };
    }
  }
  return null;
}

async function getAsistenciaFotosByVisita(visita_id) {
  const rows = await getSheetValues("EVIDENCIAS!A2:V");
  let entrada = null;
  let salida = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t = norm(r[3]);
    const v = norm(r[6]);
    const origen = upper(r[4]);
    if (v !== visita_id || origen !== "ASISTENCIA") continue;
    if (t === "ASISTENCIA_ENTRADA") entrada = norm(r[7]);
    if (t === "ASISTENCIA_SALIDA") salida = norm(r[7]);
  }
  return { entrada, salida };
}

async function getEvidenciasHoyDelPromotor(telefono) {
  const rows = await getSheetValues("EVIDENCIAS!A2:V");
  const hoy = todayISO();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (norm(r[1]) !== telefono) continue;
    const fecha_hora = norm(r[2]);
    if (!fecha_hora || fecha_hora.slice(0, 10) !== hoy) continue;
    out.push({
      rowIndex: i + 2,
      evidencia_id: norm(r[0]),
      telefono: norm(r[1]),
      fecha_hora,
      tipo_evento: norm(r[3]),
      origen: norm(r[4]),
      visita_id: norm(r[6]),
      url_foto: norm(r[7]),
      riesgo: upper(r[12] || "BAJO"),
      marca_id: norm(r[13]),
      producto_id: norm(r[14]),
      tipo_evidencia: norm(r[15]),
      descripcion: norm(r[16]),
      // extras si existen:
      tienda_id: norm(r[17]),
      promotor_id: norm(r[18]),
      marca_nombre: norm(r[19]),
      fase: norm(r[20]),
      batch_id: norm(r[21]),
      seq: safeInt(r[22], 0),
      estatus: norm(r[23]),
      reemplazada_por: norm(r[24]),
      actualizado_en: norm(r[25]),
    });
  }
  return out;
}

// ==========================
// GRUPOS_CLIENTE (Supervisor envío)
// ==========================
async function getGruposClienteActivos() {
  const rows = await getSheetValues("GRUPOS_CLIENTE!A2:E");
  return rows
    .filter((r) => isTrue(r[4] ?? "TRUE"))
    .map((r) => ({
      grupo_id: norm(r[0]),
      nombre_grupo: norm(r[1]),
      cliente: norm(r[2]),
      telefonos: norm(r[3]).split(",").map(norm).filter(Boolean),
    }));
}

// ==========================
// Menús
// ==========================
function menuPromotor() {
  return (
    "👋 *Promobolsillo+*\n\n" +
    "1️⃣ Asistencia (entrada/salida) + fotos\n" +
    "2️⃣ Evidencias (marca → tipo → fotos)\n" +
    "3️⃣ Mis evidencias de hoy (ver / nota / anular / rehacer / reclasificar)\n" +
    "4️⃣ Resumen de mi día\n" +
    "5️⃣ Ayuda\n\n" +
    "Comandos: `menu`, `sup`, `ayuda`"
  );
}
function ayudaPromotor() {
  return (
    "🆘 *Ayuda Promotor*\n\n" +
    "Asistencia:\n" +
    "• Usa opción 1 para ver *tienda activa*, cambiar fotos y ver historial.\n\n" +
    "Evidencias:\n" +
    "• Opción 2 usa la *tienda activa* (entrada abierta).\n" +
    "• Si mandas más fotos de las necesarias, se ignoran extras.\n\n" +
    "Mis evidencias:\n" +
    "• `ver 2`, `nota 2 texto`, `anular 2`, `rehacer 2`, `reclasificar 2`"
  );
}
function menuSupervisor(nombre = "Supervisor") {
  return (
    `👋 *${nombre}* (Supervisor)\n\n` +
    "1️⃣ Evidencias hoy por promotor\n" +
    "2️⃣ Evidencias hoy MEDIO/ALTO\n" +
    "3️⃣ Ayuda\n\n" +
    "Comandos: `sup`, `menu`"
  );
}
function ayudaSupervisor() {
  return (
    "🆘 *Ayuda Supervisor*\n\n" +
    "En listados:\n" +
    "• `ver 2` (muestra la foto)\n" +
    "• `enviar 1,3,5`\n" +
    "• `enviar todas`\n"
  );
}

// ==========================
// PROMOTOR: Asistencia (HOME)
// ==========================
async function startAsistenciaHome(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ Tu número no aparece como promotor activo. Revisa PROMOTORES.";

  const tiendaMap = await getTiendaMap();
  const abiertas = await getOpenVisitsToday(prom.promotor_id);
  const visitasHoy = await getVisitsToday(prom.promotor_id);

  let tiendaActivaTxt = "Ninguna";
  let activa = null;
  if (abiertas.length === 1) {
    activa = abiertas[0];
    const t = tiendaMap[activa.tienda_id];
    tiendaActivaTxt = t ? t.nombre_tienda : activa.tienda_id;
  } else if (abiertas.length > 1) {
    tiendaActivaTxt = `Varias (${abiertas.length})`;
  }

  const cerradas = visitasHoy.filter(v => v.hora_fin).length;
  const abiertasCount = visitasHoy.filter(v => !v.hora_fin).length;

  await setSession(telefono, STATE_ASIS_HOME, {
    promotor_id: prom.promotor_id,
  });

  return (
    "🕒 *Asistencia (hoy)*\n\n" +
    `🏬 Tienda activa: *${tiendaActivaTxt}*\n` +
    `📌 Visitas hoy: ${visitasHoy.length} (abiertas ${abiertasCount}, cerradas ${cerradas})\n\n` +
    "1️⃣ Registrar *SALIDA* (tienda activa)\n" +
    "2️⃣ Ver fotos de asistencia (tienda activa)\n" +
    "3️⃣ Cambiar foto de *ENTRADA* (tienda activa)\n" +
    "4️⃣ Cambiar foto de *SALIDA* (tienda activa)\n" +
    "5️⃣ Registrar *ENTRADA* en otra tienda\n" +
    "6️⃣ Historial de asistencias (últimas 10)\n" +
    "7️⃣ Volver al menú"
  );
}

async function handleAsistencia(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) { await setSession(telefono, STATE_MENU, {}); return "⚠️ No estás como promotor activo."; }

  const tiendaMap = await getTiendaMap();

  if (estado === STATE_ASIS_HOME) {
    if (lower === "7") { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }

    const abiertas = await getOpenVisitsToday(prom.promotor_id);

    if (lower === "5") {
      // ENTRADA a otra tienda (lista + búsqueda)
      const asignadas = await getTiendasAsignadas(prom.promotor_id);
      const tiendas = asignadas.map(id => tiendaMap[id]).filter(t => t && t.activa);

      await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA_ENTRADA, {
        promotor_id: prom.promotor_id,
        tiendas,
        filtro: "",
      });

      let msg = "🏬 *Entrada* – Elige tienda (puedes escribir parte del nombre para buscar):\n\n";
      tiendas.slice(0, 15).forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena}${t.ciudad ? " (" + t.ciudad + ")" : ""}\n`;
      });
      msg += "\nResponde con número o escribe texto para buscar.";
      return msg;
    }

    if (lower === "6") {
      const rows = await getSheetValues("VISITAS!A2:F");
      const out = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (norm(r[1]) !== prom.promotor_id) continue;
        out.push({
          visita_id: norm(r[0]),
          tienda_id: norm(r[2]),
          fecha: norm(r[3]),
          hora_inicio: norm(r[4]),
          hora_fin: norm(r[5]),
        });
        if (out.length >= 10) break;
      }

      await setSession(telefono, STATE_ASIS_HIST, { listado: out });

      let msg = "📚 *Historial de asistencias (últimas 10)*\n\n";
      out.forEach((v, idx) => {
        const t = tiendaMap[v.tienda_id];
        const tn = t ? t.nombre_tienda : v.tienda_id;
        const ent = v.hora_inicio ? v.hora_inicio.substring(11, 16) : "—";
        const sal = v.hora_fin ? v.hora_fin.substring(11, 16) : "—";
        msg += `${idx + 1}) ${v.fecha} – ${tn} – ${ent}–${sal}\n`;
      });
      msg += "\nComando: `veras 3` para ver fotos de esa asistencia.\n`menu` para salir.";
      return msg;
    }

    // opciones que requieren tienda activa (si hay varias activas, pedimos escoger)
    if (["1","2","3","4"].includes(lower)) {
      if (!abiertas.length) {
        return "⚠️ No tienes tienda activa (sin ENTRADA). Usa opción 5️⃣ para registrar entrada.";
      }
      if (abiertas.length > 1) {
        // pide elegir cuál visita activa
        let msg = "⚠️ Tienes varias tiendas activas. Escribe `veras N` desde Historial (opción 6) para elegir una visita.\n";
        msg += "Tip: cierra una por una con SALIDA para evitar duplicados.";
        return msg;
      }
      const activa = abiertas[0];

      if (lower === "1") {
        // SALIDA
        const t = tiendaMap[activa.tienda_id];
        await setSession(telefono, STATE_ASIS_CONFIRMAR_SALIDA, {
          promotor_id: prom.promotor_id,
          visita_id: activa.visita_id,
          tienda_id: activa.tienda_id,
          tienda_nombre: t ? t.nombre_tienda : activa.tienda_id,
        });
        return `🚪 *Salida* – ${t ? t.nombre_tienda : activa.tienda_id}\n\n1️⃣ Continuar\n2️⃣ Cancelar`;
      }

      if (lower === "2") {
        const fotos = await getAsistenciaFotosByVisita(activa.visita_id);
        const t = tiendaMap[activa.tienda_id];
        const tn = t ? t.nombre_tienda : activa.tienda_id;
        const medias = [];
        if (fotos.entrada) medias.push(fotos.entrada);
        if (fotos.salida) medias.push(fotos.salida);
        if (!medias.length) return `📭 Aún no tengo fotos registradas para asistencia en ${tn}.`;
        return { text: `📷 *Fotos asistencia* – ${tn}\n(entrada y/o salida)`, mediaUrl: medias.slice(0, 2) };
      }

      if (lower === "3" || lower === "4") {
        const tipo = lower === "3" ? "ASISTENCIA_ENTRADA" : "ASISTENCIA_SALIDA";
        const t = tiendaMap[activa.tienda_id];
        await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, {
          promotor_id: prom.promotor_id,
          visita_id: activa.visita_id,
          tienda_id: activa.tienda_id,
          tienda_nombre: t ? t.nombre_tienda : activa.tienda_id,
          tipo_evento: tipo,
        });
        return `🔁 *Cambiar foto* (${tipo === "ASISTENCIA_ENTRADA" ? "ENTRADA" : "SALIDA"}) – ${t ? t.nombre_tienda : activa.tienda_id}\n📸 Envía la nueva foto.`;
      }
    }

    return await startAsistenciaHome(telefono);
  }

  if (estado === STATE_ASIS_ELEGIR_TIENDA_ENTRADA) {
    const tiendas = data.tiendas || [];
    const q = norm(text);
    // si no es número -> búsqueda
    const nTry = parseInt(q, 10);
    if (Number.isNaN(nTry)) {
      const needle = q.toLowerCase();
      const filtradas = tiendas.filter(t =>
        (t.nombre_tienda || "").toLowerCase().includes(needle) ||
        (t.cadena || "").toLowerCase().includes(needle) ||
        (t.ciudad || "").toLowerCase().includes(needle)
      );
      if (!filtradas.length) return "⚠️ No encontré coincidencias. Escribe otro texto o `menu`.";
      await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA_ENTRADA, { ...data, filtro: needle, filtradas });

      let msg = "🔎 Resultados:\n\n";
      filtradas.slice(0, 15).forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena}${t.ciudad ? " (" + t.ciudad + ")" : ""}\n`;
      });
      msg += "\nResponde con número.";
      return msg;
    }

    const listado = data.filtradas || tiendas;
    const n = safeInt(q, -1);
    if (n < 1 || n > Math.min(15, listado.length)) return "⚠️ Elige un número válido.";
    const tienda = listado[n - 1];

    // Si ya tiene una visita abierta en esa tienda hoy, no crear nueva
    const open = await findOpenVisit(prom.promotor_id, tienda.tienda_id);
    if (open) return "⚠️ Ya tienes una ENTRADA abierta en esa tienda. Registra SALIDA desde Asistencia.";

    await setSession(telefono, STATE_ASIS_CONFIRMAR_ENTRADA, {
      promotor_id: prom.promotor_id,
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
    });
    return `🕒 *Entrada* – ${tienda.nombre_tienda}\n\n1️⃣ Continuar\n2️⃣ Cancelar`;
  }

  if (estado === STATE_ASIS_CONFIRMAR_ENTRADA) {
    if (lower === "2") { await setSession(telefono, STATE_ASIS_HOME, {}); return await startAsistenciaHome(telefono); }
    if (lower !== "1") return "Responde 1 o 2.";
    await setSession(telefono, STATE_ASIS_FOTO, { ...data, accion: "ENTRADA" });
    return `📸 Envía foto de *ENTRADA* – ${data.tienda_nombre}`;
  }

  if (estado === STATE_ASIS_CONFIRMAR_SALIDA) {
    if (lower === "2") { await setSession(telefono, STATE_ASIS_HOME, {}); return await startAsistenciaHome(telefono); }
    if (lower !== "1") return "Responde 1 o 2.";
    await setSession(telefono, STATE_ASIS_FOTO, { ...data, accion: "SALIDA" });
    return `📸 Envía foto de *SALIDA* – ${data.tienda_nombre}`;
  }

  if (estado === STATE_ASIS_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito una foto. Adjunta una foto y reenvía.";
    const fotoUrl = inbound?.MediaUrl0 || "";
    await setSession(telefono, STATE_ASIS_UBI, { ...data, fotoUrl });
    return "✅ Foto recibida.\n📍 Ahora comparte ubicación (Share location).";
  }

  if (estado === STATE_ASIS_UBI) {
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    if (!lat || !lon) return "Necesito tu ubicación (Share location).";

    if (data.accion === "ENTRADA") {
      const visita_id = await createVisit(data.promotor_id, data.tienda_id);

      await registrarEvidencia({
        evidencia_id: `EV-${Date.now()}-1`,
        telefono,
        tipo_evento: "ASISTENCIA_ENTRADA",
        origen: "ASISTENCIA",
        visita_id,
        url_foto: data.fotoUrl,
        lat, lon,
        tienda_id: data.tienda_id,
        promotor_id: data.promotor_id,
        tipo_evidencia: "ASISTENCIA",
        descripcion: "",
        estatus: "ACTIVA",
      });

      await setSession(telefono, STATE_ASIS_HOME, {});
      return `✅ Entrada registrada – *${data.tienda_nombre}*\n\n` + (await startAsistenciaHome(telefono));
    }

    // SALIDA
    await closeVisitById(data.visita_id);

    await registrarEvidencia({
      evidencia_id: `EV-${Date.now()}-1`,
      telefono,
      tipo_evento: "ASISTENCIA_SALIDA",
      origen: "ASISTENCIA",
      visita_id: data.visita_id,
      url_foto: data.fotoUrl,
      lat, lon,
      tienda_id: data.tienda_id,
      promotor_id: data.promotor_id,
      tipo_evidencia: "ASISTENCIA",
      descripcion: "",
      estatus: "ACTIVA",
    });

    await setSession(telefono, STATE_ASIS_HOME, {});
    return `✅ Salida registrada – *${data.tienda_nombre}*\n\n` + (await startAsistenciaHome(telefono));
  }

  if (estado === STATE_ASIS_HIST) {
    const listado = data.listado || [];
    if (lower.startsWith("veras")) {
      const n = safeInt(lower.replace("veras", "").trim(), -1);
      if (n < 1 || n > listado.length) return "⚠️ Usa `veras 1`..";
      const v = listado[n - 1];
      const t = tiendaMap[v.tienda_id];
      const tn = t ? t.nombre_tienda : v.tienda_id;
      const fotos = await getAsistenciaFotosByVisita(v.visita_id);
      const medias = [];
      if (fotos.entrada) medias.push(fotos.entrada);
      if (fotos.salida) medias.push(fotos.salida);
      if (!medias.length) return `📭 No hay fotos de asistencia para ${tn}.`;
      return { text: `📷 *Asistencia* – ${tn}\n${v.fecha} (${v.hora_inicio?.substring(11,16) || "—"}–${v.hora_fin?.substring(11,16) || "—"})`, mediaUrl: medias.slice(0,2) };
    }
    return "Comando: `veras N` o `menu`.";
  }

  if (estado === STATE_ASIS_CAMBIAR_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito que envíes la nueva foto.";
    const newUrl = inbound?.MediaUrl0 || "";
    const tipo = data.tipo_evento;

    // Marcar la anterior como reemplazada si existe
    const prev = await findLastEvidenceRowIndexForAsistencia(data.visita_id, tipo);
    const newEvidenceId = `EV-${Date.now()}-1`;

    if (prev) {
      await updateRowCellsByHeaders("EVIDENCIAS", prev.rowIndex, {
        estatus: "REEMPLAZADA",
        reemplazada_por: newEvidenceId,
        actualizado_en: nowISO(),
        descripcion: `[REEMPLAZADA→${newEvidenceId}]`,
      });
    }

    // Crear nueva fila (corrección)
    await registrarEvidencia({
      evidencia_id: newEvidenceId,
      telefono,
      tipo_evento: tipo,
      origen: "ASISTENCIA",
      visita_id: data.visita_id,
      url_foto: newUrl,
      lat: "", lon: "",
      tienda_id: data.tienda_id,
      promotor_id: data.promotor_id,
      tipo_evidencia: "ASISTENCIA",
      descripcion: `[CORRECCION_${tipo}]`,
      estatus: "ACTIVA",
    });

    await setSession(telefono, STATE_ASIS_HOME, {});
    return `✅ Foto actualizada (${tipo === "ASISTENCIA_ENTRADA" ? "ENTRADA" : "SALIDA"}) – ${data.tienda_nombre}\n\n` + (await startAsistenciaHome(telefono));
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// PROMOTOR: Evidencias (tienda activa → marca → tipo → fotos)
// ==========================
async function startEvidencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ Tu número no aparece como promotor activo. Revisa PROMOTORES.";

  const abiertas = await getOpenVisitsToday(prom.promotor_id);
  const tiendaMap = await getTiendaMap();

  if (!abiertas.length) return "⚠️ No hay tienda activa (sin ENTRADA). Primero registra ENTRADA.";

  if (abiertas.length > 1) {
    const opciones = abiertas.map(v => ({
      visita_id: v.visita_id,
      tienda_id: v.tienda_id,
      tienda_nombre: tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id,
    }));
    await setSession(telefono, STATE_EVID_ELEGIR_VISITA, { promotor_id: prom.promotor_id, opciones });
    let msg = "🏬 Tienes *más de una tienda activa*. Elige una:\n\n";
    opciones.slice(0,10).forEach((o, i) => msg += `${i+1}) ${o.tienda_nombre}\n`);
    msg += "\nResponde con el número.";
    return msg;
  }

  const v = abiertas[0];
  const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;
  return await goToMarcas(telefono, prom.promotor_id, v.visita_id, v.tienda_id, tn);
}

async function goToMarcas(telefono, promotor_id, visita_id, tienda_id, tienda_nombre) {
  const marcas = await getMarcasActivas();
  if (!marcas.length) return "⚠️ No hay marcas activas en MARCAS.";

  await setSession(telefono, STATE_EVID_ELEGIR_MARCA, {
    promotor_id, visita_id, tienda_id, tienda_nombre, marcas,
  });

  let msg = `🏬 *${tienda_nombre}*\n🏷️ Selecciona *marca*:\n\n`;
  marcas.slice(0, 15).forEach((m, idx) => msg += `${idx+1}) ${m.marca_nombre}\n`);
  msg += "\nResponde con el número.";
  return msg;
}

async function handleEvidencias(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_EVID_ELEGIR_VISITA) {
    const opciones = data.opciones || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(10, opciones.length)) return "⚠️ Elige un número válido.";
    const o = opciones[n - 1];
    return await goToMarcas(telefono, data.promotor_id, o.visita_id, o.tienda_id, o.tienda_nombre);
  }

  if (estado === STATE_EVID_ELEGIR_MARCA) {
    const marcas = data.marcas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(15, marcas.length)) return "⚠️ Elige un número válido.";
    const marca = marcas[n - 1];

    const reglas = await getReglasPorMarca(marca.marca_id);
    if (!reglas.length) return `⚠️ No hay reglas activas para *${marca.marca_nombre}*.`;

    await setSession(telefono, STATE_EVID_ELEGIR_TIPO, { ...data, marca_id: marca.marca_id, marca_nombre: marca.marca_nombre, reglas });

    let msg = `🏷️ Marca: *${marca.marca_nombre}*\n\n🧾 Tipo de evidencia:\n\n`;
    reglas.forEach((r, i) => msg += `${i+1}) ${r.tipo_evidencia} (fotos: ${r.fotos_requeridas}${r.requiere_antes_despues ? ", antes/después" : ""})\n`);
    msg += "\nResponde con el número.";
    return msg;
  }

  if (estado === STATE_EVID_ELEGIR_TIPO) {
    const reglas = data.reglas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > reglas.length) return "⚠️ Elige un número válido.";
    const regla = reglas[n - 1];

    if (regla.requiere_antes_despues) {
      await setSession(telefono, STATE_EVID_ELEGIR_FASE, { ...data, regla });
      return `🧾 *${regla.tipo_evidencia}*\n1️⃣ ANTES\n2️⃣ DESPUÉS\n\nResponde 1 o 2.`;
    }

    const batch_id = "B-" + Date.now();
    await setSession(telefono, STATE_EVID_FOTOS, {
      ...data,
      regla,
      fase: "NA",
      batch_id,
      fotos_requeridas: regla.fotos_requeridas,
      fotos_recibidas: 0,
    });

    return `📸 Envía *${regla.fotos_requeridas}* foto(s) (puedes seleccionar varias en un solo mensaje).`;
  }

  if (estado === STATE_EVID_ELEGIR_FASE) {
    if (lower !== "1" && lower !== "2") return "Responde 1 (ANTES) o 2 (DESPUÉS).";
    const fase = lower === "1" ? "ANTES" : "DESPUES";
    const batch_id = "B-" + Date.now();

    await setSession(telefono, STATE_EVID_FOTOS, {
      ...data,
      fase,
      batch_id,
      fotos_requeridas: data.regla.fotos_requeridas,
      fotos_recibidas: 0,
    });

    return `📸 Envía *${data.regla.fotos_requeridas}* foto(s) para fase *${fase}* (en un solo mensaje si puedes).`;
  }

  if (estado === STATE_EVID_FOTOS) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito que envíes foto(s).";

    const needed = data.fotos_requeridas || 1;
    const already = data.fotos_recibidas || 0;
    const remaining = Math.max(0, needed - already);

    // Aceptamos solo lo que falta
    const accepted = Math.min(numMedia, remaining);
    const ignored = Math.max(0, numMedia - accepted);

    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    const descripcion = norm(inbound?.Body || "");

    // Guardar solo accepted
    for (let i = 0; i < accepted; i++) {
      const url = inbound?.[`MediaUrl${i}`] || "";
      if (!url) continue;

      await registrarEvidencia({
        evidencia_id: `EV-${Date.now()}-${already + i + 1}`,
        telefono,
        tipo_evento: `EVIDENCIA_${upper(data.regla.tipo_evidencia).replace(/\W+/g, "_")}`,
        origen: "EVIDENCIA",
        visita_id: data.visita_id,
        url_foto: url,
        lat, lon,
        tienda_id: data.tienda_id,
        promotor_id: data.promotor_id,
        marca_id: data.marca_id,
        marca_nombre: data.marca_nombre,
        tipo_evidencia: data.regla.tipo_evidencia,
        fase: data.fase || "NA",
        batch_id: data.batch_id,
        seq: already + i + 1,
        descripcion,
        estatus: "ACTIVA",
      });
    }

    const newCount = already + accepted;

    if (newCount < needed) {
      await setSession(telefono, STATE_EVID_FOTOS, { ...data, fotos_recibidas: newCount });

      const faltan = needed - newCount;
      return (
        `✅ Recibí *${accepted}* foto(s).` +
        (ignored ? ` (Ignoré ${ignored} extra.)` : "") +
        `\n📌 Faltan *${faltan}* foto(s) para completar. Envía las restantes.`
      );
    }

    await setSession(telefono, STATE_MENU, {});
    return (
      `✅ Evidencia completada (${needed} foto(s)).` +
      (ignored ? ` (Ignoré ${ignored} extra.)` : "") +
      `\n🏷️ ${data.marca_nombre} – ${data.regla.tipo_evidencia}` +
      (data.fase && data.fase !== "NA" ? ` (${data.fase})` : "") +
      "\n\n" + menuPromotor()
    );
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// PROMOTOR: Resumen día
// ==========================
async function resumenDia(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const visitas = await getVisitsToday(prom.promotor_id);
  const abiertas = visitas.filter(v => !v.hora_fin);
  const cerradas = visitas.filter(v => v.hora_fin);

  const evid = await getEvidenciasHoyDelPromotor(telefono);
  const evEvid = evid.filter(e => upper(e.origen) === "EVIDENCIA");
  const evAsis = evid.filter(e => upper(e.origen) === "ASISTENCIA");

  // Conteo por marca_nombre si existe, si no por tipo_evento
  const by = {};
  for (const e of evEvid) {
    const k = e.marca_nombre || e.tipo_evidencia || e.tipo_evento || "EVIDENCIA";
    by[k] = (by[k] || 0) + 1;
  }

  let msg = "📊 *Resumen de mi día (hoy)*\n\n";
  msg += `🕒 Visitas: ${visitas.length} (abiertas ${abiertas.length}, cerradas ${cerradas.length})\n`;
  if (abiertas.length === 1) {
    const t = tiendaMap[abiertas[0].tienda_id];
    msg += `🏬 Tienda activa: *${t ? t.nombre_tienda : abiertas[0].tienda_id}*\n`;
  } else if (abiertas.length > 1) {
    msg += `🏬 Tiendas activas: *${abiertas.length}* (revisa Asistencia)\n`;
  } else {
    msg += "🏬 Tienda activa: —\n";
  }

  msg += `📸 Evidencias: ${evEvid.length}\n`;
  msg += `🧾 Asistencia (fotos): ${evAsis.length}\n\n`;

  const keys = Object.keys(by);
  if (keys.length) {
    msg += "🏷️ Evidencias por marca/tipo:\n";
    keys.slice(0, 8).forEach(k => msg += `• ${k}: ${by[k]}\n`);
    if (keys.length > 8) msg += `• (+${keys.length - 8} más)\n`;
  } else {
    msg += "🏷️ Evidencias por marca/tipo: —\n";
  }

  msg += "\nEscribe `menu` para continuar.";
  return msg;
}

// ==========================
// PROMOTOR: Mis evidencias (lista + fotos + modificar)
// ==========================
async function startMyEvidencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const raw = await getEvidenciasHoyDelPromotor(telefono);
  const mine = raw.filter(e => upper(e.origen) === "EVIDENCIA");

  if (!mine.length) return "📭 Hoy aún no tienes evidencias. Registra en opción 2️⃣.";

  const groups = {};
  for (const e of mine) {
    const key = e.batch_id || e.evidencia_id;
    if (!groups[key]) {
      groups[key] = {
        key,
        batch_id: e.batch_id || "",
        visita_id: e.visita_id,
        tienda_id: e.tienda_id || "",
        tienda_nombre: e.tienda_id ? (tiendaMap[e.tienda_id]?.nombre_tienda || e.tienda_id) : "",
        marca_nombre: e.marca_nombre || "",
        tipo_evidencia: e.tipo_evidencia || e.tipo_evento,
        fase: e.fase || "NA",
        riesgo: e.riesgo,
        rows: [],
        urls: [],
        descripcion: e.descripcion || "",
      };
    }
    const g = groups[key];
    g.riesgo = maxRiesgo(g.riesgo, e.riesgo);
    if (e.descripcion) g.descripcion = e.descripcion;
    g.rows.push({ rowIndex: e.rowIndex, evidencia_id: e.evidencia_id });
    if (e.url_foto) g.urls.push(e.url_foto);
  }

  const listado = Object.values(groups).slice(0, 15);
  await setSession(telefono, STATE_MY_EVID_LIST, { listado });

  let msg = "📚 *Mis evidencias de hoy* (agrupadas)\n\n";
  listado.forEach((g, idx) => {
    const faseTxt = g.fase && g.fase !== "NA" ? ` (${g.fase})` : "";
    msg += `${idx + 1}) ${g.tipo_evidencia}${faseTxt} – ${g.marca_nombre || ""} – ${g.tienda_nombre || ""} – ${g.urls.length} foto(s) – ${g.riesgo}\n`;
  });

  msg +=
    "\nComandos:\n" +
    "• `ver 2` (hasta 5 fotos)\n" +
    "• `nota 2 texto...`\n" +
    "• `anular 2`\n" +
    "• `rehacer 2`\n" +
    "• `reclasificar 2`\n" +
    "• `menu`";

  return msg;
}

async function handleMyEvidencias(telefono, estado, text, data, inbound) {
  const t = norm(text);
  const lower = t.toLowerCase();
  const listado = data.listado || [];

  function cmd(name) {
    if (!lower.startsWith(name)) return null;
    return t.slice(name.length).trim();
  }

  if (estado === STATE_MY_EVID_LIST) {
    const ver = cmd("ver");
    if (ver) {
      const n = safeInt(ver, -1);
      if (n < 1 || n > listado.length) return "⚠️ Usa `ver 1`..";
      const g = listado[n - 1];
      const mediaUrls = (g.urls || []).slice(0, 5);
      if (!mediaUrls.length) return "📭 No hay fotos en este paquete.";
      const caption =
        `🧾 *Evidencia ${n}*\n` +
        (g.tienda_nombre ? `🏬 ${g.tienda_nombre}\n` : "") +
        (g.marca_nombre ? `🏷️ ${g.marca_nombre}\n` : "") +
        `🧾 ${g.tipo_evidencia}${g.fase && g.fase !== "NA" ? " (" + g.fase + ")" : ""}\n` +
        `📸 ${g.urls.length} foto(s) | ⚠️ ${g.riesgo}\n` +
        (g.descripcion ? `💬 ${g.descripcion}\n` : "");
      return { text: caption, mediaUrl: mediaUrls };
    }

    const nota = cmd("nota");
    if (nota) {
      const parts = nota.split(" ");
      const n = safeInt(parts[0], -1);
      const newText = nota.slice(parts[0].length).trim();
      if (n < 1 || n > listado.length) return "⚠️ Usa `nota 2 texto...`";
      if (!newText) return "⚠️ Falta texto. Ej: `nota 2 Anaquel OK`";
      const g = listado[n - 1];
      for (const rr of g.rows || []) {
        await updateRowCellsByHeaders("EVIDENCIAS", rr.rowIndex, { descripcion: newText, actualizado_en: nowISO() });
      }
      g.descripcion = newText;
      await setSession(telefono, STATE_MY_EVID_LIST, { listado });
      return `✅ Nota actualizada en evidencia ${n}.`;
    }

    const anular = cmd("anular");
    if (anular) {
      const n = safeInt(anular, -1);
      if (n < 1 || n > listado.length) return "⚠️ Usa `anular 2`";
      const g = listado[n - 1];
      for (const rr of g.rows || []) {
        await updateRowCellsByHeaders("EVIDENCIAS", rr.rowIndex, {
          estatus: "ANULADA",
          actualizado_en: nowISO(),
          descripcion: `[ANULADA] ${g.descripcion || ""}`.trim(),
        });
      }
      return `✅ Evidencia ${n} marcada como ANULADA.`;
    }

    const rehacer = cmd("rehacer");
    if (rehacer) {
      const n = safeInt(rehacer, -1);
      if (n < 1 || n > listado.length) return "⚠️ Usa `rehacer 2`";
      const g = listado[n - 1];
      await setSession(telefono, STATE_MY_EVID_REHACER, { listado, idx: n - 1 });
      return `🔁 *Rehacer evidencia ${n}*\n📸 Envía las nuevas fotos (puedes mandar varias en un mensaje).`;
    }

    const reclas = cmd("reclasificar");
    if (reclas) {
      const n = safeInt(reclas, -1);
      if (n < 1 || n > listado.length) return "⚠️ Usa `reclasificar 2`";
      const g = listado[n - 1];

      // Elegir tienda de hoy (para evitar lista enorme)
      const prom = await getPromotorPorTelefono(telefono);
      const visitas = await getVisitsToday(prom.promotor_id);
      const tiendaMap = await getTiendaMap();
      const tiendasHoy = Array.from(new Set(visitas.map(v => v.tienda_id))).map(id => ({
        tienda_id: id,
        nombre: tiendaMap[id]?.nombre_tienda || id,
      }));

      if (!tiendasHoy.length) return "⚠️ No tienes visitas hoy. No puedo reclasificar tienda.";

      await setSession(telefono, STATE_MY_EVID_RECLASIFICAR_TIENDA, {
        listado,
        idx: n - 1,
        tiendasHoy,
      });

      let msg = `🏬 *Reclasificar evidencia ${n}* – elige tienda:\n\n`;
      tiendasHoy.slice(0, 10).forEach((x, i) => msg += `${i+1}) ${x.nombre}\n`);
      msg += "\nResponde con el número.";
      return msg;
    }

    return "Usa `ver N`, `nota N texto`, `anular N`, `rehacer N`, `reclasificar N` o `menu`.";
  }

  if (estado === STATE_MY_EVID_REHACER) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito foto(s) para rehacer.";
    const toProcess = Math.min(numMedia, 10);

    const prom = await getPromotorPorTelefono(telefono);
    const listado = data.listado || [];
    const g = listado[data.idx];
    if (!g) { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }

    const newBatch = "B-" + Date.now();
    const descripcion = norm(inbound?.Body || "");

    for (let i = 0; i < toProcess; i++) {
      const url = inbound?.[`MediaUrl${i}`] || "";
      if (!url) continue;
      await registrarEvidencia({
        evidencia_id: `EV-${Date.now()}-${i+1}`,
        telefono,
        tipo_evento: `EVIDENCIA_${upper(g.tipo_evidencia).replace(/\W+/g,"_")}`,
        origen: "EVIDENCIA",
        visita_id: g.visita_id,
        url_foto: url,
        tienda_id: g.tienda_id,
        promotor_id: prom?.promotor_id || "",
        marca_nombre: g.marca_nombre || "",
        tipo_evidencia: g.tipo_evidencia,
        fase: g.fase || "NA",
        batch_id: newBatch,
        seq: i+1,
        descripcion,
        estatus: "ACTIVA",
      });
    }

    // marcar anterior como reemplazado
    for (const rr of g.rows || []) {
      await updateRowCellsByHeaders("EVIDENCIAS", rr.rowIndex, {
        estatus: "REEMPLAZADA",
        reemplazada_por: newBatch,
        actualizado_en: nowISO(),
        descripcion: `[REEMPLAZADA→${newBatch}] ${g.descripcion || ""}`.trim(),
      });
    }

    await setSession(telefono, STATE_MENU, {});
    return `✅ Evidencia rehecha. Nuevo batch ${newBatch} (${toProcess} foto(s)).\n\n` + menuPromotor();
  }

  if (estado === STATE_MY_EVID_RECLASIFICAR_TIENDA) {
    const tiendasHoy = data.tiendasHoy || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(10, tiendasHoy.length)) return "⚠️ Elige un número válido.";
    const tiendaSel = tiendasHoy[n - 1];

    // Elegir marca (rápido: lista primeras 15)
    const marcas = await getMarcasActivas();
    await setSession(telefono, STATE_MY_EVID_RECLASIFICAR_MARCA, {
      ...data,
      tiendaSel,
      marcas,
    });

    let msg = `🏷️ Reclasificar – elige marca:\n\n`;
    marcas.slice(0, 15).forEach((m, i) => msg += `${i+1}) ${m.marca_nombre}\n`);
    msg += "\nResponde con el número.";
    return msg;
  }

  if (estado === STATE_MY_EVID_RECLASIFICAR_MARCA) {
    const marcas = data.marcas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(15, marcas.length)) return "⚠️ Elige un número válido.";
    const marcaSel = marcas[n - 1];

    const listado = data.listado || [];
    const g = listado[data.idx];
    if (!g) { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }

    for (const rr of g.rows || []) {
      await updateRowCellsByHeaders("EVIDENCIAS", rr.rowIndex, {
        tienda_id: data.tiendaSel?.tienda_id || "",
        marca_id: marcaSel.marca_id,
        marca_nombre: marcaSel.marca_nombre,
        actualizado_en: nowISO(),
        descripcion: `[RECLASIFICADA] ${g.descripcion || ""}`.trim(),
      });
    }

    await setSession(telefono, STATE_MENU, {});
    return `✅ Evidencia reclasificada a tienda "${data.tiendaSel?.nombre}" y marca "${marcaSel.marca_nombre}".\n\n` + menuPromotor();
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// SUPERVISOR (simple)
// ==========================
async function getEvidenciasHoyForSupervisor() {
  const rows = await getSheetValues("EVIDENCIAS!A2:V");
  const hoy = todayISO();
  return rows
    .filter(r => norm(r[2]) && norm(r[2]).slice(0,10) === hoy && upper(r[4]) === "EVIDENCIA")
    .map(r => ({
      evidencia_id: norm(r[0]),
      telefono: norm(r[1]),
      fecha_hora: norm(r[2]),
      tipo_evento: norm(r[3]),
      origen: norm(r[4]),
      visita_id: norm(r[6]),
      url_foto: norm(r[7]),
      riesgo: upper(r[12] || "BAJO"),
      marca_nombre: norm(r[19]) || "",  // si existe
      tipo_evidencia: norm(r[15]) || norm(r[3]),
      fase: norm(r[20]) || "NA",
      descripcion: norm(r[16]) || "",
      tienda_id: norm(r[17]) || "",
    }));
}

async function enviarFotoAGrupoCliente(ev, grupo, tiendaMap) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) return { ok: false, enviados: 0 };

  const t = ev.tienda_id ? tiendaMap[ev.tienda_id] : null;
  const tn = t ? `${t.nombre_tienda}${t.ciudad ? " (" + t.ciudad + ")" : ""}` : "";

  const body =
    "🏪 *Evidencia*\n" +
    (grupo.cliente ? `👤 Cliente: ${grupo.cliente}\n` : "") +
    (ev.marca_nombre ? `🏷️ Marca: ${ev.marca_nombre}\n` : "") +
    (tn ? `🏬 Tienda: ${tn}\n` : "") +
    (ev.tipo_evidencia ? `🧾 Tipo: ${ev.tipo_evidencia}\n` : "") +
    (ev.fase && ev.fase !== "NA" ? `🔁 Fase: ${ev.fase}\n` : "") +
    (ev.fecha_hora ? `📅 ${ev.fecha_hora}\n` : "") +
    `🧠 Riesgo: ${ev.riesgo}\n` +
    (ev.descripcion ? `💬 ${ev.descripcion}\n` : "");

  let enviados = 0;
  for (const to of grupo.telefonos) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to,
        body,
        mediaUrl: ev.url_foto ? [ev.url_foto] : undefined,
      });
      enviados++;
    } catch (e) {
      console.error("Error enviando:", to, e?.message || e);
    }
  }
  return { ok: enviados > 0, enviados };
}

async function handleSupervisor(telefono, estado, text, data) {
  const lower = norm(text).toLowerCase();
  const sup = await getSupervisorPorTelefono(telefono);
  if (!sup) { await setSession(telefono, STATE_MENU, {}); return "⚠️ No eres supervisor activo."; }

  if (lower === "menu") { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }
  if (lower === "sup") { await setSession(telefono, STATE_SUP_MENU, {}); return menuSupervisor(sup.nombre || "Supervisor"); }
  if (lower === "ayuda") return ayudaSupervisor();

  if (estado === STATE_SUP_MENU) {
    if (lower === "1") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      const evs = await getEvidenciasHoyForSupervisor();
      const counts = {};
      evs.forEach(e => counts[e.telefono] = (counts[e.telefono] || 0) + 1);

      let msg = "👀 *Evidencias hoy por promotor*\n\n";
      equipo.forEach((p, idx) => msg += `${idx+1}) ${p.nombre} – ${(counts[p.telefono] || 0)}\n`);
      msg += "\nResponde con el número del promotor.";
      await setSession(telefono, STATE_SUP_PROMOTOR_LIST, { equipo });
      return msg;
    }

    if (lower === "2") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      const telSet = new Set(equipo.map(p => p.telefono));
      const telName = {};
      equipo.forEach(p => telName[p.telefono] = p.nombre);

      const evs = (await getEvidenciasHoyForSupervisor())
        .filter(e => telSet.has(e.telefono) && (e.riesgo === "MEDIO" || e.riesgo === "ALTO"))
        .map(e => ({ ...e, promotor_nombre: telName[e.telefono] || e.telefono }));

      if (!evs.length) return "🧠📸 No hay evidencias MEDIO/ALTO hoy.";

      let msg = "🧠📸 *Evidencias MEDIO/ALTO (hoy)*\n\n";
      evs.forEach((e, i) => msg += `${i+1}) ${e.tipo_evidencia} – ${e.marca_nombre || ""} – ${e.promotor_nombre} – ${e.riesgo}\n`);
      msg += "\nComandos: `ver 2`, `enviar 1,3`, `enviar todas`, `sup`";

      await setSession(telefono, STATE_SUP_FOTOS_LIST, { listado: evs });
      return msg;
    }

    if (lower === "3") return ayudaSupervisor();
    return menuSupervisor(sup.nombre || "Supervisor");
  }

  if (estado === STATE_SUP_PROMOTOR_LIST) {
    const equipo = data.equipo || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > equipo.length) return "⚠️ Número inválido.";
    const p = equipo[n - 1];

    const evs = (await getEvidenciasHoyForSupervisor())
      .filter(e => e.telefono === p.telefono)
      .map(e => ({ ...e, promotor_nombre: p.nombre }));

    if (!evs.length) { await setSession(telefono, STATE_SUP_MENU, {}); return `⚠️ No hay evidencias hoy para ${p.nombre}.\n\n` + menuSupervisor(sup.nombre); }

    let msg = `📷 *Evidencias de hoy – ${p.nombre}*\n\n`;
    evs.forEach((e, i) => msg += `${i+1}) ${e.tipo_evidencia} – ${e.marca_nombre || ""} – ${e.riesgo}\n`);
    msg += "\nComandos: `ver 1`, `enviar 1,3`, `enviar todas`, `sup`";

    await setSession(telefono, STATE_SUP_FOTOS_LIST, { listado: evs });
    return msg;
  }

  if (estado === STATE_SUP_FOTOS_LIST) {
    const listado = data.listado || [];

    const verMatch = lower.match(/^ver\s+(\d+)/);
    if (verMatch) {
      const idx = safeInt(verMatch[1], 0) - 1;
      if (idx < 0 || idx >= listado.length) return "⚠️ Número inválido.";
      const e = listado[idx];
      return { text: `🧾 *Detalle #${idx+1}*\n🧾 ${e.tipo_evidencia}\n🏷️ ${e.marca_nombre || ""}\n⚠️ ${e.riesgo}\n${e.descripcion ? "💬 "+e.descripcion : ""}`, mediaUrl: e.url_foto || null };
    }

    if (lower.startsWith("enviar")) {
      let resto = lower.replace(/^enviar\s*/, "").trim();
      if (!resto) return "⚠️ Usa `enviar 1,3` o `enviar todas`.";

      let seleccionadas = [];
      if (resto === "todas" || resto === "todos") {
        seleccionadas = listado.slice();
      } else {
        const partes = resto.split(/[, ]+/).map(p => p.trim()).filter(Boolean);
        const idxs = [];
        for (const p of partes) {
          const n = safeInt(p, -1);
          if (n < 1 || n > listado.length) return "⚠️ Número fuera de rango.";
          idxs.push(n-1);
        }
        seleccionadas = Array.from(new Set(idxs)).map(i => listado[i]);
      }

      const grupos = await getGruposClienteActivos();
      if (!grupos.length) return "⚠️ No hay grupos activos en GRUPOS_CLIENTE.";

      let msg = `📤 Vas a enviar *${seleccionadas.length}* evidencia(s).\n\nElige grupo:\n`;
      grupos.forEach((g, i) => msg += `${i+1}) ${g.nombre_grupo}\n`);
      msg += "\nResponde con el número o escribe `sup` para cancelar.";

      await setSession(telefono, STATE_SUP_ELEGIR_GRUPO, { seleccionadas, grupos });
      return msg;
    }

    await setSession(telefono, STATE_SUP_MENU, {});
    return menuSupervisor(sup.nombre || "Supervisor");
  }

  if (estado === STATE_SUP_ELEGIR_GRUPO) {
    if (lower === "sup" || lower === "cancelar") { await setSession(telefono, STATE_SUP_MENU, {}); return menuSupervisor(sup.nombre); }
    const n = safeInt(text, -1);
    const grupos = data.grupos || [];
    if (n < 1 || n > grupos.length) return "⚠️ Grupo inválido.";

    const grupo = grupos[n - 1];
    const tiendaMap = await getTiendaMap();

    let okCount = 0;
    for (const ev of (data.seleccionadas || [])) {
      const r = await enviarFotoAGrupoCliente(ev, grupo, tiendaMap);
      if (r.ok) okCount++;
    }
    await setSession(telefono, STATE_SUP_MENU, {});
    return `✅ Enviadas ${okCount} evidencia(s) a *${grupo.nombre_grupo}*.\n\n` + menuSupervisor(sup.nombre);
  }

  await setSession(telefono, STATE_SUP_MENU, {});
  return menuSupervisor(sup.nombre || "Supervisor");
}

// ==========================
// Router principal
// ==========================
async function handleIncoming(from, body, inbound) {
  const telefono = norm(from);
  const text = norm(body);
  const lower = text.toLowerCase();

  if (lower === "menu" || lower === "inicio") {
    await setSession(telefono, STATE_MENU, {});
    return menuPromotor();
  }
  if (lower === "ayuda" || lower === "help" || lower === "?") {
    const sup = await getSupervisorPorTelefono(telefono);
    return sup ? ayudaSupervisor() : ayudaPromotor();
  }
  if (lower === "sup") {
    const sup = await getSupervisorPorTelefono(telefono);
    if (!sup) return "⚠️ Tu número no está dado de alta como supervisor.";
    await setSession(telefono, STATE_SUP_MENU, {});
    return menuSupervisor(sup.nombre || "Supervisor");
  }

  const ses = await getSession(telefono);
  const estado = ses.estado_actual;
  const data = ses.data_json || {};

  // Supervisor states
  if ([STATE_SUP_MENU, STATE_SUP_PROMOTOR_LIST, STATE_SUP_FOTOS_LIST, STATE_SUP_ELEGIR_GRUPO].includes(estado)) {
    return await handleSupervisor(telefono, estado, text, data);
  }

  // Main menu
  if (estado === STATE_MENU) {
    if (lower === "1") { await setSession(telefono, STATE_ASIS_HOME, {}); return await startAsistenciaHome(telefono); }
    if (lower === "2") return await startEvidencias(telefono);
    if (lower === "3") return await startMyEvidencias(telefono);
    if (lower === "4") return await resumenDia(telefono);
    if (lower === "5") return ayudaPromotor();
    return menuPromotor();
  }

  // Asistencia flow
  if ([STATE_ASIS_HOME, STATE_ASIS_ELEGIR_TIENDA_ENTRADA, STATE_ASIS_CONFIRMAR_ENTRADA, STATE_ASIS_CONFIRMAR_SALIDA, STATE_ASIS_FOTO, STATE_ASIS_UBI, STATE_ASIS_HIST, STATE_ASIS_CAMBIAR_FOTO].includes(estado)) {
    return await handleAsistencia(telefono, estado, text, data, inbound);
  }

  // Evidencias flow
  if ([STATE_EVID_ELEGIR_VISITA, STATE_EVID_ELEGIR_MARCA, STATE_EVID_ELEGIR_TIPO, STATE_EVID_ELEGIR_FASE, STATE_EVID_FOTOS].includes(estado)) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
  }

  // Mis evidencias flow
  if ([STATE_MY_EVID_LIST, STATE_MY_EVID_REHACER, STATE_MY_EVID_RECLASIFICAR_TIENDA, STATE_MY_EVID_RECLASIFICAR_MARCA].includes(estado)) {
    return await handleMyEvidencias(telefono, estado, text, data, inbound);
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// Express routes
// ==========================
app.post("/whatsapp", async (req, res) => {
  const from = norm(req.body.From);
  const body = norm(req.body.Body);

  console.log("IN:", from, body, "NumMedia:", req.body.NumMedia);

  let respuesta;
  try {
    respuesta = await handleIncoming(from, body, req.body);
  } catch (e) {
    console.error("Error:", e?.message || e);
    respuesta = "Ocurrió un error procesando tu mensaje. Intenta de nuevo 🙏";
  }

  const twiml = new MessagingResponse();
  if (typeof respuesta === "string") {
    twiml.message(respuesta);
  } else if (respuesta && typeof respuesta === "object") {
    const msg = twiml.message(respuesta.text || "");
    if (respuesta.mediaUrl) {
      const arr = Array.isArray(respuesta.mediaUrl) ? respuesta.mediaUrl : [respuesta.mediaUrl];
      arr.filter(Boolean).forEach(u => msg.media(u));
    }
  } else {
    twiml.message("Ocurrió un error.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => res.send("Promobolsillo+ piloto REZGO ✅"));
app.listen(PORT, () => console.log(`🚀 Promobolsillo+ escuchando en puerto ${PORT}`));
