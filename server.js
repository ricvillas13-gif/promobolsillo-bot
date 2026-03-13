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
  PUBLIC_BASE_URL, // RECOMENDADO: https://tu-app.onrender.com
  MEDIA_PROXY_TTL_SECONDS, // opcional: default 3600
} = process.env;

const MEDIA_TTL = parseInt(MEDIA_PROXY_TTL_SECONDS || "3600", 10);

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

function colToA1(n0) {
  let n = n0 + 1, s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ==========================
// Estados
// ==========================
const STATE_MENU = "MENU";

// Asistencia
const STATE_ASIS_HOME = "ASIS_HOME";
const STATE_ASIS_ELEGIR_TIENDA_ENTRADA = "ASIS_ELEGIR_TIENDA_ENTRADA";
const STATE_ASIS_CONFIRMAR_ENTRADA = "ASIS_CONFIRMAR_ENTRADA";
const STATE_ASIS_CONFIRMAR_SALIDA = "ASIS_CONFIRMAR_SALIDA";
const STATE_ASIS_FOTO = "ASIS_FOTO";
const STATE_ASIS_UBI = "ASIS_UBI";
const STATE_ASIS_HIST = "ASIS_HIST";
const STATE_ASIS_CAMBIAR_FOTO = "ASIS_CAMBIAR_FOTO";

// Evidencias
const STATE_EVID_ELEGIR_VISITA = "EVID_ELEGIR_VISITA";
const STATE_EVID_ELEGIR_MARCA = "EVID_ELEGIR_MARCA";
const STATE_EVID_ELEGIR_TIPO = "EVID_ELEGIR_TIPO";
const STATE_EVID_ELEGIR_FASE = "EVID_ELEGIR_FASE";
const STATE_EVID_FOTOS = "EVID_FOTOS";

// Mis evidencias
const STATE_MY_EVID_TIENDA_PICK = "MY_EVID_TIENDA_PICK";
const STATE_MY_EVID_LIST = "MY_EVID_LIST";
const STATE_MY_EVID_REHACER = "MY_EVID_REHACER";

// Supervisor
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";

// ==========================
// SESIONES (merge + idempotencia)
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
  // preserva meta idempotencia
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
// Proxy de media (soluciona 63019)
// ==========================
function signMedia(u, exp) {
  const h = crypto.createHmac("sha256", TWILIO_AUTH_TOKEN || "dev");
  h.update(`${u}|${exp}`);
  return h.digest("hex");
}

function buildBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
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
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(403).send("invalid_sig");
    }

    // Descargar desde Twilio con Basic Auth
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const r = await fetch(u, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      return res.status(502).send("upstream_failed");
    }

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
// EVIDENCIAS (simple) + búsqueda asistencia
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

async function getAsistenciaFotosByVisita(visita_id) {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  let entrada = "";
  let salida = "";
  for (const r of rows) {
    if (norm(r[6]) !== visita_id) continue;
    if (upper(r[4]) !== "ASISTENCIA") continue;
    if (norm(r[3]) === "ASISTENCIA_ENTRADA") entrada = norm(r[7]);
    if (norm(r[3]) === "ASISTENCIA_SALIDA") salida = norm(r[7]);
  }
  return { entrada, salida };
}

async function hasAsistenciaEvento(visita_id, tipo_evento) {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  for (const r of rows) {
    if (norm(r[6]) === visita_id && upper(r[4]) === "ASISTENCIA" && norm(r[3]) === tipo_evento) return true;
  }
  return false;
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
    "1️⃣ Asistencia (más intuitiva)\n" +
    "2️⃣ Evidencias (marca → tipo → fotos)\n" +
    "3️⃣ Mis evidencias (por tienda)\n" +
    "4️⃣ Ayuda\n\n" +
    "Comandos: `menu`, `sup`, `ayuda`"
  );
}
function ayudaPromotor() {
  return (
    "🆘 *Ayuda Promotor*\n\n" +
    "Asistencia:\n" +
    "• Te muestra tienda activa y opciones rápidas.\n\n" +
    "Evidencias:\n" +
    "• Pide fotos según regla.\n" +
    "• Si te faltan fotos: envía el resto o escribe `omitir`.\n\n" +
    "Mis evidencias:\n" +
    "• Agrupa por tienda.\n" +
    "• `ver N` para ver fotos del lote."
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
    "• `ver 2` (muestra foto)\n" +
    "• `enviar 1,3,5`\n" +
    "• `enviar todas`\n"
  );
}

