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
// TZ (CDMX)
// ==========================
const APP_TZ = "America/Mexico_City";

function ymdInTZ(date = new Date(), tz = APP_TZ) {
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
// Twilio client (outbound)
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
// LOCK por usuario (evita concurrencia)
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

function tipsFoto() {
  return (
    "📸 *Cómo enviar foto*\n" +
    "1) Toca el clip 📎\n" +
    "2) Elige *Cámara* 📷\n" +
    "3) Toma la foto y envía ✅"
  );
}

function tipsUbicacion() {
  return (
    "📍 *Cómo enviar ubicación*\n" +
    "1) Toca el clip 📎\n" +
    "2) Elige *Ubicación* 📍\n" +
    "3) Pulsa *Enviar ubicación actual* ✅"
  );
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
const STATE_ASIS_CAMBIAR_FOTO = "ASIS_CAMBIAR_FOTO";

// Evidencias
const STATE_EVID_PICK_VISITA = "EVID_PICK_VISITA";
const STATE_EVID_PICK_MARCA = "EVID_PICK_MARCA";
const STATE_EVID_PICK_TIPO = "EVID_PICK_TIPO";
const STATE_EVID_PICK_FASE = "EVID_PICK_FASE";
const STATE_EVID_FOTOS = "EVID_FOTOS";
const STATE_EVID_POST = "EVID_POST";

// Mis evidencias
const STATE_MY_EVID_PICK_TIENDA = "MY_EVID_PICK_TIENDA";
const STATE_MY_EVID_LIST = "MY_EVID_LIST";
const STATE_MY_EVID_REPLACE = "MY_EVID_REPLACE";

// Atajo “activas”
const STATE_ACTIVAS_PICK = "ACTIVAS_PICK";
const STATE_ACTIVAS_ACTION = "ACTIVAS_ACTION";

// Supervisor (se mantiene, no tocamos alcance aquí)
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";

// ==========================
// SESIONES (SESIONES A:telefono B:estado C:data_json)
// ==========================
function mergePersist(prev, next) {
  // Persistimos pending evidence aunque el estado se vaya a MENU
  const persistedKeys = ["_pending_evid"];
  const out = { ...next };
  for (const k of persistedKeys) {
    if (out[k] === undefined && prev && prev[k] !== undefined) out[k] = prev[k];
  }
  // siempre preserva meta de idempotencia si no viene
  if (out._last_sid === undefined && prev?._last_sid) out._last_sid = prev._last_sid;
  if (out._last_resp === undefined && prev?._last_resp) out._last_resp = prev._last_resp;
  return out;
}

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
  const merged = mergePersist(prev, data_json);
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
async function getVisitsToday(promotor_id) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const fecha = todayISO();
  return rows
    .filter((r) => norm(r[1]) === promotor_id && norm(r[3]) === fecha)
    .map((r) => ({
      visita_id: norm(r[0]),
      promotor_id: norm(r[1]),
      tienda_id: norm(r[2]),
      fecha: norm(r[3]),
      hora_inicio: norm(r[4]),
      hora_fin: norm(r[5]),
    }));
}

async function getOpenVisitsToday(promotor_id) {
  const visits = await getVisitsToday(promotor_id);
  return visits.filter(v => !v.hora_fin).map(v => ({ visita_id: v.visita_id, tienda_id: v.tienda_id }));
}

async function getLastVisits(promotor_id, limit = 10) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const visits = rows
    .filter(r => norm(r[1]) === promotor_id)
    .map(r => ({
      visita_id: norm(r[0]),
      promotor_id: norm(r[1]),
      tienda_id: norm(r[2]),
      fecha: norm(r[3]),
      hora_inicio: norm(r[4]),
      hora_fin: norm(r[5]),
    }));
  visits.sort((a, b) => (b.hora_inicio || "").localeCompare(a.hora_inicio || ""));
  return visits.slice(0, limit);
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

async function getMarcaMap() {
  const rows = await getSheetValues("MARCAS!A2:D");
  const map = {};
  for (const r of rows) {
    const id = norm(r[0]);
    if (!id) continue;
    const nombre = r.length >= 4 ? norm(r[2]) : norm(r[1]);
    const activa = r.length >= 4 ? isTrue(r[3]) : isTrue(r[2]);
    map[id] = { marca_id: id, marca_nombre: nombre, activa };
  }
  return map;
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
// EVIDENCIAS (A:Q)
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

function tagAppend(desc, tag) {
  const d = norm(desc);
  if (!d) return tag;
  return d.includes(tag) ? d : `${d} | ${tag}`;
}
function makeStatusTag(k, v) {
  return `${k}=${(v || "").toString().replace(/\|/g, "/")}`;
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

async function findEvidenciaRowById(evidencia_id) {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  for (let i = 0; i < rows.length; i++) {
    if (norm(rows[i][0]) === evidencia_id) {
      return { rowIndex: i + 2, row: rows[i] };
    }
  }
  return null;
}

async function updateEvidenciaDescripcion(evidencia_id, patchText) {
  const found = await findEvidenciaRowById(evidencia_id);
  if (!found) return false;
  const currentDesc = norm(found.row[16] || "");
  const nextDesc = tagAppend(currentDesc, patchText);
  await updateSheetValues(`EVIDENCIAS!Q${found.rowIndex}:Q${found.rowIndex}`, [[nextDesc]]);
  return true;
}

function isEvidenciaCancelada(desc) {
  return upper(desc).includes("STATUS=ANULADA") || upper(desc).includes("STATUS=REEMPLAZADA");
}

async function hasAsistenciaEvento(visita_id, tipo_evento) {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  for (const r of rows) {
    if (norm(r[6]) === visita_id && upper(r[4]) === "ASISTENCIA" && norm(r[3]) === tipo_evento) return true;
  }
  return false;
}

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
// Pending evidence (continuar)
// ==========================
function setPendingEvid(prevJson, pending) {
  return { ...(prevJson || {}), _pending_evid: pending };
}

function clearPendingEvid(prevJson) {
  const out = { ...(prevJson || {}) };
  delete out._pending_evid;
  return out;
}

function pendingIsFresh(p) {
  const ts = safeInt(p?.ts || 0, 0);
  if (!ts) return false;
  const ageMs = Date.now() - ts;
  return ageMs < 12 * 60 * 60 * 1000; // 12h
}

async function resumePendingEvidence(telefono, sessionData) {
  const p = sessionData?._pending_evid;
  if (!p || !pendingIsFresh(p)) return null;

  // reconstruye prompt según step
  if (p.step === "FOTOS") {
    await setSession(telefono, STATE_EVID_FOTOS, {
      ...sessionData,
      visita_id: p.visita_id,
      tienda_nombre: p.tienda_nombre,
      marca_id: p.marca_id,
      marca_nombre: p.marca_nombre,
      regla: p.regla,
      fase: p.fase || "NA",
      fotos_requeridas: p.fotos_requeridas,
      fotos_recibidas: p.fotos_recibidas || 0,
      _pending_evid: p,
    });
    const faltan = Math.max(0, (p.fotos_requeridas || 1) - (p.fotos_recibidas || 0));
    return (
      `⏯️ *Continuando evidencia pendiente*\n` +
      `🏬 ${p.tienda_nombre}\n` +
      `🏷️ ${p.marca_nombre}\n` +
      `🧾 ${p.regla?.tipo_evidencia}\n\n` +
      `📸 Faltan *${faltan}* foto(s).\n` +
      `${tipsFoto()}\n\n` +
      "Envía las fotos ahora."
    );
  }

  if (p.step === "POST") {
    await setSession(telefono, STATE_EVID_POST, { ...sessionData, ...p, _pending_evid: p });
    return (
      "⏯️ *Continuando*\n\n" +
      "Tu última evidencia ya quedó completa.\n" +
      "Elige qué hacer:\n" +
      `*${nEmoji(0)}* Nueva evidencia (misma marca + mismo tipo)\n` +
      `*${nEmoji(1)}* Nueva evidencia (misma marca, otro tipo)\n` +
      `*${nEmoji(2)}* Cambiar marca\n` +
      `*${nEmoji(3)}* Menú`
    );
  }

  // Si no sabemos, manda a flujo normal
  return null;
}

// ==========================
// GRUPOS_CLIENTE (para supervisor; no tocado aquí)
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
// Menús promotor (dinámico si hay pendiente)
// ==========================
function menuPromotor(hasPending = false) {
  const extra = hasPending ? `\n*${nEmoji(5)}* Continuar evidencia pendiente ⏯️` : "";
  return (
    "👋 *Promobolsillo+*\n\n" +
    `*${nEmoji(0)}* Asistencia\n` +
    `*${nEmoji(1)}* Evidencias\n` +
    `*${nEmoji(2)}* Mis evidencias\n` +
    `*${nEmoji(3)}* Resumen del día\n` +
    `*${nEmoji(4)}* Ayuda\n` +
    extra +
    "\n\nAtajos: `activas`, `continuar`, `menu`, `ayuda`"
  );
}

// Ayuda contextual
function ayudaContextual(estado) {
  // Si está esperando foto/ubicación, la ayuda cambia
  if (estado === STATE_ASIS_FOTO || estado === STATE_EVID_FOTOS || estado === STATE_MY_EVID_REPLACE || estado === STATE_ASIS_CAMBIAR_FOTO) {
    return "🆘 *Ayuda*\n\n" + tipsFoto() + "\n\nSi mandaste texto por error, vuelve a adjuntar la foto y envía.";
  }
  if (estado === STATE_ASIS_UBI) {
    return "🆘 *Ayuda*\n\n" + tipsUbicacion() + "\n\nSi mandaste texto por error, vuelve a compartir tu ubicación.";
  }
  if (estado === STATE_MY_EVID_LIST) {
    return (
      "🆘 *Ayuda – Mis evidencias*\n\n" +
      "• `ver 3`\n" +
      "• `ver todas`\n" +
      "• `anular 2 motivo`\n" +
      "• `reemplazar 1`\n" +
      "• `nota 4 texto...`\n"
    );
  }
  if (estado === STATE_ASIS_HIST) {
    return "🆘 *Ayuda – Historial*\n\nComando: `fotos N` para ver fotos de esa visita.";
  }
  if (estado === STATE_EVID_POST) {
    return "🆘 *Ayuda – Evidencias*\n\nElige 1–4 para nueva tanda / cambiar tipo / cambiar marca / menú.";
  }
  return (
    "🆘 *Ayuda*\n\n" +
    "• `activas` → ver tiendas abiertas hoy\n" +
    "• `continuar` → retomar evidencia pendiente\n" +
    "• `menu` → menú principal\n"
  );
}

// ==========================
// 2) Atajo "activas"
// ==========================
async function showActivasMenu(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const abiertas = await getOpenVisitsToday(prom.promotor_id);

  if (!abiertas.length) {
    return "📭 No tienes tiendas activas hoy (sin ENTRADA). Usa *Asistencia* para registrar entrada.";
  }

  const opciones = abiertas.map(a => ({
    visita_id: a.visita_id,
    tienda_id: a.tienda_id,
    tienda_nombre: tiendaMap[a.tienda_id]?.nombre_tienda || a.tienda_id,
  }));

  await setSession(telefono, STATE_ACTIVAS_PICK, { promotor_id: prom.promotor_id, opciones });

  let msg = "🏬 *Tiendas activas hoy*\n\nElige una:\n\n";
  opciones.slice(0, 10).forEach((o, i) => { msg += `*${nEmoji(i)}* ${o.tienda_nombre}\n`; });
  msg += "\nResponde con número.";
  return msg;
}

async function handleActivas(telefono, estado, text, data) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_ACTIVAS_PICK) {
    const opciones = data.opciones || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, opciones.length)) return "⚠️ Elige un número válido.";
    const sel = opciones[idx];

    await setSession(telefono, STATE_ACTIVAS_ACTION, { ...data, sel });

    return (
      `🏬 *${sel.tienda_nombre}*\n\n¿Qué quieres hacer?\n` +
      `*${nEmoji(0)}* Registrar salida\n` +
      `*${nEmoji(1)}* Capturar evidencias\n` +
      `*${nEmoji(2)}* Ver fotos de asistencia\n` +
      `*${nEmoji(3)}* Cancelar`
    );
  }

  if (estado === STATE_ACTIVAS_ACTION) {
    const sel = data.sel;
    if (!sel) { await setSession(telefono, STATE_MENU, {}); return "Reinicié. Escribe `activas` de nuevo."; }

    if (lower === "1") {
      // ir directo a salida (asistencia foto)
      await setSession(telefono, STATE_ASIS_FOTO, {
        accion: "SALIDA",
        visita_id: sel.visita_id,
        tienda_id: sel.tienda_id,
        tienda_nombre: sel.tienda_nombre,
      });
      return `📸 Envía foto de *SALIDA* – ${sel.tienda_nombre}\n\n${tipsFoto()}`;
    }

    if (lower === "2") {
      // ir a evidencias con esa visita fija
      const marcas = await getMarcasActivas();
      await setSession(telefono, STATE_EVID_PICK_MARCA, {
        visita_id: sel.visita_id,
        tienda_nombre: sel.tienda_nombre,
        marcas,
      });
      let msg = `🏬 *${sel.tienda_nombre}*\n🏷️ Selecciona marca:\n\n`;
      marcas.slice(0, 10).forEach((m, i) => msg += `*${nEmoji(i)}* ${m.marca_nombre}\n`);
      msg += "\nResponde con número.";
      return msg;
    }

    if (lower === "3") {
      await setSession(telefono, STATE_ASIS_ACTIVA_MENU, {
        visita_id: sel.visita_id,
        tienda_id: sel.tienda_id,
        tienda_nombre: sel.tienda_nombre,
      });
      return (
        `🕒 *Asistencia* – Tienda activa: *${sel.tienda_nombre}*\n\n` +
        `*${nEmoji(0)}* Registrar *SALIDA*\n` +
        `*${nEmoji(1)}* Ver fotos asistencia\n` +
        `*${nEmoji(2)}* Cambiar foto ENTRADA\n` +
        `*${nEmoji(3)}* Cambiar foto SALIDA\n` +
        `*${nEmoji(4)}* Volver (lista de activas)\n` +
        `*${nEmoji(5)}* Menú`
      );
    }

    await setSession(telefono, STATE_MENU, {});
    return menuPromotor(!!data?._pending_evid);
  }

  await setSession(telefono, STATE_MENU, {});
  return "Reinicié. Escribe `activas`.";
}

