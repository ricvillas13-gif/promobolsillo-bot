import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

/**
 * ============================================================
 * PROMOBOLSILLO+ – PILOTO REZGO (PROMOTOR + SUPERVISOR)
 * - Asistencia por tienda (entrada/salida con foto+ubicación)
 * - Evidencias por tienda → marca → tipo → antes/después → N fotos
 * - Supervisor: ver evidencias, ver fotos, envío múltiple, asistencia equipo
 * ============================================================
 */

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
  console.warn(
    "⚠️ Falta TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN. Reenvío a cliente deshabilitado."
  );
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const MessagingResponse = twilio.twiml.MessagingResponse;

// ==========================
// Google Sheets client (cache)
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
// Helpers generales
// ==========================
function norm(s) {
  return (s || "").toString().trim();
}
function upper(s) {
  return norm(s).toUpperCase();
}
function isTrue(v) {
  const t = upper(v);
  return t === "TRUE" || t === "1" || t === "SI" || t === "SÍ";
}
function safeInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}

function parseSelectionIndices(resto, maxLen) {
  // Acepta: "1,2,4" o "1 2 4" o "1, 2 4"
  const partes = resto
    .split(/[, ]+/)
    .map((p) => p.trim())
    .filter((p) => p);

  if (!partes.length) return { ok: false, indices: [], error: "Vacío" };

  const indices = [];
  for (const p of partes) {
    const n = parseInt(p, 10);
    if (Number.isNaN(n) || n < 1 || n > maxLen) {
      return {
        ok: false,
        indices: [],
        error: `Número inválido (${p}). Rango: 1-${maxLen}`,
      };
    }
    indices.push(n - 1);
  }
  const uniq = Array.from(new Set(indices));
  return { ok: true, indices: uniq };
}

function buildPagedList(items, page, pageSize) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * pageSize;
  const end = Math.min(total, start + pageSize);
  const slice = items.slice(start, end);
  return { page: p, pages, start, end, slice, total };
}

function normalizeWhatsAppPhone(raw) {
  const t = norm(raw);
  if (!t) return "";
  if (t.startsWith("whatsapp:")) return t;
  if (t.startsWith("+")) return "whatsapp:" + t;
  return t; // no adivino país aquí
}

// ==========================
// Estados
// ==========================
const STATE_MENU = "MENU_PRINCIPAL";

// Promotor - Asistencia (por tienda)
const STATE_ASIS_ELEGIR_TIENDA = "ASIS_ELEGIR_TIENDA";
const STATE_ASIS_ACCION = "ASIS_ACCION"; // entrada o salida
const STATE_ASIS_FOTO = "ASIS_FOTO";
const STATE_ASIS_UBI = "ASIS_UBI";

// Promotor - Evidencias
const STATE_EVID_ELEGIR_TIENDA = "EVID_ELEGIR_TIENDA";
const STATE_EVID_ELEGIR_MARCA = "EVID_ELEGIR_MARCA";
const STATE_EVID_ELEGIR_TIPO = "EVID_ELEGIR_TIPO";
const STATE_EVID_ELEGIR_FASE = "EVID_ELEGIR_FASE";
const STATE_EVID_FOTOS = "EVID_FOTOS";

// Supervisor
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";
const STATE_SUP_ASIST_EQ = "SUP_ASIST_EQ";

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
      try {
        data_json = r[2] ? JSON.parse(r[2]) : {};
      } catch {
        data_json = {};
      }
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
    await updateSheetValues(`SESIONES!A${ses.rowIndex}:C${ses.rowIndex}`, [
      [telefono, estado_actual, dataStr],
    ]);
  }
}

// ==========================
// Catálogos: PROMOTORES / SUPERVISORES
// ==========================

async function getSupervisorPorTelefono(telefono) {
  // SUPERVISORES: A telefono, B supervisor_id, C nombre, D region, E nivel, F activo
  const rows = await getSheetValues("SUPERVISORES!A2:F");
  for (const r of rows) {
    const tel = norm(r[0]);
    const activo = isTrue(r[5]);
    if (tel === telefono && activo) {
      return {
        telefono: tel,
        supervisor_id: norm(r[1]),
        nombre: norm(r[2]),
        region: norm(r[3]),
        nivel: norm(r[4]),
        activo,
      };
    }
  }
  return null;
}

async function getPromotorPorTelefono(telefono) {
  // PROMOTORES: A telefono, B promotor_id, C nombre, D region, E cadena, F activo, G telefono_supervisor
  const rows = await getSheetValues("PROMOTORES!A2:G");
  for (const r of rows) {
    const tel = norm(r[0]);
    if (tel === telefono) {
      return {
        telefono: tel,
        promotor_id: norm(r[1]),
        nombre: norm(r[2]),
        region: norm(r[3]),
        cadena_principal: norm(r[4]),
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
      region: norm(r[3]),
      cadena_principal: norm(r[4]),
    }));
}

// ==========================
// TIENDAS + ASIGNACIONES
// ==========================

async function getTiendaMap() {
  // TIENDAS: A tienda_id, B nombre, C cadena, D ciudad, E region, F activa, G+ extras
  const rows = await getSheetValues("TIENDAS!A2:K");
  const map = {};
  for (const r of rows) {
    const tienda_id = norm(r[0]);
    if (!tienda_id) continue;
    map[tienda_id] = {
      tienda_id,
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
  // ASIGNACIONES: A promotor_id, B tienda_id, C frecuencia, D activa
  const rows = await getSheetValues("ASIGNACIONES!A2:D");
  const tiendaIds = [];
  for (const r of rows) {
    if (norm(r[0]) === promotor_id && isTrue(r[3] ?? "TRUE")) {
      const tid = norm(r[1]);
      if (tid) tiendaIds.push(tid);
    }
  }
  // uniq
  return Array.from(new Set(tiendaIds));
}

// ==========================
// MARCAS / TIENDA_MARCA / REGLAS_EVIDENCIA
// ==========================

async function getMarcasActivasMap() {
  // MARCAS: A marca_id, B cliente_id(opc), C marca_nombre, D activa
  // o MARCAS: A marca_id, B marca_nombre, C activa (si no hay cliente_id)
  const rows = await getSheetValues("MARCAS!A2:D");
  const map = {};
  for (const r of rows) {
    const marca_id = norm(r[0]);
    if (!marca_id) continue;
    // si r[3] existe -> activa; si no, r[2]
    const activa = r.length >= 4 ? isTrue(r[3]) : isTrue(r[2]);
    const marca_nombre = r.length >= 4 ? norm(r[2]) : norm(r[1]);
    const cliente_id = r.length >= 4 ? norm(r[1]) : "";
    if (activa) {
      map[marca_id] = { marca_id, cliente_id, marca_nombre, activa };
    }
  }
  return map;
}

async function getMarcasPorTienda(tienda_id) {
  // TIENDA_MARCA: A tienda_id, B marca_id, C activa
  const rows = await getSheetValues("TIENDA_MARCA!A2:C");
  const marcaIds = [];
  for (const r of rows) {
    if (norm(r[0]) === tienda_id && isTrue(r[2] ?? "TRUE")) {
      const mid = norm(r[1]);
      if (mid) marcaIds.push(mid);
    }
  }
  return Array.from(new Set(marcaIds));
}

async function getReglasPorMarca(marca_id) {
  // REGLAS_EVIDENCIA: A marca_id, B tipo_evidencia, C fotos_requeridas, D requiere_antes_despues, E activa
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
      activa,
    });
  }
  return reglas;
}

