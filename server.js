const express = require('express');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = '8400560729:AAHQbx4JthWEr8o3dccoUJgDw2lSnV_JO24';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_API_KEY = 'AIzaSyD5pMc74tA8K9kkklsxFOKzPqe1J-yPQ1E';

// Configuración de Google
const SHEET_ID = process.env.SHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar'
  ]
});

const sheets = google.sheets({ version: 'v4', auth });
const calendar = google.calendar({ version: 'v3', auth });
const CALENDAR_ID = '2d53b8a8e363449f4651cfde31f393c83dbb300968aec2d84ad1f645b48ed860@group.calendar.google.com';

// Contextos en memoria
const contextos = {};

// ============================================
// WEBHOOK ENDPOINT
// ============================================

app.post('/webhook', async (req, res) => {
  const update = req.body;
  
  try {
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const mensaje = update.message.text;
      const userId = update.message.from.id;
      
      await procesarMensaje(chatId, mensaje, userId);
    }
    
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
  
  // Detectar tipo con Gemini
  const tipo = await detectarTipoConGemini(mensaje);
  
  if (tipo === 'GASTO') {
    await iniciarGasto(chatId, mensaje, userId);
  } else if (tipo === 'TAREA') {
    await iniciarTarea(chatId, mensaje, userId);
  } else if (tipo === 'CONVERSACION') {
    const respuesta = await responderConversacionConGemini(mensaje);
    await enviarMensaje(chatId, respuesta);
  } else {
    await enviarMensaje(chatId, 
      '❓ No entendí.\n\n' +
      '💰 Para gastos: "Gasté 15000 en el super"\n' +
      '✅ Para tareas: "Lavar los platos" o "Arreglar heladera urgente"'
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
    await enviarMensaje(chatId, '📝 ¿Qué compraste?');
    
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
    const categorias = ['Auto - Plata', 'Auto - Tiempo', 'Casa', 'Casa - Plata', 'Estandarización', 'Personal', 'Personas', 'Salud', 'Trabajo', 'Facultad'];
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
  
  // Analizar con Gemini
  const analisis = await analizarTareaConGemini(mensaje);
  
  // Si Gemini detectó categoría, usarla automáticamente
  if (analisis.categoria) {
    const categorias = ['Auto - Plata', 'Auto - Tiempo', 'Casa', 'Casa - Plata', 'Estandarización', 'Personal', 'Personas', 'Salud', 'Trabajo', 'Facultad'];
    
    if (categorias.includes(analisis.categoria)) {
      const fecha = parsearFecha(analisis.fecha, analisis.hora);
      
      contextos[userId] = { 
        tipo: 'TAREA', 
        esperando: 'PRIORIDAD', 
        datos: { 
          tarea, 
          urgente: esUrgente,
          categoria: analisis.categoria,
          fecha: fecha,
          duracion: analisis.duracion
        } 
      };
      
      if (!esUrgente) {
        const botonesPrioridad = [
          [{text: '🔴 Urgente', callback_data: 'tarea_prio_1'}],
          [{text: '🟠 Alta', callback_data: 'tarea_prio_2'}],
          [{text: '🟡 Media', callback_data: 'tarea_prio_3'}],
          [{text: '🟢 Baja', callback_data: 'tarea_prio_4'}]
        ];
        
        await enviarMensajeConBotones(chatId, 
          `📝 Tarea: "${tarea}"\n📁 Categoría: ${analisis.categoria}${fecha ? `\n📅 Fecha: ${fecha.toLocaleDateString('es-AR')}` : ''}\n\n¿Qué prioridad?`, 
          botonesPrioridad
        );
      } else {
        contextos[userId].datos.prioridad = 'Urgente';
        await finalizarTareaUrgente(chatId, userId, contextos[userId].datos);
      }
      
      return;
    }
  }
  
  // Si Gemini no detectó, preguntar manualmente
  const botones = [
    [{text: '💰 Auto - Plata', callback_data: 'tarea_cat_1'}],
    [{text: '⏱️ Auto - Tiempo', callback_data: 'tarea_cat_2'}],
    [{text: '🏠 Casa', callback_data: 'tarea_cat_3'}],
    [{text: '💵 Casa - Plata', callback_data: 'tarea_cat_4'}],
    [{text: '📋 Estandarización', callback_data: 'tarea_cat_5'}],
    [{text: '👤 Personal', callback_data: 'tarea_cat_6'}],
    [{text: '👥 Personas', callback_data: 'tarea_cat_7'}],
    [{text: '💊 Salud', callback_data: 'tarea_cat_8'}],
    [{text: '💼 Trabajo', callback_data: 'tarea_cat_9'}],
    [{text: '🎓 Facultad', callback_data: 'tarea_cat_10'}]
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
  
  try {
    await agregarGasto(datos.monto, datos.categoria, datos.descripcion, datos.medioPago, cuotas);
    
    await enviarMensaje(chatId, 
      `✅ Gasto guardado!\n\n` +
      `💰 $${datos.monto.toLocaleString('es-AR')} - ${datos.categoria}\n` +
      `📝 ${datos.descripcion}\n` +
      `💳 ${datos.medioPago}${cuotas > 1 ? ` (${cuotas} cuotas)` : ''}`
    );
  } catch (error) {
    console.error('Error al guardar gasto:', error);
    await enviarMensaje(chatId, '❌ Error al guardar en Sheet');
  }
  
  delete contextos[userId];
}

async function finalizarTarea(chatId, userId, datos) {
  try {
    await agregarTarea(datos.categoria, datos.prioridad, datos.tarea);
    
    await enviarMensaje(chatId, 
      `✅ Tarea guardada!\n\n` +
      `📝 ${datos.tarea}\n` +
      `🏷️ ${datos.categoria} - ${datos.prioridad}`
    );
  } catch (error) {
    console.error('Error al guardar tarea:', error);
    await enviarMensaje(chatId, '❌ Error al guardar en Sheet');
  }
  
  delete contextos[userId];
}

async function finalizarTareaUrgente(chatId, userId, datos) {
  try {
    await agregarTareaUrgente(datos.categoria, datos.tarea);
    await crearEventoCalendar(datos.categoria, datos.tarea, datos.fecha, datos.duracion);
    
    let mensaje = `✅ Tarea URGENTE guardada!\n\n🔴 ${datos.tarea}\n🏷️ ${datos.categoria}\n\n✓ Guardada en Sheet\n✓ Agregada a Calendar`;
    
    if (datos.fecha) {
      mensaje += `\n📅 ${datos.fecha.toLocaleString('es-AR')}`;
    }
    
    if (datos.duracion) {
      mensaje += `\n⏱️ Duración: ${datos.duracion} minutos`;
    }
    
    await enviarMensaje(chatId, mensaje);
  } catch (error) {
    console.error('Error al guardar tarea urgente:', error);
    await enviarMensaje(chatId, '❌ Error: ' + error.message);
  }
  
  delete contextos[userId];
}

// ============================================
// GOOGLE SHEETS
// ============================================

async function agregarGasto(monto, categoria, descripcion, medioPago, cuotas) {
  const fecha = new Date();
  
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Gastos!A:K',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        '', // ID (auto)
        fecha.toLocaleDateString('es-AR'),
        monto,
        categoria,
        descripcion,
        medioPago,
        cuotas,
        `1/${cuotas}`,
        fecha.toLocaleDateString('es-AR', { month: 'long' }),
        fecha.getFullYear(),
        ''
      ]]
    }
  });
}

