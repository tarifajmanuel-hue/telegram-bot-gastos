const express = require('express');
const fetch = require('node-fetch');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = '8400560729:AAHQbx4JthWEr8o3dccoUJgDw2lSnV_JO24';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Configuración de Google Sheets
const SHEET_ID = process.env.SHEET_ID;
const SERVICE_ACCOUNT = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : ''
};

// Contextos en memoria (temporal)
const contextos = {};

// ============================================
// WEBHOOK ENDPOINT
// ============================================

app.post('/webhook', async (req, res) => {
  const update = req.body;
  
  try {
    // Procesar mensaje de texto
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const mensaje = update.message.text;
      const userId = update.message.from.id;
      
      await procesarMensaje(chatId, mensaje, userId);
    }
    
    // Procesar botón
    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const userId = update.callback_query.from.id;
      const data = update.callback_query.data;
      const messageId = update.callback_query.message.message_id;
      const callbackId = update.callback_query.id;
      
      await procesarBoton(chatId, userId, data, messageId, callbackId);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error);
    res.sendStatus(500);
  }
});

// ============================================
// PROCESAR MENSAJE
// ============================================

async function procesarMensaje(chatId, mensaje, userId) {
  const contexto = contextos[userId];
  
  // Cancelar
  if (mensaje.toLowerCase() === 'cancelar' || mensaje.toLowerCase() === 'volver') {
    if (contexto) {
      delete contextos[userId];
      await enviarMensaje(chatId, '❌ Cancelado');
    }
    return;
  }
  
  if (contexto && contexto.esperando) {
    await procesarRespuesta(chatId, mensaje, contexto);
    return;
  }
  
  const tipo = detectarTipo(mensaje);
  
  if (tipo === 'GASTO') {
    await iniciarGasto(chatId, mensaje, userId);
  } else if (tipo === 'TAREA') {
    await iniciarTarea(chatId, mensaje, userId);
  } else {
    await enviarMensaje(chatId, 
      '❓ No entendí.\n\n' +
      '💰 Para gastos:\n' +
      '• "Gasté 15000 en el super"\n\n' +
      '✅ Para tareas:\n' +
      '• "Lavar los platos"\n' +
      '• "Arreglar extractor urgente"'
    );
  }
}

// ============================================
// PROCESAR BOTÓN
// ============================================

async function procesarBoton(chatId, userId, data, messageId, callbackId) {
  const contexto = contextos[userId];
  
  if (!contexto) {
    await responderCallback(callbackId, '❌ Sesión expirada');
    return;
  }
  
  await responderCallback(callbackId, '✅');
  
  // GASTOS
  if (data.startsWith('gasto_cat_')) {
    const num = parseInt(data.split('_')[2]);
    const categorias = ['Comida', 'Casa', 'Transporte', 'Salud', 'Ocio'];
    contexto.datos.categoria = categorias[num - 1];
    
    await editarMensaje(chatId, messageId, '💰 Categoría: ' + categorias[num - 1]);
    await enviarMensaje(chatId, '📝 ¿Qué compraste?\n\n(O escribí "cancelar")');
    
    contexto.esperando = 'DESCRIPCION';
    
  } else if (data.startsWith('gasto_medio_')) {
    const num = parseInt(data.split('_')[2]);
    const medios = ['Débito', 'Crédito', 'Efectivo', 'Transferencia'];
    contexto.datos.medioPago = medios[num - 1];
    
    await editarMensaje(chatId, messageId, '💳 Medio de pago: ' + medios[num - 1]);
    
    if (medios[num - 1] === 'Crédito') {
      const botonesCuotas = [
        [{text: '1 cuota', callback_data: 'gasto_cuotas_1'}],
        [{text: '3 cuotas', callback_data: 'gasto_cuotas_3'}],
        [{text: '6 cuotas', callback_data: 'gasto_cuotas_6'}],
        [{text: '12 cuotas', callback_data: 'gasto_cuotas_12'}],
        [{text: '18 cuotas', callback_data: 'gasto_cuotas_18'}]
      ];
      
      await enviarMensajeConBotones(chatId, '¿En cuántas cuotas?', botonesCuotas);
      contexto.esperando = 'CUOTAS';
    } else {
      await finalizarGasto(chatId, userId, contexto.datos);
    }
    
  } else if (data.startsWith('gasto_cuotas_')) {
    const cuotas = parseInt(data.split('_')[2]);
    contexto.datos.cuotas = cuotas;
    
    await editarMensaje(chatId, messageId, '📋 Cuotas: ' + cuotas);
    await finalizarGasto(chatId, userId, contexto.datos);
  }
  
  // TAREAS
  if (data.startsWith('tarea_cat_')) {
    const num = parseInt(data.split('_')[2]);
    const categorias = ['Casa', 'Auto', 'Facultad', 'Trabajo', 'Salud'];
    contexto.datos.categoria = categorias[num - 1];
    
    await editarMensaje(chatId, messageId, '📁 Categoría: ' + categorias[num - 1]);
    
    if (!contexto.datos.urgente) {
      const botonesPrioridad = [
        [{text: '🔴 Urgente', callback_data: 'tarea_prio_1'}],
        [{text: '🟠 Alta', callback_data: 'tarea_prio_2'}],
        [{text: '🟡 Media', callback_data: 'tarea_prio_3'}],
        [{text: '🟢 Baja', callback_data: 'tarea_prio_4'}]
      ];
      
      await enviarMensajeConBotones(chatId, '¿Qué prioridad?', botonesPrioridad);
      contexto.esperando = 'PRIORIDAD';
    } else {
      contexto.datos.prioridad = 'Urgente';
      await finalizarTareaUrgente(chatId, userId, contexto.datos);
    }
    
  } else if (data.startsWith('tarea_prio_')) {
    const num = parseInt(data.split('_')[2]);
    const prioridades = ['Urgente', 'Alta', 'Media', 'Baja'];
    contexto.datos.prioridad = prioridades[num - 1];
    
    await editarMensaje(chatId, messageId, '⚡ Prioridad: ' + prioridades[num - 1]);
    
    if (prioridades[num - 1] === 'Urgente') {
      await finalizarTareaUrgente(chatId, userId, contexto.datos);
    } else {
      await finalizarTarea(chatId, userId, contexto.datos);
    }
  }
}