// ==========================
// 4) Resumen del día (por tienda + marcas)
// ==========================
async function resumenDiaDetallado(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const marcaMap = await getMarcaMap();
  const hoy = todayISO();

  const visits = await getVisitsToday(prom.promotor_id);
  const byTienda = {};
  for (const v of visits) {
    const tid = v.tienda_id;
    if (!byTienda[tid]) byTienda[tid] = {
      tienda_id: tid,
      tienda_nombre: tiendaMap[tid]?.nombre_tienda || tid,
      entrada: v.hora_inicio || "",
      salida: v.hora_fin || "",
      evid_total: 0,
      evid_by_marca: {},
    };
  }

  // evidencias de hoy, del teléfono
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  for (const r of rows) {
    if (norm(r[1]) !== telefono) continue;
    const fh = norm(r[2]);
    if (!fh) continue;
    if (ymdInTZ(new Date(fh), APP_TZ) !== hoy) continue;

    const origen = upper(r[4]);
    if (origen !== "EVIDENCIA") continue;

    const visita_id = norm(r[6]);
    const marca_id = norm(r[13]);
    // Map visita->tienda via visits list
    const v = visits.find(x => x.visita_id === visita_id);
    if (!v) continue;

    const tid = v.tienda_id;
    if (!byTienda[tid]) continue;

    const bn = marcaMap[marca_id]?.marca_nombre || (marca_id || "SIN_MARCA");
    byTienda[tid].evid_total++;
    byTienda[tid].evid_by_marca[bn] = (byTienda[tid].evid_by_marca[bn] || 0) + 1;
  }

  const abiertas = visits.filter(v => !v.hora_fin).length;
  const cerradas = visits.filter(v => v.hora_fin).length;

  let msg = `📊 *Resumen del día* (${hoy})\n\n`;
  msg += `🏬 Visitas: ${visits.length} (abiertas ${abiertas}, cerradas ${cerradas})\n\n`;

  const tiendas = Object.values(byTienda);
  if (!tiendas.length) {
    msg += "📭 Hoy no tienes visitas.\n";
    msg += "\nTip: usa *Asistencia* para registrar entrada.";
    return msg;
  }

  // listado por tienda (máximo 8 para no saturar)
  tiendas.slice(0, 8).forEach((t, idx) => {
    const ent = t.entrada ? fmtDateTimeTZ(t.entrada) : "—";
    const sal = t.salida ? fmtDateTimeTZ(t.salida) : "pendiente";
    msg += `*${nEmoji(idx)}* ${t.tienda_nombre}\n`;
    msg += `   🟢 Entrada: ${ent}\n`;
    msg += `   🔴 Salida: ${sal}\n`;
    msg += `   📸 Evidencias: ${t.evid_total}\n`;

    const marcas = Object.entries(t.evid_by_marca).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (marcas.length) {
      msg += `   🏷️ Marcas: ${marcas.map(([k, v]) => `${k}(${v})`).join(", ")}\n`;
    }
  });

  msg += "\nAtajos: `activas`, `menu`";
  return msg;
}

