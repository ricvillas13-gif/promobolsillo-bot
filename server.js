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
  console.warn("⚠️ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. Reenvío a cliente deshabilitado.");
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

// ==========================
// Estados
// ==========================
const STATE_MENU = "MENU";

// Asistencia por tienda
const STATE_ASIS_ELEGIR_TIENDA = "ASIS_ELEGIR_TIENDA";
const STATE_ASIS_ACCION = "ASIS_ACCION";
const STATE_ASIS_FOTO = "ASIS_FOTO";
const STATE_ASIS_UBI = "ASIS_UBI";

// Evidencias (tienda activa)
const STATE_EVID_ELEGIR_MARCA = "EVID_ELEGIR_MARCA";
const STATE_EVID_ELEGIR_TIPO = "EVID_ELEGIR_TIPO";
const STATE_EVID_ELEGIR_FASE = "EVID_ELEGIR_FASE";
const STATE_EVID_FOTOS = "EVID_FOTOS";
const STATE_EVID_ELEGIR_VISITA = "EVID_ELEGIR_VISITA"; // si hay >1 abierta

// Supervisor
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
// Escritura por HEADERS (para que no se descuadren columnas)
// ==========================
const headerCache = new Map();

function normalizeHeaderName(h) {
  return norm(h)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, ""); // quita caracteres raros
}

async function getHeaderInfo(sheetName, maxCols = 40) {
  const key = `${sheetName}:${maxCols}`;
  if (headerCache.has(key)) return headerCache.get(key);

  // A1:AN1 (40 cols aprox)
  const endCol = String.fromCharCode("A".charCodeAt(0) + (maxCols - 1)); // hasta AN no aplica bien, pero suficiente para 40 (A..n)
  const headers = await getSheetValues(`${sheetName}!A1:${endCol}1`);
  const row = (headers[0] || []).map(norm);

  // recorta al último header no vacío
  let last = row.length - 1;
  while (last >= 0 && !row[last]) last--;
  const used = row.slice(0, last + 1);

  const map = {};
  used.forEach((h, idx) => {
    if (!h) return;
    map[normalizeHeaderName(h)] = idx;
  });

  const info = { headers: used, map, width: used.length || maxCols, endCol };
  headerCache.set(key, info);
  return info;
}

async function appendByHeaders(sheetName, obj) {
  const info = await getHeaderInfo(sheetName, 40);
  const row = new Array(info.width).fill("");

  // Sinónimos (por si tu hoja usa otros nombres)
  const synonyms = {
    comentario: ["descripcion", "nota", "observaciones"],
    descripcion: ["comentario", "nota", "observaciones"],
    marca_nombre: ["marca"],
    tipo_evidencia: ["tipoevidencia", "tipo"],
    score_confianza: ["score", "confianza"],
  };

  function setIfExists(key, value) {
    const k = normalizeHeaderName(key);
    if (info.map[k] !== undefined) {
      row[info.map[k]] = value;
      return true;
    }
    // intenta sinónimos
    const alts = synonyms[key] || [];
    for (const a of alts) {
      const ak = normalizeHeaderName(a);
      if (info.map[ak] !== undefined) {
        row[info.map[ak]] = value;
        return true;
      }
    }
    return false;
  }

  Object.entries(obj).forEach(([k, v]) => setIfExists(k, v));

  await appendSheetValues(`${sheetName}!A2:${info.endCol}`, [row]);
}

// ==========================
// Catálogos (PROMOTORES / SUPERVISORES)
// ==========================
async function getSupervisorPorTelefono(telefono) {
  const rows = await getSheetValues("SUPERVISORES!A2:F");
  for (const r of rows) {
    if (norm(r[0]) === telefono && isTrue(r[5])) {
      return {
        telefono: norm(r[0]),
        supervisor_id: norm(r[1]),
        nombre: norm(r[2]),
        region: norm(r[3]),
        nivel: norm(r[4]),
        activo: true,
      };
    }
  }
  return null;
}