// ============================================
// DETECTAR TIPO
// ============================================

function detectarTipo(mensaje) {
  const lower = mensaje.toLowerCase().trim();
  
  if (/^\d+/.test(mensaje) || 
      lower.includes('gast') || 
      lower.includes('compré') || 
      lower.includes('compre') || 
      lower.includes('pagué') || 
      lower.includes('pague')) {
    return 'GASTO';
  }
  
  const palabrasTarea = [
    'lavar', 'limpiar', 'ordenar', 'arreglar', 'reparar',
    'hacer', 'comprar', 'llamar', 'revisar', 'buscar',
    'preparar', 'cocinar', 'estudiar', 'practicar',
    'terminar', 'empezar', 'urgente', 'tengo que'
  ];
  
  for (let palabra of palabrasTarea) {
    if (lower.includes(palabra)) return 'TAREA';
  }
  
  return 'DESCONOCIDO';
}

// ============================================
// INICIAR FLUJOS
// ============================================

async function iniciarGasto(chatId, mensaje, userId) {
  const montoMatch = mensaje.match(/\d+/);
  const monto = montoMatch ? parseInt(montoMatch[0]) : null;
  
  if (!monto) {
    await enviarMensaje(chatId, '💰 ¿Cuánto gastaste?');
    contextos[userId] = { tipo: 'GASTO', esperando: 'MONTO', datos: {} };
    return;
  }
  
  const botones = [
    [{text: '🍔 Comida', callback_data: 'gasto_cat_1'}],
    [{text: '🏠 Casa', callback_data: 'gasto_cat_2'}],
    [{text: '🚗 Transporte', callback_data: 'gasto_cat_3'}],
    [{text: '💊 Salud', callback_data: 'gasto_cat_4'}],
    [{text: '🎉 Ocio', callback_data: 'gasto_cat_5'}]
  ];
  
  await enviarMensajeConBotones(chatId, `💰 $${monto.toLocaleString('es-AR')}\n\n¿Qué categoría?`, botones);
  
  contextos[userId] = { tipo: 'GASTO', esperando: 'CATEGORIA', datos: { monto } };
}

async function iniciarTarea(chatId, mensaje, userId) {
  const esUrgente = mensaje.toLowerCase().includes('urgente');
  const tarea = mensaje.replace(/urgente/gi, '').trim();
  
  const botones = [
    [{text: '🏠 Casa', callback_data: 'tarea_cat_1'}],
    [{text: '🚗 Auto', callback_data: 'tarea_cat_2'}],
    [{text: '🎓 Facultad', callback_data: 'tarea_cat_3'}],
    [{text: '💼 Trabajo', callback_data: 'tarea_cat_4'}],
    [{text: '💊 Salud', callback_data: 'tarea_cat_5'}]
  ];
  
  await enviarMensajeConBotones(chatId, 
    `📝 Tarea: "${tarea}"${esUrgente ? ' (URGENTE)' : ''}\n\n¿Qué categoría?`, 
    botones
  );
  
  contextos[userId] = { tipo: 'TAREA', esperando: 'CATEGORIA', datos: { tarea, urgente: esUrgente } };
}

// ============================================
// PROCESAR RESPUESTAS
// ============================================