// ==========================
// Asistencia (igual base) + reintentos guiados
// ==========================
async function buildHistorial(promotor_id) {
  const tiendaMap = await getTiendaMap();
  const out = await getLastVisits(promotor_id, 10);

  let msg = "📚 *Historial (últimas 10)*\n\n";
  out.forEach((v, idx) => {
    const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;
    const ent = v.hora_inicio ? fmtDateTimeTZ(v.hora_inicio) : "—";
    const sal = v.hora_fin ? fmtDateTimeTZ(v.hora_fin) : "pendiente";
    msg += `*${nEmoji(idx)}* ${v.fecha} – ${tn}\n   🟢 ${ent}\n   🔴 ${sal}\n`;
  });
  msg += "\nComando: `fotos N` para ver fotos de esa visita.\n`menu` para volver.";
  return { listado: out, msg };
}

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

  await setSession(telefono, STATE_ASIS_PICK_ACTIVA, { promotor_id: prom.promotor_id });

  let msg = "🕒 *Asistencia*\n\n⚠️ Tienes *varias tiendas activas*. Elige cuál administrar:\n\n";
  abiertas.slice(0, 10).forEach((a, idx) => {
    const tn = tiendaMap[a.tienda_id]?.nombre_tienda || a.tienda_id;
    msg += `*${nEmoji(idx)}* ${tn}\n`;
  });
  msg += "\nResponde con el número.\n\nTip: también puedes usar el atajo `activas`.";
  return msg;
}