// ==========================
// ASISTENCIA (HOME)
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

  await setSession(telefono, STATE_ASIS_HOME, { promotor_id: prom.promotor_id });

  return (
    "🕒 *Asistencia (hoy)*\n\n" +
    `🏬 Tienda activa: *${tiendaActivaTxt}*\n` +
    `📌 Visitas hoy: ${visitasHoy.length} (abiertas ${abiertasCount}, cerradas ${cerradas})\n\n` +
    "1️⃣ Registrar *SALIDA* (tienda activa)\n" +
    "2️⃣ Ver fotos de asistencia (tienda activa)\n" +
    "3️⃣ Cambiar foto de *ENTRADA* (solo si existe)\n" +
    "4️⃣ Cambiar foto de *SALIDA* (solo si existe)\n" +
    "5️⃣ Registrar *ENTRADA* en otra tienda\n" +
    "6️⃣ Historial (últimas 10)\n" +
    "7️⃣ Volver al menú"
  );
}

async function handleAsistencia(telefono, estado, text, data, inbound, baseUrl) {
  const lower = norm(text).toLowerCase();
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) { await setSession(telefono, STATE_MENU, {}); return "⚠️ No estás como promotor activo."; }

  const tiendaMap = await getTiendaMap();

  if (estado === STATE_ASIS_HOME) {
    if (lower === "7") { await setSession(telefono, STATE_MENU, {}); return menuPromotor(); }

    const abiertas = await getOpenVisitsToday(prom.promotor_id);

    if (lower === "5") {
      const asignadas = await getTiendasAsignadas(prom.promotor_id);
      const tiendas = asignadas.map(id => tiendaMap[id]).filter(t => t && t.activa);

      await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA_ENTRADA, { promotor_id: prom.promotor_id, tiendas, filtradas: [] });

      let msg = "🏬 *Entrada* – Elige tienda o escribe texto para buscar:\n\n";
      tiendas.slice(0, 15).forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena}${t.ciudad ? " (" + t.ciudad + ")" : ""}\n`;
      });
      msg += "\nResponde con número o escribe texto.";
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

      let msg = "📚 *Historial (últimas 10)*\n\n";
      out.forEach((v, idx) => {
        const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;
        const ent = v.hora_inicio ? v.hora_inicio.substring(11, 16) : "—";
        const sal = v.hora_fin ? v.hora_fin.substring(11, 16) : "pendiente";
        const est = v.hora_fin ? "CERRADA" : "ABIERTA";
        msg += `${idx + 1}) ${v.fecha} – ${tn} – entrada ${ent} / salida ${sal} – ${est}\n`;
      });
      msg += "\nComando: `fotos 3` para ver fotos de esa asistencia.\n`menu` para salir.";
      return msg;
    }

    if (["1","2","3","4"].includes(lower)) {
      if (!abiertas.length) return "⚠️ No tienes tienda activa. Usa opción 5️⃣ para registrar entrada.";
      if (abiertas.length > 1) return "⚠️ Tienes varias tiendas activas. Cierra salidas una por una para evitar duplicados.";

      const activa = abiertas[0];
      const tn = tiendaMap[activa.tienda_id]?.nombre_tienda || activa.tienda_id;

      if (lower === "1") {
        await setSession(telefono, STATE_ASIS_CONFIRMAR_SALIDA, {
          promotor_id: prom.promotor_id,
          visita_id: activa.visita_id,
          tienda_id: activa.tienda_id,
          tienda_nombre: tn,
        });
        return `🚪 *Salida* – ${tn}\n\n1️⃣ Continuar\n2️⃣ Cancelar`;
      }

      if (lower === "2") {
        const fotos = await getAsistenciaFotosByVisita(activa.visita_id);
        const medias = [];
        if (fotos.entrada) medias.push(proxifyMediaUrl(baseUrl, fotos.entrada));
        if (fotos.salida) medias.push(proxifyMediaUrl(baseUrl, fotos.salida));
        if (!medias.length) return `📭 Aún no hay fotos de asistencia para ${tn}.`;
        return { text: `📷 *Fotos asistencia* – ${tn}`, mediaUrl: medias.slice(0,2) };
      }

      if (lower === "3") {
        const ok = await hasAsistenciaEvento(activa.visita_id, "ASISTENCIA_ENTRADA");
        if (!ok) return "⚠️ No existe una foto de ENTRADA para cambiar. Registra entrada primero.";
        await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, { visita_id: activa.visita_id, tienda_id: activa.tienda_id, tienda_nombre: tn, tipo_evento: "ASISTENCIA_ENTRADA" });
        return `🔁 Cambiar *ENTRADA* – ${tn}\n📸 Envía la nueva foto.`;
      }

      if (lower === "4") {
        const ok = await hasAsistenciaEvento(activa.visita_id, "ASISTENCIA_SALIDA");
        if (!ok) return "⚠️ Aún no hay SALIDA registrada. Primero registra salida (opción 1).";
        await setSession(telefono, STATE_ASIS_CAMBIAR_FOTO, { visita_id: activa.visita_id, tienda_id: activa.tienda_id, tienda_nombre: tn, tipo_evento: "ASISTENCIA_SALIDA" });
        return `🔁 Cambiar *SALIDA* – ${tn}\n📸 Envía la nueva foto.`;
      }
    }

    return await startAsistenciaHome(telefono);
  }

  if (estado === STATE_ASIS_ELEGIR_TIENDA_ENTRADA) {
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
      await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA_ENTRADA, { ...data, filtradas });

      let msg = "🔎 Resultados:\n\n";
      filtradas.slice(0, 15).forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena}${t.ciudad ? " (" + t.ciudad + ")" : ""}\n`;
      });
      msg += "\nResponde con número.";
      return msg;
    }

    const listado = (data.filtradas && data.filtradas.length) ? data.filtradas : tiendas;
    const n = safeInt(q, -1);
    if (n < 1 || n > Math.min(15, listado.length)) return "⚠️ Elige un número válido.";
    const tienda = listado[n - 1];

    const open = await findOpenVisit(prom.promotor_id, tienda.tienda_id);
    if (open) return "⚠️ Ya tienes una ENTRADA abierta en esa tienda. Registra SALIDA desde Asistencia.";

    await setSession(telefono, STATE_ASIS_CONFIRMAR_ENTRADA, { promotor_id: prom.promotor_id, tienda_id: tienda.tienda_id, tienda_nombre: tienda.nombre_tienda });
    return `🕒 *Entrada* – ${tienda.nombre_tienda}\n\n1️⃣ Continuar\n2️⃣ Cancelar`;
  }

  if (estado === STATE_ASIS_CONFIRMAR_ENTRADA) {
    if (lower === "2") return await startAsistenciaHome(telefono);
    if (lower !== "1") return "Responde 1 o 2.";
    await setSession(telefono, STATE_ASIS_FOTO, { ...data, accion: "ENTRADA" });
    return `📸 Envía foto de *ENTRADA* – ${data.tienda_nombre}`;
  }

  if (estado === STATE_ASIS_CONFIRMAR_SALIDA) {
    if (lower === "2") return await startAsistenciaHome(telefono);
    if (lower !== "1") return "Responde 1 o 2.";
    await setSession(telefono, STATE_ASIS_FOTO, { ...data, accion: "SALIDA" });
    return `📸 Envía foto de *SALIDA* – ${data.tienda_nombre}`;
  }

  if (estado === STATE_ASIS_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito una foto. Adjunta y reenvía.";
    const fotoUrl = inbound?.MediaUrl0 || "";
    await setSession(telefono, STATE_ASIS_UBI, { ...data, fotoUrl });
    return "✅ Foto recibida.\n📍 Comparte ubicación (Share location).";
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
        tipo_evidencia: "ASISTENCIA",
      });
      return `✅ Entrada registrada – *${data.tienda_nombre}*\n\n` + (await startAsistenciaHome(telefono));
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
    });

    return `✅ Salida registrada – *${data.tienda_nombre}*\n\n` + (await startAsistenciaHome(telefono));
  }

  if (estado === STATE_ASIS_HIST) {
    const listado = data.listado || [];
    if (lower.startsWith("fotos")) {
      const n = safeInt(lower.replace("fotos", "").trim(), -1);
      if (n < 1 || n > listado.length) return "⚠️ Usa `fotos 1`..";
      const v = listado[n - 1];
      const tn = (await getTiendaMap())[v.tienda_id]?.nombre_tienda || v.tienda_id;
      const fotos = await getAsistenciaFotosByVisita(v.visita_id);
      const medias = [];
      if (fotos.entrada) medias.push(proxifyMediaUrl(baseUrl, fotos.entrada));
      if (fotos.salida) medias.push(proxifyMediaUrl(baseUrl, fotos.salida));
      if (!medias.length) return `📭 No hay fotos de asistencia para ${tn}.`;
      return { text: `📷 *Asistencia* – ${tn}\n${v.fecha}`, mediaUrl: medias.slice(0,2) };
    }
    return "Comando: `fotos N` o `menu`.";
  }

  if (estado === STATE_ASIS_CAMBIAR_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) return "Necesito la nueva foto.";
    // Para piloto: se registra como corrección (no borra anterior)
    await registrarEvidencia({
      evidencia_id: `EV-${Date.now()}-1`,
      telefono,
      tipo_evento: data.tipo_evento,
      origen: "ASISTENCIA",
      visita_id: data.visita_id,
      url_foto: inbound?.MediaUrl0 || "",
      tipo_evidencia: "ASISTENCIA",
      descripcion: `[CORRECCION_${data.tipo_evento}]`,
    });
    return `✅ Foto actualizada (${data.tipo_evento}) – ${data.tienda_nombre}\n\n` + (await startAsistenciaHome(telefono));
  }

  return menuPromotor();
}

