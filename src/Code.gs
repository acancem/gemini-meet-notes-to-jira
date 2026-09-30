/**
 * ============================================================================
 *  Gemini Meet Notes  ->  Jira Service Management
 * ============================================================================
 *
 *  Flujo:
 *    1. Busca correos de gemini-notes@google.com sin procesar.
 *    2. Extrae el link del Doc "Notes by Gemini".
 *    3. Lee las pestañas "Notas" y "Transcripción" del documento.
 *    4. Limpia los pies de página que agrega Gemini.
 *    5. Resuelve el ticket (ej. SOP2-1234) desde el evento de Google Calendar.
 *    6. Publica las notas como comentario PÚBLICO y la transcripción como
 *       comentario INTERNO en el ticket de Jira.
 *
 *  ------------------------------------------------------------------------
 *  CONFIGURACIÓN (Configuración del proyecto > Propiedades del script)
 *  ------------------------------------------------------------------------
 *    JIRA_BASE           https://tu-org.atlassian.net
 *    JIRA_USER_EMAIL     tu.correo@empresa.com
 *    JIRA_API_TOKEN      Token personal de Atlassian (NUNCA subirlo al repo)
 *
 *  ------------------------------------------------------------------------
 *  PUESTA EN MARCHA
 *  ------------------------------------------------------------------------
 *    1. Carga las propiedades de arriba.
 *    2. Ejecuta testJiraConnection()  -> debe responder 200.
 *    3. Ejecuta testDocument() con el ID de un Doc de Gemini tuyo.
 *    4. Ejecuta setup()  -> crea las etiquetas de Gmail y el trigger cada 15 min.
 *
 *  Guía completa: docs/guia.md
 * ============================================================================
 */

var PROPS = PropertiesService.getScriptProperties();

var LABEL_DONE    = 'gemini-notes/procesado';
var LABEL_PENDING = 'gemini-notes/sin-ticket';
var LABEL_ERROR   = 'gemini-notes/error';

var JIRA_MAX_COMMENT_CHARS = 30000;   // el límite real ronda 32.767

/** Pies de página que Gemini agrega y que NO deben subirse al ticket. */
var FOOTER_PATTERNS = [
  /revisa las notas de gemini/i,
  /obt[ée]n sugerencias y descubre c[óo]mo gemini toma notas/i,
  /c[óo]mo (es|son) la calidad de estas notas/i,
  /responde una breve encuesta/i,
  /para darnos tu opini[óo]n/i,
  /esta transcripci[óo]n editable se gener[óo] por computadora/i,
  /los usuarios tambi[ée]n pueden cambiar el texto/i,
  // equivalentes en inglés, por si el Doc sale en ese idioma
  /review gemini notes for accuracy/i,
  /get tips and learn how gemini takes notes/i,
  /how is the quality of these specific notes/i,
  /take a quick survey/i,
  /this editable transcript was computer generated/i,
  /users can also change the text after it was created/i
];

// ============================================================================
//  ENTRADA PRINCIPAL
// ============================================================================