async function handleAsistencia(telefono, estado, text, data, inbound, baseUrl) {
  const lower = norm(text).toLowerCase();
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) { await setSession(telefono, STATE_MENU, data); return "⚠️ No estás como promotor activo."; }

  const tiendaMap = await getTiendaMap();

  if (estado === STATE_ASIS_HOME) {
    if (lower === "3") { await setSession(telefono, STATE_MENU, data); return menuPromotor(!!data?._pending_evid); }

    if (lower === "1") {
      const asignadas = await getTiendasAsignadas(prom.promotor_id);
      const tiendas = asignadas.map(id => tiendaMap[id]).filter(t => t && t.activa);

      await setSession(telefono, STATE_ASIS_PICK_ENTRADA, { promotor_id: prom.promotor_id, tiendas, filtradas: data.filtradas || [] });

      let msg = "🏬 *Entrada* – Elige tienda o escribe texto para buscar:\n\n";
      tiendas.slice(0, 10).forEach((t, idx) => msg += `*${nEmoji(idx)}* ${t.nombre_tienda}\n`);
      msg += "\nResponde con número o texto.";
      return msg;
    }

    if (lower === "2") {
      const { listado, msg } = await buildHistorial(prom.promotor_id);
      await setSession(telefono, STATE_ASIS_HIST, { listado });
      return msg;
    }

    return await startAsistenciaHome(telefono);
  }

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
      `*${nEmoji(4)}* Volver (lista de activas)\n` +
      `*${nEmoji(5)}* Volver al menú`
    );
  }

  if (estado === STATE_ASIS_ACTIVA_MENU) {
    const tn = data.tienda_nombre || "Tienda";

    if (lower === "5") return await startAsistenciaHome(telefono);
    if (lower === "6") { await setSession(telefono, STATE_MENU, data); return menuPromotor(!!data?._pending_evid); }

    if (lower === "1") {
      await setSession(telefono, STATE_ASIS_FOTO, {
        accion: "SALIDA",
        visita_id: data.visita_id,
        tienda_id: data.tienda_id,
        tienda_nombre: tn,
        promotor_id: prom.promotor_id,
      });
      return `📸 Envía foto de *SALIDA* – ${tn}\n\n${tipsFoto()}`;
    }

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

    if (lower === "3") {
      const ok = await hasAsistenciaEvento(data.visita_id, "ASISTENCIA_ENTRADA");
      if (!ok) return "⚠️ No existe foto de ENTRADA para cambiar.";
      await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, {
        visita_id: data.visita_id,
        tienda_nombre: tn,
        tipo_evento: "ASISTENCIA_ENTRADA",
        paso: "FOTO",
      });
      return `🔁 Cambiar ENTRADA – ${tn}\n\n${tipsFoto()}`;
    }

    if (lower === "4") {
      const ok = await hasAsistenciaEvento(data.visita_id, "ASISTENCIA_SALIDA");
      if (!ok) return "⚠️ Aún no hay SALIDA registrada. Primero registra salida.";
      await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, {
        visita_id: data.visita_id,
        tienda_nombre: tn,
        tipo_evento: "ASISTENCIA_SALIDA",
        paso: "FOTO",
      });
      return `🔁 Cambiar SALIDA – ${tn}\n\n${tipsFoto()}`;
    }

    if (lower === "5") {
      const asignadas = await getTiendasAsignadas(prom.promotor_id);
      const tiendas = asignadas.map(id => tiendaMap[id]).filter(t => t && t.activa);
      await setSession(telefono, STATE_ASIS_PICK_ENTRADA, { promotor_id: prom.promotor_id, tiendas, filtradas: [] });

      let msg = "🏬 *Entrada* – Elige tienda o escribe texto:\n\n";
      tiendas.slice(0, 10).forEach((t, idx) => msg += `*${nEmoji(idx)}* ${t.nombre_tienda}\n`);
      msg += "\nResponde con número o texto.";
      return msg;
    }

    if (lower === "6") {
      const { listado, msg } = await buildHistorial(prom.promotor_id);
      await setSession(telefono, STATE_ASIS_HIST, { listado });
      return msg;
    }

    return "Responde con una opción del menú.";
  }

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
    if (open) return "⚠️ Ya tienes ENTRADA abierta en esa tienda. Usa `activas` o Asistencia para registrar SALIDA.";

    await setSession(telefono, STATE_ASIS_FOTO, {
      accion: "ENTRADA",
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      promotor_id: prom.promotor_id,
    });
    return `📸 Envía foto de *ENTRADA* – ${tienda.nombre_tienda}\n\n${tipsFoto()}`;
  }

  if (estado === STATE_ASIS_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) {
      return `Necesito una *foto*.\n\n${tipsFoto()}`;
    }
    const fotoUrl = inbound?.MediaUrl0 || "";
    await setSession(telefono, STATE_ASIS_UBI, { ...data, fotoUrl });
    return `✅ Foto recibida.\n\nAhora necesito tu ubicación.\n\n${tipsUbicacion()}`;
  }

  if (estado === STATE_ASIS_UBI) {
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    if (!lat || !lon) {
      return `Necesito tu *ubicación*.\n\n${tipsUbicacion()}`;
    }

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

      await setSession(telefono, STATE_MENU, data);
      return `✅ Entrada registrada – *${data.tienda_nombre}*\n\n` + menuPromotor(!!data?._pending_evid);
    }

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

    await setSession(telefono, STATE_MENU, data);
    return `✅ Salida registrada – *${data.tienda_nombre}*\n\n` + menuPromotor(!!data?._pending_evid);
  }

  if (estado === STATE_ASIS_HIST) {
    const listado = data.listado || [];
    const cmd = lower.trim();

    if (cmd.startsWith("fotos")) {
      const idx = safeInt(cmd.replace("fotos", "").trim(), -1) - 1;
      if (idx < 0 || idx >= listado.length) return "⚠️ Usa `fotos 1`, `fotos 2`, etc.";
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

  if (estado === STATE_ASIS_CAMBIAR_FOTO) {
    if (data.paso === "FOTO") {
      const numMedia = safeInt(inbound?.NumMedia || "0", 0);
      if (numMedia < 1) return `Necesito la nueva foto.\n\n${tipsFoto()}`;
      const newUrl = inbound?.MediaUrl0 || "";
      await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, { ...data, paso: "UBI", newUrl });
      return `✅ Foto recibida.\n\nAhora comparte ubicación.\n\n${tipsUbicacion()}`;
    }
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";
    if (!lat || !lon) return `Necesito ubicación.\n\n${tipsUbicacion()}`;

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

    await setSession(telefono, STATE_MENU, data);
    return `✅ Foto actualizada (${data.tipo_evento}) – *${data.tienda_nombre}*\n\n` + menuPromotor(!!data?._pending_evid);
  }

  await setSession(telefono, STATE_MENU, data);
  return menuPromotor(!!data?._pending_evid);
}

// ==========================
// EVIDENCIAS (captura) + POST
// ==========================
function postEvidMenu(ctx) {
  return (
    "✅ Evidencia completada.\n\n" +
    `🏬 ${ctx.tienda_nombre}\n` +
    `🏷️ ${ctx.marca_nombre}\n` +
    `🧾 ${ctx.tipo_evidencia}\n\n` +
    `*${nEmoji(0)}* Nueva evidencia (misma marca + mismo tipo)\n` +
    `*${nEmoji(1)}* Nueva evidencia (misma marca, otro tipo)\n` +
    `*${nEmoji(2)}* Cambiar marca\n` +
    `*${nEmoji(3)}* Menú\n`
  );
}