// ==========================
// Evidencias (fix conteo + omitir + menú directo)
// ==========================
async function startEvidencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const abiertas = await getOpenVisitsToday(prom.promotor_id);
  const tiendaMap = await getTiendaMap();
  if (!abiertas.length) return "⚠️ No hay tienda activa (sin ENTRADA).";

  if (abiertas.length > 1) {
    const opciones = abiertas.map(v => ({
      visita_id: v.visita_id,
      tienda_id: v.tienda_id,
      tienda_nombre: tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id,
    }));
    await setSession(telefono, STATE_EVID_ELEGIR_VISITA, { promotor_id: prom.promotor_id, opciones });
    let msg = "🏬 Tienes *más de una tienda activa*. Elige una:\n\n";
    opciones.slice(0,10).forEach((o,i) => msg += `${i+1}) ${o.tienda_nombre}\n`);
    msg += "\nResponde con el número.";
    return msg;
  }

  const v = abiertas[0];
  const tn = tiendaMap[v.tienda_id]?.nombre_tienda || v.tienda_id;

  const marcas = await getMarcasActivas();
  await setSession(telefono, STATE_EVID_ELEGIR_MARCA, {
    promotor_id: prom.promotor_id,
    visita_id: v.visita_id,
    tienda_id: v.tienda_id,
    tienda_nombre: tn,
    marcas,
  });

  let msg = `🏬 *${tn}*\n🏷️ Selecciona marca:\n\n`;
  marcas.slice(0,15).forEach((m,i) => msg += `${i+1}) ${m.marca_nombre}\n`);
  msg += "\nResponde con el número.";
  return msg;
}