// ==========================
// VISITAS (usamos como asistencia por tienda)
// VISITAS columnas base:
// A visita_id, B promotor_id, C tienda_id, D fecha, E hora_inicio, F hora_fin
// ==========================

async function findOpenVisit(promotor_id, tienda_id, fechaISO) {
  const rows = await getSheetValues("VISITAS!A2:F");
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (
      norm(r[1]) === promotor_id &&
      norm(r[2]) === tienda_id &&
      norm(r[3]) === fechaISO &&
      !norm(r[5]) // hora_fin vacío
    ) {
      return { rowIndex: i + 2, visita_id: norm(r[0]), row: r };
    }
  }
  return null;
}

async function createVisit(promotor_id, tienda_id) {
  const visita_id = "V-" + Date.now();
  const fecha = todayISO();
  const hora_inicio = nowISO();
  await appendSheetValues("VISITAS!A2:F", [
    [visita_id, promotor_id, tienda_id, fecha, hora_inicio, ""],
  ]);
  return visita_id;
}

async function closeVisit(visitaRowIndex) {
  const hora_fin = nowISO();
  await updateSheetValues(`VISITAS!F${visitaRowIndex}:F${visitaRowIndex}`, [[hora_fin]]);
}

async function getUltimasVisitas(promotor_id, limite = 5) {
  const rows = await getSheetValues("VISITAS!A2:F");
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (norm(r[1]) !== promotor_id) continue;
    out.push({
      visita_id: norm(r[0]),
      promotor_id: norm(r[1]),
      tienda_id: norm(r[2]),
      fecha: norm(r[3]),
      hora_inicio: norm(r[4]),
      hora_fin: norm(r[5]),
    });
    if (out.length >= limite) break;
  }
  return out;
}

async function getVisitasHoyPorPromotor(promotor_id) {
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

// ==========================
// EVIDENCIAS
// EVIDENCIAS base A2:M + extras N.. (no rompe si no existen headers)
// Base A-M:
// A evidencia_id
// B telefono
// C fecha_hora
// D tipo_evento
// E origen
// F jornada_id (no usamos)
// G visita_id
// H url_foto
// I lat
// J lon
// K resultado_ai
// L score_confianza
// M riesgo
//
// Extras (N..):
// N tienda_id
// O promotor_id
// P marca_id
// Q marca_nombre
// R tipo_evidencia
// S fase (ANTES/DESPUES/NA)
// T batch_id
// U seq
// V comentario
// ==========================

function demoAnalisisPorTipo(tipo_evento) {
  // demo simple: riesgo aleatorio suave según tipo
  const t = upper(tipo_evento);
  if (t.includes("ENTRADA")) return { resultado_ai: "Entrada validada (demo).", score: 0.93, riesgo: "BAJO" };
  if (t.includes("SALIDA")) return { resultado_ai: "Salida validada (demo).", score: 0.92, riesgo: "BAJO" };
  if (t.includes("EVIDENCIA")) {
    // baja probabilidad de MEDIO/ALTO para que el supervisor vea algo
    const r = Math.random();
    if (r < 0.08) return { resultado_ai: "Posible evidencia incompleta (demo).", score: 0.62, riesgo: "ALTO" };
    if (r < 0.20) return { resultado_ai: "Evidencia con dudas leves (demo).", score: 0.78, riesgo: "MEDIO" };
    return { resultado_ai: "Evidencia coherente (demo).", score: 0.90, riesgo: "BAJO" };
  }
  return { resultado_ai: "Registro OK (demo).", score: 0.9, riesgo: "BAJO" };
}

async function registrarEvidenciaFoto({
  telefono,
  tipo_evento,
  origen,
  visita_id,
  tienda_id,
  promotor_id,
  marca_id = "",
  marca_nombre = "",
  tipo_evidencia = "",
  fase = "NA",
  batch_id = "",
  seq = 1,
  fotoUrl = "",
  lat = "",
  lon = "",
  comentario = "",
}) {
  const evidencia_id = "EV-" + Date.now() + "-" + seq;
  const fecha_hora = nowISO();
  const demo = demoAnalisisPorTipo(tipo_evento);
  const resultado_ai = demo.resultado_ai;
  const score_confianza = demo.score;
  const riesgo = demo.riesgo;

  await appendSheetValues("EVIDENCIAS!A2:V", [
    [
      evidencia_id,
      telefono,
      fecha_hora,
      tipo_evento,
      origen,
      "", // jornada_id no se usa en este piloto
      visita_id || "",
      fotoUrl,
      lat,
      lon,
      resultado_ai,
      score_confianza,
      riesgo,
      tienda_id || "",
      promotor_id || "",
      marca_id || "",
      marca_nombre || "",
      tipo_evidencia || "",
      fase || "NA",
      batch_id || "",
      seq,
      comentario || "",
    ],
  ]);

  return { evidencia_id, resultado_ai, score_confianza, riesgo };
}

function mapEvidRowExt(r) {
  // Soporta tanto base A-M como extendido
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
    comentario: norm(r[21]),
  };
}

async function getEvidenciasHoy() {
  const rows = await getSheetValues("EVIDENCIAS!A2:V");
  const hoy = todayISO();
  return rows
    .map(mapEvidRowExt)
    .filter((ev) => (ev.fecha_hora || "").slice(0, 10) === hoy);
}

// ==========================
// GRUPOS_CLIENTE (para reenvío)
// ==========================
async function getGruposClienteActivos() {
  // GRUPOS_CLIENTE: A grupo_id, B nombre_grupo, C cliente, D telefonos_csv, E activo
  const rows = await getSheetValues("GRUPOS_CLIENTE!A2:E");
  return rows
    .filter((r) => isTrue(r[4] ?? "TRUE"))
    .map((r) => {
      const telefonos = norm(r[3])
        .split(",")
        .map((t) => norm(t))
        .filter((t) => t);
      return {
        grupo_id: norm(r[0]),
        nombre_grupo: norm(r[1]),
        cliente: norm(r[2]),
        telefonos,
      };
    });
}