async function agregarTarea(categoria, prioridad, tarea) {
  const fecha = new Date();
  
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Tareas Específicas!A:L',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        '', // ID (auto)
        fecha.toLocaleDateString('es-AR'),
        categoria,
        prioridad,
        tarea,
        '', // Deadline
        '', // Día planificado
        '', // Hora
        'Pendiente',
        'No', // En Calendar
        '', // Notas
        '' // Fecha completada
      ]]
    }
  });
}

async function agregarTareaUrgente(categoria, tarea) {
  const fecha = new Date();
  
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Tareas Específicas!A:L',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        '', // ID (auto)
        fecha.toLocaleDateString('es-AR'),
        categoria,
        'Urgente',
        tarea,
        '', // Deadline
        fecha.toLocaleDateString('es-AR'), // Día planificado
        '', // Hora
        'Pendiente',
        'Sí', // En Calendar
        '', // Notas
        '' // Fecha completada
      ]]
    }
  });
}

// ============================================
// GEMINI AI - DETECCIÓN DE TIPO
// ============================================

async function detectarTipoConGemini(mensaje) {
  console.log('🤖 Detectando tipo con Gemini:', mensaje);
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `Sos Boty, un asistente argentino copado que ayuda a registrar GASTOS y TAREAS.

Analizá este mensaje y decidí qué tipo es:

GASTO: si menciona que gastó/compró/pagó dinero, o empieza con un monto
Ejemplos: "gasté 5000", "compré pan", "pagué la luz", "15000 en el super"

TAREA: si es algo que tiene que hacer
Ejemplos: "llamar al médico", "pagar la luz", "lavar los platos", "reunión mañana"

CONVERSACION: saludos, preguntas, bardeos, cualquier otra cosa
Ejemplos: "hola", "cómo estás", "sos re tonto", "no entiendo", "ayuda"

Mensaje: "${mensaje}"

Responde SOLO una palabra: GASTO, TAREA o CONVERSACION`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 seg timeout
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();
    console.log('📥 Gemini respondió:', JSON.stringify(data).substring(0, 200));
    
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      const respuesta = data.candidates[0].content.parts[0].text.trim().toUpperCase();
      console.log('✅ Tipo detectado:', respuesta);
      
      if (respuesta.includes('GASTO')) return 'GASTO';
      if (respuesta.includes('TAREA')) return 'TAREA';
      if (respuesta.includes('CONVERSACION')) return 'CONVERSACION';
    }
  } catch (error) {
    console.error('❌ Error Gemini detectar tipo:', error.message);
    
    // FALLBACK: detección simple si Gemini falla
    const lower = mensaje.toLowerCase();
    
    if (/^\d+/.test(mensaje) || lower.includes('gast') || lower.includes('compré') || lower.includes('pagué')) {
      console.log('⚡ Fallback: detectado como GASTO');
      return 'GASTO';
    }
    
    const palabrasTarea = ['lavar', 'limpiar', 'llamar', 'pagar', 'arreglar', 'revisar'];
    if (palabrasTarea.some(p => lower.includes(p))) {
      console.log('⚡ Fallback: detectado como TAREA');
      return 'TAREA';
    }
    
    const saludos = ['hola', 'hi', 'hey', 'buen dia', 'buenas'];
    if (saludos.some(s => lower.includes(s))) {
      console.log('⚡ Fallback: detectado como CONVERSACION');
      return 'CONVERSACION';
    }
  }
  
  console.log('⚠️ No se pudo detectar tipo');
  return 'DESCONOCIDO';
}

