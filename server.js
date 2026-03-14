import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";
import crypto from "crypto";

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
  PUBLIC_BASE_URL,
  MEDIA_PROXY_TTL_SECONDS,
} = process.env;

const MEDIA_TTL = parseInt(MEDIA_PROXY_TTL_SECONDS || "3600", 10);

// ==========================
// App TZ (para que HOY sea CDMX, no UTC)
// ==========================
const APP_TZ = "America/Mexico_City";

function ymdInTZ(date = new Date(), tz = APP_TZ) {
  // 'sv-SE' -> YYYY-MM-DD
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function hmInTZ(date = new Date(), tz = APP_TZ) {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function fmtDateTimeTZ(iso, tz = APP_TZ) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${ymdInTZ(d, tz)} ${hmInTZ(d, tz)}`;
}

function todayISO() {
  return ymdInTZ(new Date(), APP_TZ);
}

function nowISO() {
  return new Date().toISOString();
}

// ==========================
// Twilio client (solo para enviar outbound / supervisor)
// ==========================
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
// LOCK por usuario (evita conteos raros por concurrencia)
// ==========================
const userLocks = new Map();
async function withUserLock(key, fn) {
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  userLocks.set(key, prev.then(() => next).catch(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    setTimeout(() => {
      if (userLocks.get(key) === next) userLocks.delete(key);
    }, 5000);
  }
}

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

function buildBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function nEmoji(i) {
  const arr = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  return arr[i] || `${i + 1})`;
}

// ==========================
// Media proxy (soluciona 63019)
// ==========================
function signMedia(u, exp) {
  const h = crypto.createHmac("sha256", TWILIO_AUTH_TOKEN || "dev");
  h.update(`${u}|${exp}`);
  return h.digest("hex");
}
function proxifyMediaUrl(baseUrl, originalUrl) {
  if (!originalUrl) return "";
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL;
  const sig = signMedia(originalUrl, exp);
  return `${baseUrl}/media?u=${encodeURIComponent(originalUrl)}&exp=${exp}&sig=${sig}`;
}

app.get("/media", async (req, res) => {
  try {
    const u = (req.query.u || "").toString();
    const exp = parseInt((req.query.exp || "0").toString(), 10);
    const sig = (req.query.sig || "").toString();

    if (!u || !exp || !sig) return res.status(400).send("bad_request");
    if (Math.floor(Date.now() / 1000) > exp) return res.status(403).send("expired");

    const expected = signMedia(u, exp);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).send("invalid_sig");
    }

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const r = await fetch(u, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) return res.status(502).send("upstream_failed");

    const ct = r.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=300");

    const buf = Buffer.from(await r.arrayBuffer());
    res.status(200).send(buf);
  } catch (e) {
    console.error("media proxy error:", e?.message || e);
    res.status(500).send("error");
  }
});

// ==========================
// Estados
// ==========================
const STATE_MENU = "MENU";

// Asistencia
const STATE_ASIS_HOME = "ASIS_HOME";
const STATE_ASIS_PICK_ENTRADA = "ASIS_PICK_ENTRADA";
const STATE_ASIS_PICK_ACTIVA = "ASIS_PICK_ACTIVA";
const STATE_ASIS_ACTIVA_MENU = "ASIS_ACTIVA_MENU";
const STATE_ASIS_FOTO = "ASIS_FOTO";
const STATE_ASIS_UBI = "ASIS_UBI";
const STATE_ASIS_HIST = "ASIS_HIST";
const STATE_ASIS_CAMBIAR_FOTO = "ASIS_CAMBIAR_FOTO"; // paso FOTO -> UBI

// Evidencias
const STATE_EVID_PICK_VISITA = "EVID_PICK_VISITA";
const STATE_EVID_PICK_MARCA = "EVID_PICK_MARCA";
const STATE_EVID_PICK_TIPO = "EVID_PICK_TIPO";
const STATE_EVID_PICK_FASE = "EVID_PICK_FASE";
const STATE_EVID_FOTOS = "EVID_FOTOS";

// Mis evidencias
const STATE_MY_EVID_PICK_TIENDA = "MY_EVID_PICK_TIENDA";
const STATE_MY_EVID_LIST = "MY_EVID_LIST";

// Supervisor (básico)
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";

// ==========================
// SESIONES (hoja SESIONES A2:C)
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
  const prev = ses?.data_json || {};
  const merged = {
    ...data_json,
    _last_sid: prev._last_sid || "",
    _last_resp: prev._last_resp || "",
  };
  const dataStr = JSON.stringify(merged);
  if (!ses) {
    await appendSheetValues("SESIONES!A2:C", [[telefono, estado_actual, dataStr]]);
  } else {
    await updateSheetValues(`SESIONES!A${ses.rowIndex}:C${ses.rowIndex}`, [[telefono, estado_actual, dataStr]]);
  }
}

async function setSessionMeta(telefono, meta) {
  const ses = await getSession(telefono);
  const merged = { ...(ses.data_json || {}), ...meta };
  await updateSheetValues(`SESIONES!A${ses.rowIndex}:C${ses.rowIndex}`, [
    [telefono, ses.estado_actual, JSON.stringify(merged)],
  ]);
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
async function getVisitsByDate(promotor_id, ymd) {
  const rows = await getSheetValues("VISITAS!A2:F");
  return rows
    .filter((r) => norm(r[1]) === promotor_id && norm(r[3]) === ymd)
    .map((r) => ({
      visita_id: norm(r[0]),
      tienda_id: norm(r[2]),
      fecha: norm(r[3]),
      hora_inicio: norm(r[4]),
      hora_fin: norm(r[5]),
    }));
}

async function getVisitsToday(promotor_id) {
  return await getVisitsByDate(promotor_id, todayISO());
}

async function getOpenVisitsToday(promotor_id) {
  const visits = await getVisitsToday(promotor_id);
  return visits.filter(v => !v.hora_fin).map(v => ({ visita_id: v.visita_id, tienda_id: v.tienda_id }));
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
// EVIDENCIAS (A:Q) — respeta tu estructura actual
// Columns:
// evidencia_id, telefono, fecha_hora, tipo_evento, origen, jornada_id,
// visita_id, url_foto, lat, lon, resultado_ai, score_confianza, riesgo,
// marca_id, producto_id, tipo_evidencia, descripcion
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
  await appendSheetValues("EVIDENCIAS!A2:Q", [[
    payload.evidencia_id,
    payload.telefono,
    nowISO(),
    payload.tipo_evento,
    payload.origen,
    "", // jornada_id
    payload.visita_id,
    payload.url_foto,
    payload.lat || "",
    payload.lon || "",
    a.resultado_ai,
    a.score,
    a.riesgo,
    payload.marca_id || "",
    payload.producto_id || "",
    payload.tipo_evidencia || "",
    payload.descripcion || "",
  ]]);
  return a;
}

async function hasAsistenciaEvento(visita_id, tipo_evento) {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  for (const r of rows) {
    if (norm(r[6]) === visita_id && upper(r[4]) === "ASISTENCIA" && norm(r[3]) === tipo_evento) return true;
  }
  return false;
}

// Devuelve la ENTRADA/SALIDA "más reciente" (para correcciones)
async function getAsistenciaMetaByVisita(visita_id) {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  let entrada = { url: "", fecha_hora: "" };
  let salida = { url: "", fecha_hora: "" };

  for (const r of rows) {
    if (norm(r[6]) !== visita_id) continue;
    if (upper(r[4]) !== "ASISTENCIA") continue;

    const tipo = norm(r[3]);
    const fh = norm(r[2]);
    const url = norm(r[7]);

    if (tipo === "ASISTENCIA_ENTRADA") {
      if (!entrada.fecha_hora || fh > entrada.fecha_hora) entrada = { url, fecha_hora: fh };
    }
    if (tipo === "ASISTENCIA_SALIDA") {
      if (!salida.fecha_hora || fh > salida.fecha_hora) salida = { url, fecha_hora: fh };
    }
  }
  return { entrada, salida };
}

// ==========================
// GRUPOS_CLIENTE
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
    `*${nEmoji(0)}* Asistencia\n` +
    `*${nEmoji(1)}* Evidencias\n` +
    `*${nEmoji(2)}* Mis evidencias\n` +
    `*${nEmoji(3)}* Resumen del día\n` +
    `*${nEmoji(4)}* Ayuda\n\n` +
    "Comandos: `menu`, `sup`, `ayuda`"
  );
}

function ayudaPromotor() {
  return (
    "🆘 *Ayuda*\n\n" +
    "• Asistencia: si NO hay tienda activa, te ofrece ENTRADA.\n" +
    "• Evidencias: manda fotos según regla (puedes mandar varias juntas).\n" +
    "• Mis evidencias: elige tienda y usa `ver N` o `ver todas`.\n\n" +
    "Escribe `menu` para volver."
  );
}

function menuSupervisor(nombre="Supervisor") {
  return (
    `👋 *${nombre}* (Supervisor)\n\n` +
    `*${nEmoji(0)}* Evidencias hoy por promotor\n` +
    `*${nEmoji(1)}* Evidencias hoy MEDIO/ALTO\n` +
    `*${nEmoji(2)}* Ayuda\n\n` +
    "Comandos: `ver N`, `enviar 1,3`, `enviar todas`, `sup`, `menu`"
  );
}

function ayudaSupervisor() {
  return (
    "🆘 *Ayuda Supervisor*\n\n" +
    "• `ver 2` muestra la foto.\n" +
    "• `enviar 1,3` envía esas evidencias a un grupo.\n" +
    "• `enviar todas` envía todas las evidencias listadas.\n"
  );
}

// ==========================
// Resumen del día
// ==========================
async function resumenDia(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const visits = await getVisitsToday(prom.promotor_id);
  const abiertas = visits.filter(v => !v.hora_fin);
  const cerradas = visits.filter(v => v.hora_fin);

  // contar eventos desde EVIDENCIAS por "hoy CDMX"
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  const hoy = todayISO();

  let asis = 0;
  let evid = 0;
  for (const r of rows) {
    if (norm(r[1]) !== telefono) continue;
    const fh = norm(r[2]);
    if (!fh) continue;
    const ymd = ymdInTZ(new Date(fh), APP_TZ);
    if (ymd !== hoy) continue;

    const origen = upper(r[4]);
    if (origen === "ASISTENCIA") asis++;
    if (origen === "EVIDENCIA") evid++;
  }

  let msg = `📊 *Resumen del día* (${hoy})\n\n`;
  msg += `🏬 Visitas: ${visits.length} (abiertas ${abiertas.length}, cerradas ${cerradas.length})\n`;
  msg += `📸 Evidencias: ${evid}\n`;
  msg += `🕒 Asistencia (eventos): ${asis}\n\n`;
  msg += "Escribe `menu` para volver.";
  return msg;
}

// ==========================
// ASISTENCIA
// ==========================
async function startAsistenciaHome(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const abiertas = await getOpenVisitsToday(prom.promotor_id);

  if (!abiertas.length) {
    await setSession(telefono, STATE_ASIS_HOME, { promotor_id: prom.promotor_id });
    return (
      "🕒 *Asistencia*\n\n" +
      "No tienes tienda activa.\n\n" +
      `*${nEmoji(0)}* Registrar *ENTRADA*\n` +
      `*${nEmoji(1)}* Historial (últimas 10)\n` +
      `*${nEmoji(2)}* Volver al menú`
    );
  }

  if (abiertas.length === 1) {
    const a = abiertas[0];
    const tn = tiendaMap[a.tienda_id]?.nombre_tienda || a.tienda_id;

    await setSession(telefono, STATE_ASIS_ACTIVA_MENU, {
      promotor_id: prom.promotor_id,
      visita_id: a.visita_id,
      tienda_id: a.tienda_id,
      tienda_nombre: tn,
    });

    return (
      `🕒 *Asistencia* – Tienda activa: *${tn}*\n\n` +
      `*${nEmoji(0)}* Registrar *SALIDA*\n` +
      `*${nEmoji(1)}* Ver fotos asistencia\n` +
      `*${nEmoji(2)}* Cambiar foto ENTRADA\n` +
      `*${nEmoji(3)}* Cambiar foto SALIDA\n` +
      `*${nEmoji(4)}* Registrar ENTRADA en otra tienda\n` +
      `*${nEmoji(5)}* Historial (últimas 10)\n` +
      `*${nEmoji(6)}* Volver al menú`
    );
  }

  // varias activas
  await setSession(telefono, STATE_ASIS_PICK_ACTIVA, { promotor_id: prom.promotor_id });

  let msg = "🕒 *Asistencia*\n\n⚠️ Tienes *varias tiendas activas*. Elige cuál administrar:\n\n";
  abiertas.slice(0, 10).forEach((a, idx) => {
    const tn = tiendaMap[a.tienda_id]?.nombre_tienda || a.tienda_id;
    msg += `*${nEmoji(idx)}* ${tn}\n`;
  });
  msg += "\nResponde con el número.";
  return msg;
}

async function buildHistorial(telefono, promotor_id) {
  const tiendaMap = await getTiendaMap();
  const visits = await getVisitsToday(promotor_id);
  const out = visits.slice(-10).reverse();

  let msg = "📚 *Historial (últimas 10)*\n\n";
  out.forEach((v, idx) => {
    const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;
    const ent = v.hora_inicio ? fmtDateTimeTZ(v.hora_inicio) : "—";
    const sal = v.hora_fin ? fmtDateTimeTZ(v.hora_fin) : "pendiente";
    msg += `*${nEmoji(idx)}* ${tn}\n   🟢 Entrada: ${ent}\n   🔴 Salida: ${sal}\n`;
  });
  msg += "\nComando: `fotos 2` para ver fotos de esa visita.\n`menu` para volver.";
  return { listado: out, msg };
}

async function handleAsistencia(telefono, estado, text, data, inbound, baseUrl) {
  const lower = norm(text).toLowerCase();
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) { await setSession(telefono, STATE_MENU, {}); return "⚠️ No estás como promotor activo."; }

  const tiendaMap = await getTiendaMap();

  // --- HOME (sin tienda activa)
  if (estado === STATE_ASIS_HOME) {
    if (lower === "3") { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }

    if (lower === "1") {
      const asignadas = await getTiendasAsignadas(prom.promotor_id);
      const tiendas = asignadas.map(id => tiendaMap[id]).filter(t => t && t.activa);

      await setSession(telefono, STATE_ASIS_PICK_ENTRADA, { promotor_id: prom.promotor_id, tiendas, filtradas: [] });

      let msg = "🏬 *Entrada* – Elige tienda o escribe texto para buscar:\n\n";
      tiendas.slice(0, 10).forEach((t, idx) => msg += `*${nEmoji(idx)}* ${t.nombre_tienda}\n`);
      msg += "\nResponde con número o texto.";
      return msg;
    }

    if (lower === "2") {
      const { listado, msg } = await buildHistorial(telefono, prom.promotor_id);
      await setSession(telefono, STATE_ASIS_HIST, { listado });
      return msg;
    }

    return await startAsistenciaHome(telefono);
  }

  // --- PICK ACTIVA (varias tiendas)
  if (estado === STATE_ASIS_PICK_ACTIVA) {
    const abiertas = await getOpenVisitsToday(prom.promotor_id);
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, abiertas.length)) return "⚠️ Elige un número válido.";
    const a = abiertas[idx];
    const tn = tiendaMap[a.tienda_id]?.nombre_tienda || a.tienda_id;

    await setSession(telefono, STATE_ASIS_ACTIVA_MENU, {
      promotor_id: prom.promotor_id,
      visita_id: a.visita_id,
      tienda_id: a.tienda_id,
      tienda_nombre: tn,
    });

    return (
      `🕒 *Asistencia* – Tienda activa: *${tn}*\n\n` +
      `*${nEmoji(0)}* Registrar *SALIDA*\n` +
      `*${nEmoji(1)}* Ver fotos asistencia\n` +
      `*${nEmoji(2)}* Cambiar foto ENTRADA\n` +
      `*${nEmoji(3)}* Cambiar foto SALIDA\n` +
      `*${nEmoji(4)}* Volver (lista de activas)`
    );
  }

  // --- ACTIVA MENU
  if (estado === STATE_ASIS_ACTIVA_MENU) {
    const tn = data.tienda_nombre || "Tienda";

    // 5) volver a lista activas (si hay varias), o refrescar home
    if (lower === "5" || lower === "4") {
      return await startAsistenciaHome(telefono);
    }

    // 1) salida
    if (lower === "1") {
      await setSession(telefono, STATE_ASIS_FOTO, {
        accion: "SALIDA",
        visita_id: data.visita_id,
        tienda_id: data.tienda_id,
        tienda_nombre: tn,
        promotor_id: prom.promotor_id,
      });
      return `📸 Envía foto de *SALIDA* – ${tn}`;
    }

    // 2) ver fotos asistencia con fecha/hora
    if (lower === "2") {
      const meta = await getAsistenciaMetaByVisita(data.visita_id);
      const medias = [];
      if (meta.entrada.url) medias.push(proxifyMediaUrl(baseUrl, meta.entrada.url));
      if (meta.salida.url) medias.push(proxifyMediaUrl(baseUrl, meta.salida.url));
      if (!medias.length) return `📭 Aún no hay fotos de asistencia para ${tn}.`;

      const caption =
        `📷 *Asistencia* – ${tn}\n` +
        (meta.entrada.fecha_hora ? `🟢 Entrada: ${fmtDateTimeTZ(meta.entrada.fecha_hora)}\n` : "") +
        (meta.salida.fecha_hora ? `🔴 Salida: ${fmtDateTimeTZ(meta.salida.fecha_hora)}\n` : "");

      return { text: caption, mediaUrl: medias };
    }

    // 3) cambiar entrada
    if (lower === "3") {
      const ok = await hasAsistenciaEvento(data.visita_id, "ASISTENCIA_ENTRADA");
      if (!ok) return "⚠️ No existe foto de ENTRADA para cambiar.";
      await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, {
        visita_id: data.visita_id,
        tienda_nombre: tn,
        tipo_evento: "ASISTENCIA_ENTRADA",
        paso: "FOTO",
      });
      return `🔁 Cambiar ENTRADA – ${tn}\n📸 Envía la nueva foto.`;
    }

    // 4) cambiar salida
    if (lower === "4") {
      const ok = await hasAsistenciaEvento(data.visita_id, "ASISTENCIA_SALIDA");
      if (!ok) return "⚠️ Aún no hay SALIDA registrada. Primero registra salida.";
      await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, {
        visita_id: data.visita_id,
        tienda_nombre: tn,
        tipo_evento: "ASISTENCIA_SALIDA",
        paso: "FOTO",
      });
      return `🔁 Cambiar SALIDA – ${tn}\n📸 Envía la nueva foto.`;
    }

    // 5) entrada otra tienda
    if (lower === "5") {
      const asignadas = await getTiendasAsignadas(prom.promotor_id);
      const tiendas = asignadas.map(id => tiendaMap[id]).filter(t => t && t.activa);
      await setSession(telefono, STATE_ASIS_PICK_ENTRADA, { promotor_id: prom.promotor_id, tiendas, filtradas: [] });

      let msg = "🏬 *Entrada* – Elige tienda o escribe texto:\n\n";
      tiendas.slice(0, 10).forEach((t, idx) => msg += `*${nEmoji(idx)}* ${t.nombre_tienda}\n`);
      msg += "\nResponde con número o texto.";
      return msg;
    }

    // 6) historial
    if (lower === "6") {
      const { listado, msg } = await buildHistorial(telefono, prom.promotor_id);
      await setSession(telefono, STATE_ASIS_HIST, { listado });
      return msg;
    }

    // 7) menu
    if (lower === "7") {
      await setSession(telefono, STATE_MENU, {});
      return menuPromotor();
    }

    return "Responde con una opción del menú.";
  }

  // --- PICK ENTRADA (lista/búsqueda)
  if (estado === STATE_ASIS_PICK_ENTRADA) {
    const tiendas = data.tiendas || [];
    const q = norm(text);
    const nTry = parseInt(q, 10);

    if (Number.isNaN(nTry)) {
      const needle = q.toLowerCase();
      const filtradas = tiendas.filter(t =>
        (t.nombre_tienda || "").toLowerCase().includes(needle) ||
        (t.cadena || "").toLowerCase().includes(needle) ||
        (t.ciudad || "").toLowerCase().includes(needle)
      );
      if (!filtradas.length) return "⚠️ No encontré coincidencias. Escribe otro texto o `menu`.";
      await setSession(telefono, STATE_ASIS_PICK_ENTRADA, { ...data, filtradas });

      let msg = "🔎 Resultados:\n\n";
      filtradas.slice(0, 10).forEach((t, i) => msg += `*${nEmoji(i)}* ${t.nombre_tienda}\n`);
      msg += "\nResponde con número.";
      return msg;
    }

    const listado = (data.filtradas && data.filtradas.length) ? data.filtradas : tiendas;
    const idx = safeInt(q, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, listado.length)) return "⚠️ Elige un número válido.";
    const tienda = listado[idx];

    const open = await findOpenVisit(prom.promotor_id, tienda.tienda_id);
    if (open) return "⚠️ Ya tienes ENTRADA abierta en esa tienda. Registra SALIDA en Asistencia.";

    await setSession(telefono, STATE_ASIS_FOTO, {
      accion: "ENTRADA",
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      promotor_id: prom.promotor_id,
    });
    return `📸 Envía foto de *ENTRADA* – ${tienda.nombre_tienda}`;
  }

  // --- FOTO (entrada/salida)
  if (estado === STATE_ASIS_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito una foto. Adjunta y reenvía.";
    const fotoUrl = inbound?.MediaUrl0 || "";
    await setSession(telefono, STATE_ASIS_UBI, { ...data, fotoUrl });
    return "✅ Foto recibida.\n📍 Comparte ubicación (Share location).";
  }

  // --- UBI (entrada/salida)
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
        tipo_evidencia: "ASISTENCIA",
        descripcion: "",
      });

      await setSession(telefono, STATE_MENU, {});
      return `✅ Entrada registrada – *${data.tienda_nombre}*\n\n` + menuPromotor();
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
      tipo_evidencia: "ASISTENCIA",
      descripcion: "",
    });

    await setSession(telefono, STATE_MENU, {});
    return `✅ Salida registrada – *${data.tienda_nombre}*\n\n` + menuPromotor();
  }

  // --- HIST
  if (estado === STATE_ASIS_HIST) {
    const listado = data.listado || [];
    if (lower.startsWith("fotos")) {
      const idx = safeInt(lower.replace("fotos", "").trim(), -1) - 1;
      if (idx < 0 || idx >= listado.length) return "⚠️ Usa `fotos 1`..";
      const v = listado[idx];
      const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;

      const meta = await getAsistenciaMetaByVisita(v.visita_id);
      const medias = [];
      if (meta.entrada.url) medias.push(proxifyMediaUrl(baseUrl, meta.entrada.url));
      if (meta.salida.url) medias.push(proxifyMediaUrl(baseUrl, meta.salida.url));
      if (!medias.length) return `📭 No hay fotos de asistencia para ${tn}.`;

      const caption =
        `📷 *Asistencia* – ${tn}\n` +
        (meta.entrada.fecha_hora ? `🟢 Entrada: ${fmtDateTimeTZ(meta.entrada.fecha_hora)}\n` : "") +
        (meta.salida.fecha_hora ? `🔴 Salida: ${fmtDateTimeTZ(meta.salida.fecha_hora)}\n` : "");

      return { text: caption, mediaUrl: medias };
    }
    return "Comando: `fotos N` o `menu`.";
  }

  // --- CAMBIAR FOTO (foto -> ubicación)
  if (estado === STATE_ASIS_CAMBIAR_FOTO) {
    if (data.paso === "FOTO") {
      const numMedia = safeInt(inbound?.NumMedia || "0", 0);
      if (numMedia < 1) return "Necesito la nueva foto.";
      const newUrl = inbound?.MediaUrl0 || "";
      await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, { ...data, paso: "UBI", newUrl });
      return "✅ Foto recibida.\n📍 Comparte ubicación (para guardar lat/lon).";
    }
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    if (!lat || !lon) return "Necesito tu ubicación (Share location).";

    await registrarEvidencia({
      evidencia_id: `EV-${Date.now()}-1`,
      telefono,
      tipo_evento: data.tipo_evento,
      origen: "ASISTENCIA",
      visita_id: data.visita_id,
      url_foto: data.newUrl,
      lat, lon,
      tipo_evidencia: "ASISTENCIA",
      descripcion: `[CORRECCION_${data.tipo_evento}]`,
    });

    await setSession(telefono, STATE_MENU, {});
    return `✅ Foto actualizada (${data.tipo_evento}) – *${data.tienda_nombre}*\n\n` + menuPromotor();
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// EVIDENCIAS (captura)
// ==========================
async function startEvidencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const abiertas = await getOpenVisitsToday(prom.promotor_id);
  if (!abiertas.length) return "⚠️ No hay tienda activa (sin ENTRADA).";

  if (abiertas.length > 1) {
    const opciones = abiertas.map(v => ({
      visita_id: v.visita_id,
      tienda_id: v.tienda_id,
      tienda_nombre: tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id,
    }));
    await setSession(telefono, STATE_EVID_PICK_VISITA, { promotor_id: prom.promotor_id, opciones });

    let msg = "🏬 Tienes *varias tiendas activas*. Elige una:\n\n";
    opciones.slice(0,10).forEach((o,i) => msg += `*${nEmoji(i)}* ${o.tienda_nombre}\n`);
    msg += "\nResponde con número.";
    return msg;
  }

  const v = abiertas[0];
  const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;

  const marcas = await getMarcasActivas();
  await setSession(telefono, STATE_EVID_PICK_MARCA, {
    promotor_id: prom.promotor_id,
    visita_id: v.visita_id,
    tienda_nombre: tn,
    marcas,
  });

  let msg = `🏬 *${tn}*\n🏷️ Selecciona marca:\n\n`;
  marcas.slice(0,10).forEach((m,i) => msg += `*${nEmoji(i)}* ${m.marca_nombre}\n`);
  msg += "\nResponde con número.";
  return msg;
}

async function handleEvidencias(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_EVID_PICK_VISITA) {
    const opciones = data.opciones || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, opciones.length)) return "⚠️ Elige un número válido.";
    const o = opciones[idx];

    const marcas = await getMarcasActivas();
    await setSession(telefono, STATE_EVID_PICK_MARCA, {
      promotor_id: data.promotor_id,
      visita_id: o.visita_id,
      tienda_nombre: o.tienda_nombre,
      marcas,
    });

    let msg = `🏬 *${o.tienda_nombre}*\n🏷️ Selecciona marca:\n\n`;
    marcas.slice(0,10).forEach((m,i) => msg += `*${nEmoji(i)}* ${m.marca_nombre}\n`);
    msg += "\nResponde con número.";
    return msg;
  }

  if (estado === STATE_EVID_PICK_MARCA) {
    const marcas = data.marcas || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, marcas.length)) return "⚠️ Marca inválida.";
    const marca = marcas[idx];

    const reglas = await getReglasPorMarca(marca.marca_id);
    if (!reglas.length) return `⚠️ No hay reglas activas para ${marca.marca_nombre}.`;

    await setSession(telefono, STATE_EVID_PICK_TIPO, {
      ...data,
      marca_id: marca.marca_id,
      marca_nombre: marca.marca_nombre,
      reglas,
    });

    let msg = `🏷️ Marca: *${marca.marca_nombre}*\n\n🧾 Tipo de evidencia:\n\n`;
    reglas.slice(0,10).forEach((r,i) => msg += `*${nEmoji(i)}* ${r.tipo_evidencia} (fotos: ${r.fotos_requeridas}${r.requiere_antes_despues ? ", antes/después" : ""})\n`);
    msg += "\nResponde con número.";
    return msg;
  }

  if (estado === STATE_EVID_PICK_TIPO) {
    const reglas = data.reglas || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= reglas.length) return "⚠️ Tipo inválido.";
    const regla = reglas[idx];

    if (regla.requiere_antes_despues) {
      await setSession(telefono, STATE_EVID_PICK_FASE, { ...data, regla });
      return `🧾 *${regla.tipo_evidencia}*\n\n*${nEmoji(0)}* ANTES\n*${nEmoji(1)}* DESPUÉS`;
    }

    await setSession(telefono, STATE_EVID_FOTOS, { ...data, regla, fotos_requeridas: regla.fotos_requeridas, fotos_recibidas: 0 });
    return `📸 Envía *${regla.fotos_requeridas}* foto(s). (Puedes enviar varias juntas)`;
  }

  if (estado === STATE_EVID_PICK_FASE) {
    if (lower !== "1" && lower !== "2") return "Responde 1 o 2.";
    const fase = (lower === "1") ? "ANTES" : "DESPUES";
    await setSession(telefono, STATE_EVID_FOTOS, { ...data, fase, fotos_requeridas: data.regla.fotos_requeridas, fotos_recibidas: 0 });
    return `📸 Envía *${data.regla.fotos_requeridas}* foto(s) para *${fase}*.`;
  }

  if (estado === STATE_EVID_FOTOS) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    const needed = data.fotos_requeridas || 1;
    const already = data.fotos_recibidas || 0;

    if (numMedia < 1) {
      const faltan = Math.max(0, needed - already);
      return `Necesito foto(s). Faltan *${faltan}*.`;
    }

    const remaining = Math.max(0, needed - already);
    const accepted = Math.min(numMedia, remaining);
    const ignored = Math.max(0, numMedia - accepted);

    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    const descripcion = norm(inbound?.Body || "");

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
        marca_id: data.marca_id,
        tipo_evidencia: data.regla.tipo_evidencia,
        descripcion,
      });
    }

    const newCount = already + accepted;

    if (newCount < needed) {
      await setSession(telefono, STATE_EVID_FOTOS, { ...data, fotos_recibidas: newCount });
      const faltan = needed - newCount;
      return `✅ Recibí *${accepted}* foto(s)${ignored ? ` (ignoré ${ignored} extra)` : ""}.\n📌 Faltan *${faltan}*.`;
    }

    await setSession(telefono, STATE_MENU, {});
    return `✅ Evidencia completada (${needed})${ignored ? ` (ignoré ${ignored} extra)` : ""}.\n\n` + menuPromotor();
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// MIS EVIDENCIAS (por tienda, con conteo, ver todas)
// ==========================
async function startMisEvidencias(telefono, baseUrl) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const visitas = await getVisitsToday(prom.promotor_id);
  if (!visitas.length) return "📭 Hoy no tienes visitas registradas.";

  const visitaToTienda = {};
  visitas.forEach(v => visitaToTienda[v.visita_id] = v.tienda_id);

  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  const hoy = todayISO();

  const countByTienda = {};
  for (const r of rows) {
    if (norm(r[1]) !== telefono) continue;
    const fh = norm(r[2]);
    if (!fh) continue;
    const ymd = ymdInTZ(new Date(fh), APP_TZ);
    if (ymd !== hoy) continue;
    if (upper(r[4]) !== "EVIDENCIA") continue;

    const visita_id = norm(r[6]);
    const tid = visitaToTienda[visita_id] || "SIN_TIENDA";
    countByTienda[tid] = (countByTienda[tid] || 0) + 1;
  }

  const tiendasHoy = Array.from(new Set(visitas.map(v => v.tienda_id))).map(tid => ({
    tienda_id: tid,
    tienda_nombre: tiendaMap[tid]?.nombre_tienda || tid,
    fotos_hoy: countByTienda[tid] || 0,
  }));

  await setSession(telefono, STATE_MY_EVID_PICK_TIENDA, { promotor_id: prom.promotor_id, tiendasHoy });

  let msg = `📚 *Mis evidencias* (${hoy}) – por tienda\n\n`;
  tiendasHoy.slice(0,10).forEach((t,i) => {
    msg += `*${nEmoji(i)}* ${t.tienda_nombre} (${t.fotos_hoy})\n`;
  });
  msg += "\nElige tienda con número.";
  return msg;
}

async function handleMisEvidencias(telefono, estado, text, data, inbound, baseUrl) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_MY_EVID_PICK_TIENDA) {
    const tiendasHoy = data.tiendasHoy || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, tiendasHoy.length)) return "⚠️ Elige un número válido.";
    const tiendaSel = tiendasHoy[idx];

    const prom = await getPromotorPorTelefono(telefono);
    const visitas = await getVisitsToday(prom.promotor_id);
    const visitasT = visitas.filter(v => v.tienda_id === tiendaSel.tienda_id).map(v => v.visita_id);

    const rows = await getSheetValues("EVIDENCIAS!A2:Q");
    const hoy = todayISO();

    const list = rows
      .filter(r => {
        if (norm(r[1]) !== telefono) return false;
        const fh = norm(r[2]);
        if (!fh) return false;
        if (ymdInTZ(new Date(fh), APP_TZ) !== hoy) return false;
        if (upper(r[4]) !== "EVIDENCIA") return false;
        if (!visitasT.includes(norm(r[6]))) return false;
        return true;
      })
      .map(r => ({
        tipo_evento: norm(r[3]),
        url_foto: norm(r[7]),
        riesgo: upper(r[12] || "BAJO"),
        fecha_hora: norm(r[2]),
      }));

    if (!list.length) return `📭 No hay evidencias hoy en *${tiendaSel.tienda_nombre}*.`;

    await setSession(telefono, STATE_MY_EVID_LIST, { tiendaSel, list });

    let msg = `📷 *Evidencias – ${tiendaSel.tienda_nombre}* (${list.length})\n\n`;
    list.slice(0, 20).forEach((e,i) => {
      msg += `*${nEmoji(i)}* ${e.tipo_evento} – ${e.riesgo}\n`;
    });
    msg += "\nComandos:\n• `ver 3`\n• `ver todas`\n• `menu`";
    return msg;
  }

  if (estado === STATE_MY_EVID_LIST) {
    const list = data.list || [];

    if (lower === "ver todas") {
      const urls = list.map(x => x.url_foto).filter(Boolean).slice(0, 20);
      if (!urls.length) return "📭 No hay fotos para mostrar.";

      // En WhatsApp/TwiML: 1 media por mensaje es lo más estable.
      const msgs = urls.map((u, i) => ({
        text: `📷 ${data.tiendaSel?.tienda_nombre || ""} – ${i + 1}/${urls.length}`,
        mediaUrl: proxifyMediaUrl(baseUrl, u),
      }));

      return { messages: msgs };
    }

    const m = lower.match(/^ver\s+(\d+)/);
    if (m) {
      const idx = safeInt(m[1], 0) - 1;
      if (idx < 0 || idx >= list.length) return "⚠️ Número inválido.";
      const e = list[idx];
      const caption =
        `📷 Evidencia #${idx+1}\n` +
        `🧾 ${e.tipo_evento}\n` +
        `⚠️ ${e.riesgo}\n` +
        (e.fecha_hora ? `📅 ${fmtDateTimeTZ(e.fecha_hora)}\n` : "");
      return { text: caption, mediaUrl: proxifyMediaUrl(baseUrl, e.url_foto) };
    }

    return "Usa `ver N`, `ver todas` o `menu`.";
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