async function startEvidencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const abiertas = await getOpenVisitsToday(prom.promotor_id);
  if (!abiertas.length) return "⚠️ No hay tienda activa (sin ENTRADA). Usa *Asistencia* para registrar entrada.";

  if (abiertas.length > 1) {
    const opciones = abiertas.map(v => ({
      visita_id: v.visita_id,
      tienda_id: v.tienda_id,
      tienda_nombre: tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id,
    }));
    await setSession(telefono, STATE_EVID_PICK_VISITA, { promotor_id: prom.promotor_id, opciones });

    let msg = "🏬 Tienes *varias tiendas activas*. Elige una:\n\n";
    opciones.slice(0,10).forEach((o,i) => msg += `*${nEmoji(i)}* ${o.tienda_nombre}\n`);
    msg += "\nResponde con número.\n\nTip: también puedes usar `activas`.";
    return msg;
  }

  const v = abiertas[0];
  const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;

  const marcas = await getMarcasActivas();
  const pending = { ts: Date.now(), step: "PICK_MARCA", visita_id: v.visita_id, tienda_nombre: tn };

  await setSession(telefono, STATE_EVID_PICK_MARCA, {
    promotor_id: prom.promotor_id,
    visita_id: v.visita_id,
    tienda_nombre: tn,
    marcas,
    _pending_evid: pending,
  });

  let msg = `🏬 *${tn}*\n🏷️ Selecciona marca:\n\n`;
  marcas.slice(0,10).forEach((m,i) => msg += `*${nEmoji(i)}* ${m.marca_nombre}\n`);
  msg += "\nResponde con número.";
  return msg;
}

async function handleEvidencias(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_EVID_POST) {
    if (lower === "1") {
      const regla = data.regla;
      const pending = {
        ts: Date.now(),
        step: "FOTOS",
        visita_id: data.visita_id,
        tienda_nombre: data.tienda_nombre,
        marca_id: data.marca_id,
        marca_nombre: data.marca_nombre,
        regla,
        fase: data.fase || "NA",
        fotos_requeridas: regla.fotos_requeridas,
        fotos_recibidas: 0,
      };
      await setSession(telefono, STATE_EVID_FOTOS, { ...data, fotos_requeridas: regla.fotos_requeridas, fotos_recibidas: 0, _pending_evid: pending });
      return `📸 Envía *${regla.fotos_requeridas}* foto(s). (Nueva tanda)\n\n${tipsFoto()}`;
    }

    if (lower === "2") {
      const reglas = await getReglasPorMarca(data.marca_id);
      const pending = { ts: Date.now(), step: "PICK_TIPO", visita_id: data.visita_id, tienda_nombre: data.tienda_nombre, marca_id: data.marca_id, marca_nombre: data.marca_nombre };
      await setSession(telefono, STATE_EVID_PICK_TIPO, { ...data, reglas, _pending_evid: pending });

      let msg = `🧾 Marca: *${data.marca_nombre}*\n\nTipo de evidencia:\n\n`;
      reglas.slice(0,10).forEach((r,i) =>
        msg += `*${nEmoji(i)}* ${r.tipo_evidencia} (fotos: ${r.fotos_requeridas}${r.requiere_antes_despues ? ", antes/después" : ""})\n`
      );
      msg += "\nResponde con número.";
      return msg;
    }

    if (lower === "3") {
      const marcas = await getMarcasActivas();
      const pending = { ts: Date.now(), step: "PICK_MARCA", visita_id: data.visita_id, tienda_nombre: data.tienda_nombre };
      await setSession(telefono, STATE_EVID_PICK_MARCA, { ...data, marcas, _pending_evid: pending });

      let msg = `🏬 *${data.tienda_nombre}*\n🏷️ Selecciona marca:\n\n`;
      marcas.slice(0,10).forEach((m,i) => msg += `*${nEmoji(i)}* ${m.marca_nombre}\n`);
      msg += "\nResponde con número.";
      return msg;
    }

    // Menú
    const cleared = clearPendingEvid(data);
    await setSession(telefono, STATE_MENU, cleared);
    return menuPromotor(false);
  }

  if (estado === STATE_EVID_PICK_VISITA) {
    const opciones = data.opciones || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= Math.min(10, opciones.length)) return "⚠️ Elige un número válido.";
    const o = opciones[idx];

    const marcas = await getMarcasActivas();
    const pending = { ts: Date.now(), step: "PICK_MARCA", visita_id: o.visita_id, tienda_nombre: o.tienda_nombre };

    await setSession(telefono, STATE_EVID_PICK_MARCA, {
      visita_id: o.visita_id,
      tienda_nombre: o.tienda_nombre,
      marcas,
      _pending_evid: pending,
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

    const pending = {
      ts: Date.now(),
      step: "PICK_TIPO",
      visita_id: data.visita_id,
      tienda_nombre: data.tienda_nombre,
      marca_id: marca.marca_id,
      marca_nombre: marca.marca_nombre,
    };

    await setSession(telefono, STATE_EVID_PICK_TIPO, {
      ...data,
      marca_id: marca.marca_id,
      marca_nombre: marca.marca_nombre,
      reglas,
      _pending_evid: pending,
    });

    let msg = `🏷️ Marca: *${marca.marca_nombre}*\n\n🧾 Tipo de evidencia:\n\n`;
    reglas.slice(0,10).forEach((r,i) =>
      msg += `*${nEmoji(i)}* ${r.tipo_evidencia} (fotos: ${r.fotos_requeridas}${r.requiere_antes_despues ? ", antes/después" : ""})\n`
    );
    msg += "\nResponde con número.";
    return msg;
  }

  if (estado === STATE_EVID_PICK_TIPO) {
    const reglas = data.reglas || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= reglas.length) return "⚠️ Tipo inválido.";
    const regla = reglas[idx];

    if (regla.requiere_antes_despues) {
      const pending = { ...(data._pending_evid || {}), ts: Date.now(), step: "PICK_FASE", regla };
      await setSession(telefono, STATE_EVID_PICK_FASE, { ...data, regla, _pending_evid: pending });
      return `🧾 *${regla.tipo_evidencia}*\n\n*${nEmoji(0)}* ANTES\n*${nEmoji(1)}* DESPUÉS`;
    }

    const pending = {
      ts: Date.now(),
      step: "FOTOS",
      visita_id: data.visita_id,
      tienda_nombre: data.tienda_nombre,
      marca_id: data.marca_id,
      marca_nombre: data.marca_nombre,
      regla,
      fase: "NA",
      fotos_requeridas: regla.fotos_requeridas,
      fotos_recibidas: 0,
    };

    await setSession(telefono, STATE_EVID_FOTOS, {
      ...data,
      regla,
      fase: "NA",
      fotos_requeridas: regla.fotos_requeridas,
      fotos_recibidas: 0,
      _pending_evid: pending,
    });

    return `📸 Envía *${regla.fotos_requeridas}* foto(s). (Puedes enviar varias juntas)\n\n${tipsFoto()}`;
  }

  if (estado === STATE_EVID_PICK_FASE) {
    if (lower !== "1" && lower !== "2") return "Responde 1 o 2.";
    const fase = (lower === "1") ? "ANTES" : "DESPUES";

    const pending = {
      ts: Date.now(),
      step: "FOTOS",
      visita_id: data.visita_id,
      tienda_nombre: data.tienda_nombre,
      marca_id: data.marca_id,
      marca_nombre: data.marca_nombre,
      regla: data.regla,
      fase,
      fotos_requeridas: data.regla.fotos_requeridas,
      fotos_recibidas: 0,
    };

    await setSession(telefono, STATE_EVID_FOTOS, {
      ...data,
      fase,
      fotos_requeridas: data.regla.fotos_requeridas,
      fotos_recibidas: 0,
      _pending_evid: pending,
    });

    return `📸 Envía *${data.regla.fotos_requeridas}* foto(s) para *${fase}*.\n\n${tipsFoto()}`;
  }

  if (estado === STATE_EVID_FOTOS) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    const needed = data.fotos_requeridas || 1;
    const already = data.fotos_recibidas || 0;

    if (numMedia < 1) {
      const faltan = Math.max(0, needed - already);
      return `Necesito foto(s). Faltan *${faltan}*.\n\n${tipsFoto()}`;
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
        descripcion: descripcion ? `${descripcion}` : "",
      });
    }

    const newCount = already + accepted;

    if (newCount < needed) {
      const pending = {
        ts: Date.now(),
        step: "FOTOS",
        visita_id: data.visita_id,
        tienda_nombre: data.tienda_nombre,
        marca_id: data.marca_id,
        marca_nombre: data.marca_nombre,
        regla: data.regla,
        fase: data.fase || "NA",
        fotos_requeridas: needed,
        fotos_recibidas: newCount,
      };
      await setSession(telefono, STATE_EVID_FOTOS, { ...data, fotos_recibidas: newCount, _pending_evid: pending });
      const faltan = needed - newCount;
      return `✅ Recibí *${accepted}* foto(s)${ignored ? ` (ignoré ${ignored} extra)` : ""}.\n📌 Faltan *${faltan}*.\n\n${tipsFoto()}`;
    }

    // terminado -> menú post
    const ctx = {
      tienda_nombre: data.tienda_nombre,
      marca_id: data.marca_id,
      marca_nombre: data.marca_nombre,
      tipo_evidencia: data.regla.tipo_evidencia,
      regla: data.regla,
      visita_id: data.visita_id,
      fase: data.fase || "NA",
    };

    const pending = { ts: Date.now(), step: "POST", ...ctx };

    await setSession(telefono, STATE_EVID_POST, { ...ctx, _pending_evid: pending });

    return postEvidMenu(ctx) + (ignored ? `\nℹ️ Ignoré ${ignored} foto(s) extra.` : "");
  }

  await setSession(telefono, STATE_MENU, data);
  return menuPromotor(!!data?._pending_evid);
}