async function enviarFotoAGrupoCliente(evidence, grupo, tiendaMap) {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    return { ok: false, enviados: 0 };
  }

  const tienda = evidence.tienda_id ? tiendaMap[evidence.tienda_id] : null;
  const tiendaTexto = tienda
    ? `${tienda.nombre_tienda}${tienda.ciudad ? " (" + tienda.ciudad + ")" : ""}`
    : "";

  const titulo =
    "🏪 *Evidencia en punto de venta*\n" +
    (grupo.cliente ? `👤 Cliente: ${grupo.cliente}\n` : "") +
    (evidence.marca_nombre ? `🏷️ Marca: ${evidence.marca_nombre}\n` : "") +
    (tiendaTexto ? `🏬 Tienda: ${tiendaTexto}\n` : "") +
    (evidence.tipo_evidencia ? `🧾 Tipo: ${evidence.tipo_evidencia}\n` : `🧾 Tipo: ${evidence.tipo_evento}\n`) +
    (evidence.fase && evidence.fase !== "NA" ? `🔁 Fase: ${evidence.fase}\n` : "") +
    (evidence.fecha_hora ? `📅 Fecha: ${evidence.fecha_hora}\n` : "") +
    `🧠 EVIDENCIA+ (demo) – Riesgo: ${evidence.riesgo}\n` +
    (evidence.comentario ? `💬 Nota: ${evidence.comentario}\n` : "");

  let enviados = 0;
  for (const telDestino of grupo.telefonos) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: telDestino,
        body: titulo,
        mediaUrl: evidence.url_foto ? [evidence.url_foto] : undefined,
      });
      enviados++;
    } catch (e) {
      console.error("Error enviando a cliente:", telDestino, e?.message || e);
    }
  }

  return { ok: enviados > 0, enviados };
}

// ==========================
// Menús / ayuda
// ==========================
function buildMenuPromotor() {
  return (
    "👋 Hola, soy *Promobolsillo+*.\n\n" +
    "¿Qué quieres hacer?\n" +
    "1️⃣ Registrar asistencia por tienda (entrada/salida 📸📍)\n" +
    "2️⃣ Registrar evidencias (tienda → marca → tipo → fotos)\n" +
    "3️⃣ Ver mi historial de asistencias\n" +
    "4️⃣ Ayuda\n\n" +
    "Comandos:\n" +
    "• `menu` → volver al inicio\n" +
    "• `sup` → menú supervisor (si aplica)\n" +
    "• `ayuda` → ver ayuda\n"
  );
}

function buildAyudaPromotor() {
  return (
    "🆘 *Ayuda (Promotor)*\n\n" +
    "Flujo recomendado:\n" +
    "1) Registra asistencia por tienda (entrada).\n" +
    "2) En esa tienda, registra evidencias por marca.\n" +
    "3) Al terminar en tienda, registra salida.\n\n" +
    "Comandos:\n" +
    "• `menu` → inicio\n" +
    "• `ayuda` → ayuda\n" +
    "• `sup` → supervisor (si tu número es supervisor)\n"
  );
}

function buildMenuSupervisor(supervisorNombre = "Supervisor") {
  return (
    `👋 Hola, *${supervisorNombre}* (Supervisor).\n\n` +
    "¿Qué quieres hacer?\n" +
    "1️⃣ Ver evidencias de hoy por promotor\n" +
    "2️⃣ Ver evidencias de hoy con riesgo MEDIO/ALTO 🧠📸\n" +
    "3️⃣ Ver asistencia de mi equipo hoy 🕒\n" +
    "4️⃣ Ayuda\n\n" +
    "Comandos:\n" +
    "• `sup` → volver a este menú\n" +
    "• `menu` → menú promotor\n"
  );
}

function buildAyudaSupervisor() {
  return (
    "🆘 *Ayuda (Supervisor)*\n\n" +
    "En listados de evidencias:\n" +
    "• `ver 2` → ver detalle + foto #2\n" +
    "• `enviar 1` → enviar la evidencia #1 al cliente\n" +
    "• `enviar 1,3,5` → envío múltiple\n" +
    "• `enviar todas` → enviar todas las listadas\n\n" +
    "Comandos:\n" +
    "• `sup` → menú supervisor\n" +
    "• `menu` → menú promotor\n"
  );
}

// ==========================
// PROMOTOR: Asistencia por tienda
// ==========================
async function startAsistenciaElegirTienda(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) {
    return "⚠️ Tu número no aparece como promotor activo. Revisa PROMOTORES.";
  }

  const tiendaMap = await getTiendaMap();
  const asignadas = await getTiendasAsignadas(prom.promotor_id);
  const tiendas = asignadas
    .map((id) => tiendaMap[id])
    .filter((t) => t && t.activa);

  if (!tiendas.length) {
    return "⚠️ No tienes tiendas asignadas activas. Revisa ASIGNACIONES y TIENDAS.";
  }

  // guardamos lista completa en sesión con paginación
  await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA, {
    promotor_id: prom.promotor_id,
    tiendas: tiendas.map((t) => ({
      tienda_id: t.tienda_id,
      nombre_tienda: t.nombre_tienda,
      cadena: t.cadena,
      ciudad: t.ciudad,
    })),
    page: 0,
    pageSize: 8,
  });

  return buildTiendaListMessage("🕒 *Asistencia – selecciona tienda*", tiendas, 0, 8);
}