// ==========================
// SUPERVISOR (mínimo funcional)
// ==========================
async function getEvidenciasHoyForSupervisor() {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  const hoy = todayISO();
  return rows
    .filter(r => {
      const fh = norm(r[2]);
      if (!fh) return false;
      if (ymdInTZ(new Date(fh), APP_TZ) !== hoy) return false;
      return upper(r[4]) === "EVIDENCIA";
    })
    .map(r => ({
      evidencia_id: norm(r[0]),
      telefono: norm(r[1]),
      fecha_hora: norm(r[2]),
      tipo_evento: norm(r[3]),
      url_foto: norm(r[7]),
      riesgo: upper(r[12] || "BAJO"),
    }));
}

async function enviarFotoAGrupoCliente(ev, grupo) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) return { ok: false, enviados: 0 };
  let enviados = 0;

  for (const to of grupo.telefonos) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to,
        body: `🏪 Evidencia\n⚠️ ${ev.riesgo}\n🧾 ${ev.tipo_evento}\n📅 ${fmtDateTimeTZ(ev.fecha_hora)}`,
        mediaUrl: ev.url_foto ? [ev.url_foto] : undefined,
      });
      enviados++;
    } catch (e) {
      console.error("send to client failed:", to, e?.message || e);
    }
  }

  return { ok: enviados > 0, enviados };
}