async function getPromotorPorTelefono(telefono) {
  const rows = await getSheetValues("PROMOTORES!A2:G");
  for (const r of rows) {
    if (norm(r[0]) === telefono) {
      return {
        telefono: norm(r[0]),
        promotor_id: norm(r[1]),
        nombre: norm(r[2]),
        region: norm(r[3]),
        cadena: norm(r[4]),
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
    .map((r) => ({
      telefono: norm(r[0]),
      promotor_id: norm(r[1]),
      nombre: norm(r[2]),
    }));
}

// ==========================
// TIENDAS / ASIGNACIONES
// ==========================
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
      region: norm(r[4]),
      activa: isTrue(r[5]),
      direccion: norm(r[6]),
      estado: norm(r[7]),
      lat: norm(r[8]),
      lon: norm(r[9]),
      radio_m: norm(r[10]),
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
// VISITAS (asistencia por tienda)
// VISITAS: A visita_id, B promotor_id, C tienda_id, D fecha, E hora_inicio, F hora_fin
// ==========================
async function findVisitRowById(visita_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  for (let i = 0; i < rows.length; i++) {
    if (norm(rows[i][0]) === visita_id) {
      return { rowIndex: i + 2, row: rows[i] };
    }
  }
  return null;
}

async function findOpenVisit(promotor_id, tienda_id, fechaISO) {
  const rows = await getSheetValues("VISITAS!A2:F");
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (
      norm(r[1]) === promotor_id &&
      norm(r[2]) === tienda_id &&
      norm(r[3]) === fechaISO &&
      !norm(r[5])
    ) {
      return { rowIndex: i + 2, visita_id: norm(r[0]) };
    }
  }
  return null;
}

async function getOpenVisitsToday(promotor_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const fecha = todayISO();
  return rows
    .map((r, idx) => ({ r, rowIndex: idx + 2 }))
    .filter((x) => norm(x.r[1]) === promotor_id && norm(x.r[3]) === fecha && !norm(x.r[5]))
    .map((x) => ({
      visita_id: norm(x.r[0]),
      tienda_id: norm(x.r[2]),
      hora_inicio: norm(x.r[4]),
      rowIndex: x.rowIndex,
    }));
}

async function createVisit(promotor_id, tienda_id) {
  const visita_id = "V-" + Date.now();
  await appendSheetValues("VISITAS!A2:F", [
    [visita_id, promotor_id, tienda_id, todayISO(), nowISO(), ""],
  ]);
  return visita_id;
}

async function closeVisitById(visita_id) {
  const found = await findVisitRowById(visita_id);
  if (!found) return false;
  await updateSheetValues(`VISITAS!F${found.rowIndex}:F${found.rowIndex}`, [[nowISO()]]);
  return true;
}

// ==========================
// MARCAS / TIENDA_MARCA / REGLAS_EVIDENCIA
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

async function getMarcasPorTienda(tienda_id) {
  const rows = await getSheetValues("TIENDA_MARCA!A2:C");
  const ids = [];
  for (const r of rows) {
    if (norm(r[0]) === tienda_id && isTrue(r[2] ?? "TRUE")) {
      const mid = norm(r[1]);
      if (mid) ids.push(mid);
    }
  }
  return Array.from(new Set(ids));
}

async function getReglasPorMarca(marca_id) {
  const rows = await getSheetValues("REGLAS_EVIDENCIA!A2:E");
  const reglas = [];
  for (const r of rows) {
    if (norm(r[0]) !== marca_id) continue;
    const activa = isTrue(r[4] ?? "TRUE");
    if (!activa) continue;
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
// EVIDENCIAS (DEMO análisis)
// ==========================
function demoAnalisisPorTipo(tipo_evento) {
  const t = upper(tipo_evento);
  if (t.includes("ENTRADA")) return { resultado: "Entrada validada (demo).", score: 0.93, riesgo: "BAJO" };
  if (t.includes("SALIDA")) return { resultado: "Salida validada (demo).", score: 0.92, riesgo: "BAJO" };
  const r = Math.random();
  if (r < 0.08) return { resultado: "Posible evidencia incompleta (demo).", score: 0.62, riesgo: "ALTO" };
  if (r < 0.20) return { resultado: "Evidencia con dudas leves (demo).", score: 0.78, riesgo: "MEDIO" };
  return { resultado: "Evidencia coherente (demo).", score: 0.90, riesgo: "BAJO" };
}

async function registrarEvidencia({
  evidencia_id,
  telefono,
  tipo_evento,
  origen,
  visita_id,
  url_foto,
  lat,
  lon,
  tienda_id,
  promotor_id,
  marca_id,
  marca_nombre,
  tipo_evidencia,
  fase,
  batch_id,
  seq,
  descripcion,
}) {
  const fecha_hora = nowISO();
  const demo = demoAnalisisPorTipo(tipo_evento);

  await appendByHeaders("EVIDENCIAS", {
    evidencia_id,
    telefono,
    fecha_hora,
    tipo_evento,
    origen,
    jornada_id: "",
    visita_id,
    url_foto,
    lat,
    lon,
    resultado_ai: demo.resultado,
    score_confianza: demo.score,
    riesgo: demo.riesgo,
    tienda_id,
    promotor_id,
    marca_id,
    marca_nombre,
    tipo_evidencia,
    fase,
    batch_id,
    seq,
    descripcion,
  });

  return demo;
}

// ==========================
// Menús
// ==========================
function menuPromotor() {
  return (
    "👋 *Promobolsillo+*\n\n" +
    "1️⃣ Asistencia por tienda (entrada/salida 📸📍)\n" +
    "2️⃣ Evidencias (marca → tipo → fotos)\n" +
    "3️⃣ Ayuda\n\n" +
    "Comandos: `menu`, `sup`, `ayuda`"
  );
}

function ayudaPromotor() {
  return (
    "🆘 *Ayuda Promotor*\n\n" +
    "Flujo:\n" +
    "1) Opción 1: registra ENTRADA en tienda.\n" +
    "2) Opción 2: registra evidencias (usa tienda activa).\n" +
    "3) Opción 1: registra SALIDA.\n\n" +
    "Tip: si te pide tienda en evidencias, no hay tienda activa (sin entrada)."
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
// Supervisor: grupos cliente + envío
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

async function enviarFotoAGrupoCliente(ev, grupo, tiendaMap) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) return { ok: false, enviados: 0 };

  const tienda = ev.tienda_id ? tiendaMap[ev.tienda_id] : null;
  const tiendaTxt = tienda ? `${tienda.nombre_tienda}${tienda.ciudad ? " (" + tienda.ciudad + ")" : ""}` : "";

  const body =
    "🏪 *Evidencia*\n" +
    (grupo.cliente ? `👤 Cliente: ${grupo.cliente}\n` : "") +
    (ev.marca_nombre ? `🏷️ Marca: ${ev.marca_nombre}\n` : "") +
    (tiendaTxt ? `🏬 Tienda: ${tiendaTxt}\n` : "") +
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
      console.error("Error enviando al cliente:", to, e?.message || e);
    }
  }
  return { ok: enviados > 0, enviados };
}

// ==========================
// Evidencias hoy (para supervisor)
// ==========================
function mapEvidRow(r) {
  return {
    evidencia_id: norm(r[0]),
    telefono: norm(r[1]),
    fecha_hora: norm(r[2]),
    tipo_evento: norm(r[3]),
    origen: norm(r[4]),
    visita_id: norm(r[6]),
    url_foto: norm(r[7]),
    lat: norm(r[8]),
    lon: norm(r[9]),
    resultado_ai: norm(r[10]),
    score_confianza: Number(r[11] || 0),
    riesgo: upper(r[12] || "BAJO"),
    tienda_id: norm(r[13]),
    promotor_id: norm(r[14]),
    marca_id: norm(r[15]),
    marca_nombre: norm(r[16]),
    tipo_evidencia: norm(r[17]),
    fase: norm(r[18]),
    batch_id: norm(r[19]),
    seq: safeInt(r[20], 0),
    descripcion: norm(r[21]),
  };
}

async function getEvidenciasHoy() {
  const rows = await getSheetValues("EVIDENCIAS!A2:V");
  const hoy = todayISO();
  return rows.map(mapEvidRow).filter((ev) => (ev.fecha_hora || "").slice(0, 10) === hoy);
}

// ==========================
// Flujos Promotor
// ==========================
async function startAsistencia(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ Tu número no aparece como promotor activo. Revisa PROMOTORES.";

  const tiendaMap = await getTiendaMap();
  const asignadas = await getTiendasAsignadas(prom.promotor_id);
  const tiendas = asignadas.map((id) => tiendaMap[id]).filter((t) => t && t.activa);

  if (!tiendas.length) return "⚠️ No tienes tiendas asignadas activas. Revisa ASIGNACIONES y TIENDAS.";

  await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA, { promotor_id: prom.promotor_id, tiendas });
  let msg = "🕒 *Asistencia – selecciona tienda*\n\n";
  tiendas.slice(0, 12).forEach((t, idx) => {
    msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena}${t.ciudad ? " (" + t.ciudad + ")" : ""}\n`;
  });
  msg += "\nResponde con el número.";
  return msg;
}

async function handleAsistencia(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_ASIS_ELEGIR_TIENDA) {
    const tiendas = data.tiendas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(12, tiendas.length)) return "⚠️ Elige un número válido.";
    const tienda = tiendas[n - 1];

    const open = await findOpenVisit(data.promotor_id, tienda.tienda_id, todayISO());

    if (open) {
      await setSession(telefono, STATE_ASIS_ACCION, {
        promotor_id: data.promotor_id,
        tienda_id: tienda.tienda_id,
        tienda_nombre: tienda.nombre_tienda,
        visita_id: open.visita_id,
        accion: "SALIDA",
      });
      return `🏬 *${tienda.nombre_tienda}*\n\n1️⃣ Registrar *SALIDA* (📸📍)\n2️⃣ Cancelar`;
    } else {
      await setSession(telefono, STATE_ASIS_ACCION, {
        promotor_id: data.promotor_id,
        tienda_id: tienda.tienda_id,
        tienda_nombre: tienda.nombre_tienda,
        accion: "ENTRADA",
      });
      return `🏬 *${tienda.nombre_tienda}*\n\n1️⃣ Registrar *ENTRADA* (📸📍)\n2️⃣ Cancelar`;
    }
  }

  if (estado === STATE_ASIS_ACCION) {
    if (lower === "2") { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }
    if (lower !== "1") return "Responde 1 para continuar o 2 para cancelar.";

    await setSession(telefono, STATE_ASIS_FOTO, { ...data });
    return data.accion === "ENTRADA"
      ? `🕒 *Entrada – ${data.tienda_nombre}*\n📸 Envía foto de entrada.`
      : `🚪 *Salida – ${data.tienda_nombre}*\n📸 Envía foto de salida.`;
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

    const evidencia_id = "EV-" + Date.now() + "-1";

    if (data.accion === "ENTRADA") {
      const visita_id = await createVisit(data.promotor_id, data.tienda_id);

      await registrarEvidencia({
        evidencia_id,
        telefono,
        tipo_evento: "ASISTENCIA_ENTRADA",
        origen: "ASISTENCIA",
        visita_id,
        url_foto: data.fotoUrl,
        lat,
        lon,
        tienda_id: data.tienda_id,
        promotor_id: data.promotor_id,
        marca_id: "",
        marca_nombre: "",
        tipo_evidencia: "ASISTENCIA",
        fase: "NA",
        batch_id: "",
        seq: 1,
        descripcion: "",
      });

      await setSession(telefono, STATE_MENU, {});
      return `✅ Entrada registrada – *${data.tienda_nombre}*\n\nAhora puedes ir a *Evidencias* (opción 2).`;
    }

    // SALIDA
    const ok = await closeVisitById(data.visita_id);
    if (!ok) console.warn("⚠️ No se pudo cerrar VISITAS para visita_id:", data.visita_id);

    await registrarEvidencia({
      evidencia_id,
      telefono,
      tipo_evento: "ASISTENCIA_SALIDA",
      origen: "ASISTENCIA",
      visita_id: data.visita_id,
      url_foto: data.fotoUrl,
      lat,
      lon,
      tienda_id: data.tienda_id,
      promotor_id: data.promotor_id,
      marca_id: "",
      marca_nombre: "",
      tipo_evidencia: "ASISTENCIA",
      fase: "NA",
      batch_id: "",
      seq: 1,
      descripcion: "",
    });

    await setSession(telefono, STATE_MENU, {});
    return `✅ Salida registrada – *${data.tienda_nombre}*`;
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// --------------------------
// Evidencias: usa tienda activa
// --------------------------
async function startEvidencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ Tu número no aparece como promotor activo. Revisa PROMOTORES.";

  const abiertas = await getOpenVisitsToday(prom.promotor_id);
  const tiendaMap = await getTiendaMap();

  if (!abiertas.length) {
    return "⚠️ No hay tienda activa (sin ENTRADA). Primero registra ENTRADA en Asistencia (opción 1).";
  }

  if (abiertas.length > 1) {
    // pedir cuál tienda activa
    const opciones = abiertas.map((v) => {
      const t = tiendaMap[v.tienda_id];
      return {
        visita_id: v.visita_id,
        tienda_id: v.tienda_id,
        tienda_nombre: t ? t.nombre_tienda : v.tienda_id,
      };
    });

    await setSession(telefono, STATE_EVID_ELEGIR_VISITA, {
      promotor_id: prom.promotor_id,
      opciones,
    });

    let msg = "🏬 Tienes *más de una tienda activa* (visitas abiertas). Elige una:\n\n";
    opciones.slice(0, 10).forEach((o, idx) => {
      msg += `${idx + 1}) ${o.tienda_nombre}\n`;
    });
    msg += "\nResponde con el número.";
    return msg;
  }

  // una sola tienda activa -> directo a marcas
  const v = abiertas[0];
  const tienda = tiendaMap[v.tienda_id];
  const tienda_nombre = tienda ? tienda.nombre_tienda : v.tienda_id;

  return await goToMarcas(telefono, prom.promotor_id, v.visita_id, v.tienda_id, tienda_nombre);
}

async function goToMarcas(telefono, promotor_id, visita_id, tienda_id, tienda_nombre) {
  const marcasAll = await getMarcasActivas();
  let marcaIds = [];
  try { marcaIds = await getMarcasPorTienda(tienda_id); } catch { marcaIds = []; }

  let marcas = marcasAll;
  if (marcaIds.length) {
    const set = new Set(marcaIds);
    marcas = marcasAll.filter((m) => set.has(m.marca_id));
  }

  if (!marcas.length) return "⚠️ No hay marcas activas configuradas para esta tienda.";

  await setSession(telefono, STATE_EVID_ELEGIR_MARCA, {
    promotor_id,
    visita_id,
    tienda_id,
    tienda_nombre,
    marcas,
  });

  let msg = `🏬 *${tienda_nombre}*\n🏷️ Selecciona *marca*:\n\n`;
  marcas.slice(0, 15).forEach((m, idx) => { msg += `${idx + 1}) ${m.marca_nombre}\n`; });
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

    await setSession(telefono, STATE_EVID_ELEGIR_TIPO, {
      ...data,
      marca_id: marca.marca_id,
      marca_nombre: marca.marca_nombre,
      reglas,
    });

    let msg = `🏬 *${data.tienda_nombre}*\n🏷️ Marca: *${marca.marca_nombre}*\n\n🧾 Selecciona *tipo de evidencia*:\n\n`;
    reglas.forEach((r, idx) => {
      msg += `${idx + 1}) ${r.tipo_evidencia} (fotos: ${r.fotos_requeridas}${r.requiere_antes_despues ? ", antes/después" : ""})\n`;
    });
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

    return `📸 Envía *${regla.fotos_requeridas}* foto(s) en un solo mensaje.\n(Estás en ${data.tienda_nombre} / ${data.marca_nombre} / ${regla.tipo_evidencia})`;
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

    return `📸 Envía *${data.regla.fotos_requeridas}* foto(s) para fase *${fase}* (en un solo mensaje).`;
  }

  if (estado === STATE_EVID_FOTOS) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito que envíes foto(s).";

    const needed = data.fotos_requeridas || 1;
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    const descripcion = norm(inbound?.Body || "");

    let recibidas = data.fotos_recibidas || 0;
    const seqStart = recibidas + 1;

    for (let i = 0; i < Math.min(numMedia, 10); i++) {
      const url = inbound?.[`MediaUrl${i}`] || "";
      if (!url) continue;

      const evidencia_id = `EV-${Date.now()}-${seqStart + i}`;

      await registrarEvidencia({
        evidencia_id,
        telefono,
        tipo_evento: `EVIDENCIA_${upper(data.regla.tipo_evidencia).replace(/\W+/g, "_")}`,
        origen: "EVIDENCIA",
        visita_id: data.visita_id,
        url_foto: url,
        lat,
        lon,
        tienda_id: data.tienda_id,
        promotor_id: data.promotor_id,
        marca_id: data.marca_id,
        marca_nombre: data.marca_nombre,
        tipo_evidencia: data.regla.tipo_evidencia,
        fase: data.fase || "NA",
        batch_id: data.batch_id,
        seq: seqStart + i,
        descripcion,
      });
    }

    recibidas += Math.min(numMedia, 10);

    if (recibidas < needed) {
      await setSession(telefono, STATE_EVID_FOTOS, { ...data, fotos_recibidas: recibidas });
      return `✅ Recibí ${numMedia} foto(s). Faltan *${needed - recibidas}* foto(s). Envía las restantes.`;
    }

    // terminado -> volver a marcas (misma tienda activa)
    await setSession(telefono, STATE_MENU, {});
    return `✅ Evidencia registrada para *${data.marca_nombre}* (${data.regla.tipo_evidencia}).\n\nPuedes registrar otra evidencia (opción 2) o cerrar salida (opción 1).`;
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// Supervisor flow
// ==========================
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
      const telSet = new Set(equipo.map((p) => p.telefono));
      const evs = await getEvidenciasHoy();
      const conteos = {};
      evs.forEach((e) => { if (telSet.has(e.telefono)) conteos[e.telefono] = (conteos[e.telefono] || 0) + 1; });

      let msg = "👀 *Evidencias de hoy por promotor*\n\n";
      equipo.forEach((p, idx) => { msg += `${idx + 1}) ${p.nombre} – ${(conteos[p.telefono] || 0)}\n`; });
      msg += "\nResponde con el número del promotor.";
      await setSession(telefono, STATE_SUP_PROMOTOR_LIST, { equipo });
      return msg;
    }

    if (lower === "2") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      const telSet = new Set(equipo.map((p) => p.telefono));
      const telName = {};
      equipo.forEach((p) => (telName[p.telefono] = p.nombre));

      const evs = (await getEvidenciasHoy())
        .filter((e) => telSet.has(e.telefono) && (e.riesgo === "MEDIO" || e.riesgo === "ALTO"))
        .map((e) => ({ ...e, promotor_nombre: telName[e.telefono] || e.telefono }));

      if (!evs.length) return "🧠📸 No hay evidencias MEDIO/ALTO hoy.";

      const tiendaMap = await getTiendaMap();
      let msg = "🧠📸 *Evidencias MEDIO/ALTO (hoy)*\n\n";
      evs.forEach((e, i) => {
        const t = e.tienda_id ? tiendaMap[e.tienda_id] : null;
        const tn = t ? ` – ${t.nombre_tienda}` : "";
        msg += `${i + 1}) ${e.tipo_evidencia || e.tipo_evento}${e.fase && e.fase !== "NA" ? " (" + e.fase + ")" : ""} – ${e.marca_nombre || ""}${tn} – ${e.promotor_nombre} – ${e.riesgo}\n`;
      });
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
    if (n < 1 || n > equipo.length) return "⚠️ Elige un número válido.";
    const p = equipo[n - 1];

    const tiendaMap = await getTiendaMap();
    const evs = (await getEvidenciasHoy())
      .filter((e) => e.telefono === p.telefono)
      .map((e) => ({ ...e, promotor_nombre: p.nombre }));

    if (!evs.length) { await setSession(telefono, STATE_SUP_MENU, {}); return `⚠️ No hay evidencias hoy para ${p.nombre}.\n\n` + menuSupervisor(sup.nombre); }

    let msg = `📷 *Evidencias de hoy – ${p.nombre}*\n\n`;
    evs.forEach((e, i) => {
      const t = e.tienda_id ? tiendaMap[e.tienda_id] : null;
      const tn = t ? ` – ${t.nombre_tienda}` : "";
      msg += `${i + 1}) ${e.tipo_evidencia || e.tipo_evento}${e.fase && e.fase !== "NA" ? " (" + e.fase + ")" : ""} – ${e.marca_nombre || ""}${tn} – ${e.riesgo}\n`;
    });
    msg += "\nComandos: `ver 1`, `enviar 1,3`, `enviar todas`, `sup`";
    await setSession(telefono, STATE_SUP_FOTOS_LIST, { listado: evs });
    return msg;
  }

  if (estado === STATE_SUP_FOTOS_LIST) {
    const listado = data.listado || [];
    const tiendaMap = await getTiendaMap();

    const verMatch = lower.match(/^ver\s+(\d+)/);
    if (verMatch) {
      const idx = safeInt(verMatch[1], 0) - 1;
      if (idx < 0 || idx >= listado.length) return "⚠️ Número inválido.";
      const e = listado[idx];
      const t = e.tienda_id ? tiendaMap[e.tienda_id] : null;
      const tn = t ? `${t.nombre_tienda}${t.ciudad ? " (" + t.ciudad + ")" : ""}` : "";

      const texto =
        `🧾 *Detalle #${idx + 1}*\n` +
        `👤 ${e.promotor_nombre || ""}\n` +
        (tn ? `🏬 ${tn}\n` : "") +
        (e.marca_nombre ? `🏷️ ${e.marca_nombre}\n` : "") +
        `🧾 ${e.tipo_evidencia || e.tipo_evento}${e.fase && e.fase !== "NA" ? " (" + e.fase + ")" : ""}\n` +
        `🧠 ${e.resultado_ai || ""}\n` +
        `⚠️ Riesgo: ${e.riesgo}\n\n` +
        "Comandos: `enviar 1,3`, `enviar todas`, `sup`";

      return { text: texto, mediaUrl: e.url_foto || null };
    }

    if (lower.startsWith("enviar")) {
      let resto = lower.replace(/^enviar\s*/, "").trim();
      if (!resto) return "⚠️ Usa `enviar 1,3` o `enviar todas`.";

      let seleccionadas = [];
      if (resto === "todas" || resto === "todos") {
        seleccionadas = listado.slice();
      } else {
        const partes = resto.split(/[, ]+/).map((p) => p.trim()).filter(Boolean);
        const idxs = [];
        for (const p of partes) {
          const n = safeInt(p, -1);
          if (n < 1 || n > listado.length) return "⚠️ Número fuera de rango.";
          idxs.push(n - 1);
        }
        seleccionadas = Array.from(new Set(idxs)).map((i) => listado[i]);
      }

      const grupos = await getGruposClienteActivos();
      if (!grupos.length) return "⚠️ No hay grupos activos en GRUPOS_CLIENTE.";

      let msg = `📤 Vas a enviar *${seleccionadas.length}* evidencia(s).\n\nElige grupo:\n`;
      grupos.forEach((g, i) => { msg += `${i + 1}) ${g.nombre_grupo}\n`; });
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
    if (n < 1 || n > grupos.length) return "⚠️ Elige un grupo válido.";

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

  // supervisor states
  if ([STATE_SUP_MENU, STATE_SUP_PROMOTOR_LIST, STATE_SUP_FOTOS_LIST, STATE_SUP_ELEGIR_GRUPO].includes(estado)) {
    return await handleSupervisor(telefono, estado, text, data);
  }

  // promotor menu
  if (estado === STATE_MENU) {
    if (lower === "1") return await startAsistencia(telefono);
    if (lower === "2") return await startEvidencias(telefono);
    if (lower === "3") return ayudaPromotor();
    return menuPromotor();
  }

  // flows
  if ([STATE_ASIS_ELEGIR_TIENDA, STATE_ASIS_ACCION, STATE_ASIS_FOTO, STATE_ASIS_UBI].includes(estado)) {
    return await handleAsistencia(telefono, estado, text, data, inbound);
  }

  if ([STATE_EVID_ELEGIR_VISITA, STATE_EVID_ELEGIR_MARCA, STATE_EVID_ELEGIR_TIPO, STATE_EVID_ELEGIR_FASE, STATE_EVID_FOTOS].includes(estado)) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
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
    if (respuesta.mediaUrl) msg.media(respuesta.mediaUrl);
  } else {
    twiml.message("Ocurrió un error.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send("Promobolsillo+ piloto REZGO ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Promobolsillo+ escuchando en puerto ${PORT}`);
});
