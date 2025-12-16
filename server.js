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
} = process.env;

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

// ==========================
// Estados de conversación
// ==========================
const STATE_MENU                     = "MENU_PRINCIPAL";
const STATE_OPER_MENU                = "OPER_MENU";
const STATE_OPER_VENTA               = "OPER_VENTA";              // venta rápida demo
const STATE_OPER_ELEGIR_TIENDA       = "OPER_ELEGIR_TIENDA";
const STATE_OPER_VISITA_MENU         = "OPER_VISITA_MENU";
const STATE_OPER_INV_PROD            = "OPER_INV_PROD";
const STATE_OPER_COMP_COMPETIDOR     = "OPER_COMP_COMPETIDOR";
const STATE_OPER_COMP_ACTIVIDAD      = "OPER_COMP_ACTIVIDAD";

const STATE_ACAD_MENU                = "ACADEMIA_MENU";
const STATE_ACAD_RETO                = "ACADEMIA_RETO";

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
    const pts  = Number(row[4] || 0);
    if (tel === telefono) {
      if (tipo === "OPERACION")    operacion    += pts;
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

// PROMOTORES: [telefono, promotor_id, nombre, region, cadena_principal, activo]
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

  const activas = rows.filter(r =>
    (r[5] || "").toString().toUpperCase() === "TRUE"
  );

  let filtradas = activas;
  if (promotor) {
    filtradas = activas.filter(r => {
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
    if (!filtradas.length) {
      filtradas = activas;
    }
  }

  // Limitar a 6 para no saturar el mensaje
  const top = filtradas.slice(0, 6);
  return top.map(r => ({
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
  const foco = rows.filter(r =>
    (r[5] || "").toString().toUpperCase() === "TRUE"
  );
  const lista = (foco.length ? foco : rows).slice(0, 6);
  return lista.map(r => ({
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
  const filtradas = rows.filter(r => (r[1] || "").toString() === competidor);
  return filtradas.map(r => ({
    actividad_id: r[0],
    competidor: r[1],
    tipo_actividad: r[2],
    descripcion_corta: r[3],
    puntos: Number(r[4] || 0),
  }));
}

// ==========================
// Lógica principal
// ==========================
async function handleIncoming(telefono, body) {
  const text  = (body || "").trim();
  const lower = text.toLowerCase();

  // Comandos globales
  if (lower === "menu") {
    await setSession(telefono, STATE_MENU, {});
    return (
      "👋 Hola, soy *Promobolsillo*.\n\n" +
      "¿Qué quieres hacer?\n" +
      "1️⃣ Operación en tienda\n" +
      "2️⃣ Academia (capacitaciones)\n" +
      "3️⃣ Ver mis puntos"
    );
  }

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

  const sesion = await getSession(telefono);
  const estado = sesion.estado_actual;
  const data   = sesion.data_json || {};

  switch (estado) {
    case STATE_MENU:
      return await handleMenuPrincipal(telefono, text);
    case STATE_OPER_MENU:
    case STATE_OPER_VENTA:
    case STATE_OPER_ELEGIR_TIENDA:
    case STATE_OPER_VISITA_MENU:
    case STATE_OPER_INV_PROD:
    case STATE_OPER_COMP_COMPETIDOR:
    case STATE_OPER_COMP_ACTIVIDAD:
      return await handleOperacion(telefono, estado, text, data);
    case STATE_ACAD_MENU:
    case STATE_ACAD_RETO:
      return await handleAcademia(telefono, estado, text, data);
    default:
      await setSession(telefono, STATE_MENU, {});
      return (
        "Reinicié tu sesión 🔄\n\n" +
        "¿Qué quieres hacer?\n" +
        "1️⃣ Operación en tienda\n" +
        "2️⃣ Academia (capacitaciones)\n" +
        "3️⃣ Ver mis puntos"
      );
  }
}

// ==========================
// Menú principal
// ==========================
async function handleMenuPrincipal(telefono, text) {
  if (!["1", "2", "3"].includes(text)) {
    await setSession(telefono, STATE_MENU, {});
    return (
      "👋 Hola, soy *Promobolsillo*.\n\n" +
      "¿Qué quieres hacer?\n" +
      "1️⃣ Operación en tienda\n" +
      "2️⃣ Academia (capacitaciones)\n" +
      "3️⃣ Ver mis puntos\n\n" +
      "También puedes escribir *menu* en cualquier momento."
    );
  }

  if (text === "1") {
    await setSession(telefono, STATE_OPER_MENU, {});
    return (
      "🧰 *Operación en tienda*\n" +
      "1️⃣ Iniciar visita en tienda\n" +
      "2️⃣ Registrar venta rápida (Modelo X)\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  if (text === "2") {
    await setSession(telefono, STATE_ACAD_MENU, {});
    return (
      "🎓 *Academia de Bolsillo*\n" +
      "1️⃣ Reto del día\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  if (text === "3") {
    const { operacion, capacitacion, total } = await getResumenPuntos(telefono);
    return (
      "📊 *Tus puntos actuales*\n" +
      `🟦 Operación: ${operacion}\n` +
      `🟨 Capacitación: ${capacitacion}\n` +
      `🎯 Total: ${total}\n\n` +
      "Escribe *menu* para volver al inicio."
    );
  }
}

// ==========================
// Operación
// ==========================
async function handleOperacion(telefono, estado, text, data) {
  // ----- Menú de operación -----
  if (estado === STATE_OPER_MENU) {
    if (text === "1") {
      // Iniciar visita
      const promotor = await getPromotorPorTelefono(telefono);
      const tiendas  = await getTiendasParaPromotor(promotor);

      if (!tiendas.length) {
        return (
          "Por ahora no tengo tiendas configuradas para ti 🏪\n" +
          "Revisa el catálogo en la hoja *TIENDAS* y vuelve a intentar.\n\n" +
          "Escribe *menu* para volver al inicio."
        );
      }

      await setSession(telefono, STATE_OPER_ELEGIR_TIENDA, {
        tiendas,
        promotor_id: promotor ? promotor.promotor_id : "",
        promotor_nombre: promotor ? promotor.nombre : "",
      });

      let msg = "🏪 *¿En qué tienda estás hoy?*\n";
      tiendas.forEach((t, idx) => {
        msg += `${idx + 1}) ${t.nombre_tienda} – ${t.cadena} (${t.ciudad})\n`;
      });
      msg += "\nResponde con el número de la tienda.";
      return msg;
    }

    if (text === "2") {
      // Venta rápida demo (sin visita)
      await setSession(telefono, STATE_OPER_VENTA, {});
      return (
        "🛒 *Venta rápida demo*\n" +
        "Producto: *Modelo X 128GB*\n\n" +
        "Escribe cuántas unidades vendiste hoy de este producto (solo número)."
      );
    }

    if (text === "3") {
      await setSession(telefono, STATE_MENU, {});
      return (
        "Volviendo al menú principal…\n\n" +
        "1️⃣ Operación en tienda\n" +
        "2️⃣ Academia (capacitaciones)\n" +
        "3️⃣ Ver mis puntos"
      );
    }

    return (
      "🧰 *Operación en tienda*\n" +
      "1️⃣ Iniciar visita en tienda\n" +
      "2️⃣ Registrar venta rápida (Modelo X)\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  // ----- Elegir tienda -----
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
    const fecha = now.toISOString().slice(0, 10); // yyyy-mm-dd
    const horaInicio = now.toISOString();

    const promotor_id = data.promotor_id || "";
    await appendSheetValues("VISITAS!A2:G", [[
      visitaId,
      promotor_id,
      tienda.tienda_id,
      fecha,
      horaInicio,
      "",       // hora_fin
      ""        // foto_url (futuro)
    ]]);

    await setSession(telefono, STATE_OPER_VISITA_MENU, {
      visitaId,
      promotor_id,
      tienda_id: tienda.tienda_id,
      tienda_nombre: tienda.nombre_tienda,
      tienda_ciudad: tienda.ciudad,
    });

    return (
      `📝 *Visita iniciada* en *${tienda.nombre_tienda}* (${tienda.ciudad}).\n\n` +
      "¿Qué quieres registrar ahora?\n" +
      "1️⃣ Inventario de productos foco\n" +
      "2️⃣ Actividades de la competencia\n" +
      "3️⃣ Cerrar visita"
    );
  }

  // ----- Menú dentro de la visita -----
  if (estado === STATE_OPER_VISITA_MENU) {
    if (text === "1") {
      // Inventario
      const productos = await getProductosFoco();
      if (!productos.length) {
        return (
          "Por ahora no tengo productos configurados en la hoja *PRODUCTOS* 📦\n" +
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
        "Responde con un número o escribe *s* para saltar."
      );
    }

    if (text === "2") {
      // Actividades de competencia
      const competidores = await getCompetidoresCatalogo();
      if (!competidores.length) {
        return (
          "Aún no hay actividades de competencia configuradas en la hoja *ACTIVIDADES_COMPETENCIA* ⚔️\n" +
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
      // Cerrar visita
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
        const range = `VISITAS!F${rowIndex}:F${rowIndex}`; // hora_fin
        await updateSheetValues(range, [[now]]);
      }

      await addPuntos(telefono, "OPERACION", `CIERRE_VISITA_${visitaId}`, 5);
      await setSession(telefono, STATE_OPER_MENU, {});

      return (
        "✅ *Visita cerrada*.\n" +
        "🎯 Ganaste *5 puntos de operación* por completar la visita.\n\n" +
        "🧰 *Operación en tienda*\n" +
        "1️⃣ Iniciar otra visita\n" +
        "2️⃣ Registrar venta rápida (Modelo X)\n" +
        "3️⃣ Volver al menú principal"
      );
    }

    return (
      "Dentro de la visita puedes:\n" +
      "1️⃣ Inventario de productos foco\n" +
      "2️⃣ Actividades de la competencia\n" +
      "3️⃣ Cerrar visita"
    );
  }

  // ----- Inventario dentro de visita -----
  if (estado === STATE_OPER_INV_PROD) {
    const productos = data.productos || [];
    let idx = data.idx || 0;
    let contestados = data.contestados || 0;

    if (!productos.length || idx >= productos.length) {
      // Algo raro, regresar al menú de visita
      await setSession(telefono, STATE_OPER_VISITA_MENU, {
        visitaId: data.visitaId,
        promotor_id: data.promotor_id,
        tienda_id: data.tienda_id,
        tienda_nombre: data.tienda_nombre,
      });
      return (
        "Terminé el inventario de productos foco.\n\n" +
        "1️⃣ Inventario de productos foco\n" +
        "2️⃣ Actividades de la competencia\n" +
        "3️⃣ Cerrar visita"
      );
    }

    const lower = text.toLowerCase();
    let grabar = false;
    let cantidad = 0;

    if (lower === "s") {
      // saltar sin registrar
    } else {
      cantidad = Number(text);
      if (Number.isNaN(cantidad) || cantidad < 0) {
        const p = productos[idx];
        return (
          `Por favor escribe un número válido para *${p.nombre_producto}* ` +
          "o *s* para saltar."
        );
      }
      grabar = true;
    }

    const p = productos[idx];

    if (grabar) {
      const fecha = new Date().toISOString().slice(0, 10);
      await appendSheetValues("INVENTARIO!A2:F", [[
        data.visitaId,
        data.promotor_id || "",
        data.tienda_id,
        p.producto_id,
        cantidad,
        fecha,
      ]]);
      contestados++;
    }

    idx++;
    if (idx >= productos.length) {
      // Fin del inventario
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
        "✅ Inventario de productos foco registrado.\n" +
        `Productos respondidos: *${contestados}*.\n` +
        (pts > 0 ? `🎯 Ganaste *${pts} puntos de operación*.\n\n` : "\n") +
        "¿Qué quieres hacer ahora?\n" +
        "1️⃣ Inventario de productos foco\n" +
        "2️⃣ Actividades de la competencia\n" +
        "3️⃣ Cerrar visita"
      );
    }

    // Continuar con el siguiente producto
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
      "Responde con un número o escribe *s* para saltar."
    );
  }

  // ----- Competencia: elegir competidor -----
  if (estado === STATE_OPER_COMP_COMPETIDOR) {
    const competidores = data.competidores || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > competidores.length) {
      let msg = "Por favor elige una opción válida:\n\n";
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
        `Por ahora no tengo actividades configuradas para *${competidor}* ⚔️\n\n` +
        "¿Qué quieres hacer ahora?\n" +
        "1️⃣ Inventario de productos foco\n" +
        "2️⃣ Actividades de la competencia\n" +
        "3️⃣ Cerrar visita"
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
    msg += "\nResponde con el número de la actividad que viste en piso.";
    return msg;
  }

  // ----- Competencia: elegir actividad -----
  if (estado === STATE_OPER_COMP_ACTIVIDAD) {
    const actividades = data.actividades || [];
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1 || n > actividades.length) {
      let msg = `Por favor elige una opción válida de *${data.competidor}*:\n\n`;
      actividades.forEach((a, idx) => {
        msg += `${idx + 1}) ${a.tipo_actividad} – ${a.descripcion_corta}\n`;
      });
      msg += "\nResponde con el número de la actividad que viste en piso.";
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
      (pts > 0 ? `🎯 Ganaste *${pts} puntos de operación*.\n\n` : "\n") +
      "¿Qué quieres hacer ahora?\n" +
      "1️⃣ Inventario de productos foco\n" +
      "2️⃣ Actividades de la competencia\n" +
      "3️⃣ Cerrar visita"
    );
  }

  // ----- Venta rápida demo (sin visita) -----
  if (estado === STATE_OPER_VENTA) {
    const unidades = Number(text);
    if (Number.isNaN(unidades) || unidades < 0) {
      return "Por favor escribe solo el número de unidades vendidas (ej. 3).";
    }

    const fecha      = new Date().toISOString();
    const productoId = "PROD_X"; // demo

    await appendSheetValues("VENTAS!A2:D", [[
      fecha,
      telefono,
      productoId,
      unidades,
    ]]);

    await addPuntos(telefono, "OPERACION", "VENTA_DEMO", 10);
    await setSession(telefono, STATE_OPER_MENU, {});

    return (
      "✅ Venta registrada.\n" +
      "Producto: *Modelo X 128GB*\n" +
      `Unidades: *${unidades}*\n\n` +
      "🎯 Ganaste *10 puntos de operación*.\n" +
      "¿Qué quieres hacer ahora?\n" +
      "1️⃣ Iniciar visita en tienda\n" +
      "2️⃣ Registrar otra venta rápida\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  // Fallback
  await setSession(telefono, STATE_OPER_MENU, {});
  return (
    "🧰 *Operación en tienda*\n" +
    "1️⃣ Iniciar visita en tienda\n" +
    "2️⃣ Registrar venta rápida (Modelo X)\n" +
    "3️⃣ Volver al menú principal"
  );
}

// ==========================
// Academia (se mantiene)
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
      return (
        "Volviendo al menú principal…\n\n" +
        "1️⃣ Operación en tienda\n" +
        "2️⃣ Academia (capacitaciones)\n" +
        "3️⃣ Ver mis puntos"
      );
    }

    return (
      "🎓 *Academia de Bolsillo*\n" +
      "1️⃣ Reto del día\n" +
      "2️⃣ Ver mis puntos de capacitación\n" +
      "3️⃣ Volver al menú principal"
    );
  }

  if (estado === STATE_ACAD_RETO) {
    if (!["1", "2", "3"].includes(text)) {
      return "Responde solo con 1, 2 o 3 😉";
    }

    const { reto_id } = data;
    const rows = await getSheetValues("RETOS!A2:H");
    const retoRow = rows.find(r => r[0] === reto_id);
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
    const pts = es_correcta ? Number(puntos_ok || 0) : Number(puntos_error || 0);

    const fecha_hora = new Date().toISOString();
    await appendSheetValues("RESPUESTAS_RETOS!A2:F", [[
      fecha_hora,
      telefono,
      reto_id,
      respuestaNum,
      es_correcta ? "TRUE" : "FALSE",
      pts,
    ]]);

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
      "3️⃣ Volver al menú principal\n\n" +
      "O escribe *menu* para ir al inicio."
    );
  }

  await setSession(telefono, STATE_ACAD_MENU, {});
  return (
    "🎓 *Academia de Bolsillo*\n" +
    "1️⃣ Reto del día\n" +
    "2️⃣ Ver mis puntos de capacitación\n" +
    "3️⃣ Volver al menú principal"
  );
}

// ==========================
// Rutas Express
// ==========================
app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  console.log("Mensaje entrante:", from, body);

  let respuesta;
  try {
    respuesta = await handleIncoming(from, body);
  } catch (err) {
    console.error("Error en handleIncoming:", err);
    respuesta =
      "Ocurrió un error procesando tu mensaje. Intenta de nuevo más tarde 🙏";
  }

  const twiml = new MessagingResponse();
  twiml.message(respuesta);

  res.type("text/xml");
  res.send(twiml.toString());
});

// Ruta raíz para probar en navegador
app.get("/", (req, res) => {
  res.send("Promobolsillo bot está vivo ✅ (Sheets conectado, operación robusta)");
});

app.listen(PORT, () => {
  console.log(`🚀 Promobolsillo bot escuchando en puerto ${PORT}`);
});