async function handleSupervisor(telefono, estado, text, data, baseUrl) {
  const lower = norm(text).toLowerCase();
  const sup = await getSupervisorPorTelefono(telefono);
  if (!sup) { await setSession(telefono, STATE_MENU, {}); return "⚠️ No eres supervisor activo."; }

  if (lower === "menu") { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }
  if (lower === "ayuda") return ayudaSupervisor();
  if (lower === "sup") { await setSession(telefono, STATE_SUP_MENU, {}); return menuSupervisor(sup.nombre || "Supervisor"); }

  if (estado === STATE_SUP_MENU) {
    if (lower === "1") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      const evs = await getEvidenciasHoyForSupervisor();
      const counts = {};
      evs.forEach(e => counts[e.telefono] = (counts[e.telefono] || 0) + 1);

      let msg = `👀 *Evidencias hoy por promotor* (${todayISO()})\n\n`;
      equipo.slice(0,10).forEach((p, idx) => msg += `*${nEmoji(idx)}* ${p.nombre} – ${(counts[p.telefono] || 0)}\n`);
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

      let msg = "🧠📸 *MEDIO/ALTO (hoy)*\n\n";
      evs.slice(0,20).forEach((e,i) => msg += `*${nEmoji(i)}* ${e.tipo_evento} – ${e.promotor_nombre} – ${e.riesgo}\n`);
      msg += "\nComandos: `ver 2`, `enviar 1,3`, `enviar todas`, `sup`";
      await setSession(telefono, STATE_SUP_FOTOS_LIST, { listado: evs });
      return msg;
    }

    if (lower === "3") return ayudaSupervisor();
    return menuSupervisor(sup.nombre || "Supervisor");
  }

  if (estado === STATE_SUP_PROMOTOR_LIST) {
    const equipo = data.equipo || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= equipo.length) return "⚠️ Número inválido.";
    const p = equipo[idx];

    const evs = (await getEvidenciasHoyForSupervisor())
      .filter(e => e.telefono === p.telefono)
      .map(e => ({ ...e, promotor_nombre: p.nombre }));

    if (!evs.length) { await setSession(telefono, STATE_SUP_MENU, {}); return `⚠️ No hay evidencias hoy para ${p.nombre}.\n\n` + menuSupervisor(sup.nombre); }

    let msg = `📷 *Evidencias – ${p.nombre}*\n\n`;
    evs.slice(0, 20).forEach((e,i) => msg += `*${nEmoji(i)}* ${e.tipo_evento} – ${e.riesgo}\n`);
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
      return {
        text: `📷 Evidencia #${idx+1}\n🧾 ${e.tipo_evento}\n⚠️ ${e.riesgo}\n📅 ${fmtDateTimeTZ(e.fecha_hora)}`,
        mediaUrl: proxifyMediaUrl(baseUrl, e.url_foto),
      };
    }

    if (lower.startsWith("enviar")) {
      let resto = lower.replace(/^enviar\s*/, "").trim();
      let seleccionadas = [];

      if (resto === "todas" || resto === "todos") {
        seleccionadas = listado.slice();
      } else {
        const parts = resto.split(/[, ]+/).filter(Boolean);
        const idxs = [];
        for (const p of parts) {
          const n = safeInt(p, -1);
          if (n < 1 || n > listado.length) return "⚠️ Número fuera de rango.";
          idxs.push(n-1);
        }
        seleccionadas = Array.from(new Set(idxs)).map(i => listado[i]);
      }

      const grupos = await getGruposClienteActivos();
      if (!grupos.length) return "⚠️ No hay grupos activos en GRUPOS_CLIENTE.";

      let msg = `📤 Enviarás *${seleccionadas.length}* evidencia(s).\n\nElige grupo:\n`;
      grupos.slice(0,10).forEach((g,i) => msg += `*${nEmoji(i)}* ${g.nombre_grupo}\n`);
      msg += "\nResponde con número.";
      await setSession(telefono, STATE_SUP_ELEGIR_GRUPO, { seleccionadas, grupos });
      return msg;
    }

    return "Usa `ver N`, `enviar 1,3`, `enviar todas` o `sup`.";
  }

  if (estado === STATE_SUP_ELEGIR_GRUPO) {
    const grupos = data.grupos || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= grupos.length) return "⚠️ Grupo inválido.";
    const grupo = grupos[idx];

    let okCount = 0;
    for (const ev of (data.seleccionadas || [])) {
      const r = await enviarFotoAGrupoCliente(ev, grupo);
      if (r.ok) okCount++;
    }

    await setSession(telefono, STATE_SUP_MENU, {});
    return `✅ Enviadas ${okCount} evidencia(s) a *${grupo.nombre_grupo}*.\n\n` + menuSupervisor(sup.nombre || "Supervisor");
  }

  await setSession(telefono, STATE_SUP_MENU, {});
  return menuSupervisor(sup.nombre || "Supervisor");
}