async function handleEvidencias(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_EVID_ELEGIR_VISITA) {
    const opciones = data.opciones || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(10, opciones.length)) return "⚠️ Número inválido.";
    const o = opciones[n - 1];

    const marcas = await getMarcasActivas();
    await setSession(telefono, STATE_EVID_ELEGIR_MARCA, { promotor_id: data.promotor_id, visita_id: o.visita_id, tienda_id: o.tienda_id, tienda_nombre: o.tienda_nombre, marcas });
    let msg = `🏬 *${o.tienda_nombre}*\n🏷️ Selecciona marca:\n\n`;
    marcas.slice(0,15).forEach((m,i) => msg += `${i+1}) ${m.marca_nombre}\n`);
    msg += "\nResponde con el número.";
    return msg;
  }

  if (estado === STATE_EVID_ELEGIR_MARCA) {
    const marcas = data.marcas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(15, marcas.length)) return "⚠️ Marca inválida.";
    const marca = marcas[n - 1];

    const reglas = await getReglasPorMarca(marca.marca_id);
    if (!reglas.length) return `⚠️ No hay reglas activas para ${marca.marca_nombre}.`;

    await setSession(telefono, STATE_EVID_ELEGIR_TIPO, { ...data, marca_id: marca.marca_id, marca_nombre: marca.marca_nombre, reglas });

    let msg = `🏷️ Marca: *${marca.marca_nombre}*\n\n🧾 Tipo de evidencia:\n\n`;
    reglas.forEach((r,i) => msg += `${i+1}) ${r.tipo_evidencia} (fotos: ${r.fotos_requeridas}${r.requiere_antes_despues ? ", antes/después" : ""})\n`);
    msg += "\nResponde con el número.";
    return msg;
  }

  if (estado === STATE_EVID_ELEGIR_TIPO) {
    const reglas = data.reglas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > reglas.length) return "⚠️ Tipo inválido.";
    const regla = reglas[n - 1];

    if (regla.requiere_antes_despues) {
      await setSession(telefono, STATE_EVID_ELEGIR_FASE, { ...data, regla });
      return `🧾 *${regla.tipo_evidencia}*\n1️⃣ ANTES\n2️⃣ DESPUÉS\n\nResponde 1 o 2.`;
    }

    const batch_id = "B-" + Date.now();
    await setSession(telefono, STATE_EVID_FOTOS, { ...data, regla, fase: "NA", batch_id, fotos_requeridas: regla.fotos_requeridas, fotos_recibidas: 0 });
    return `📸 Envía *${regla.fotos_requeridas}* foto(s). Si no completas, escribe \`omitir\` para guardar incompleta.`;
  }

  if (estado === STATE_EVID_ELEGIR_FASE) {
    if (lower !== "1" && lower !== "2") return "Responde 1 (ANTES) o 2 (DESPUÉS).";
    const fase = lower === "1" ? "ANTES" : "DESPUES";
    const batch_id = "B-" + Date.now();
    await setSession(telefono, STATE_EVID_FOTOS, { ...data, fase, batch_id, fotos_requeridas: data.regla.fotos_requeridas, fotos_recibidas: 0 });
    return `📸 Envía *${data.regla.fotos_requeridas}* foto(s) para fase *${fase}*. Si no completas, \`omitir\`.`;
  }

  if (estado === STATE_EVID_FOTOS) {
    if (lower === "omitir") {
      // guarda como incompleta y vuelve al menú
      await setSession(telefono, STATE_MENU, {});
      return "⚠️ Evidencia guardada como *INCOMPLETA*.\n\n" + menuPromotor();
    }

    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) {
      const faltan = Math.max(0, (data.fotos_requeridas || 1) - (data.fotos_recibidas || 0));
      return `Necesito que envíes foto(s). Faltan *${faltan}*. O escribe \`omitir\`.`;
    }

    const needed = data.fotos_requeridas || 1;
    const already = data.fotos_recibidas || 0;
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
      return `✅ Recibí ${accepted}.${ignored ? ` (Ignoré ${ignored} extra)` : ""}\n📌 Faltan *${faltan}* foto(s).`;
    }

    await setSession(telefono, STATE_MENU, {});
    return `✅ Evidencia completada (${needed} foto(s)).${ignored ? ` (Ignoré ${ignored} extra)` : ""}\n\n` + menuPromotor();
  }

  return menuPromotor();
}