// ==========================
// MIS EVIDENCIAS (lista + ver/anular/reemplazar/nota)
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
    if (ymdInTZ(new Date(fh), APP_TZ) !== hoy) continue;
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
        const desc = norm(r[16] || "");
        if (isEvidenciaCancelada(desc)) return false;
        return true;
      })
      .map(r => ({
        evidencia_id: norm(r[0]),
        tipo_evento: norm(r[3]),
        url_foto: norm(r[7]),
        riesgo: upper(r[12] || "BAJO"),
        fecha_hora: norm(r[2]),
        marca_id: norm(r[13]),
        tipo_evidencia: norm(r[15]),
        descripcion: norm(r[16]),
        visita_id: norm(r[6]),
      }));

    if (!list.length) return `📭 No hay evidencias hoy en *${tiendaSel.tienda_nombre}*.`;

    await setSession(telefono, STATE_MY_EVID_LIST, { tiendaSel, list });

    let msg = `📷 *Evidencias – ${tiendaSel.tienda_nombre}* (${list.length})\n\n`;
    list.slice(0, 20).forEach((e,i) => {
      msg += `*${nEmoji(i)}* ${e.tipo_evento} – ${e.riesgo}\n`;
    });

    msg +=
      "\nComandos:\n" +
      "• `ver 3`\n" +
      "• `ver todas`\n" +
      "• `anular 3 motivo`\n" +
      "• `reemplazar 2`\n" +
      "• `nota 4 texto...`\n" +
      "• `menu`";

    return msg;
  }

  if (estado === STATE_MY_EVID_LIST) {
    const list = data.list || [];

    if (lower === "ver todas") {
      const urls = list.map(x => x.url_foto).filter(Boolean).slice(0, 20);
      if (!urls.length) return "📭 No hay fotos para mostrar.";

      const msgs = urls.map((u, i) => ({
        text: `📷 ${data.tiendaSel?.tienda_nombre || ""} – ${i + 1}/${urls.length}`,
        mediaUrl: proxifyMediaUrl(baseUrl, u),
      }));
      return { messages: msgs };
    }

    let m = lower.match(/^ver\s+(\d+)/);
    if (m) {
      const idx = safeInt(m[1], 0) - 1;
      if (idx < 0 || idx >= list.length) return "⚠️ Número inválido.";
      const e = list[idx];
      const caption =
        `📷 Evidencia #${idx+1}\n` +
        `🧾 ${e.tipo_evento}\n` +
        `⚠️ ${e.riesgo}\n` +
        (e.fecha_hora ? `📅 ${fmtDateTimeTZ(e.fecha_hora)}\n` : "") +
        (e.descripcion ? `📝 ${e.descripcion}\n` : "");
      return { text: caption, mediaUrl: proxifyMediaUrl(baseUrl, e.url_foto) };
    }

    m = lower.match(/^anular\s+(\d+)(.*)$/);
    if (m) {
      const idx = safeInt(m[1], 0) - 1;
      const motivo = norm(m[2] || "").replace(/^[-:]/, "").trim();
      if (idx < 0 || idx >= list.length) return "⚠️ Número inválido.";
      const e = list[idx];

      const ok = await updateEvidenciaDescripcion(
        e.evidencia_id,
        `${makeStatusTag("STATUS", "ANULADA")}${motivo ? " " + makeStatusTag("MOTIVO", motivo) : ""} ${makeStatusTag("TS", nowISO())}`
      );

      if (!ok) return "⚠️ No encontré esa evidencia en Sheets.";

      const newList = list.filter((_, i) => i !== idx);
      await setSession(telefono, STATE_MY_EVID_LIST, { ...data, list: newList });

      return `✅ Evidencia #${idx+1} anulada.${motivo ? "\n📝 Motivo: " + motivo : ""}`;
    }

    m = lower.match(/^nota\s+(\d+)\s+(.+)$/);
    if (m) {
      const idx = safeInt(m[1], 0) - 1;
      const nota = norm(m[2] || "");
      if (idx < 0 || idx >= list.length) return "⚠️ Número inválido.";
      const e = list[idx];

      const ok = await updateEvidenciaDescripcion(
        e.evidencia_id,
        `${makeStatusTag("NOTA", nota)} ${makeStatusTag("TS", nowISO())}`
      );
      if (!ok) return "⚠️ No encontré esa evidencia en Sheets.";

      return `✅ Nota actualizada en evidencia #${idx+1}.`;
    }

    m = lower.match(/^reemplazar\s+(\d+)(.*)$/);
    if (m) {
      const idx = safeInt(m[1], 0) - 1;
      const motivo = norm(m[2] || "").replace(/^[-:]/, "").trim();
      if (idx < 0 || idx >= list.length) return "⚠️ Número inválido.";
      const e = list[idx];

      await setSession(telefono, STATE_MY_EVID_REPLACE, {
        tiendaSel: data.tiendaSel,
        list,
        targetIndex: idx,
        target: e,
        motivo,
      });

      return `🔁 Reemplazar evidencia #${idx+1}\n\n${tipsFoto()}\n\nEnvía la NUEVA foto.${motivo ? "\n📝 Motivo: " + motivo : ""}`;
    }

    return "Usa `ver N`, `ver todas`, `anular N`, `reemplazar N` o `nota N ...`.";
  }

  if (estado === STATE_MY_EVID_REPLACE) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return `Necesito una foto para reemplazar.\n\n${tipsFoto()}`;

    const newUrl = inbound?.MediaUrl0 || "";
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";

    const target = data.target;
    const motivo = norm(data.motivo || "");

    const newId = `EV-${Date.now()}-R`;

    await registrarEvidencia({
      evidencia_id: newId,
      telefono,
      tipo_evento: target.tipo_evento || "EVIDENCIA_REEMPLAZO",
      origen: "EVIDENCIA",
      visita_id: target.visita_id || "",
      url_foto: newUrl,
      lat, lon,
      marca_id: target.marca_id || "",
      tipo_evidencia: target.tipo_evidencia || "",
      descripcion: `${makeStatusTag("REEMPLAZO_DE", target.evidencia_id)}${motivo ? " " + makeStatusTag("MOTIVO", motivo) : ""}`,
    });

    await updateEvidenciaDescripcion(
      target.evidencia_id,
      `${makeStatusTag("STATUS", "REEMPLAZADA")} ${makeStatusTag("REF", newId)} ${makeStatusTag("TS", nowISO())}`
    );

    const list = data.list || [];
    const idx = safeInt(data.targetIndex, -1);
    const newList = list.filter((_, i) => i !== idx);

    await setSession(telefono, STATE_MY_EVID_LIST, { tiendaSel: data.tiendaSel, list: newList });

    return `✅ Evidencia #${idx+1} reemplazada.\n🆕 Nueva evidencia: ${newId}`;
  }

  await setSession(telefono, STATE_MENU, data);
  return menuPromotor(!!data?._pending_evid);
}

