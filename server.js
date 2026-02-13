import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { google } from "googleapis";

// ==========================
// Configuración básica
// ==========================
const {
  PORT = 10000,
  SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
} = process.env;

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

async function getEvidenciasHoy() {
  const rows = await getSheetValues("EVIDENCIAS!A2:M");
  if (!rows || !rows.length) return [];
  const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return rows
    .map(mapEvidRow)
    .filter((ev) => (ev.fecha_hora || "").slice(0, 10) === hoy);
}

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
          tiendaTexto =
            tienda.nombre_tienda +
            (tienda.ciudad ? " (" + tienda.ciudad + ")" : "");
        }
      }
    }
  } catch (err) {
    console.error("Error buscando tienda por visita:", err);
  }

  let textoBase =
    "🏪 *Evidencia en punto de venta*\n" +
    (grupo.cliente ? "👤 Cliente: " + grupo.cliente + "\n" : "") +
    (tiendaTexto ? "🏬 Tienda: " + tiendaTexto + "\n" : "") +
    "🧑‍💼 Promotor: " + nombrePromotor + "\n";
  if (evidence.fecha_hora) {
    textoBase += "📅 Fecha: " + evidence.fecha_hora + "\n";
  }
  textoBase +=
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

// ==========================
// Estados de conversación
// ==========================
const STATE_MENU = "MENU_PRINCIPAL";

// Día de trabajo / jornada
const STATE_DIA_MENU = "DIA_MENU";
const STATE_JORNADA_FOTO_SUBEVENTO = "JORNADA_FOTO_SUBEVENTO";
const STATE_JORNADA_UBICACION_SUBEVENTO = "JORNADA_UBICACION_SUBEVENTO";

// Supervisor
const STATE_SUP_MENU = "SUP_MENU";
const STATE_SUP_PROMOTOR_LIST = "SUP_PROMOTOR_LIST";
const STATE_SUP_FOTOS_LIST = "SUP_FOTOS_LIST";
const STATE_SUP_ELEGIR_GRUPO = "SUP_ELEGIR_GRUPO";

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
    const range = "SESIONES!A" + sesion.rowIndex + ":C" + sesion.rowIndex;
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

  const activas = rows.filter(function (r) {
    return (r[5] || "").toString().toUpperCase() === "TRUE";
  });

  let filtradas = activas;
  if (promotor) {
    filtradas = activas.filter(function (r) {
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
  return top.map(function (r) {
    return {
      tienda_id: r[0],
      nombre_tienda: r[1],
      cadena: r[2],
      ciudad: r[3],
      region: r[4],
    };
  });
}

// PRODUCTOS: [producto_id, sku_barcode, nombre_producto, categoria, marca, es_foco, precio_sugerido]
async function getProductosFoco() {
  const rows = await getSheetValues("PRODUCTOS!A2:G");
  if (!rows.length) return [];
  const foco = rows.filter(function (r) {
    return (r[5] || "").toString().toUpperCase() === "TRUE";
  });
  const lista = (foco.length ? foco : rows).slice(0, 6);
  return lista.map(function (r) {
    return {
      producto_id: r[0],
      sku_barcode: r[1],
      nombre_producto: r[2],
      categoria: r[3],
      marca: r[4],
      es_foco: (r[5] || "").toString().toUpperCase() === "TRUE",
      precio_sugerido: r[6],
    };
  });
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
  const filtradas = rows.filter(function (r) {
    return (r[1] || "").toString() === competidor;
  });
  return filtradas.map(function (r) {
    return {
      actividad_id: r[0],
      competidor: r[1],
      tipo_actividad: r[2],
      descripcion_corta: r[3],
      puntos: Number(r[4] || 0),
    };
  });
}

// ==========================
// JORNADAS (entrada/salida día)
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
        resultado_ai: "Exhibición secundaria detectada, producto frontal visible (demo).",
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

async function registrarEvidencia(opts) {
  const telefono = opts.telefono;
  const tipo_evento = opts.tipo_evento;
  const origen = opts.origen || "";
  const jornada_id = opts.jornada_id || "";
  const visita_id = opts.visita_id || "";
  const fotoUrl = opts.fotoUrl || "";
  const lat = opts.lat || "";
  const lon = opts.lon || "";

  const evidencia_id = "EV-" + Date.now();
  const fecha_hora = new Date().toISOString();
  const demo = demoAnalisisPorTipo(tipo_evento);

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
      demo.resultado_ai,
      demo.score_confianza,
      demo.riesgo,
    ],
  ]);

  return {
    evidencia_id,
    resultado_ai: demo.resultado_ai,
    score_confianza: demo.score_confianza,
    riesgo: demo.riesgo,
  };
}

// ==========================
// Menús
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