// ==========================
// Mis evidencias (por tienda) + ver fotos (proxy)
// ==========================
async function startMyEvidenciasPorTienda(telefono, baseUrl) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const tiendaMap = await getTiendaMap();
  const visitas = await getVisitsToday(prom.promotor_id);
  if (!visitas.length) return "📭 Hoy no tienes visitas registradas.";

  // contamos evidencias por visita/tienda (simple, usando EVIDENCIAS A2:Q)
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  const hoy = todayISO();
  const countByTienda = {};
  for (const r of rows) {
    if (norm(r[1]) !== telefono) continue;
    if (!norm(r[2]) || norm(r[2]).slice(0,10) !== hoy) continue;
    if (upper(r[4]) !== "EVIDENCIA") continue;
    // NO tenemos tienda_id en tus columnas actuales, así que agrupamos por visita->tienda desde VISITAS
    const visita_id = norm(r[6]);
    const v = visitas.find(x => x.visita_id === visita_id);
    const tid = v ? v.tienda_id : "SIN_TIENDA";
    countByTienda[tid] = (countByTienda[tid] || 0) + 1;
  }

  const tiendasHoy = Array.from(new Set(visitas.map(v => v.tienda_id))).map(tid => ({
    tienda_id: tid,
    tienda_nombre: tiendaMap[tid]?.nombre_tienda || tid,
    evidencias: countByTienda[tid] || 0,
  }));

  await setSession(telefono, STATE_MY_EVID_TIENDA_PICK, { promotor_id: prom.promotor_id, tiendasHoy });

  let msg = "📚 *Mis evidencias (hoy) – por tienda*\n\n";
  tiendasHoy.slice(0,10).forEach((t,i) => {
    msg += `${i+1}) ${t.tienda_nombre} – ${t.evidencias} evidencia(s)\n`;
  });
  msg += "\nElige tienda con número o `menu`.";
  return msg;
}