// ==========================
// Supervisor: se conserva (no prioridad en esta fase)
// ==========================
async function getEvidenciasHoyForSupervisor() {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  const hoy = todayISO();
  return rows
    .filter(r => {
      const fh = norm(r[2]);
      if (!fh) return false;
      if (ymdInTZ(new Date(fh), APP_TZ) !== hoy) return false;
      if (upper(r[4]) !== "EVIDENCIA") return false;
      const desc = norm(r[16] || "");
      if (isEvidenciaCancelada(desc)) return false;
      return true;
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

async function enviarFotoAGrupoCliente(ev, grupo, baseUrl) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) return { ok: false, enviados: 0 };
  let enviados = 0;

  for (const to of grupo.telefonos) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to,
        body: `🏪 Evidencia\n⚠️ ${ev.riesgo}\n🧾 ${ev.tipo_evento}\n📅 ${fmtDateTimeTZ(ev.fecha_hora)}`,
        mediaUrl: ev.url_foto ? [proxifyMediaUrl(baseUrl, ev.url_foto)] : undefined,
      });
      enviados++;
    } catch (e) {
      console.error("send to client failed:", to, e?.message || e);
    }
  }
  return { ok: enviados > 0, enviados };
}

async function handleSupervisor(telefono, estado, text, data, baseUrl) {
  // dejamos igual tu versión “mínima” (la robustecemos en siguiente fase)
  const lower = norm(text).toLowerCase();
  const sup = await getSupervisorPorTelefono(telefono);
  if (!sup) { await setSession(telefono, STATE_MENU, data); return "⚠️ No eres supervisor activo."; }

  if (lower === "menu") { await setSession(telefono, STATE_MENU, data); return menuPromotor(!!data?._pending_evid); }
  if (lower === "ayuda") return "🆘 Supervisor\n\nComandos: `ver N`, `enviar 1,3`, `enviar todas`.";
  if (lower === "sup") {
    await setSession(telefono, STATE_SUP_MENU, data);
    return `👋 *${sup.nombre || "Supervisor"}*\n\n*${nEmoji(0)}* Evidencias hoy por promotor\n*${nEmoji(1)}* Evidencias hoy MEDIO/ALTO`;
  }

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

    return "Responde 1 o 2, o escribe `sup`.";
  }

  if (estado === STATE_SUP_PROMOTOR_LIST) {
    const equipo = data.equipo || [];
    const idx = safeInt(text, -1) - 1;
    if (idx < 0 || idx >= equipo.length) return "⚠️ Número inválido.";
    const p = equipo[idx];

    const evs = (await getEvidenciasHoyForSupervisor())
      .filter(e => e.telefono === p.telefono)
      .map(e => ({ ...e, promotor_nombre: p.nombre }));

    if (!evs.length) { await setSession(telefono, STATE_SUP_MENU, data); return `⚠️ No hay evidencias hoy para ${p.nombre}.\nEscribe \`sup\` para volver.`; }

    let msg = `📷 *Evidencias – ${p.nombre}*\n\n`;
    evs.slice(0, 20).forEach((e,i) => msg += `*${nEmoji(i)}* ${e.tipo_evento} – ${e.riesgo}\n`);
    msg += "\nComandos: `ver 1`, `enviar 1,3`, `enviar todas`, `sup`";
    await setSession(telefono, STATE_SUP_FOTOS_LIST, { listado: evs });
    return msg;
  }

  if (estado === STATE_SUP_FOTOS_LIST) {
    const listado = data.listado || [];

    let m = lower.match(/^ver\s+(\d+)/);
    if (m) {
      const idx = safeInt(m[1], 0) - 1;
      if (idx < 0 || idx >= listado.length) return "⚠️ Número inválido.";
      const e = listado[idx];
      return { text: `📷 #${idx+1}\n🧾 ${e.tipo_evento}\n⚠️ ${e.riesgo}\n📅 ${fmtDateTimeTZ(e.fecha_hora)}`, mediaUrl: proxifyMediaUrl(baseUrl, e.url_foto) };
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
      const r = await enviarFotoAGrupoCliente(ev, grupo, baseUrl);
      if (r.ok) okCount++;
    }

    await setSession(telefono, STATE_SUP_MENU, data);
    return `✅ Enviadas ${okCount} evidencia(s) a *${grupo.nombre_grupo}*.\nEscribe \`sup\` para volver.`;
  }

  await setSession(telefono, STATE_SUP_MENU, data);
  return "Escribe `sup` para menú supervisor.";
}