function buildTiendaListMessage(title, tiendas, page, pageSize) {
  const { slice, page: p, pages, total } = buildPagedList(tiendas, page, pageSize);
  let msg = `${title}\n\n`;
  slice.forEach((t, idx) => {
    msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena}${t.ciudad ? " (" + t.ciudad + ")" : ""}\n`;
  });
  msg += `\nPágina ${p + 1}/${pages} (${total} tiendas)\n`;
  msg += "Responde con el número de la tienda.";
  if (pages > 1) msg += "\nEscribe `mas` para ver más tiendas.";
  msg += "\nEscribe `menu` para volver.";
  return msg;
}

async function handleAsistencia(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  // elegir tienda
  if (estado === STATE_ASIS_ELEGIR_TIENDA) {
    const tiendas = data.tiendas || [];
    const pageSize = data.pageSize || 8;
    let page = data.page || 0;

    if (lower === "mas") {
      page++;
      const msg = buildTiendaListMessage(
        "🕒 *Asistencia – selecciona tienda*",
        tiendas,
        page,
        pageSize
      );
      await setSession(telefono, STATE_ASIS_ELEGIR_TIENDA, { ...data, page });
      return msg;
    }

    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(pageSize, tiendas.length - page * pageSize)) {
      // si el usuario manda un número válido global, lo resolvemos respecto a página
      // (aceptamos que escriba 9, 10… no, mantenemos local de la página para evitar confusión)
      return "⚠️ Elige un número válido de la lista (o escribe `mas`).";
    }

    const idxGlobal = page * pageSize + (n - 1);
    const tienda = tiendas[idxGlobal];
    if (!tienda) return "⚠️ Tienda inválida. Intenta de nuevo.";

    // determinamos si hay visita abierta hoy para esa tienda
    const promotor_id = data.promotor_id;
    const open = await findOpenVisit(promotor_id, tienda.tienda_id, todayISO());

    if (open) {
      // hay visita abierta -> se ofrece SALIDA
      await setSession(telefono, STATE_ASIS_ACCION, {
        promotor_id,
        tienda_id: tienda.tienda_id,
        tienda_nombre: tienda.nombre_tienda,
        visita_id: open.visita_id,
        visita_rowIndex: open.rowIndex,
        accion: "SALIDA",
      });
      return (
        `🏬 *${tienda.nombre_tienda}*\n\n` +
        "Ya tienes una *entrada* registrada hoy para esta tienda.\n" +
        "¿Qué deseas hacer?\n" +
        "1️⃣ Registrar *SALIDA* (foto + ubicación)\n" +
        "2️⃣ Cancelar"
      );
    }

    // no hay visita abierta -> se ofrece ENTRADA
    await setSession(telefono, STATE_ASIS_ACCION, {
      promotor_id,
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      accion: "ENTRADA",
    });

    return (
      `🏬 *${tienda.nombre_tienda}*\n\n` +
      "No tengo entrada registrada hoy para esta tienda.\n" +
      "¿Qué deseas hacer?\n" +
      "1️⃣ Registrar *ENTRADA* (foto + ubicación)\n" +
      "2️⃣ Cancelar"
    );
  }

  // confirmar acción
  if (estado === STATE_ASIS_ACCION) {
    if (lower === "2" || lower === "cancelar") {
      await setSession(telefono, STATE_MENU, {});
      return buildMenuPromotor();
    }
    if (lower !== "1") return "Responde 1️⃣ para continuar o 2️⃣ para cancelar.";

    const accion = data.accion; // ENTRADA o SALIDA
    await setSession(telefono, STATE_ASIS_FOTO, {
      ...data,
      accion,
    });

    if (accion === "ENTRADA") {
      return `🕒 *Entrada – ${data.tienda_nombre}*\n📸 Envía una *foto de entrada* (selfie / frente de tienda).`;
    } else {
      return `🚪 *Salida – ${data.tienda_nombre}*\n📸 Envía una *foto de salida* (frente / salida de tienda).`;
    }
  }

  // recibir foto
  if (estado === STATE_ASIS_FOTO) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) {
      return "Necesito una *foto* para este registro. Adjunta foto y reenvía.";
    }
    const fotoUrl = inbound?.MediaUrl0 || "";
    if (!fotoUrl) return "No pude leer la foto. Intenta de nuevo.";

    await setSession(telefono, STATE_ASIS_UBI, {
      ...data,
      fotoUrl,
    });

    return "✅ Foto recibida.\n\n📍 Ahora comparte tu *ubicación* (mensaje de ubicación en WhatsApp).";
  }

  // recibir ubicación y registrar
  if (estado === STATE_ASIS_UBI) {
    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";

    if (!lat || !lon) {
      return "Necesito tu *ubicación* (share location) para completar el registro.";
    }

    const promotor_id = data.promotor_id;
    const tienda_id = data.tienda_id;
    const accion = data.accion;
    const fotoUrl = data.fotoUrl;

    let visita_id = data.visita_id || "";
    let visita_rowIndex = data.visita_rowIndex || null;

    if (accion === "ENTRADA") {
      visita_id = await createVisit(promotor_id, tienda_id);
      // registrar evidencia entrada
      await registrarEvidenciaFoto({
        telefono,
        tipo_evento: "ASISTENCIA_ENTRADA",
        origen: "ASISTENCIA",
        visita_id,
        tienda_id,
        promotor_id,
        fotoUrl,
        lat,
        lon,
        comentario: "",
      });

      await setSession(telefono, STATE_MENU, {});
      return (
        `✅ *Entrada registrada* – ${data.tienda_nombre}\n` +
        "Ahora puedes registrar evidencias (opción 2 del menú).\n\n" +
        buildMenuPromotor()
      );
    }

    // SALIDA
    if (!visita_id) {
      // fallback: buscar abierta
      const open = await findOpenVisit(promotor_id, tienda_id, todayISO());
      if (!open) {
        await setSession(telefono, STATE_MENU, {});
        return (
          "⚠️ No encontré una visita abierta para esta tienda.\n" +
          "Registra primero *entrada*.\n\n" +
          buildMenuPromotor()
        );
      }
      visita_id = open.visita_id;
      visita_rowIndex = open.rowIndex;
    }

    if (visita_rowIndex) {
      await closeVisit(visita_rowIndex);
    }

    await registrarEvidenciaFoto({
      telefono,
      tipo_evento: "ASISTENCIA_SALIDA",
      origen: "ASISTENCIA",
      visita_id,
      tienda_id,
      promotor_id,
      fotoUrl,
      lat,
      lon,
      comentario: "",
    });

    await setSession(telefono, STATE_MENU, {});
    return `✅ *Salida registrada* – ${data.tienda_nombre}\n\n` + buildMenuPromotor();
  }

  await setSession(telefono, STATE_MENU, {});
  return buildMenuPromotor();
}

// ==========================
// PROMOTOR: Evidencias
// ==========================
async function startEvidenciasElegirTienda(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) {
    return "⚠️ Tu número no aparece como promotor activo. Revisa PROMOTORES.";
  }

  const tiendaMap = await getTiendaMap();
  const asignadas = await getTiendasAsignadas(prom.promotor_id);
  const tiendas = asignadas
    .map((id) => tiendaMap[id])
    .filter((t) => t && t.activa);

  if (!tiendas.length) {
    return "⚠️ No tienes tiendas asignadas activas. Revisa ASIGNACIONES y TIENDAS.";
  }

  await setSession(telefono, STATE_EVID_ELEGIR_TIENDA, {
    promotor_id: prom.promotor_id,
    tiendas: tiendas.map((t) => ({
      tienda_id: t.tienda_id,
      nombre_tienda: t.nombre_tienda,
      cadena: t.cadena,
      ciudad: t.ciudad,
    })),
    page: 0,
    pageSize: 8,
  });

  return buildTiendaListMessage("📸 *Evidencias – selecciona tienda*", tiendas, 0, 8);
}

async function handleEvidencias(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();

  // elegir tienda
  if (estado === STATE_EVID_ELEGIR_TIENDA) {
    const tiendas = data.tiendas || [];
    const pageSize = data.pageSize || 8;
    let page = data.page || 0;

    if (lower === "mas") {
      page++;
      const msg = buildTiendaListMessage(
        "📸 *Evidencias – selecciona tienda*",
        tiendas,
        page,
        pageSize
      );
      await setSession(telefono, STATE_EVID_ELEGIR_TIENDA, { ...data, page });
      return msg;
    }

    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(pageSize, tiendas.length - page * pageSize)) {
      return "⚠️ Elige un número válido de la lista (o escribe `mas`).";
    }

    const idxGlobal = page * pageSize + (n - 1);
    const tienda = tiendas[idxGlobal];
    if (!tienda) return "⚠️ Tienda inválida.";

    // Requerimos que exista entrada (visita abierta) hoy para esa tienda
    const open = await findOpenVisit(data.promotor_id, tienda.tienda_id, todayISO());
    if (!open) {
      return (
        `⚠️ Para registrar evidencias en *${tienda.nombre_tienda}*, primero registra *ENTRADA* de esa tienda.\n\n` +
        "Ve a opción 1️⃣ (Asistencia) y registra la entrada."
      );
    }

    // cargar marcas para tienda (si TIENDA_MARCA no tiene datos, mostramos todas)
    const marcasMap = await getMarcasActivasMap();
    let marcaIds = [];
    try {
      marcaIds = await getMarcasPorTienda(tienda.tienda_id);
    } catch {
      marcaIds = [];
    }

    let marcas = [];
    if (marcaIds.length) {
      marcas = marcaIds.map((id) => marcasMap[id]).filter(Boolean);
    } else {
      marcas = Object.values(marcasMap);
    }

    if (!marcas.length) {
      return "⚠️ No hay marcas activas configuradas. Revisa pestaña MARCAS.";
    }

    // orden por nombre
    marcas.sort((a, b) => a.marca_nombre.localeCompare(b.marca_nombre));

    await setSession(telefono, STATE_EVID_ELEGIR_MARCA, {
      promotor_id: data.promotor_id,
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      visita_id: open.visita_id,
      marcas: marcas.map((m) => ({ marca_id: m.marca_id, marca_nombre: m.marca_nombre })),
      page: 0,
      pageSize: 8,
    });

    // mostrar marcas paginadas
    const { slice, page: p, pages, total } = buildPagedList(marcas, 0, 8);
    let msg = `🏬 *${tienda.nombre_tienda}*\n🏷️ Selecciona *marca*:\n\n`;
    slice.forEach((m, idx) => {
      msg += `${idx + 1}) ${m.marca_nombre}\n`;
    });
    msg += `\nPágina ${p + 1}/${pages} (${total} marcas)\n`;
    msg += "Responde con el número de la marca.";
    if (pages > 1) msg += "\nEscribe `mas` para ver más marcas.";
    msg += "\nEscribe `menu` para volver.";
    return msg;
  }

  // elegir marca
  if (estado === STATE_EVID_ELEGIR_MARCA) {
    const marcas = data.marcas || [];
    const pageSize = data.pageSize || 8;
    let page = data.page || 0;

    if (lower === "mas") {
      page++;
      const { slice, page: p, pages, total } = buildPagedList(marcas, page, pageSize);
      await setSession(telefono, STATE_EVID_ELEGIR_MARCA, { ...data, page });
      let msg = `🏬 *${data.tienda_nombre}*\n🏷️ Selecciona *marca*:\n\n`;
      slice.forEach((m, idx) => {
        msg += `${idx + 1}) ${m.marca_nombre}\n`;
      });
      msg += `\nPágina ${p + 1}/${pages} (${total} marcas)\n`;
      msg += "Responde con el número de la marca.";
      if (pages > 1) msg += "\nEscribe `mas` para ver más marcas.";
      msg += "\nEscribe `menu` para volver.";
      return msg;
    }

    const n = safeInt(text, -1);
    if (n < 1 || n > Math.min(pageSize, marcas.length - page * pageSize)) {
      return "⚠️ Elige un número válido de la lista (o escribe `mas`).";
    }
    const idxGlobal = page * pageSize + (n - 1);
    const marca = marcas[idxGlobal];
    if (!marca) return "⚠️ Marca inválida.";

    const reglas = await getReglasPorMarca(marca.marca_id);
    if (!reglas.length) {
      return (
        `⚠️ No hay reglas de evidencia activas para *${marca.marca_nombre}*.\n` +
        "Revisa la pestaña REGLAS_EVIDENCIA."
      );
    }

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
    msg += "\nResponde con el número del tipo de evidencia.";
    msg += "\nEscribe `menu` para volver.";
    return msg;
  }

  // elegir tipo evidencia
  if (estado === STATE_EVID_ELEGIR_TIPO) {
    const reglas = data.reglas || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > reglas.length) {
      return "⚠️ Elige un número válido de la lista.";
    }
    const regla = reglas[n - 1];
    if (!regla) return "⚠️ Regla inválida.";

    // si requiere antes/después pedimos fase
    if (regla.requiere_antes_despues) {
      await setSession(telefono, STATE_EVID_ELEGIR_FASE, {
        ...data,
        regla,
      });
      return (
        `🧾 Tipo: *${regla.tipo_evidencia}*\n` +
        "¿Qué fase vas a capturar?\n" +
        "1️⃣ ANTES\n" +
        "2️⃣ DESPUÉS\n\n" +
        "Responde con 1 o 2."
      );
    }

    // no requiere fase -> directo a fotos
    const batch_id = "B-" + Date.now();
    await setSession(telefono, STATE_EVID_FOTOS, {
      ...data,
      regla,
      fase: "NA",
      batch_id,
      fotos_requeridas: regla.fotos_requeridas,
      fotos_recibidas: 0,
    });

    return (
      `📸 *Captura de evidencias*\n` +
      `🏬 Tienda: *${data.tienda_nombre}*\n` +
      `🏷️ Marca: *${data.marca_nombre}*\n` +
      `🧾 Tipo: *${regla.tipo_evidencia}*\n\n` +
      `Envía *${regla.fotos_requeridas}* foto(s) en un solo mensaje (puedes seleccionar varias).\n` +
      "Puedes escribir un comentario en el texto del mismo envío (opcional)."
    );
  }

  // elegir fase
  if (estado === STATE_EVID_ELEGIR_FASE) {
    if (lower !== "1" && lower !== "2") return "Responde 1️⃣ ANTES o 2️⃣ DESPUÉS.";

    const fase = lower === "1" ? "ANTES" : "DESPUES";
    const regla = data.regla;
    const batch_id = "B-" + Date.now();

    await setSession(telefono, STATE_EVID_FOTOS, {
      ...data,
      fase,
      batch_id,
      fotos_requeridas: regla.fotos_requeridas,
      fotos_recibidas: 0,
    });

    return (
      `📸 *Captura de evidencias*\n` +
      `🏬 Tienda: *${data.tienda_nombre}*\n` +
      `🏷️ Marca: *${data.marca_nombre}*\n` +
      `🧾 Tipo: *${regla.tipo_evidencia}*\n` +
      `🔁 Fase: *${fase}*\n\n` +
      `Envía *${regla.fotos_requeridas}* foto(s) en un solo mensaje (puedes seleccionar varias).\n` +
      "Puedes escribir un comentario en el texto del mismo envío (opcional)."
    );
  }

  // recibir fotos (posible en uno o varios mensajes)
  if (estado === STATE_EVID_FOTOS) {
    const numMedia = safeInt(inbound?.NumMedia || "0", 0);
    if (numMedia < 1) {
      return "Necesito que envíes foto(s). Selecciona una o varias y reenvía.";
    }

    const comentario = norm(inbound?.Body || text || ""); // caption si escriben texto con fotos
    const regla = data.regla;
    const needed = data.fotos_requeridas || regla.fotos_requeridas || 1;
    const fase = data.fase || "NA";
    const batch_id = data.batch_id || ("B-" + Date.now());

    const lat = inbound?.Latitude || inbound?.Latitude0 || "";
    const lon = inbound?.Longitude || inbound?.Longitude0 || "";

    // registramos cada foto como fila
    const toProcess = Math.min(numMedia, 10); // límite de seguridad
    const tiendaMap = await getTiendaMap(); // solo para futuros usos, no crítico aquí

    let seqBase = (data.fotos_recibidas || 0) + 1;
    for (let i = 0; i < toProcess; i++) {
      const url = inbound?.[`MediaUrl${i}`] || "";
      if (!url) continue;

      await registrarEvidenciaFoto({
        telefono,
        tipo_evento: `EVIDENCIA_${upper(regla.tipo_evidencia) || "EVIDENCIA"}`,
        origen: "EVIDENCIA",
        visita_id: data.visita_id,
        tienda_id: data.tienda_id,
        promotor_id: data.promotor_id,
        marca_id: data.marca_id,
        marca_nombre: data.marca_nombre,
        tipo_evidencia: regla.tipo_evidencia,
        fase,
        batch_id,
        seq: seqBase,
        fotoUrl: url,
        lat,
        lon,
        comentario,
      });

      seqBase++;
    }

    const recibidas = (data.fotos_recibidas || 0) + toProcess;

    if (recibidas < needed) {
      await setSession(telefono, STATE_EVID_FOTOS, {
        ...data,
        fotos_recibidas: recibidas,
      });

      const faltan = needed - recibidas;
      return (
        `✅ Recibí *${toProcess}* foto(s).\n` +
        `Aún faltan *${faltan}* foto(s) para completar este tipo de evidencia.\n\n` +
        "Envía las fotos restantes (puedes mandar varias juntas)."
      );
    }

    await setSession(telefono, STATE_MENU, {});
    return (
      `✅ Evidencia registrada.\n` +
      `🏬 Tienda: *${data.tienda_nombre}*\n` +
      `🏷️ Marca: *${data.marca_nombre}*\n` +
      `🧾 Tipo: *${regla.tipo_evidencia}*\n` +
      (fase !== "NA" ? `🔁 Fase: *${fase}*\n` : "") +
      `📸 Fotos: *${needed}*\n\n` +
      buildMenuPromotor()
    );
  }

  await setSession(telefono, STATE_MENU, {});
  return buildMenuPromotor();
}

// ==========================
// SUPERVISOR
// ==========================
async function handleSupervisor(telefono, estado, text, data, inbound) {
  const lower = norm(text).toLowerCase();
  const supervisor = await getSupervisorPorTelefono(telefono);
  if (!supervisor) {
    await setSession(telefono, STATE_MENU, {});
    return "⚠️ Tu número no está como supervisor activo. Escribe `menu`.";
  }

  if (lower === "ayuda" || lower === "help") return buildAyudaSupervisor();

  // MENU
  if (estado === STATE_SUP_MENU) {
    if (lower === "1") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      if (!equipo.length) return "⚠️ No tienes promotores asignados. Revisa PROMOTORES (telefono_supervisor).";

      const evidenciasHoy = await getEvidenciasHoy();
      const telSet = new Set(equipo.map((p) => p.telefono));
      const conteos = {};
      for (const ev of evidenciasHoy) {
        if (!telSet.has(ev.telefono)) continue;
        conteos[ev.telefono] = (conteos[ev.telefono] || 0) + 1;
      }

      let msg = "👀 *Evidencias de hoy por promotor*\n\n";
      equipo.forEach((p, idx) => {
        msg += `${idx + 1}) ${p.nombre} – ${(conteos[p.telefono] || 0)} evidencia(s)\n`;
      });
      msg += "\nResponde con el número del promotor.";

      await setSession(telefono, STATE_SUP_PROMOTOR_LIST, {
        equipo,
      });
      return msg;
    }

    if (lower === "2") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      if (!equipo.length) return "⚠️ No tienes promotores asignados. Revisa PROMOTORES (telefono_supervisor).";

      const telSet = new Set(equipo.map((p) => p.telefono));
      const telToName = {};
      equipo.forEach((p) => (telToName[p.telefono] = p.nombre));

      const evidenciasHoy = await getEvidenciasHoy();
      const filtradas = evidenciasHoy
        .filter((ev) => telSet.has(ev.telefono) && (ev.riesgo === "MEDIO" || ev.riesgo === "ALTO"))
        .map((ev) => ({ ...ev, promotor_nombre: telToName[ev.telefono] || ev.telefono }));

      if (!filtradas.length) return "🧠📸 No hay evidencias MEDIO/ALTO hoy para tu equipo.";

      const tiendaMap = await getTiendaMap();

      let msg = "🧠📸 *Evidencias MEDIO/ALTO de hoy*\n\n";
      filtradas.forEach((ev, idx) => {
        const t = ev.tienda_id ? tiendaMap[ev.tienda_id] : null;
        const tiendaTxt = t ? ` – ${t.nombre_tienda}` : "";
        const marcaTxt = ev.marca_nombre ? ` – ${ev.marca_nombre}` : "";
        const tipoTxt = ev.tipo_evidencia ? ev.tipo_evidencia : ev.tipo_evento;
        const faseTxt = ev.fase && ev.fase !== "NA" ? ` (${ev.fase})` : "";
        msg += `${idx + 1}) ${tipoTxt}${faseTxt}${marcaTxt}${tiendaTxt} – ${ev.promotor_nombre} – riesgo ${ev.riesgo}\n`;
      });

      msg +=
        "\nComandos:\n" +
        "• `ver 2`\n" +
        "• `enviar 1,3,5`\n" +
        "• `enviar todas`\n" +
        "• `sup` para menú";

      await setSession(telefono, STATE_SUP_FOTOS_LIST, {
        listado: filtradas,
        modo: "RIESGO",
      });

      return msg;
    }

    if (lower === "3") {
      const equipo = await getPromotoresDeSupervisor(telefono);
      if (!equipo.length) return "⚠️ No tienes promotores asignados.";

      const tiendaMap = await getTiendaMap();
      const fecha = todayISO();

      let msg = "🕒 *Asistencia (visitas) de tu equipo hoy*\n\n";
      for (const p of equipo) {
        const visitas = await getVisitasHoyPorPromotor(p.promotor_id);
        if (!visitas.length) {
          msg += `- ${p.nombre}: sin visitas hoy\n`;
          continue;
        }
        const abiertas = visitas.filter((v) => !v.hora_fin).length;
        msg += `- ${p.nombre}: ${visitas.length} visita(s) (${abiertas} abierta(s))\n`;
        // mostramos hasta 2 tiendas para no saturar
        const top = visitas.slice(0, 2);
        top.forEach((v) => {
          const t = tiendaMap[v.tienda_id];
          const tn = t ? t.nombre_tienda : v.tienda_id;
          const ent = v.hora_inicio ? v.hora_inicio.substring(11, 16) : "—";
          const sal = v.hora_fin ? v.hora_fin.substring(11, 16) : "—";
          msg += `   • ${tn}: ${ent}–${sal}\n`;
        });
        if (visitas.length > 2) msg += `   • (+${visitas.length - 2} más)\n`;
      }

      msg += "\nEscribe `sup` para volver al menú.";
      await setSession(telefono, STATE_SUP_MENU, {});
      return msg;
    }

    if (lower === "4") return buildAyudaSupervisor();

    return buildMenuSupervisor(supervisor.nombre || "Supervisor");
  }

  // Elegir promotor
  if (estado === STATE_SUP_PROMOTOR_LIST) {
    const equipo = data.equipo || [];
    const n = safeInt(text, -1);
    if (n < 1 || n > equipo.length) return "⚠️ Elige un número válido de promotor.";

    const p = equipo[n - 1];
    const evidenciasHoy = await getEvidenciasHoy();
    const listado = evidenciasHoy
      .filter((ev) => ev.telefono === p.telefono)
      .map((ev) => ({ ...ev, promotor_nombre: p.nombre }));

    if (!listado.length) {
      await setSession(telefono, STATE_SUP_MENU, {});
      return `⚠️ Hoy no hay evidencias para *${p.nombre}*.\n\n` + buildMenuSupervisor(supervisor.nombre);
    }

    const tiendaMap = await getTiendaMap();

    let msg = `📷 *Evidencias de hoy de ${p.nombre}*\n\n`;
    listado.forEach((ev, idx) => {
      const t = ev.tienda_id ? tiendaMap[ev.tienda_id] : null;
      const tiendaTxt = t ? ` – ${t.nombre_tienda}` : "";
      const marcaTxt = ev.marca_nombre ? ` – ${ev.marca_nombre}` : "";
      const tipoTxt = ev.tipo_evidencia ? ev.tipo_evidencia : ev.tipo_evento;
      const faseTxt = ev.fase && ev.fase !== "NA" ? ` (${ev.fase})` : "";
      msg += `${idx + 1}) ${tipoTxt}${faseTxt}${marcaTxt}${tiendaTxt} – riesgo ${ev.riesgo}\n`;
    });

    msg +=
      "\nComandos:\n" +
      "• `ver 1`\n" +
      "• `enviar 1,3`\n" +
      "• `enviar todas`\n" +
      "• `sup` para menú";

    await setSession(telefono, STATE_SUP_FOTOS_LIST, {
      listado,
      modo: "POR_PROMOTOR",
      promotor_nombre: p.nombre,
    });

    return msg;
  }

  // Listado de fotos: ver / enviar (múltiple)
  if (estado === STATE_SUP_FOTOS_LIST) {
    const listado = data.listado || [];
    const tiendaMap = await getTiendaMap();

    if (lower === "sup") {
      await setSession(telefono, STATE_SUP_MENU, {});
      return buildMenuSupervisor(supervisor.nombre);
    }

    const verMatch = lower.match(/^ver\s+(\d+)/);
    if (verMatch) {
      const idx = safeInt(verMatch[1], 0) - 1;
      if (idx < 0 || idx >= listado.length) return "⚠️ Número inválido para ver.";

      const ev = listado[idx];
      const tienda = ev.tienda_id ? tiendaMap[ev.tienda_id] : null;
      const tiendaTxt = tienda ? `${tienda.nombre_tienda}${tienda.ciudad ? " (" + tienda.ciudad + ")" : ""}` : "";

      const texto =
        `🧾 *Detalle evidencia ${idx + 1}*\n` +
        (ev.promotor_nombre ? `👤 Promotor: ${ev.promotor_nombre}\n` : "") +
        (tiendaTxt ? `🏬 Tienda: ${tiendaTxt}\n` : "") +
        (ev.marca_nombre ? `🏷️ Marca: ${ev.marca_nombre}\n` : "") +
        (ev.tipo_evidencia ? `🧾 Tipo: ${ev.tipo_evidencia}\n` : `🧾 Tipo: ${ev.tipo_evento}\n`) +
        (ev.fase && ev.fase !== "NA" ? `🔁 Fase: ${ev.fase}\n` : "") +
        (ev.fecha_hora ? `📅 Fecha: ${ev.fecha_hora}\n` : "") +
        `🧠 EVIDENCIA+ (demo): ${ev.resultado_ai || "OK"}\n` +
        `⚠️ Riesgo: ${ev.riesgo}\n` +
        (ev.comentario ? `💬 Nota: ${ev.comentario}\n` : "") +
        `\nComandos:\n• \`enviar ${idx + 1}\`\n• \`enviar 1,3,5\`\n• \`enviar todas\`\n• \`sup\``;

      return { text: texto, mediaUrl: ev.url_foto || null };
    }

    if (lower.startsWith("enviar")) {
      let resto = lower.replace(/^enviar\s*/, "").trim();
      if (!resto) return "⚠️ Usa `enviar 1,3` o `enviar todas`.";

      let seleccionadas = [];
      if (resto === "todas" || resto === "todos") {
        seleccionadas = listado.slice();
      } else {
        const parsed = parseSelectionIndices(resto, listado.length);
        if (!parsed.ok) return "⚠️ " + parsed.error;
        seleccionadas = parsed.indices.map((i) => listado[i]);
      }

      const grupos = await getGruposClienteActivos();
      if (!grupos.length) return "⚠️ No hay grupos activos en GRUPOS_CLIENTE.";

      let msg =
        `📤 *Enviar evidencias*\n\n` +
        `Seleccionaste *${seleccionadas.length}* evidencia(s).\n\n` +
        "¿A qué grupo quieres enviarlas?\n\n";
      grupos.forEach((g, i) => {
        msg += `${i + 1}) ${g.nombre_grupo}${g.cliente ? " – " + g.cliente : ""}\n`;
      });
      msg += "\nResponde con el número del grupo o escribe `sup` para cancelar.";

      await setSession(telefono, STATE_SUP_ELEGIR_GRUPO, {
        evidenciasSeleccionadas: seleccionadas,
        grupos,
      });

      return msg;
    }

    return "⚠️ Usa `ver N`, `enviar 1,3` o `enviar todas`. Escribe `sup` para menú.";
  }

  // Elegir grupo y enviar en lote
  if (estado === STATE_SUP_ELEGIR_GRUPO) {
    const grupos = data.grupos || [];
    const evidencias = data.evidenciasSeleccionadas || [];

    if (lower === "sup" || lower === "cancelar") {
      await setSession(telefono, STATE_SUP_MENU, {});
      return buildMenuSupervisor(supervisor.nombre);
    }

    const n = safeInt(text, -1);
    if (n < 1 || n > grupos.length) return "⚠️ Elige un número de grupo válido.";

    const grupo = grupos[n - 1];
    const tiendaMap = await getTiendaMap();

    let okCount = 0;
    for (const ev of evidencias) {
      const res = await enviarFotoAGrupoCliente(ev, grupo, tiendaMap);
      if (res.ok) okCount++;
    }

    await setSession(telefono, STATE_SUP_MENU, {});
    if (!okCount) {
      return "⚠️ No se pudo enviar. Revisa TWILIO_* y TWILIO_WHATSAPP_FROM.\n\n" + buildMenuSupervisor(supervisor.nombre);
    }
    return `✅ Se enviaron *${okCount}* evidencia(s) al grupo *${grupo.nombre_grupo}*.\n\n` + buildMenuSupervisor(supervisor.nombre);
  }

  await setSession(telefono, STATE_SUP_MENU, {});
  return buildMenuSupervisor(supervisor.nombre);
}