async function handleMyEvidencias(telefono, estado, text, data, inbound, baseUrl) {
  const lower = norm(text).toLowerCase();

  if (estado === STATE_MY_EVID_TIENDA_PICK) {
    const tiendasHoy = data.tiendasHoy || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(10, tiendasHoy.length)) return "⚠️ Elige un número válido.";
    const tiendaSel = tiendasHoy[n - 1];

    // listar evidencias de hoy para esa tienda (vía visita_id)
    const prom = await getPromotorPorTelefono(telefono);
    const visitas = await getVisitsToday(prom.promotor_id);
    const visitasT = visitas.filter(v => v.tienda_id === tiendaSel.tienda_id).map(v => v.visita_id);

    const rows = await getSheetValues("EVIDENCIAS!A2:Q");
    const hoy = todayISO();
    const list = rows
      .map((r, idx) => ({ r, rowIndex: idx + 2 }))
      .filter(x =>
        norm(x.r[1]) === telefono &&
        norm(x.r[2]) && norm(x.r[2]).slice(0,10) === hoy &&
        upper(x.r[4]) === "EVIDENCIA" &&
        visitasT.includes(norm(x.r[6]))
      )
      .map(x => ({
        rowIndex: x.rowIndex,
        evidencia_id: norm(x.r[0]),
        fecha_hora: norm(x.r[2]),
        tipo_evento: norm(x.r[3]),
        url_foto: norm(x.r[7]),
        riesgo: upper(x.r[12] || "BAJO"),
      }))
      .slice(0, 20);

    if (!list.length) return `📭 No hay evidencias hoy en ${tiendaSel.tienda_nombre}.`;

    await setSession(telefono, STATE_MY_EVID_LIST, { tiendaSel, list });

    let msg = `📷 *Evidencias – ${tiendaSel.tienda_nombre}*\n\n`;
    list.forEach((e,i) => {
      msg += `${i+1}) ${e.tipo_evento} – ${e.riesgo}\n`;
    });
    msg += "\nComando: `ver 3` para ver la foto.\n`menu` para volver.";
    return msg;
  }

  if (estado === STATE_MY_EVID_LIST) {
    const list = data.list || [];
    const verMatch = lower.match(/^ver\s+(\d+)/);
    if (verMatch) {
      const idx = safeInt(verMatch[1], 0) - 1;
      if (idx < 0 || idx >= list.length) return "⚠️ Número inválido.";
      const e = list[idx];
      const media = proxifyMediaUrl(baseUrl, e.url_foto);
      return { text: `📷 Evidencia #${idx+1}\n${e.tipo_evento}\n⚠️ ${e.riesgo}`, mediaUrl: media };
    }
    return "Usa `ver N` o `menu`.";
  }

  return menuPromotor();
}