async function responderConversacionConGemini(mensaje) {
  console.log('💬 Generando respuesta de conversación');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `Sos Boty, un asistente de Telegram argentino copado que ayuda a registrar gastos y tareas.

Tu personalidad:
- Hablás en argentino casual (dale, joya, che)
- Si te saludan, saludás amigable y explicás qué hacés
- Si te bardean, respondés con humor sin ofenderte
- Si piden ayuda, explicás claro y conciso
- Siempre recordás que pueden mandarte gastos o tareas

Mensaje del usuario: "${mensaje}"

Respondé en máximo 2-3 líneas, copado y útil:`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();
    
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      const respuesta = data.candidates[0].content.parts[0].text.trim();
      console.log('✅ Respuesta generada');
      return respuesta;
    }
  } catch (error) {
    console.error('❌ Error Gemini conversacion:', error.message);
  }
  
  // FALLBACK: respuesta simple
  const lower = mensaje.toLowerCase();
  
  if (lower.includes('hola') || lower.includes('hey') || lower.includes('hi')) {
    return '¡Hola! 👋 Soy Boty, te ayudo a registrar gastos y tareas. Mandame algo como:\n💰 "Gasté 5000 en el super"\n✅ "Llamar al médico mañana"';
  }
  
  if (lower.includes('ayuda') || lower.includes('cómo') || lower.includes('como')) {
    return '📝 Podés mandarme:\n💰 Gastos: "Gasté X en..."\n✅ Tareas: "Tengo que..." o "Llamar a..."';
  }
  
  return '¡Dale! Mandame un gasto o una tarea y la registro para vos 😄';
}