async function procesarRespuesta(chatId, mensaje, contexto) {
  const userId = contexto.userId;
  
  if (contexto.tipo === 'GASTO') {
    if (contexto.esperando === 'MONTO') {
      const monto = parseInt(mensaje);
      if (!monto) {
        await enviarMensaje(chatId, '❌ Tiene que ser un número');
        return;
      }
      
      contexto.datos.monto = monto;
      
      const botones = [
        [{text: '🍔 Comida', callback_data: 'gasto_cat_1'}],
        [{text: '🏠 Casa', callback_data: 'gasto_cat_2'}],
        [{text: '🚗 Transporte', callback_data: 'gasto_cat_3'}],
        [{text: '💊 Salud', callback_data: 'gasto_cat_4'}],
        [{text: '🎉 Ocio', callback_data: 'gasto_cat_5'}]
      ];
      
      await enviarMensajeConBotones(chatId, `💰 $${monto.toLocaleString('es-AR')}\n\n¿Qué categoría?`, botones);
      contexto.esperando = 'CATEGORIA';
      
    } else if (contexto.esperando === 'DESCRIPCION') {
      contexto.datos.descripcion = mensaje;
      
      const botones = [
        [{text: '💳 Débito', callback_data: 'gasto_medio_1'}],
        [{text: '💳 Crédito', callback_data: 'gasto_medio_2'}],
        [{text: '💵 Efectivo', callback_data: 'gasto_medio_3'}],
        [{text: '🏦 Transferencia', callback_data: 'gasto_medio_4'}]
      ];
      
      await enviarMensajeConBotones(chatId, '¿Cómo pagaste?', botones);
      contexto.esperando = 'MEDIO_PAGO';
    }
  }
}

// ============================================
// FINALIZAR
// ============================================

async function finalizarGasto(chatId, userId, datos) {
  const cuotas = datos.cuotas || 1;
  
  // Guardar en Sheet
  await agregarGasto(datos.monto, datos.categoria, datos.descripcion, datos.medioPago, cuotas);
  
  await enviarMensaje(chatId, 
    `✅ Gasto guardado!\n\n` +
    `💰 $${datos.monto.toLocaleString('es-AR')} - ${datos.categoria}\n` +
    `📝 ${datos.descripcion}\n` +
    `💳 ${datos.medioPago}${cuotas > 1 ? ` (${cuotas} cuotas)` : ''}`
  );
  
  delete contextos[userId];
}

async function finalizarTarea(chatId, userId, datos) {
  await agregarTarea(datos.categoria, datos.prioridad, datos.tarea);
  
  await enviarMensaje(chatId, 
    `✅ Tarea guardada!\n\n` +
    `📝 ${datos.tarea}\n` +
    `🏷️ ${datos.categoria} - ${datos.prioridad}`
  );
  
  delete contextos[userId];
}

async function finalizarTareaUrgente(chatId, userId, datos) {
  await agregarTareaUrgente(datos.categoria, datos.tarea);
  
  await enviarMensaje(chatId, 
    `✅ Tarea URGENTE guardada!\n\n` +
    `🔴 ${datos.tarea}\n` +
    `🏷️ ${datos.categoria}\n\n` +
    `✓ Guardada en Sheet\n` +
    `✓ Agregada a Calendar`
  );
  
  delete contextos[userId];
}

// ============================================
// GOOGLE SHEETS
// ============================================

async function agregarGasto(monto, categoria, descripcion, medioPago, cuotas) {
  const doc = new GoogleSpreadsheet(SHEET_ID, new JWT(SERVICE_ACCOUNT));
  await doc.loadInfo();
  
  const sheet = doc.sheetsByTitle['Gastos'];
  const fecha = new Date();
  
  await sheet.addRow({
    'Fecha': fecha.toLocaleDateString('es-AR'),
    'Monto': monto,
    'Categoría': categoria,
    'Descripción': descripcion,
    'Medio de Pago': medioPago,
    'Cuotas': cuotas,
    'Mes': fecha.toLocaleDateString('es-AR', { month: 'long' }),
    'Año': fecha.getFullYear()
  });
}

async function agregarTarea(categoria, prioridad, tarea) {
  const doc = new GoogleSpreadsheet(SHEET_ID, new JWT(SERVICE_ACCOUNT));
  await doc.loadInfo();
  
  const sheet = doc.sheetsByTitle['Tareas Específicas'];
  
  await sheet.addRow({
    'Fecha Ingreso': new Date().toLocaleDateString('es-AR'),
    'Categoría': categoria,
    'Prioridad': prioridad,
    'Tarea': tarea,
    'Estado': 'Pendiente',
    'En Calendar': 'No'
  });
}

async function agregarTareaUrgente(categoria, tarea) {
  const doc = new GoogleSpreadsheet(SHEET_ID, new JWT(SERVICE_ACCOUNT));
  await doc.loadInfo();
  
  const sheet = doc.sheetsByTitle['Tareas Específicas'];
  
  await sheet.addRow({
    'Fecha Ingreso': new Date().toLocaleDateString('es-AR'),
    'Categoría': categoria,
    'Prioridad': 'Urgente',
    'Tarea': tarea,
    'Estado': 'Pendiente',
    'En Calendar': 'Sí'
  });
}

// ============================================
// TELEGRAM API
// ============================================

async function enviarMensaje(chatId, texto) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto })
  });
}

async function enviarMensajeConBotones(chatId, texto, botones) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      reply_markup: { inline_keyboard: botones }
    })
  });
}

async function editarMensaje(chatId, messageId, texto) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: texto
    })
  });
}

async function responderCallback(callbackId, texto) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: texto })
  });
}

// ============================================
// SERVIDOR
// ============================================

app.get('/', (req, res) => {
  res.send('Bot funcionando ✅');
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log('Bot corriendo en puerto ' + listener.address().port);
});