// ==========================
// Supervisor (solo lo esencial + proxy al ver)
// ==========================
async function getEvidenciasHoyForSupervisor() {
  const rows = await getSheetValues("EVIDENCIAS!A2:Q");
  const hoy = todayISO();
  return rows
    .filter(r => norm(r[2]) && norm(r[2]).slice(0,10) === hoy && upper(r[4]) === "EVIDENCIA")
    .map(r => ({
      evidencia_id: norm(r[0]),
      telefono: norm(r[1]),
      fecha_hora: norm(r[2]),
      tipo_evento: norm(r[3]),
      visita_id: norm(r[6]),
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
        body: `🏪 Evidencia\n⚠️ Riesgo: ${ev.riesgo}\n🧾 ${ev.tipo_evento}\n📅 ${ev.fecha_hora}`,
        mediaUrl: ev.url_foto ? [ev.url_foto] : undefined,
      });
      enviados++;
    } catch (e) {
      console.error("Error enviando:", to, e?.message || e);
    }
  }
  return { ok: enviados > 0, enviados };
}

async function handleSupervisor(telefono, estado, text, data, baseUrl) {
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

      let msg = "🧠📸 *MEDIO/ALTO (hoy)*\n\n";
      evs.forEach((e,i) => msg += `${i+1}) ${e.tipo_evento} – ${e.promotor_nombre} – ${e.riesgo}\n`);
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

    let msg = `📷 *Evidencias – ${p.nombre}*\n\n`;
    evs.forEach((e,i) => msg += `${i+1}) ${e.tipo_evento} – ${e.riesgo}\n`);
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
      // Proxy para evitar 63019
      return { text: `📷 Evidencia #${idx+1}\n🧾 ${e.tipo_evento}\n⚠️ ${e.riesgo}`, mediaUrl: proxifyMediaUrl(baseUrl, e.url_foto) };
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
    let okCount = 0;
    for (const ev of (data.seleccionadas || [])) {
      const r = await enviarFotoAGrupoCliente(ev, grupo);
      if (r.ok) okCount++;
    }

    await setSession(telefono, STATE_SUP_MENU, {});
    return `✅ Enviadas ${okCount} evidencia(s) a *${grupo.nombre_grupo}*.\n\n` + menuSupervisor(sup.nombre);
  }

  await setSession(telefono, STATE_SUP_MENU, {});
  return menuSupervisor(sup.nombre);
}