// ============================================
// GEMINI AI - ANÁLISIS DE TAREAS
// ============================================

async function analizarTareaConGemini(mensaje) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `Sos un asistente que categoriza tareas inteligentemente. Analiza este mensaje y extrae información.

CATEGORÍAS Y EJEMPLOS:

1. Auto - Plata: pagar seguro, cargar nafta, pagar patente, multas, gastos del auto
2. Auto - Tiempo: cambiar aceite, service, lavar auto, revisar frenos, llevar a mecánico
3. Casa: arreglar algo en casa, pintar, organizar, limpiar pileta, jardinería
4. Casa - Plata: pagar luz, gas, alquiler, expensas, internet, servicios
5. Estandarización: mejorar procesos, documentar, optimizar, organizar sistemas
6. Personal: gym, psicólogo, turno médico personal, comprar ropa, corte de pelo
7. Personas: reunión, llamar a alguien, juntarse, visitar, evento social
8. Salud: médico, estudios, ejercicio físico, nutricionista, terapia
9. Trabajo: tareas laborales, reuniones de trabajo, proyectos, presentaciones
10. Facultad: estudiar, parcial, TP, clases, leer para la facultad

REGLAS PARA DETECTAR FECHA Y HORA:
- "mañana" = mañana
- "pasado mañana" = dentro de 2 días  
- "hoy" = hoy
- "el viernes", "el lunes" = ese día específico
- "18 de abril", "25/04" = fecha exacta
- Horas: "3 PM", "15:00", "10 de la mañana"

REGLAS PARA DURACIÓN:
- "1 hora", "30 minutos", "2 horas" = duración específica
- "media hora" = 30 minutos
- Si no menciona duración = null

Mensaje del usuario: "${mensaje}"

PIENSA PASO A PASO:
1. ¿De qué se trata esta tarea?
2. ¿A qué categoría pertenece mejor?
3. ¿Menciona alguna fecha o día?
4. ¿Menciona alguna hora?
5. ¿Menciona cuánto tiempo le va a llevar?

Responde SOLO con JSON (sin markdown, sin \`\`\`):
{
  "categoria": "nombre exacto de categoría",
  "razonamiento": "por qué elegiste esa categoría",
  "fecha": "descripción de fecha o null",
  "hora": "hora mencionada o null",
  "duracion": número de minutos o null
}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    });
    
    const data = await response.json();
    
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      const texto = data.candidates[0].content.parts[0].text.trim();
      
      // Limpiar markdown si existe
      let jsonText = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const resultado = JSON.parse(jsonMatch[0]);
        console.log('Gemini detectó:', resultado);
        return resultado;
      }
    }
  } catch (error) {
    console.error('Error Gemini:', error);
  }
  
  return { categoria: null, fecha: null, hora: null, duracion: null };
}

function parsearFecha(descripcionFecha, hora) {
  if (!descripcionFecha) return null;
  
  const ahora = new Date();
  let fecha = new Date(ahora);
  
  const lower = descripcionFecha.toLowerCase();
  
  if (lower.includes('mañana') && !lower.includes('pasado')) {
    fecha.setDate(fecha.getDate() + 1);
  } else if (lower.includes('pasado mañana')) {
    fecha.setDate(fecha.getDate() + 2);
  } else if (lower.includes('lunes')) {
    fecha = siguienteDiaSemana(1);
  } else if (lower.includes('martes')) {
    fecha = siguienteDiaSemana(2);
  } else if (lower.includes('miércoles') || lower.includes('miercoles')) {
    fecha = siguienteDiaSemana(3);
  } else if (lower.includes('jueves')) {
    fecha = siguienteDiaSemana(4);
  } else if (lower.includes('viernes')) {
    fecha = siguienteDiaSemana(5);
  } else if (lower.includes('sábado') || lower.includes('sabado')) {
    fecha = siguienteDiaSemana(6);
  } else if (lower.includes('domingo')) {
    fecha = siguienteDiaSemana(0);
  }
  
  if (hora) {
    const horaMatch = hora.match(/(\d+):?(\d*)\s*(am|pm)?/i);
    if (horaMatch) {
      let horas = parseInt(horaMatch[1]);
      const minutos = parseInt(horaMatch[2] || '0');
      const ampm = horaMatch[3];
      
      if (ampm && ampm.toLowerCase() === 'pm' && horas < 12) {
        horas += 12;
      } else if (ampm && ampm.toLowerCase() === 'am' && horas === 12) {
        horas = 0;
      }
      
      fecha.setHours(horas, minutos, 0, 0);
    }
  } else {
    fecha.setHours(9, 0, 0, 0); // Por defecto 9 AM
  }
  
  return fecha;
}

function siguienteDiaSemana(diaSemana) {
  const hoy = new Date();
  const hoyDia = hoy.getDay();
  let diasHasta = diaSemana - hoyDia;
  
  if (diasHasta <= 0) {
    diasHasta += 7;
  }
  
  const fecha = new Date(hoy);
  fecha.setDate(fecha.getDate() + diasHasta);
  return fecha;
}

// ============================================
// GOOGLE CALENDAR
// ============================================

function obtenerColorCalendar(categoria) {
  const colores = {
    'Auto - Plata': '5',      // Amarillo
    'Auto - Tiempo': '6',     // Naranja
    'Casa': '9',              // Azul
    'Casa - Plata': '7',      // Celeste
    'Estandarización': '3',   // Morado
    'Personal': '4',          // Rosa
    'Personas': '10',         // Verde
    'Salud': '11',            // Rojo
    'Trabajo': '8',           // Gris
    'Facultad': '2'           // Verde Lima
  };
  
  return colores[categoria] || '1';
}

async function crearEventoCalendar(categoria, tarea, fecha = null, duracion = null) {
  const hoy = new Date();
  let start, end;
  
  if (fecha) {
    // Si tiene fecha específica
    start = { dateTime: fecha.toISOString() };
    
    if (duracion) {
      const fechaFin = new Date(fecha);
      fechaFin.setMinutes(fechaFin.getMinutes() + duracion);
      end = { dateTime: fechaFin.toISOString() };
    } else {
      const fechaFin = new Date(fecha);
      fechaFin.setHours(fechaFin.getHours() + 1);
      end = { dateTime: fechaFin.toISOString() };
    }
  } else {
    // Evento de todo el día
    start = { date: hoy.toISOString().split('T')[0] };
    const mañana = new Date(hoy);
    mañana.setDate(mañana.getDate() + 1);
    end = { date: mañana.toISOString().split('T')[0] };
  }
  
  const event = {
    summary: `🔴 ${categoria} - ${tarea}`,
    description: 'Tarea urgente creada desde Telegram',
    start,
    end,
    colorId: obtenerColorCalendar(categoria)
  };
  
  await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event
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