// ==========================
// Router principal + idempotencia + multi-messages
// ==========================
async function handleIncoming(from, body, inbound, baseUrl) {
  const telefono = norm(from);
  const text = norm(body);
  const lower = text.toLowerCase();

  const msgSid = norm(inbound?.MessageSid || "");
  const ses = await getSession(telefono);

  // Idempotencia (retry)
  if (msgSid && ses.data_json?._last_sid === msgSid && ses.data_json?._last_resp) {
    return ses.data_json._last_resp;
  }

  // global commands
  if (lower === "menu" || lower === "inicio") {
    await setSession(telefono, STATE_MENU, {});
    return menuPromotor();
  }

  if (lower === "ayuda" || lower === "help" || lower === "?") {
    await setSession(telefono, STATE_MENU, {});
    return ayudaPromotor();
  }

  if (lower === "sup") {
    const sup = await getSupervisorPorTelefono(telefono);
    if (!sup) return "⚠️ Tu número no está dado de alta como supervisor.";
    await setSession(telefono, STATE_SUP_MENU, {});
    return menuSupervisor(sup.nombre || "Supervisor");
  }

  const estado = ses.estado_actual;
  const data = ses.data_json || {};

  // Supervisor
  if ([STATE_SUP_MENU, STATE_SUP_PROMOTOR_LIST, STATE_SUP_FOTOS_LIST, STATE_SUP_ELEGIR_GRUPO].includes(estado)) {
    return await handleSupervisor(telefono, estado, text, data, baseUrl);
  }

  // Menu principal
  if (estado === STATE_MENU) {
    if (lower === "1") { await setSession(telefono, STATE_ASIS_HOME, {}); return await startAsistenciaHome(telefono); }
    if (lower === "2") { return await startEvidencias(telefono); }
    if (lower === "3") { return await startMisEvidencias(telefono, baseUrl); }
    if (lower === "4") { await setSession(telefono, STATE_MENU, {}); return await resumenDia(telefono); }
    if (lower === "5") { await setSession(telefono, STATE_MENU, {}); return ayudaPromotor(); }
    return menuPromotor();
  }

  // Asistencia flow
  if ([STATE_ASIS_HOME, STATE_ASIS_PICK_ENTRADA, STATE_ASIS_PICK_ACTIVA, STATE_ASIS_ACTIVA_MENU, STATE_ASIS_FOTO, STATE_ASIS_UBI, STATE_ASIS_HIST, STATE_ASIS_CAMBIAR_FOTO].includes(estado)) {
    return await handleAsistencia(telefono, estado, text, data, inbound, baseUrl);
  }

  // Evidencias flow
  if ([STATE_EVID_PICK_VISITA, STATE_EVID_PICK_MARCA, STATE_EVID_PICK_TIPO, STATE_EVID_PICK_FASE, STATE_EVID_FOTOS].includes(estado)) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
  }

  // Mis evidencias flow
  if ([STATE_MY_EVID_PICK_TIENDA, STATE_MY_EVID_LIST].includes(estado)) {
    return await handleMisEvidencias(telefono, estado, text, data, inbound, baseUrl);
  }

  await setSession(telefono, STATE_MENU, {});
  return menuPromotor();
}