// ==========================
// Router principal + idempotencia MessageSid
// ==========================
async function handleIncoming(from, body, inbound, baseUrl) {
  const telefono = norm(from);
  const text = norm(body);
  const lower = text.toLowerCase();

  const msgSid = norm(inbound?.MessageSid || "");
  const ses = await getSession(telefono);

  // Idempotencia: si Twilio reintenta el mismo MessageSid, respondemos lo mismo
  if (msgSid && ses.data_json?._last_sid === msgSid && ses.data_json?._last_resp) {
    return ses.data_json._last_resp;
  }

  if (lower === "menu" || lower === "inicio") {
    await setSession(telefono, STATE_MENU, {});
    return menuPromotor();
  }
  if (lower === "ayuda" || lower === "help" || lower === "?") return ayudaPromotor();

  if (lower === "sup") {
    const sup = await getSupervisorPorTelefono(telefono);
    if (!sup) return "⚠️ Tu número no está dado de alta como supervisor.";
    await setSession(telefono, STATE_SUP_MENU, {});
    return menuSupervisor(sup.nombre || "Supervisor");
  }

  const estado = ses.estado_actual;
  const data = ses.data_json || {};

  // Supervisor states
  if ([STATE_SUP_MENU, STATE_SUP_PROMOTOR_LIST, STATE_SUP_FOTOS_LIST, STATE_SUP_ELEGIR_GRUPO].includes(estado)) {
    return await handleSupervisor(telefono, estado, text, data, baseUrl);
  }

  // Main menu
  if (estado === STATE_MENU) {
    if (lower === "1") return await startAsistenciaHome(telefono);
    if (lower === "2") return await startEvidencias(telefono);
    if (lower === "3") return await startMyEvidenciasPorTienda(telefono, baseUrl);
    if (lower === "4") return ayudaPromotor();
    return menuPromotor();
  }

  // Flows
  if ([STATE_ASIS_HOME, STATE_ASIS_ELEGIR_TIENDA_ENTRADA, STATE_ASIS_CONFIRMAR_ENTRADA, STATE_ASIS_CONFIRMAR_SALIDA, STATE_ASIS_FOTO, STATE_ASIS_UBI, STATE_ASIS_HIST, STATE_ASIS_CAMBIAR_FOTO].includes(estado)) {
    return await handleAsistencia(telefono, estado, text, data, inbound, baseUrl);
  }

  if ([STATE_EVID_ELEGIR_VISITA, STATE_EVID_ELEGIR_MARCA, STATE_EVID_ELEGIR_TIPO, STATE_EVID_ELEGIR_FASE, STATE_EVID_FOTOS].includes(estado)) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
  }

  if ([STATE_MY_EVID_TIENDA_PICK, STATE_MY_EVID_LIST, STATE_MY_EVID_REHACER].includes(estado)) {
    return await handleMyEvidencias(telefono, estado, text, data, inbound, baseUrl);
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

  const baseUrl = buildBaseUrl(req);

  console.log("IN:", from, body, "NumMedia:", req.body.NumMedia, "Sid:", req.body.MessageSid);

  let respuesta;
  try {
    respuesta = await handleIncoming(from, body, req.body, baseUrl);
  } catch (e) {
    console.error("Error:", e?.message || e);
    respuesta = "Ocurrió un error procesando tu mensaje. Intenta de nuevo 🙏";
  }

  // Guardar meta idempotencia
  const sid = norm(req.body.MessageSid || "");
  if (sid) {
    const respText = (typeof respuesta === "string") ? respuesta : (respuesta?.text || "");
    await setSessionMeta(norm(from), { _last_sid: sid, _last_resp: respText });
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