function buildSupervisorMenu(supervisor) {
  const nombre = supervisor && supervisor.nombre ? supervisor.nombre : "Supervisor";
  return (
    "👋 Hola, *" +
    nombre +
    "* (Supervisor).\n\n" +
    "¿Qué quieres hacer hoy?\n" +
    "1️⃣ Ver evidencias de *hoy* por promotor\n" +
    "2️⃣ Ver evidencias de *hoy* con riesgo MEDIO/ALTO 🧠📸\n" +
    "3️⃣ Ver menú estándar de promotor (demo)\n\n" +
    "Escribe el número de la opción o *menu* en cualquier momento."
  );
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
    const resumen = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos actuales*\n" +
      "🟦 Operación: " + resumen.operacion + "\n" +
      "🟨 Capacitación: " + resumen.capacitacion + "\n" +
      "🎯 Total: " + resumen.total + "\n\n" +
      "Escribe *menu* para volver al inicio."
    );
  }

  return buildMenuPrincipal();
}

// ==========================
// 1) Mi día de trabajo
// ==========================
async function handleDia(telefono, estado, text, data, inbound) {
  const numMedia = parseInt(inbound && inbound.NumMedia ? inbound.NumMedia : "0", 10);
  const mediaUrl0 = inbound && inbound.MediaUrl0 ? inbound.MediaUrl0 : "";
  const lat = inbound && (inbound.Latitude || inbound.Latitude0) ? (inbound.Latitude || inbound.Latitude0) : "";
  const lon = inbound && (inbound.Longitude || inbound.Longitude0) ? (inbound.Longitude || inbound.Longitude0) : "";

  const jornada = await getJornadaAbiertaPorTelefono(telefono);

  // MENÚ "MI DÍA"
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
          jornada_id: jornada_id,
          subtipo: "ENTRADA_DIA",
        });
        return (
          "🕒 *Inicio de jornada*\n" +
          "📸 Envía una *foto de entrada* (selfie en tienda / punto de venta)."
        );
      }

      if (text === "2") {
        await setSession(telefono, STATE_MENU, {});
        return buildMenuPrincipal();
      }

      return (
        "🕒 *Mi día de trabajo*\n" +
        "No tengo registrada tu jornada de hoy.\n\n" +
        "1️⃣ Registrar entrada al día (foto + ubicación)\n" +
        "2️⃣ Volver al menú"
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
        const horaLocal = horaEntradaStr ? horaEntradaStr.substring(11, 16) : "";
        const fecha = jornada.fecha || "";
        const salidaStr = jornada.hora_salida || "";
        const salidaLocal = salidaStr ? salidaStr.substring(11, 16) : "Pendiente";

        let msg =
          "📋 *Detalle de tu jornada de hoy*\n" +
          "📅 Fecha: *" +
          (fecha || "(sin fecha)") +
          "*\n";
        if (horaLocal) {
          msg += "🕒 Entrada: *" + horaLocal + "*\n";
        }
        msg += "🚪 Salida: *" + salidaLocal + "*\n";
        if (jornada.lat_entrada && jornada.lon_entrada) {
          msg +=
            "📍 Entrada: lat " +
            jornada.lat_entrada +
            ", lon " +
            jornada.lon_entrada +
            "\n";
        }
        if (jornada.lat_salida && jornada.lon_salida) {
          msg +=
            "📍 Salida: lat " +
            jornada.lat_salida +
            ", lon " +
            jornada.lon_salida +
            "\n";
        }
        msg += "\nEscribe *menu* para volver al inicio.";
        return msg;
      }
      if (text === "5") {
        await setSession(telefono, STATE_MENU, {});
        return buildMenuPrincipal();
      }

      return (
        "🕒 *Mi día de trabajo*\n" +
        "Tienes una jornada abierta hoy.\n\n" +
        "1️⃣ Salida a comer (foto + ubicación)\n" +
        "2️⃣ Regreso de comida (foto + ubicación)\n" +
        "3️⃣ Salida del día (foto + ubicación)\n" +
        "4️⃣ Ver detalles de mi jornada\n" +
        "5️⃣ Volver al menú"
      );
    }
  }

  // SUBEVENTOS: FOTO
  if (estado === STATE_JORNADA_FOTO_SUBEVENTO) {
    if (!numMedia || numMedia < 1 || !mediaUrl0) {
      return (
        "Necesito que me envíes una *foto* para este registro.\n" +
        "Adjunta una foto y vuelve a enviar el mensaje."
      );
    }

    const jornada_id = data.jornada_id;
    const subtipo = data.subtipo;

    if (subtipo === "ENTRADA_DIA") {
      await actualizarEntradaFoto(jornada_id, mediaUrl0);
    } else if (subtipo === "SALIDA_DIA") {
      await actualizarSalidaFoto(jornada_id, mediaUrl0);
    }

    await setSession(telefono, STATE_JORNADA_UBICACION_SUBEVENTO, {
      jornada_id: jornada_id,
      subtipo: subtipo,
      fotoUrl: mediaUrl0,
    });

    return (
      "✅ Foto recibida.\n\n" +
      "📍 Ahora comparte tu *ubicación* desde WhatsApp (mensaje de ubicación) o escribe una breve descripción del lugar."
    );
  }

  // SUBEVENTOS: UBICACIÓN + EVIDENCIA
  if (estado === STATE_JORNADA_UBICACION_SUBEVENTO) {
    const jornada_id = data.jornada_id;
    const subtipo = data.subtipo;
    const fotoUrl = data.fotoUrl;
    const latUse = lat || "";
    const lonUse = lon || "";

    if (subtipo === "ENTRADA_DIA") {
      await actualizarEntradaUbicacion(jornada_id, latUse, lonUse);
      await registrarEvidencia({
        telefono: telefono,
        tipo_evento: "ENTRADA_DIA",
        origen: "JORNADA",
        jornada_id: jornada_id,
        visita_id: "",
        fotoUrl: fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(
        telefono,
        "OPERACION",
        "ENTRADA_JORNADA_" + jornada_id,
        3
      );
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
        telefono: telefono,
        tipo_evento: "SALIDA_DIA",
        origen: "JORNADA",
        jornada_id: jornada_id,
        visita_id: "",
        fotoUrl: fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(
        telefono,
        "OPERACION",
        "SALIDA_JORNADA_" + jornada_id,
        3
      );
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Jornada cerrada correctamente (foto + ubicación).\n" +
        "🎯 Ganaste *3 puntos* por registrar tu salida.\n\n" +
        "Escribe *menu* para volver al inicio."
      );
    }

    if (subtipo === "SALIDA_COMIDA") {
      await registrarEvidencia({
        telefono: telefono,
        tipo_evento: "SALIDA_COMIDA",
        origen: "JORNADA",
        jornada_id: jornada_id,
        visita_id: "",
        fotoUrl: fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(
        telefono,
        "OPERACION",
        "SALIDA_COMIDA_" + jornada_id,
        2
      );
      await setSession(telefono, STATE_DIA_MENU, {});
      return (
        "✅ Salida a comer registrada (foto + ubicación).\n" +
        "🎯 Ganaste *2 puntos*.\n\n" +
        "Escribe *menu* para seguir con tu día."
      );
    }

    if (subtipo === "REGRESO_COMIDA") {
      await registrarEvidencia({
        telefono: telefono,
        tipo_evento: "REGRESO_COMIDA",
        origen: "JORNADA",
        jornada_id: jornada_id,
        visita_id: "",
        fotoUrl: fotoUrl,
        lat: latUse,
        lon: lonUse,
      });
      await addPuntos(
        telefono,
        "OPERACION",
        "REGRESO_COMIDA_" + jornada_id,
        2
      );
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
    "2️⃣ Volver al menú"
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
        tiendas: tiendas,
        promotor_id: promotor ? promotor.promotor_id : "",
      });

      let msg = "🏪 *¿En qué tienda estás hoy?*\n";
      tiendas.forEach(function (t, idx) {
        msg +=
          (idx + 1) +
          ") " +
          t.nombre_tienda +
          " – " +
          t.cadena +
          " (" +
          t.ciudad +
          ")\n";
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
      tiendas.forEach(function (t, idx) {
        msg +=
          (idx + 1) +
          ") " +
          t.nombre_tienda +
          " – " +
          t.cadena +
          " (" +
          t.ciudad +
          ")\n";
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
      visitaId: visitaId,
      promotor_id: promotor_id,
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      tienda_ciudad: tienda.ciudad,
    });

    return (
      "📝 *Visita iniciada* en *" +
      tienda.nombre_tienda +
      "* (" +
      tienda.ciudad +
      ").\n\n" +
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
        productos: productos,
        idx: 0,
        contestados: 0,
      });

      const p = productos[0];
      return (
        "📦 *Inventario de productos foco*\n\n" +
        "Producto 1 de " +
        productos.length +
        ":\n" +
        "*" +
        p.nombre_producto +
        "*\n\n" +
        "¿Cuántas piezas ves en anaquel?\n" +
        "Responde con un número o *s* para saltar."
      );
    }

    if (text === "2") {
      const competidores = await getCompetidoresCatalogo();
      if (!competidores.length) {
        await setSession(telefono, STATE_OPER_VISITA_MENU, {
          visitaId: data.visitaId,
          promotor_id: data.promotor_id,
          tienda_id: data.tienda_id,
          tienda_nombre: data.tienda_nombre,
        });
        return (
          "No hay actividades de competencia configuradas en *ACTIVIDADES_COMPETENCIA* ⚔️\n" +
          "Configúralas y vuelve a intentar.\n\n" +
          "1️⃣ Inventario\n" +
          "2️⃣ Actividad de la competencia\n" +
          "3️⃣ Foto de exhibición\n" +
          "4️⃣ Cerrar visita"
        );
      }

      await setSession(telefono, STATE_OPER_COMP_COMPETIDOR, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id || "",
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
        competidores: competidores,
      });

      let msg = "⚔️ *Competencia en piso de venta*\n\n";
      msg += "¿De qué competidor quieres registrar actividad?\n";
      competidores.forEach(function (c, idx) {
        msg += (idx + 1) + ") " + c + "\n";
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
      const visitaId2 = data.visitaId;
      const rows = await getSheetValues("VISITAS!A2:G");
      let rowIndex = null;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === visitaId2) {
          rowIndex = i + 2;
          break;
        }
      }
      if (rowIndex !== null) {
        const now2 = new Date().toISOString();
        const range = "VISITAS!F" + rowIndex + ":F" + rowIndex;
        await updateSheetValues(range, [[now2]]);
      }

      await addPuntos(
        telefono,
        "OPERACION",
        "CIERRE_VISITA_" + visitaId2,
        5
      );
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
          "Escribe un número válido para *" +
          p.nombre_producto +
          "* o *s* para saltar."
        );
      }
      grabar = true;
    }

    const p2 = productos[idx];

    if (grabar) {
      const fecha = new Date().toISOString().slice(0, 10);
      await appendSheetValues("INVENTARIO!A2:F", [
        [
          data.visitaId,
          data.promotor_id || "",
          data.tienda_id,
          p2.producto_id,
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
          "INVENTARIO_VISITA_" + data.visitaId,
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
        "Productos respondidos: *" +
        contestados +
        "*.\n" +
        (pts > 0 ? "🎯 Ganaste *" + pts + " puntos*.\n\n" : "\n") +
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
      productos: productos,
      idx: idx,
      contestados: contestados,
    });

    const siguiente = productos[idx];
    return (
      "📦 *Inventario de productos foco*\n\n" +
      "Producto " +
      (idx + 1) +
      " de " +
      productos.length +
      ":\n" +
      "*" +
      siguiente.nombre_producto +
      "*\n\n" +
      "¿Cuántas piezas ves en anaquel?\n" +
      "Responde con un número o *s* para saltar."
    );
  }

  if (estado === STATE_OPER_COMP_COMPETIDOR) {
    const competidores = data.competidores || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > competidores.length) {
      let msg = "Elige una opción válida:\n\n";
      competidores.forEach(function (c, idx) {
        msg += (idx + 1) + ") " + c + "\n";
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
        "No hay actividades configuradas para *" +
        competidor +
        "* ⚔️\n\n" +
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
      competidor: competidor,
      actividades: actividades,
    });

    let msg2 = "⚔️ *Actividades de " + competidor + "*\n\n";
    actividades.forEach(function (a, idx) {
      msg2 +=
        (idx + 1) +
        ") " +
        a.tipo_actividad +
        " – " +
        a.descripcion_corta +
        "\n";
    });
    msg2 += "\nResponde con el número de la actividad que viste.";
    return msg2;
  }

  if (estado === STATE_OPER_COMP_ACTIVIDAD) {
    const actividades = data.actividades || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > actividades.length) {
      let msg = "Elige una opción válida de *" + data.competidor + "*:\n\n";
      actividades.forEach(function (a, idx) {
        msg +=
          (idx + 1) +
          ") " +
          a.tipo_actividad +
          " – " +
          a.descripcion_corta +
          "\n";
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
        "COMPETENCIA_" + act.actividad_id + "_" + data.visitaId,
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
      "Competidor: *" +
      act.competidor +
      "*\n" +
      "Actividad: *" +
      act.tipo_actividad +
      " – " +
      act.descripcion_corta +
      "*\n" +
      (pts > 0 ? "🎯 Ganaste *" + pts + " puntos*.\n\n" : "\n") +
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
    const productoId = "PROD_X";

    await appendSheetValues("VENTAS!A2:D", [
      [fecha, telefono, productoId, unidades],
    ]);

    await addPuntos(telefono, "OPERACION", "VENTA_DEMO", 10);
    await setSession(telefono, STATE_OPER_MENU, {});

    return (
      "✅ Venta registrada.\n" +
      "Producto: *Modelo X 128GB*\n" +
      "Unidades: *" +
      unidades +
      "*\n\n" +
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
      const reto = rows[0];
      const reto_id = reto[0];
      const pregunta = reto[1] || "";
      const opcion_1 = reto[2] || "";
      const opcion_2 = reto[3] || "";
      const opcion_3 = reto[4] || "";

      await setSession(telefono, STATE_ACAD_RETO, { reto_id: reto_id });

      let msg =
        "🎓 *Reto del día*\n\n" +
        pregunta +
        "\n\n" +
        "1️⃣ " +
        opcion_1 +
        "\n" +
        "2️⃣ " +
        opcion_2 +
        "\n" +
        "3️⃣ " +
        opcion_3 +
        "\n\n" +
        "Responde con 1, 2 o 3.";
      return msg;
    }

    if (text === "2") {
      const resumen = await getResumenPuntos(telefono);
      return (
        "📊 *Tus puntos de capacitación*\n" +
        "🟨 Capacitación: " +
        resumen.capacitacion +
        "\n" +
        "🟦 Operación (referencia): " +
        resumen.operacion +
        "\n" +
        "🎯 Total: " +
        resumen.total +
        "\n\n" +
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
    if (text !== "1" && text !== "2" && text !== "3") {
      return "Responde solo con 1, 2 o 3 😉";
    }

    const reto_id = data.reto_id;
    const rows = await getSheetValues("RETOS!A2:H");
    const retoRow = rows.find(function (r) {
      return r[0] === reto_id;
    });
    if (!retoRow) {
      await setSession(telefono, STATE_ACAD_MENU, {});
      return "Ocurrió un problema con el reto. Intenta de nuevo más tarde 🙏";
    }

    const pregunta = retoRow[1] || "";
    const opcion_1 = retoRow[2] || "";
    const opcion_2 = retoRow[3] || "";
    const opcion_3 = retoRow[4] || "";
    const opcion_correcta = retoRow[5];
    const puntos_ok = Number(retoRow[6] || 0);
    const puntos_error = Number(retoRow[7] || 0);

    const correctaNum = Number(opcion_correcta);
    const respuestaNum = Number(text);
    const es_correcta = correctaNum === respuestaNum;
    const pts = es_correcta ? puntos_ok : puntos_error;

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
      await addPuntos(telefono, "CAPACITACION", "RETO_" + reto_id, pts);
    }

    await setSession(telefono, STATE_ACAD_MENU, {});

    const feedback = es_correcta
      ? "✅ ¡Correcto!"
      : "❌ La respuesta correcta era la opción " + opcion_correcta + ".";

    let msg =
      feedback +
      "\n\n" +
      "Pregunta: " +
      pregunta +
      "\n" +
      "1) " +
      opcion_1 +
      "\n" +
      "2) " +
      opcion_2 +
      "\n" +
      "3) " +
      opcion_3 +
      "\n\n" +
      "🎯 Ganaste *" +
      pts +
      " puntos de capacitación*.\n\n" +
      "¿Qué quieres hacer ahora?\n" +
      "1️⃣ Reto del día\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú\n\n" +
      "O escribe *menu* para ir al inicio.";
    return msg;
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
  const numMedia = parseInt(inbound && inbound.NumMedia ? inbound.NumMedia : "0", 10);
  const mediaUrl0 = inbound && inbound.MediaUrl0 ? inbound.MediaUrl0 : "";
  const lat = inbound && (inbound.Latitude || inbound.Latitude0) ? (inbound.Latitude || inbound.Latitude0) : "";
  const lon = inbound && (inbound.Longitude || inbound.Longitude0) ? (inbound.Longitude || inbound.Longitude0) : "";

  if (!numMedia || numMedia < 1 || !mediaUrl0) {
    return (
      "Necesito que me envíes una *foto* para la auditoría.\n" +
      "Adjunta una imagen y vuelve a enviar el mensaje."
    );
  }

  const modo = data.modo || "AUDITORIA_DIRECTA";
  let tipo_evento = "AUDITORIA_DIRECTA";
  let origen = "DIRECTO";
  const visita_id = data.visitaId || "";
  const jornada = await getJornadaAbiertaPorTelefono(telefono);
  const jornada_id = jornada ? jornada.jornada_id : "";

  if (modo === "FOTO_EXHIBICION") {
    tipo_evento = "FOTO_EXHIBICION";
    origen = "VISITA";
  }

  const resultado = await registrarEvidencia({
    telefono: telefono,
    tipo_evento: tipo_evento,
    origen: origen,
    jornada_id: jornada_id,
    visita_id: visita_id,
    fotoUrl: mediaUrl0,
    lat: lat,
    lon: lon,
  });

  await addPuntos(
    telefono,
    "OPERACION",
    "EVIDENCIA_" + tipo_evento,
    3
  );

  await setSession(telefono, STATE_MENU, {});

  return (
    "🔎 *Resultado EVIDENCIA+ (demo)*\n" +
    "✔️ Análisis: " +
    resultado.resultado_ai +
    "\n" +
    "📊 Confianza: " +
    Math.round(resultado.score_confianza * 100) +
    "%\n" +
    "⚠️ Riesgo: " +
    resultado.riesgo +
    "\n\n" +
    "🎯 Ganaste *3 puntos* por enviar esta evidencia.\n\n" +
    "Escribe *menu* para seguir usando el bot."
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

  if (estado === STATE_SUP_MENU) {
    if (lower === "1" || lower === "1️⃣") {
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Verifica la columna *telefono_supervisor*."
        );
      }

      const evidenciasHoy = await getEvidenciasHoy();
      const conteos = {};
      for (const ev of evidenciasHoy) {
        conteos[ev.telefono] = (conteos[ev.telefono] || 0) + 1;
      }

      let msg = "👀 *Evidencias de hoy – tu equipo*\n\n";
      promotores.forEach(function (p, idx) {
        const cuenta = conteos[p.telefono] || 0;
        msg += (idx + 1) + ") " + p.nombre + " – " + cuenta + " foto(s)\n";
      });
      msg +=
        "\nResponde con el *número* del promotor para ver detalle,\n" +
        "o escribe *menu* para volver.";

      await setSession(telefonoSupervisor, STATE_SUP_PROMOTOR_LIST, {
        promotores: promotores,
      });
      return msg;
    }

    if (lower === "2" || lower === "2️⃣") {
      const promotores = await getPromotoresDeSupervisor(telefonoSupervisor);
      if (!promotores.length) {
        return (
          "⚠️ No hay promotores asociados a tu número en la hoja PROMOTORES.\n" +
          "Verifica la columna *telefono_supervisor*."
        );
      }

      const telefonosEquipo = new Set(promotores.map(function (p) {
        return p.telefono;
      }));
      const evidenciasHoy = await getEvidenciasHoy();

      const mapTelNombre = {};
      promotores.forEach(function (p) {
        mapTelNombre[p.telefono] = p.nombre;
      });

      const filtradas = evidenciasHoy
        .filter(function (ev) {
          return (
            telefonosEquipo.has(ev.telefono) &&
            (ev.riesgo === "MEDIO" || ev.riesgo === "ALTO")
          );
        })
        .map(function (ev) {
          return {
            evidencia_id: ev.evidencia_id,
            telefono: ev.telefono,
            fecha_hora: ev.fecha_hora,
            tipo_evento: ev.tipo_evento,
            origen: ev.origen,
            jornada_id: ev.jornada_id,
            visita_id: ev.visita_id,
            url_foto: ev.url_foto,
            lat: ev.lat,
            lon: ev.lon,
            resultado_ai: ev.resultado_ai,
            score_confianza: ev.score_confianza,
            riesgo: ev.riesgo,
            promotor_nombre: mapTelNombre[ev.telefono] || ev.telefono,
          };
        });

      if (!filtradas.length) {
        return (
          "🧠📸 Hoy no hay evidencias con riesgo MEDIO/ALTO para tu equipo.\n" +
          "Escribe *menu* para otras opciones."
        );
      }

      let msg2 = "🧠📸 *Evidencias de hoy con riesgo MEDIO/ALTO*\n\n";
      filtradas.forEach(function (ev, idx) {
        msg2 +=
          (idx + 1) +
          ") " +
          ev.promotor_nombre +
          " – " +
          ev.tipo_evento +
          " – riesgo " +
          ev.riesgo +
          "\n";
      });
      msg2 +=
        "\nComandos:\n" +
        "• `ver 2` → ver detalle y foto 2\n" +
        "• `enviar 2` → reenviar solo la 2 al cliente\n" +
        "• `enviar todas` → reenviar todas las de esta lista\n" +
        "• `menu` → volver al menú supervisor";

      await setSession(telefonoSupervisor, STATE_SUP_FOTOS_LIST, {
        listado: filtradas,
      });
      return msg2;
    }

    if (lower === "3" || lower === "3️⃣") {
      await setSession(telefonoSupervisor, STATE_MENU, {});
      return (
        "Has vuelto al menú estándar de promotor.\n" +
        "Escribe *menu* para ver las opciones de promotor."
      );
    }

    return buildSupervisorMenu(supervisor);
  }

  if (estado === STATE_SUP_PROMOTOR_LIST) {
    if (lower === "menu" || lower === "inicio") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const promotores = data.promotores || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > promotores.length) {
      let msg = "Elige un *número* de promotor válido:\n\n";
      promotores.forEach(function (p, idx) {
        msg += (idx + 1) + ") " + p.nombre + "\n";
      });
      msg += "\nO escribe *menu* para volver.";
      return msg;
    }

    const prom = promotores[n - 1];
    const evidenciasHoy = await getEvidenciasHoy();
    const listado = evidenciasHoy
      .filter(function (ev) {
        return ev.telefono === prom.telefono;
      })
      .map(function (ev) {
        return {
          evidencia_id: ev.evidencia_id,
          telefono: ev.telefono,
          fecha_hora: ev.fecha_hora,
          tipo_evento: ev.tipo_evento,
          origen: ev.origen,
          jornada_id: ev.jornada_id,
          visita_id: ev.visita_id,
          url_foto: ev.url_foto,
          lat: ev.lat,
          lon: ev.lon,
          resultado_ai: ev.resultado_ai,
          score_confianza: ev.score_confianza,
          riesgo: ev.riesgo,
          promotor_nombre: prom.nombre,
        };
      });

    if (!listado.length) {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return (
        "⚠️ Hoy no hay evidencias registradas para *" +
        prom.nombre +
        "*.\n" +
        "Escribe *menu* para volver al menú supervisor."
      );
    }

    let msg3 = "📷 *Evidencias de hoy de " + prom.nombre + "*\n\n";
    listado.forEach(function (ev, idx) {
      msg3 +=
        (idx + 1) + ") " + ev.tipo_evento + " – riesgo " + ev.riesgo + "\n";
    });
    msg3 +=
      "\nComandos:\n" +
      "• `ver 1` → ver detalle y foto 1\n" +
      "• `enviar 1` → reenviar solo la 1 al cliente\n" +
      "• `enviar todas` → reenviar todas las de esta lista\n" +
      "• `menu` → volver";

    await setSession(telefonoSupervisor, STATE_SUP_FOTOS_LIST, {
      listado: listado,
    });

    return msg3;
  }

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
          "⚠️ Número inválido. Usa por ejemplo `ver 1`, `enviar 1` o `enviar todas`,\n" +
          "o escribe *menu* para volver."
        );
      }
      const ev = listado[idx];

      let texto =
        "🧾 *Detalle evidencia " +
        (idx + 1) +
        "*\n" +
        (ev.promotor_nombre ? "👤 Promotor: " + ev.promotor_nombre + "\n" : "");
      if (ev.fecha_hora) {
        texto += "📅 Fecha: " + ev.fecha_hora + "\n";
      }
      texto += "🎯 Tipo: " + ev.tipo_evento + "\n";
      texto +=
        "🧠 EVIDENCIA+ (demo): " +
        (ev.resultado_ai || "Evidencia registrada.") +
        "\n";
      texto += "⚠️ Riesgo: " + ev.riesgo + "\n\n";
      texto +=
        "Puedes escribir:\n" +
        "• `enviar " +
        (idx + 1) +
        "` → reenviar esta foto al cliente\n" +
        "• `enviar todas` → reenviar todas las de esta lista\n" +
        "• `menu` → volver al menú supervisor";

      return {
        text: texto,
        mediaUrl: ev.url_foto || null,
      };
    }

    if (enviarMatch) {
      const idx2 = parseInt(enviarMatch[1], 10) - 1;
      if (Number.isNaN(idx2) || idx2 < 0 || idx2 >= listado.length) {
        return (
          "⚠️ Número inválido. Usa por ejemplo `enviar 1` o `enviar todas`,\n" +
          "o escribe *menu* para volver."
        );
      }

      const seleccionUna = [listado[idx2]];
      const grupos = await getGruposClienteActivos();
      if (!grupos.length) {
        return (
          "⚠️ No hay grupos de cliente activos en la hoja GRUPOS_CLIENTE.\n" +
          "Configura al menos un grupo antes de usar esta opción."
        );
      }

      let msg4 =
        "📤 *Enviar evidencia al cliente*\n\n¿A qué grupo quieres enviarla?\n\n";
      grupos.forEach(function (g, i) {
        msg4 += (i + 1) + ") " + g.nombre_grupo;
        if (g.cliente) msg4 += " – " + g.cliente;
        msg4 += "\n";
      });
      msg4 +=
        "\nResponde con el *número* del grupo o escribe *menu* para cancelar.";

      await setSession(telefonoSupervisor, STATE_SUP_ELEGIR_GRUPO, {
        seleccion: seleccionUna,
        grupos: grupos,
      });

      return msg4;
    }

    if (lower === "enviar todas" || lower === "enviar todo") {
      if (!listado.length) {
        return (
          "⚠️ No hay evidencias en esta lista.\n" +
          "Escribe *menu* para volver al menú supervisor."
        );
      }

      const grupos2 = await getGruposClienteActivos();
      if (!grupos2.length) {
        return (
          "⚠️ No hay grupos de cliente activos en la hoja GRUPOS_CLIENTE.\n" +
          "Configura al menos un grupo antes de usar esta opción."
        );
      }

      let msg5 =
        "📤 *Enviar TODAS las evidencias de esta lista al cliente*\n\n¿A qué grupo quieres enviarlas?\n\n";
      grupos2.forEach(function (g, i) {
        msg5 += (i + 1) + ") " + g.nombre_grupo;
        if (g.cliente) msg5 += " – " + g.cliente;
        msg5 += "\n";
      });
      msg5 +=
        "\nResponde con el *número* del grupo o escribe *menu* para cancelar.";

      await setSession(telefonoSupervisor, STATE_SUP_ELEGIR_GRUPO, {
        seleccion: listado,
        grupos: grupos2,
      });

      return msg5;
    }

    return (
      "⚠️ No entendí tu respuesta.\n" +
      "Usa por ejemplo `ver 1`, `enviar 1` o `enviar todas`,\n" +
      "o escribe *menu* para volver."
    );
  }

  if (estado === STATE_SUP_ELEGIR_GRUPO) {
    const grupos = data.grupos || [];
    const seleccion = data.seleccion || [];

    if (lower === "menu" || lower === "cancelar" || lower === "no") {
      await setSession(telefonoSupervisor, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }

    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > grupos.length) {
      let msg = "⚠️ Número inválido. Elige uno de los siguientes grupos:\n\n";
      grupos.forEach(function (g, i) {
        msg += (i + 1) + ") " + g.nombre_grupo;
        if (g.cliente) msg += " – " + g.cliente;
        msg += "\n";
      });
      msg += "\nO escribe *menu* para cancelar.";
      return msg;
    }

    const grupo = grupos[n - 1];

    let totalMensajesOK = 0;
    for (const ev of seleccion) {
      try {
        const resultado = await enviarFotoAGrupoCliente(ev, grupo);
        if (resultado.ok) {
          totalMensajesOK += 1;
        }
      } catch (err) {
        console.error("Error enviando evidencia al cliente:", err);
      }
    }

    await setSession(telefonoSupervisor, STATE_SUP_MENU, {});

    if (!totalMensajesOK) {
      return (
        "⚠️ No se pudieron enviar las evidencias al cliente.\n" +
        "Revisa que las variables de entorno de Twilio estén configuradas.\n\n" +
        "Escribe *menu* para volver al menú supervisor."
      );
    }

    return (
      "✅ Evidencias enviadas al grupo *" +
      grupo.nombre_grupo +
      "*.\n" +
      "Se procesaron *" +
      seleccion.length +
      "* evidencia(s).\n\n" +
      "Escribe *menu* para volver al menú supervisor."
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

  // Ver puntos
  if (lower === "puntos") {
    const resumen = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos actuales*\n" +
      "🟦 Operación: " +
      resumen.operacion +
      "\n" +
      "🟨 Capacitación: " +
      resumen.capacitacion +
      "\n" +
      "🎯 Total: " +
      resumen.total +
      "\n\n" +
      "Escribe *menu* para volver al inicio."
    );
  }

  const sesion = await getSession(telefono);
  const estado = sesion.estado_actual;
  const data = sesion.data_json || {};

  const supervisor = await getSupervisorPorTelefono(telefono);
  const esSupervisor = !!supervisor;

  const estadosSupervisor = new Set([
    STATE_SUP_MENU,
    STATE_SUP_PROMOTOR_LIST,
    STATE_SUP_FOTOS_LIST,
    STATE_SUP_ELEGIR_GRUPO,
  ]);
  const enFlujoSupervisor = estadosSupervisor.has(estado);

  if (esSupervisor && (lower === "sup" || lower === "supervisor")) {
    await setSession(telefono, STATE_SUP_MENU, {});
    return buildSupervisorMenu(supervisor);
  }

  if (lower === "menu" || lower === "inicio") {
    if (esSupervisor && enFlujoSupervisor) {
      await setSession(telefono, STATE_SUP_MENU, {});
      return buildSupervisorMenu(supervisor);
    }
    await setSession(telefono, STATE_MENU, {});
    return buildMenuPrincipal();
  }

  if (esSupervisor && enFlujoSupervisor) {
    return await handleSupervisor(
      telefono,
      supervisor,
      estado,
      text,
      data,
      inbound
    );
  }

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

  if (typeof respuesta === "string") {
    twiml.message(respuesta);
  } else if (respuesta && typeof respuesta === "object") {
    const msg = twiml.message(respuesta.text || "");
    if (respuesta.mediaUrl) {
      msg.media(respuesta.mediaUrl);
    }
  } else {
    twiml.message(
      "Ocurrió un problema al generar la respuesta. Intenta de nuevo más tarde 🙏"
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send(
    "Promobolsillo+ demo está vivo ✅ (día + operación + academia + evidencias + supervisor)"
  );
});

app.listen(PORT, () => {
  console.log("🚀 Promobolsillo+ demo escuchando en puerto " + PORT);
});