app.post("/whatsapp", async (req, res) => {
  const from = norm(req.body.From);
  const body = norm(req.body.Body);
  const baseUrl = buildBaseUrl(req);

  const run = async () => {
    let respuesta;
    try {
      respuesta = await handleIncoming(from, body, req.body, baseUrl);
    } catch (e) {
      console.error("Error:", e?.message || e);
      respuesta = "Ocurrió un error procesando tu mensaje. Intenta de nuevo 🙏";
    }

    // guardar meta idempotencia (texto)
    const sid = norm(req.body.MessageSid || "");
    if (sid) {
      const respText =
        (typeof respuesta === "string")
          ? respuesta
          : (respuesta?.text || (respuesta?.messages?.[0]?.text || ""));
      await setSessionMeta(norm(from), { _last_sid: sid, _last_resp: respText });
    }

    const twiml = new MessagingResponse();

    if (typeof respuesta === "string") {
      twiml.message(respuesta);
    } else if (respuesta && typeof respuesta === "object") {
      if (respuesta.messages && Array.isArray(respuesta.messages)) {
        // multi mensajes (ver todas)
        for (const m of respuesta.messages) {
          const msg = twiml.message(m.text || "");
          if (m.mediaUrl) msg.media(m.mediaUrl);
          if (m.mediaUrls && Array.isArray(m.mediaUrls)) {
            m.mediaUrls.filter(Boolean).forEach(u => msg.media(u));
          }
        }
      } else {
        const msg = twiml.message(respuesta.text || "");
        if (respuesta.mediaUrl) {
          const arr = Array.isArray(respuesta.mediaUrl) ? respuesta.mediaUrl : [respuesta.mediaUrl];
          arr.filter(Boolean).forEach(u => msg.media(u));
        }
      }
    } else {
      twiml.message("Ocurrió un error.");
    }

    res.type("text/xml");
    res.send(twiml.toString());
  };

  await withUserLock(from, run);
});

app.get("/", (req, res) => res.send("Promobolsillo+ piloto REZGO ✅"));
app.listen(PORT, () => console.log(`🚀 Promobolsillo+ escuchando en puerto ${PORT}`));