// ==========================
// Router principal + comandos globales
// ==========================
async function handleIncoming(from, body, inbound, baseUrl) {
  const telefono = norm(from);
  const text = norm(body);
  const lower = text.toLowerCase();

  const msgSid = norm(inbound?.MessageSid || "");
  const ses = await getSession(telefono);

  // Idempotencia retry
  if (msgSid && ses.data_json?._last_sid === msgSid && ses.data_json?._last_resp) {
    return ses.data_json._last_resp;
  }

  const estado = ses.estado_actual;
  const data = ses.data_json || {};

  // Global: menu NO borra pendiente
  if (lower === "menu" || lower === "inicio") {
    await setSession(telefono, STATE_MENU, data);
    return menuPromotor(!!data?._pending_evid);
  }

  // Global: ayuda contextual
  if (lower === "ayuda" || lower === "help" || lower === "?") {
    return ayudaContextual(estado);
  }

  // Global: atajo activas
  if (lower === "activas") {
    return await showActivasMenu(telefono);
  }

  // Global: continuar evidencia pendiente
  if (lower === "continuar" || lower === "reanudar") {
    const resumed = await resumePendingEvidence(telefono, data);
    if (resumed) return resumed;
    return "📭 No tengo evidencia pendiente para continuar. Usa *Evidencias* para iniciar.";
  }

  // Global: supervisor
  if (lower === "sup") {
    const sup = await getSupervisorPorTelefono(telefono);
    if (!sup) return "⚠️ Tu número no está dado de alta como supervisor.";
    await setSession(telefono, STATE_SUP_MENU, data);
    return `👋 *${sup.nombre || "Supervisor"}*\n\n*${nEmoji(0)}* Evidencias hoy por promotor\n*${nEmoji(1)}* Evidencias hoy MEDIO/ALTO`;
  }

  // Atajo activas flow
  if ([STATE_ACTIVAS_PICK, STATE_ACTIVAS_ACTION].includes(estado)) {
    return await handleActivas(telefono, estado, text, data);
  }

  // Supervisor flow
  if ([STATE_SUP_MENU, STATE_SUP_PROMOTOR_LIST, STATE_SUP_FOTOS_LIST, STATE_SUP_ELEGIR_GRUPO].includes(estado)) {
    return await handleSupervisor(telefono, estado, text, data, baseUrl);
  }

  // Menu promotor (con opción de continuar si aplica)
  if (estado === STATE_MENU) {
    const hasPending = !!(data?._pending_evid && pendingIsFresh(data._pending_evid));

    // Si el usuario elige “6” y hay pendiente, reanuda
    if (lower === "6" && hasPending) {
      const resumed = await resumePendingEvidence(telefono, data);
      if (resumed) return resumed;
    }

    if (lower === "1") { await setSession(telefono, STATE_ASIS_HOME, data); return await startAsistenciaHome(telefono); }

    if (lower === "2") {
      // si hay pendiente fresca, ofrece continuar primero
      if (hasPending) {
        await setSession(telefono, STATE_MENU, data);
        return (
          "⏯️ Tienes una evidencia pendiente.\n\n" +
          `*${nEmoji(0)}* Continuar\n` +
          `*${nEmoji(1)}* Iniciar nueva\n\n` +
          "Responde 1 o 2."
        );
      }
      return await startEvidencias(telefono);
    }

    if (lower === "3") { return await startMisEvidencias(telefono, baseUrl); }

    if (lower === "4") { return await resumenDiaDetallado(telefono); }

    if (lower === "5") { return ayudaContextual(STATE_MENU); }

    // Si venía del prompt “continuar/nueva” (opción 2), resolvemos aquí
    if (lower === "1" && hasPending && data?._pending_evid && data?._pending_evid?.step) {
      const resumed = await resumePendingEvidence(telefono, data);
      if (resumed) return resumed;
    }
    if (lower === "2" && hasPending) {
      // iniciar nueva evid: limpiar pending y arrancar
      const cleared = clearPendingEvid(data);
      await setSession(telefono, STATE_MENU, cleared);
      return await startEvidencias(telefono);
    }

    return menuPromotor(hasPending);
  }

  // Asistencia
  if ([STATE_ASIS_HOME, STATE_ASIS_PICK_ENTRADA, STATE_ASIS_PICK_ACTIVA, STATE_ASIS_ACTIVA_MENU, STATE_ASIS_FOTO, STATE_ASIS_UBI, STATE_ASIS_HIST, STATE_ASIS_CAMBIAR_FOTO].includes(estado)) {
    return await handleAsistencia(telefono, estado, text, data, inbound, baseUrl);
  }

  // Evidencias
  if ([STATE_EVID_PICK_VISITA, STATE_EVID_PICK_MARCA, STATE_EVID_PICK_TIPO, STATE_EVID_PICK_FASE, STATE_EVID_FOTOS, STATE_EVID_POST].includes(estado)) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
  }

  // Mis evidencias
  if ([STATE_MY_EVID_PICK_TIENDA, STATE_MY_EVID_LIST, STATE_MY_EVID_REPLACE].includes(estado)) {
    return await handleMisEvidencias(telefono, estado, text, data, inbound, baseUrl);
  }

  // fallback
  await setSession(telefono, STATE_MENU, data);
  return menuPromotor(!!data?._pending_evid);
}

// ==========================
// Express /whatsapp
// ==========================
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