/** Punto de entrada. Lo llama el trigger cada 15 minutos. */
function processGeminiNotes() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('Otra ejecución sigue activa. Se omite este ciclo.');
    return;
  }

  try {
    var days = Number(prop('GMAIL_QUERY_DAYS', '7'));
    var query = 'from:gemini-notes@google.com'
              + ' -label:' + LABEL_DONE
              + ' -label:' + LABEL_PENDING
              + ' newer_than:' + days + 'd';

    var threads = GmailApp.search(query, 0, 50);
    Logger.log('Hilos por procesar: ' + threads.length);

    threads.forEach(function (thread) {
      try {
        handleThread(thread);
      } catch (err) {
        Logger.log('ERROR en hilo "' + thread.getFirstMessageSubject() + '": ' + err);
        addLabel(thread, LABEL_ERROR);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Procesa un hilo de correo de Gemini. */
function handleThread(thread) {
  var message = thread.getMessages()[thread.getMessageCount() - 1];
  var docId   = extractDocId(message);

  if (!docId) {
    Logger.log('Sin link de documento en: ' + thread.getFirstMessageSubject());
    addLabel(thread, LABEL_PENDING);
    return;
  }

  if (alreadyProcessed(docId)) {
    Logger.log('Documento ya procesado antes: ' + docId);
    addLabel(thread, LABEL_DONE);
    return;
  }

  var doc      = DocumentApp.openById(docId);
  var docTitle = doc.getName();
  var meta     = parseDocTitle(docTitle, message.getDate());
  var content  = readTabs(doc);

  if (!content.notes && !content.transcript) {
    throw new Error('No se pudo leer contenido de las pestañas del documento ' + docId);
  }

  var issueKey = resolveIssueKey(meta, content);

  if (!issueKey) {
    Logger.log('No se identificó el ticket para: ' + docTitle);
    addLabel(thread, LABEL_PENDING);
    return;
  }

  Logger.log('Documento "' + docTitle + '" -> ticket ' + issueKey);

  publishToJira(issueKey, meta, content, docId);

  markProcessed(docId, issueKey);
  addLabel(thread, LABEL_DONE);
}

// ============================================================================
//  GMAIL
// ============================================================================

/** Saca el ID del Google Doc desde el cuerpo del correo (botón "Open meeting notes"). */
function extractDocId(message) {
  var body = message.getBody() || '';
  var plain = message.getPlainBody() || '';
  var haystack = body + '\n' + plain;

  // Google suele envolver los enlaces en un redirect: .../url?q=<destino>
  haystack = haystack.replace(/https:\/\/www\.google\.com\/url\?[^"'\s>]*?q=([^&"'\s>]+)/g,
    function (_, encoded) { return decodeURIComponent(encoded); });

  var match = haystack.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  return match ? match[1] : null;
}

// ============================================================================
//  GOOGLE DOCS  (pestañas Notas / Transcripción)
// ============================================================================

/**
 * Recorre todas las pestañas (incluidas las anidadas) y devuelve
 * { notes: string, transcript: string }.
 */
function readTabs(doc) {
  var result = { notes: '', transcript: '' };
  var tabs = flattenTabs(doc.getTabs());

  if (!tabs.length) {
    // Documento sin pestañas: todo el cuerpo se trata como notas.
    result.notes = cleanText(bodyToText(doc.getBody()));
    return result;
  }

  tabs.forEach(function (tab) {
    var title = (tab.getTitle() || '').toLowerCase();
    var text  = cleanText(bodyToText(tab.asDocumentTab().getBody()));
    if (!text) return;

    if (/transcri/.test(title)) {
      result.transcript = result.transcript ? result.transcript + '\n\n' + text : text;
    } else if (!result.notes) {
      result.notes = text;
    }
  });

  return result;
}

/** Aplana el árbol de pestañas de un documento. */
function flattenTabs(tabs) {
  var out = [];
  (function walk(list) {
    (list || []).forEach(function (tab) {
      out.push(tab);
      walk(tab.getChildTabs());
    });
  })(tabs);
  return out;
}

/** Convierte el cuerpo del documento a texto conservando títulos y viñetas. */
function bodyToText(body) {
  var lines = [];
  var total = body.getNumChildren();

  for (var i = 0; i < total; i++) {
    var el = body.getChild(i);
    var type = el.getType();

    if (type === DocumentApp.ElementType.PARAGRAPH) {
      var p = el.asParagraph();
      var text = p.getText().trim();
      if (!text) { lines.push(''); continue; }

      var heading = p.getHeading();
      if (heading === DocumentApp.ParagraphHeading.TITLE ||
          heading === DocumentApp.ParagraphHeading.HEADING1) {
        lines.push('h2. ' + text);
      } else if (heading === DocumentApp.ParagraphHeading.HEADING2 ||
                 heading === DocumentApp.ParagraphHeading.HEADING3) {
        lines.push('h3. ' + text);
      } else {
        lines.push(text);
      }

    } else if (type === DocumentApp.ElementType.LIST_ITEM) {
      var li = el.asListItem();
      var text2 = li.getText().trim();
      if (text2) {
        lines.push(repeatChar('*', li.getNestingLevel() + 1) + ' ' + text2);
      }

    } else if (type === DocumentApp.ElementType.TABLE) {
      var table = el.asTable();
      for (var r = 0; r < table.getNumRows(); r++) {
        var row = table.getRow(r);
        var cells = [];
        for (var c = 0; c < row.getNumCells(); c++) {
          cells.push(row.getCell(c).getText().replace(/\s+/g, ' ').trim());
        }
        lines.push('| ' + cells.join(' | ') + ' |');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Elimina los pies de página de Gemini y normaliza los saltos de línea. */
function cleanText(text) {
  var kept = (text || '').split('\n').filter(function (line) {
    var plain = line.trim();
    if (!plain) return true;
    return !FOOTER_PATTERNS.some(function (re) { return re.test(plain); });
  });

  return kept.join('\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();
}

// ============================================================================
//  RESOLUCIÓN DEL TICKET
// ============================================================================

/**
 * Del título "Soporte (Juan Pérez) - 2026/07/30 12:01 GMT-05:00 - Notes by Gemini"
 * extrae el nombre de la reunión y la fecha.
 */
function parseDocTitle(title, fallbackDate) {
  var meetingName = title.split(' - ')[0].trim();
  var m = title.match(/(\d{4})\/(\d{2})\/(\d{2})[ T]+(\d{2}):(\d{2})/);

  var date = fallbackDate;
  if (m) {
    date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  }

  return { title: title, meetingName: meetingName, date: date };
}

/** Busca el código de ticket: primero en Calendar, luego dentro del documento. */
function resolveIssueKey(meta, content) {
  return findKeyInCalendar(meta) ||
         findKey(content.notes) ||
         findKey(content.transcript) ||
         findKey(meta.title);
}

/** Encuentra el evento del día que coincide con la reunión y lee su descripción. */
function findKeyInCalendar(meta) {
  try {
    var calendarId = prop('CALENDAR_ID', 'primary');
    var calendar = calendarId === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(calendarId);
    if (!calendar) return null;

    var from = new Date(meta.date.getTime() - 12 * 3600 * 1000);
    var to   = new Date(meta.date.getTime() + 12 * 3600 * 1000);
    var events = calendar.getEvents(from, to);

    var target = normalize(meta.meetingName);

    // Primero coincidencia de título; después la más cercana en hora.
    var candidates = events.filter(function (ev) {
      var name = normalize(ev.getTitle());
      return name === target || name.indexOf(target) === 0 || target.indexOf(name) === 0;
    });

    candidates.sort(function (a, b) {
      return Math.abs(a.getStartTime() - meta.date) - Math.abs(b.getStartTime() - meta.date);
    });

    for (var i = 0; i < candidates.length; i++) {
      var key = findKey(candidates[i].getDescription()) ||
                findKey(candidates[i].getTitle());
      if (key) return key;
    }
  } catch (err) {
    Logger.log('No se pudo consultar Calendar: ' + err);
  }
  return null;
}

/**
 * Aplica el patrón de código de ticket sobre un texto.
 * Ignora el ejemplo del formulario de reserva ("ej. SOP2-7000") y las zonas
 * horarias que el patrón genérico podría confundir con tickets (GMT-05, UTC-5).
 */
function findKey(text) {
  if (!text) return null;
  var pattern = prop('TICKET_REGEX', '[A-Z][A-Z0-9]+-\\d+');
  var cleaned = String(text).replace(/\(ej\.?[^)]*\)/gi, ' ');
  var re = new RegExp('\\b(' + pattern + ')\\b', 'g');

  var match;
  while ((match = re.exec(cleaned)) !== null) {
    var key = match[1].toUpperCase();
    if (!/^(GMT|UTC)-/.test(key)) return key;
  }
  return null;
}

// ============================================================================
//  JIRA
// ============================================================================

/**
 * Publica el resumen (público) y la transcripción (interna) en el ticket.
 * Cada comentario se marca por separado en cuanto se confirma, de modo que
 * un reintento tras un fallo parcial solo suba lo que quedó pendiente.
 */
function publishToJira(issueKey, meta, content, docId) {
  var fecha = Utilities.formatDate(meta.date, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');

  if (content.notes) {
    postOnce('done:' + docId + ':notes', issueKey, function () {
      var notesPrefix = prop('NOTES_PREFIX', 'Comparto el resumen de nuestra última reunión:');
      addComment(issueKey, notesPrefix + '\n\n' + content.notes, false);
    });
  }

  if (content.transcript) {
    var trPrefix = prop('TRANSCRIPT_PREFIX', 'Transcripción completa de la reunión del ' + fecha + ':');
    var chunks = splitForJira(content.transcript, JIRA_MAX_COMMENT_CHARS - trPrefix.length - 200);

    chunks.forEach(function (chunk, i) {
      postOnce('done:' + docId + ':tr' + i, issueKey, function () {
        var header = chunks.length > 1
          ? trPrefix + ' (parte ' + (i + 1) + ' de ' + chunks.length + ')'
          : trPrefix;
        addComment(issueKey, header + '\n\n' + chunk, true);
      });
    });
  }
}

/** Ejecuta la publicación solo si esa marca todavía no existe. */
function postOnce(markKey, issueKey, publishFn) {
  if (PROPS.getProperty(markKey)) {
    Logger.log('Ya publicado antes, se omite: ' + markKey);
    return;
  }
  publishFn();
  PROPS.setProperty(markKey, issueKey + '@' + new Date().toISOString());
}

/**
 * Crea un comentario en Jira.
 * internal = true  -> nota interna (solo agentes)
 * internal = false -> respuesta visible para el cliente
 */
function addComment(issueKey, body, internal) {
  if (prop('DRY_RUN', 'false') === 'true') {
    Logger.log('[DRY_RUN] ' + issueKey + ' | interno=' + internal + '\n' + body.substring(0, 500));
    return;
  }

  var url = jiraBase() + '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/comment';

  var payload = {
    body: body,
    properties: [{ key: 'sd.public.comment', value: { internal: !!internal } }]
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Jira respondió ' + code + ' al comentar en ' + issueKey + ': '
                    + response.getContentText().substring(0, 500));
  }
}

function jiraBase() {
  return requiredProp('JIRA_BASE').replace(/\/+$/, '');
}

function jiraAuthHeader() {
  var credentials = requiredProp('JIRA_USER_EMAIL') + ':' + requiredProp('JIRA_API_TOKEN');
  return 'Basic ' + Utilities.base64Encode(credentials);
}

/** Divide un texto largo en bloques respetando los saltos de línea. */
function splitForJira(text, maxLen) {
  if (text.length <= maxLen) return [text];

  var chunks = [];
  var current = '';

  text.split('\n').forEach(function (line) {
    // Una sola línea gigantesca: se corta a la fuerza.
    while (line.length > maxLen) {
      if (current) { chunks.push(current); current = ''; }
      chunks.push(line.substring(0, maxLen));
      line = line.substring(maxLen);
    }
    if ((current + '\n' + line).length > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  });

  if (current) chunks.push(current);
  return chunks;
}

// ============================================================================
//  ESTADO / UTILIDADES
// ============================================================================

function alreadyProcessed(docId) {
  return !!PROPS.getProperty('done:' + docId);
}

function markProcessed(docId, issueKey) {
  PROPS.setProperty('done:' + docId, issueKey + '@' + new Date().toISOString());
}

function addLabel(thread, labelName) {
  var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
  thread.addLabel(label);
}

function prop(key, fallback) {
  var value = PROPS.getProperty(key);
  return (value === null || value === '') ? fallback : value;
}

function requiredProp(key) {
  var value = PROPS.getProperty(key);
  if (!value) throw new Error('Falta la propiedad del script: ' + key);
  return value;
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function repeatChar(char, times) {
  var out = '';
  for (var i = 0; i < times; i++) out += char;
  return out;
}

// ============================================================================
//  INSTALACIÓN Y PRUEBAS
// ============================================================================

/** Crea las etiquetas de Gmail y el trigger cada 15 minutos. */
function setup() {
  [LABEL_DONE, LABEL_PENDING, LABEL_ERROR].forEach(function (name) {
    if (!GmailApp.getUserLabelByName(name)) GmailApp.createLabel(name);
  });

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'processGeminiNotes') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('processGeminiNotes').timeBased().everyMinutes(15).create();
  Logger.log('Listo: etiquetas creadas y trigger activo cada 15 minutos.');
}

/** Verifica credenciales de Jira leyendo el usuario autenticado. */
function testJiraConnection() {
  var response = UrlFetchApp.fetch(jiraBase() + '/rest/api/2/myself', {
    headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
    muteHttpExceptions: true
  });
  Logger.log(response.getResponseCode() + ' -> ' + response.getContentText().substring(0, 300));
}

/**
 * Lee un documento concreto y muestra qué se publicaría, sin tocar Jira.
 * El ID es la parte de la URL entre /d/ y /edit:
 *   https://docs.google.com/document/d/<ESTE_ES_EL_ID>/edit
 */
function testDocument() {
  var docId = 'PEGA_AQUI_EL_ID_DE_TU_DOC_DE_GEMINI';

  var doc = DocumentApp.openById(docId);
  var meta = parseDocTitle(doc.getName(), new Date());
  var content = readTabs(doc);

  Logger.log('Reunión: ' + meta.meetingName);
  Logger.log('Ticket detectado: ' + resolveIssueKey(meta, content));
  Logger.log('--- NOTAS (' + content.notes.length + ' chars) ---\n' + content.notes);
  Logger.log('--- TRANSCRIPCIÓN (' + content.transcript.length + ' chars) ---\n'
             + content.transcript.substring(0, 2000));
}

/** Reprocesa un documento borrando todas sus marcas de "ya publicado". */
function resetDocument(docId) {
  var all = PROPS.getProperties();
  var removed = 0;
  Object.keys(all).forEach(function (key) {
    if (key === 'done:' + docId || key.indexOf('done:' + docId + ':') === 0) {
      PROPS.deleteProperty(key);
      removed++;
    }
  });
  Logger.log('Marcas eliminadas para ' + docId + ': ' + removed);
  Logger.log('Recuerda quitar la etiqueta del hilo en Gmail para que vuelva a entrar en la búsqueda.');
}