// ==========================
// Historial de asistencias (por promotor)
// ==========================
async function buildHistorialAsistencias(telefono) {
  const prom = await getPromotorPorTelefono(telefono);
  if (!prom || !prom.activo) return "⚠️ No estás como promotor activo.";

  const visitas = await getUltimasVisitas(prom.promotor_id, 8);
  if (!visitas.length) return "🕒 Aún no tienes asistencias registradas. Usa opción 1️⃣.";

  const tiendaMap = await getTiendaMap();

  let msg = "🕒 *Tus últimas asistencias (visitas por tienda)*\n\n";
  visitas.forEach((v, idx) => {
    const t = tiendaMap[v.tienda_id];
    const tn = t ? t.nombre_tienda : v.tienda_id;
    const ent = v.hora_inicio ? v.hora_inicio.substring(11, 16) : "—";
    const sal = v.hora_fin ? v.hora_fin.substring(11, 16) : "—";
    msg += `${idx + 1}) ${v.fecha} – ${tn} – ${ent}–${sal}\n`;
  });
  msg += "\nEscribe `menu` para volver.";
  return msg;
}

// ==========================
// Router principal
// ==========================
async function handleIncoming(from, body, inbound) {
  const telefono = norm(from);
  const text = norm(body);
  const lower = text.toLowerCase();

  // Comandos globales
  if (lower === "menu" || lower === "inicio") {
    await setSession(telefono, STATE_MENU, {});
    return buildMenuPromotor();
  }

  if (lower === "ayuda" || lower === "help" || lower === "?") {
    const sup = await getSupervisorPorTelefono(telefono);
    return sup ? buildAyudaSupervisor() : buildAyudaPromotor();
  }

  if (lower === "sup") {
    const sup = await getSupervisorPorTelefono(telefono);
    if (!sup) return "⚠️ Tu número no está dado de alta como supervisor.";
    await setSession(telefono, STATE_SUP_MENU, {});
    return buildMenuSupervisor(sup.nombre || "Supervisor");
  }

  // Estado actual
  const ses = await getSession(telefono);
  const estado = ses.estado_actual;
  const data = ses.data_json || {};

  // En supervisor, en cualquier estado aceptamos "sup" como retorno al menú sup
  if (
    estado === STATE_SUP_MENU ||
    estado === STATE_SUP_PROMOTOR_LIST ||
    estado === STATE_SUP_FOTOS_LIST ||
    estado === STATE_SUP_ELEGIR_GRUPO ||
    estado === STATE_SUP_ASIST_EQ
  ) {
    return await handleSupervisor(telefono, estado, text, data, inbound);
  }

  // Promotor
  if (estado === STATE_MENU) {
    if (lower === "1") return await startAsistenciaElegirTienda(telefono);
    if (lower === "2") return await startEvidenciasElegirTienda(telefono);
    if (lower === "3") return await buildHistorialAsistencias(telefono);
    if (lower === "4") return buildAyudaPromotor();
    return buildMenuPromotor();
  }

  // Asistencia flow
  if (
    estado === STATE_ASIS_ELEGIR_TIENDA ||
    estado === STATE_ASIS_ACCION ||
    estado === STATE_ASIS_FOTO ||
    estado === STATE_ASIS_UBI
  ) {
    return await handleAsistencia(telefono, estado, text, data, inbound);
  }

  // Evidencias flow
  if (
    estado === STATE_EVID_ELEGIR_TIENDA ||
    estado === STATE_EVID_ELEGIR_MARCA ||
    estado === STATE_EVID_ELEGIR_TIPO ||
    estado === STATE_EVID_ELEGIR_FASE ||
    estado === STATE_EVID_FOTOS
  ) {
    return await handleEvidencias(telefono, estado, text, data, inbound);
  }

  // fallback
  await setSession(telefono, STATE_MENU, {});
  return buildMenuPromotor();
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
    console.error("Error handleIncoming:", e?.message || e);
    respuesta = "Ocurrió un error procesando tu mensaje. Intenta de nuevo 🙏";
  }

  const twiml = new MessagingResponse();

  // Soporta string o {text, mediaUrl}
  if (typeof respuesta === "string") {
    twiml.message(respuesta);
  } else if (respuesta && typeof respuesta === "object") {
    const msg = twiml.message(respuesta.text || "");
    if (respuesta.mediaUrl) {
      msg.media(respuesta.mediaUrl);
    }
  } else {
    twiml.message("Ocurrió un error. Intenta de nuevo.");
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
