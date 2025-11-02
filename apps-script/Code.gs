/************************************************************
 * Mini-App Telegram + Drive + Sheets (segura, sin exponer URLs)
 * - Hoja única: Club_DB (SHEET_ID) con pestañas:
 *   players | link_codes | files_log | sessions | clasificacion
 * - WebApp rutas:
 *   ?admin=1 (panel) | ?code=XXXX (jugador) | ?clas=1 (tabla)
 * - Seguridad:
 *   * chat sólo puede vincularse a un player 1 vez
 *   * playerId no puede re-vincularse a otro chat
 *   * sin mostrar enlaces; sólo botones (web_app / url)
 ************************************************************/

// =============== PROPS / CONFIG ===============
const PROPS = PropertiesService.getScriptProperties();
function prop(name, fb){ const v = PROPS.getProperty(name); return (v!==null && v!==undefined && v!=='') ? v : (fb||''); }

const BOT_TOKEN = prop('BOT_TOKEN');
const CHAT_ID   = prop('CHAT_ID');                  // opcional: avisos globales
let   SHEET_ID  = prop('SHEET_ID');                 // Club_DB
let   PARENT_FOLDER_ID = prop('PARENT_FOLDER_ID');  // Carpeta padre de jugadores en Drive

// =============== WRAPPERS PÚBLICOS ===============
function setParentFolderId(id){       return setParentFolderId_(id); }
function getParentFolderId(){         return getParentFolderId_(); }
function ensureAllPlayerFolders(){    return ensureAllPlayerFolders_(); }
function checkPlayerFolder(pid){      return checkPlayerFolder_(pid); }
function ensurePlayerFolder(pid){     return ensurePlayerFolder_(pid); }
function deletePlayerFolder(pid){     return deletePlayerFolder_(pid); }
function renamePlayerFolder(pid, n){  return renamePlayerFolder_(pid, n); }
function listPlayers(){               return listPlayers_(); }
function ensurePermanentCode(pid){    return ensurePermanentCode_(pid); }
function sendPlayerLink(chatId, pid){ return sendPlayerLink_(chatId, pid); }
function getDeepLinkForPlayer(playerId){ return getDeepLinkForPlayer_(playerId); }
function createLinkCode(playerId, ttlHours){ return createLinkCode_(playerId, ttlHours); }

// === Rate-limit por chat (evita spam de respuestas) ===
function _rlKey_(chatId, tag){ return 'rl:' + tag + ':' + String(chatId); }
function shouldSendToChat_(chatId, tag, windowSec){
  try {
    const cache = CacheService.getScriptCache();
    const key = _rlKey_(chatId, tag);
    if (cache.get(key)) return false;
    cache.put(key, '1', Math.max(1, Math.floor(windowSec)));
    return true;
  } catch(_){ return true; }
}

// Botón de pánico: durante X minutos no enviamos mensajes (por si hay bucle raro)
function panicStopSpam(minutes){
  const cache = CacheService.getScriptCache();
  cache.put('panic', '1', Math.max(60, (minutes||10)*60)); // mínimo 60s
  return {ok:true};
}
function panicOff(){ CacheService.getScriptCache().remove('panic'); return {ok:true}; }
function _panicOn_(){ return !!CacheService.getScriptCache().get('panic'); }


// =============== Webhook helpers (cómodo) ===============
function resetWebhookDrop(){
  mustToken_();
  const r1 = UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/deleteWebhook?drop_pending_updates=true');
  Utilities.sleep(400);
  const url = ScriptApp.getService().getUrl();
  const r2 = UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/setWebhook?url='+encodeURIComponent(url));
  return { deleteWebhook: r1.getContentText(), setWebhook: r2.getContentText(), url };
}
function getWebhookInfo(){
  mustToken_();
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/getWebhookInfo');
  return JSON.parse(r.getContentText());
}



// =============== TELEGRAM: helpers/botones ===============
const CB_ENVIAR_ACCESO = 'ENLACE'; // opcional si quieres un botón de confirmación

function sendInlineStartButton_(chatId, playerId){
  mustToken_();
  UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage', {
    method: 'post',
    payload: {
      chat_id: String(chatId),
      text: 'Pulsa el botón para vincularte y recibir tu acceso:',
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '📨 Enviar mi acceso', callback_data: CB_ENVIAR_ACCESO + '|' + playerId }
        ]]
      })
    },
    muteHttpExceptions: true
  });
}

// NO mostramos la URL: sólo botones
function sendAccessLinkToChat_(chatId, playerId){
  if (_panicOn_()) return {ok:false, message:'panic'};
  if (!shouldSendToChat_(chatId, 'access', 10)) return { ok:true, skipped:true }; // evita ráfagas
  try { ensurePlayerFolder_(playerId); } catch(_) {}
  const code = ensurePermanentCode_(playerId);
  const base = ScriptApp.getService().getUrl();
  const url  = base + '?code=' + encodeURIComponent(code) + '#code=' + encodeURIComponent(code);
  const clas = getClassificationUrl_();

  mustToken_();
  UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage', {
    method:'post',
    payload: {
      chat_id: String(chatId),
      text: 'Toca un botón para abrir tu acceso:',
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '📂 Abrir mi carpeta', web_app: { url: url } },
          { text: '📊 Clasificación', url: clas }
        ]]
      })
    },
    muteHttpExceptions: true
  });
  return { ok:true };
}



function sendHelperMenu_(chatId, isLinked, playerId){
  if (_panicOn_()) return;
  if (!shouldSendToChat_(chatId, 'menu', 10)) return; // máx 1 menú/10s por chat
  const rows = [];
  if (isLinked) rows.push([{ text:'📂 Abrir mi carpeta', callback_data:'OPEN|'+playerId }]);
  else rows.push([{ text:'📨 Vincularme', callback_data:'HELP|LINK' }]);
  rows.push([{ text:'📊 Clasificación', url: getClassificationUrl_() }]);

  mustToken_();
  UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage', {
    method:'post',
    payload:{
      chat_id:String(chatId),
      text: isLinked ? 'Opciones disponibles:' : 'Elige una opción:',
      reply_markup: JSON.stringify({ inline_keyboard: rows })
    },
    muteHttpExceptions:true
  });
}


function getClassificationUrl_(){ return ScriptApp.getService().getUrl() + '?clas=1'; }

function getBotUsername(){
  const cached = prop('BOT_USERNAME', '');
  if (cached) return { username: cached };
  mustToken_();
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/getMe', { method:'get', muteHttpExceptions:true });
  const json = JSON.parse(resp.getContentText());
  const username = (json && json.ok && json.result && json.result.username) ? json.result.username : '';
  if (username) PROPS.setProperty('BOT_USERNAME', username);
  return { username };
}
function getDeepLinkForPlayer_(playerId){
  if (!playerId) throw new Error('playerId vacío');
  let u = prop('BOT_USERNAME',''); if (!u) u = getBotUsername().username || '';
  if (!u) throw new Error('No pude obtener BOT_USERNAME');
  return { link: 'https://t.me/' + u + '?start=' + encodeURIComponent(playerId) };
}


function _alreadyProcessed_(updateId){
  try {
    const cache = CacheService.getScriptCache();
    const key = 'upd:' + String(updateId);
    if (cache.get(key)) return true;
    cache.put(key, '1', 600); // 10 minutos
    return false;
  } catch(_){ return false; }
}
function _getUpdateId_(update){
  // Telegram siempre manda update_id a primer nivel
  return (update && typeof update.update_id !== 'undefined') ? String(update.update_id) : '';
}


// =============== WEBHOOK: SIEMPRE 200 OK ===============
function doPost(e){
  try {
    if (e && e.postData && e.postData.contents) {
      const upd = JSON.parse(e.postData.contents || '{}');
      const uid = _getUpdateId_(upd);
      if (!uid || !_alreadyProcessed_(uid)) {
        handleUpdate_(upd);
      }
    }
  } catch (err){
    console.error('doPost error:', err && err.stack ? err.stack : err);
  }
  // MUY IMPORTANTE: responder SIEMPRE 200 para que TG no reintente
  return ContentService.createTextOutput('OK');
}


function handleUpdate_(update){
  // CALLBACKS
  if (update.callback_query){
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const data = String(cq.data || '');
    try {
      mustToken_();
      UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/answerCallbackQuery', {
        method:'post',
        payload:{ callback_query_id: cq.id, text: 'OK', show_alert:false },
        muteHttpExceptions:true
      });
    } catch(_){}

    if (data.startsWith('OPEN|')) {
      const pid = data.split('|')[1];
      sendAccessLinkToChat_(chatId, pid);
      return;
    }
    if (data === 'HELP|LINK') {
      sendText_(chatId, 'Pide a tu entrenador tu enlace de vinculación.');
      return;
    }
    if (data.startsWith(CB_ENVIAR_ACCESO + '|')){
      const playerId = data.split('|')[1];
      try {
        upsertTelegramLink_(playerId, chatId, true);
        sendText_(chatId, '✅ Vinculado: ' + playerId);
        sendAccessLinkToChat_(chatId, playerId);
      } catch (err){
        sendText_(chatId, '⚠️ Código en uso o inválido.');
      }
    }
    return;
  }

  // MENSAJES
  const msg = update.message; if (!msg) return;
  const chatId = msg.chat && msg.chat.id;
  const textRaw = (msg.text || '').trim();

  // /start y /start <payload>
const m = textRaw.match(/^\/start(?:\s+(.+))?$/i);
if (m) {
  const payload = (m[1] || '').trim();
  if (payload) {
    // Si ponen /start p10 (o vienes de un deep-link con payload = playerId)
    if (!isValidPlayerId_(payload)) { sendText_(chatId, '⚠️ Código no válido.'); return; }
    try {
      const already = findPlayerByTelegramId_(chatId);
      // Si ya estaba vinculado a otro player → reenvía el suyo (sin re-vincular)
      sendAccessLinkToChat_(chatId, already.playerId);
    } catch(_){
      try {
        upsertTelegramLink_(payload, chatId, true); // guarda telegramId + carpeta
        ensurePermanentCode_(payload);              // crea code si faltaba
        sendText_(chatId, '✅ Vinculado: ' + payload);
        sendAccessLinkToChat_(chatId, payload);
      } catch (err) {
        sendText_(chatId, '⚠️ Ese código no existe o ya está en uso.');
      }
    }
    return;
  }
  // /start sin payload
  try {
    const player = findPlayerByTelegramId_(chatId);
    sendAccessLinkToChat_(chatId, player.playerId);
  } catch(_){
    sendHelperMenu_(chatId, false, '');
  }
  return;
}

// Código p01/gk01 escrito a pelo
if (isValidPlayerId_(textRaw)) {
  try {
    const already = findPlayerByTelegramId_(chatId);
    sendAccessLinkToChat_(chatId, already.playerId);
  } catch(_){
    try {
      upsertTelegramLink_(textRaw, chatId, true);
      ensurePermanentCode_(textRaw);
      sendText_(chatId, '✅ Vinculado: ' + textRaw);
      sendAccessLinkToChat_(chatId, textRaw);
    } catch(e2){
      sendText_(chatId, '⚠️ Ese código no es válido o ya está en uso.');
    }
  }
  return;
}

    try {
      const player = findPlayerByTelegramId_(chatId);
      sendAccessLinkToChat_(chatId, player.playerId);
    } catch(_){
      sendHelperMenu_(chatId, false, '');
    }
    return;
  }

  // /carpeta → sólo vinculados
  if (textRaw === '/carpeta' || textRaw.startsWith('/carpeta@')) {
    try { const player = findPlayerByTelegramId_(chatId); sendAccessLinkToChat_(chatId, player.playerId); }
    catch(e3){ sendText_(chatId, '⚠️ No estás vinculado.'); }
    return;
  }

  // /ayuda
  if (textRaw === '/ayuda' || textRaw.startsWith('/ayuda@')) {
    let pid='', linked=false; try { pid = findPlayerByTelegramId_(chatId).playerId; linked=true; } catch(_){}
    sendHelperMenu_(chatId, linked, pid); return;
  }

  // Escribe p01/gk01 → sólo si NO está vinculado
  if (isValidPlayerId_(textRaw)) {
    try { const linked = findPlayerByTelegramId_(chatId); sendAccessLinkToChat_(chatId, linked.playerId); }
    catch(_){
      try { upsertTelegramLink_(textRaw, chatId, true); sendText_(chatId,'✅ Vinculado: '+textRaw); sendAccessLinkToChat_(chatId, textRaw); }
      catch(e2){ sendText_(chatId, '⚠️ Ese código no es válido o ya está en uso.'); }
    }
    return;
  }

  sendText_(chatId, 'Escribe /ayuda');
}

// =============== Validaciones / Telegram base ===============
function isValidPlayerId_(s){ return /^[a-z]{1,3}\d{2}$/i.test(String(s||'')); }

function assignTelegramIdToPlayer_(playerId, chatId){
  const sh = sh_('players');
  const values = sh.getDataRange().getValues();
  const hdr = values[0];
  const cPid = idx_(hdr,'playerId');
  let cTg  = hdr.indexOf('telegramId');
  if (cTg < 0) { cTg = hdr.length; sh.getRange(1, cTg+1).setValue('telegramId'); }

  // chat ya vinculado a otro player → bloquear
  for (let r = 1; r < values.length; r++){
    if (String(values[r][cTg]||'') === String(chatId) && values[r][cPid] !== playerId){
      throw new Error('Este chat ya está vinculado a otro jugador');
    }
  }
  // player ya vinculado a otro chat → bloquear
  for (let r = 1; r < values.length; r++){
    if (values[r][cPid] === playerId){
      const current = String(values[r][cTg]||'');
      if (current && current !== String(chatId)) throw new Error('Este jugador ya está vinculado a otro chat');
      sh.getRange(r+1, cTg+1).setValue(String(chatId));
      return true;
    }
  }
  throw new Error('playerId no encontrado');
}

function findPlayerByTelegramId_(tgId) {
  const rows = listPlayers_();
  const p = rows.find(p => String(p.telegramId) === String(tgId));
  if (!p) throw new Error('Jugador no vinculado');
  return p;
}

function sendText_(chatId, text) {
  if (!BOT_TOKEN || _panicOn_()) return;
  if (!shouldSendToChat_(chatId, 'txt', 5)) return; // máx 1 texto/5s por chat
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method:'post', payload: { chat_id: String(chatId), text }, muteHttpExceptions: true
    });
  } catch (_){}
}

function mustToken_(){ if (!BOT_TOKEN) throw new Error('Falta BOT_TOKEN'); }

// =============== SETUP SHEETS ===============
function setupSheets() {
  let ss = null;
  if (SHEET_ID) { try { ss = SpreadsheetApp.openById(SHEET_ID); } catch(e) {} }
  if (!ss) { ss = SpreadsheetApp.create('Club_DB'); SHEET_ID = ss.getId(); PROPS.setProperty('SHEET_ID', SHEET_ID); }
  ensureClubDBStructure_(); ensureClasificacionTab_();
  return { clubDb: SHEET_ID, parentFolderId: PARENT_FOLDER_ID || '' };
}
function ensureClubDBStructure_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const need = ['players','link_codes','files_log','sessions'];
  need.forEach(name => { if (!ss.getSheetByName(name)) ss.insertSheet(name); });
  setHeadersIfEmpty_(ss.getSheetByName('players'),     ['playerId','name','telegramId','driveFolderId','role','code']);
  setHeadersIfEmpty_(ss.getSheetByName('link_codes'),  ['code','playerId','expiresAt(ISO)']);
  setHeadersIfEmpty_(ss.getSheetByName('files_log'),   ['ts(ISO)','playerId','fileId','caption','token','urlIssuedAt(ISO)','status']);
  setHeadersIfEmpty_(ss.getSheetByName('sessions'),    ['sessionToken','playerId','expiresAt(ISO)','lastSeen(ISO)','userAgent']);
}
function ensureClasificacionTab_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName('clasificacion'); if (!sh) sh = ss.insertSheet('clasificacion');
  setHeadersIfEmpty_(sh, ['posicion','equipo','puntos','jugados','ganados','empatados','perdidos','racha','sancion']);
}
function setHeadersIfEmpty_(sh, headers) {
  const lastCol = Math.max(headers.length, sh.getLastColumn() || 1);
  const current = sh.getRange(1,1,1,lastCol).getValues()[0];
  const hasAny = current.some(v => v && String(v).trim()!=='');
  if (!hasAny) { sh.getRange(1,1,1,headers.length).setValues([headers]); return; }
  const needToAdd = headers.filter(h => current.indexOf(h) === -1);
  if (needToAdd.length) {
    const start = (current.filter(Boolean).length || current.length) + 1;
    sh.getRange(1, start, 1, needToAdd.length).setValues([needToAdd]);
  }
}

// =============== SHEETS HELPERS ===============
function sh_(name){ return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name); }
function idx_(hdr, name){ const i = hdr.indexOf(name); if (i<0) throw new Error('Falta columna: '+name); return i; }

function getPlayerRowById_(playerId){
  const sh = sh_('players'), values = sh.getDataRange().getValues(), hdr = values[0];
  const cPid  = idx_(hdr,'playerId'), cName = idx_(hdr,'name');
  const cTg   = hdr.indexOf('telegramId'), cFold = idx_(hdr,'driveFolderId');
  const cRole = hdr.indexOf('role'), cCode = idx_(hdr,'code');
  for (let r=1;r<values.length;r++){
    if (values[r][cPid] === playerId){
      return {
        row: r+1, playerId, name: values[r][cName],
        telegramId: cTg>=0 ? values[r][cTg] : '', driveFolderId: values[r][cFold],
        role: cRole>=0 ? values[r][cRole] : '', code: cCode>=0 ? values[r][cCode] : ''
      };
    }
  }
  throw new Error('playerId no encontrado: '+playerId);
}
function listPlayers_(){
  const sh = sh_('players'), values = sh.getDataRange().getValues(), hdr = values[0]; const out = [];
  const cPid = idx_(hdr,'playerId'), cName = idx_(hdr,'name');
  const cTg  = hdr.indexOf('telegramId'), cFold = idx_(hdr,'driveFolderId');
  const cRole= hdr.indexOf('role'), cCode = idx_(hdr,'code');
  for (let r=1;r<values.length;r++){
    const row = values[r]; if (!row[cPid]) continue;
    out.push({
      playerId: row[cPid], name: row[cName],
      telegramId: cTg>=0 ? row[cTg] : '', driveFolderId: row[cFold],
      role: cRole>=0 ? row[cRole] : '', code: cCode>=0 ? row[cCode] : ''
    });
  }
  return out;
}

// =============== DRIVE / CARPETAS ===============
function setParentFolderId_(id){
  if (!id) { PROPS.deleteProperty('PARENT_FOLDER_ID'); PARENT_FOLDER_ID=''; return {ok:true, parentFolderId:'', message:'PARENT_FOLDER_ID eliminado'}; }
  DriveApp.getFolderById(id);
  PROPS.setProperty('PARENT_FOLDER_ID', id); PARENT_FOLDER_ID = id;
  return {ok:true, parentFolderId:id, message:'PARENT_FOLDER_ID guardado'};
}
function getParentFolderId_(){ return { parentFolderId: PARENT_FOLDER_ID || '' }; }

function playerFolderName_(player){ const name = (player.name || '').toString().trim() || player.playerId; return `${player.playerId} - ${name}`; }
function findChildFolderByName_(parent, name){ const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : null; }
function findChildFolderByPrefix_(parent, prefix){
  const it = parent.getFolders(); while (it.hasNext()){ const f = it.next(); if ((f.getName() || '').startsWith(prefix)) return f; } return null;
}

function checkPlayerFolder_(playerId){
  if (!PARENT_FOLDER_ID) throw new Error('Configura primero PARENT_FOLDER_ID en Admin.');
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const p = getPlayerRowById_(playerId);
  const expected = playerFolderName_(p);
  let existing = null;
  if (p.driveFolderId) { try { existing = DriveApp.getFolderById(p.driveFolderId); } catch (_) { existing = null; } }
  if (!existing) existing = findChildFolderByName_(parent, expected);
  if (!existing) existing = findChildFolderByPrefix_(parent, `${p.playerId} - `);
  return { exists: !!existing, folderId: existing ? existing.getId() : '', expectedName: expected, currentName: existing ? existing.getName() : '' };
}

function ensurePlayerFolder_(playerId){
  if (!PARENT_FOLDER_ID) throw new Error('Configura primero PARENT_FOLDER_ID en Admin.');
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const p = getPlayerRowById_(playerId);
  const expected = playerFolderName_(p);
  let folder = null;
  if (p.driveFolderId) { try { folder = DriveApp.getFolderById(p.driveFolderId); } catch (_) { folder = null; } }
  if (!folder) folder = findChildFolderByName_(parent, expected);
  if (!folder) folder = findChildFolderByPrefix_(parent, `${p.playerId} - `);
  if (!folder) folder = parent.createFolder(expected);

  const sh = sh_('players'); const hdr = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  let cFold = hdr.indexOf('driveFolderId'); if (cFold < 0) { cFold = hdr.length; sh.getRange(1, cFold+1).setValue('driveFolderId'); }
  sh.getRange(p.row, cFold+1).setValue(folder.getId());
  return { ok:true, folderId: folder.getId(), name: folder.getName(), expectedName: expected, playerId: p.playerId, created: folder.getName()===expected };
}

function deletePlayerFolder_(playerId){
  if (!PARENT_FOLDER_ID) throw new Error('Configura primero PARENT_FOLDER_ID en Admin.');
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const p = getPlayerRowById_(playerId);
  const expected = playerFolderName_(p);

  let folder = null;
  if (p.driveFolderId) { try { folder = DriveApp.getFolderById(p.driveFolderId); } catch(_){} }
  if (!folder) folder = findChildFolderByName_(parent, expected);
  if (!folder) folder = findChildFolderByPrefix_(parent, `${p.playerId} - `);
  if (!folder) return { ok:false, message:'No existe carpeta para este jugador.' };

  folder.setTrashed(true);

  const sh = sh_('players'); const hdr = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const cFold = hdr.indexOf('driveFolderId');
  if (cFold >= 0) {
    const currentId = sh.getRange(p.row, cFold+1).getValue();
    if (currentId === folder.getId()) sh.getRange(p.row, cFold+1).setValue('');
  }
  return { ok:true, folderId: folder.getId(), trashed:true, name: folder.getName() };
}

function renamePlayerFolder_(playerId, newName){
  if (!PARENT_FOLDER_ID) throw new Error('Configura primero PARENT_FOLDER_ID en Admin.');
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const p = getPlayerRowById_(playerId);
  const expected = playerFolderName_(p);
  const finalName = (newName && newName.trim()) ? newName.trim() : expected;

  let folder = null;
  if (p.driveFolderId) { try { folder = DriveApp.getFolderById(p.driveFolderId); } catch(_){} }
  if (!folder) folder = findChildFolderByName_(parent, expected);
  if (!folder) folder = findChildFolderByPrefix_(parent, `${p.playerId} - `);
  if (!folder) return { ok:false, message:'No existe carpeta para renombrar.' };

  folder.setName(finalName);
  return { ok:true, folderId: folder.getId(), newName: finalName, playerId: p.playerId };
}

// =============== CÓDIGOS / SESIONES ===============
function ensurePermanentCode_(playerId){
  const sh = sh_('players');
  const rng = sh.getDataRange(); const values = rng.getValues(); const hdr = values[0];
  let cCode = hdr.indexOf('code'); if (cCode<0){ sh.getRange(1, hdr.length+1).setValue('code'); cCode = hdr.length; }
  const cPid = idx_(hdr,'playerId');
  for (let r=1;r<values.length;r++){
    if (values[r][cPid] === playerId){
      if (!values[r][cCode]){
        const code = Utilities.getUuid().replace(/-/g,'').slice(0,24);
        sh.getRange(r+1, cCode+1).setValue(code);
        return code;
      }
      return values[r][cCode];
    }
  }
  throw new Error('playerId no encontrado: '+playerId);
}
function getPlayerByCode_(code){
  const sh = sh_('players'), values = sh.getDataRange().getValues(), hdr = values[0];
  const cCode = idx_(hdr,'code'), cPid = idx_(hdr,'playerId');
  const cName = idx_(hdr,'name'), cFold = idx_(hdr,'driveFolderId');
  for (let r=1;r<values.length;r++){
    if (values[r][cCode] === code){
      return { playerId: values[r][cPid], name: values[r][cName], driveFolderId: values[r][cFold] };
    }
  }
  return null;
}
function sessionsSheet_(){ return sh_('sessions'); }
function sessions_create_(playerId, ttlDays, userAgent){
  const sh = sessionsSheet_();
  const token = Utilities.getUuid().replace(/-/g,'');
  const now = new Date();
  const exp = new Date(now.getTime() + (Number(ttlDays||90)*24*60*60*1000));
  sh.appendRow([token, playerId, exp.toISOString(), now.toISOString(), userAgent || '']);
  return { sessionToken: token, expiresAt: exp.toISOString() };
}
function sessions_touch_(sessionToken, extendDaysIfClose){
  const sh = sessionsSheet_(), values = sh.getDataRange().getValues(), hdr = values[0];
  const cTok = idx_(hdr,'sessionToken'), cPid = idx_(hdr,'playerId');
  const cExp = idx_(hdr,'expiresAt(ISO)'), cSeen = idx_(hdr,'lastSeen(ISO)');
  const nowIso = new Date().toISOString();
  for (let r=1;r<values.length;r++){
    if (values[r][cTok] === sessionToken){
      const expMs = Date.parse(values[r][cExp]||'');
      if (extendDaysIfClose && expMs && (expMs - Date.now()) < (7*24*60*60*1000)) {
        const newExp = new Date(Date.now() + extendDaysIfClose*24*60*60*1000).toISOString();
        sh.getRange(r+1, cExp+1).setValue(newExp);
      }
      sh.getRange(r+1, cSeen+1).setValue(nowIso);
      return { playerId: values[r][cPid] };
    }
  }
  throw new Error('Sesión inválida/expirada');
}

// Códigos de un solo uso (opcional)
function createLinkCode_(playerId, ttlHours){
  const sh = sh_('link_codes');
  const code = Utilities.getUuid().replace(/-/g,'').slice(0,16);
  const exp = new Date(Date.now() + (Number(ttlHours||24)*60*60*1000)).toISOString();
  sh.appendRow([code, playerId, exp]);
  return { code, playerId, expiresAt: exp };
}
function consumeLinkCode_(code){
  const sh = sh_('link_codes'), values = sh.getDataRange().getValues(), hdr = values[0];
  const cCode = idx_(hdr,'code'), cPid = idx_(hdr,'playerId'), cExp = idx_(hdr,'expiresAt(ISO)');
  for (let r=1; r<values.length; r++){
    if (values[r][cCode] === code){
      const expMs = Date.parse(values[r][cExp]||'');
      if (!expMs || expMs < Date.now()) throw new Error('Código caducado');
      const pid = values[r][cPid];
      sh.deleteRow(r+1);
      return pid;
    }
  }
  throw new Error('Código no válido');
}

// =============== ENDPOINTS PLAYER ===============
function player_exchangeCode(code, userAgent){
  const p = getPlayerByCode_(code);
  if (!p) throw new Error('Código inválido');
  if (!p.driveFolderId) throw new Error('Jugador sin driveFolderId');
  const sess = sessions_create_(p.playerId, 90, userAgent);
  const files = listPlayerFiles_(p.driveFolderId);
  return { sessionToken: sess.sessionToken, expiresAt: sess.expiresAt, player: { playerId:p.playerId, name:p.name, folderId:p.driveFolderId }, files };
}
function player_contextBySession(sessionToken){
  const { playerId } = sessions_touch_(sessionToken, 90);
  const p = getPlayerRowById_(playerId);
  const files = listPlayerFiles_(p.driveFolderId);
  return { player: { playerId:p.playerId, name:p.name, folderId:p.driveFolderId }, files };
}
function player_uploadBySession(sessionToken, fileMeta){
  const { playerId } = sessions_touch_(sessionToken, 90);
  const p = getPlayerRowById_(playerId);
  const bytes = Utilities.base64Decode(fileMeta.base64);
  const blob  = Utilities.newBlob(bytes, fileMeta.mimeType || MimeType.BINARY, fileMeta.name || 'archivo');
  const file  = DriveApp.getFolderById(p.driveFolderId).createFile(blob);
  appendFilesLog_({ playerId, fileId:file.getId(), caption:fileMeta.caption||'', status:'UPLOADED' });
  try {
    if (BOT_TOKEN && CHAT_ID){
      UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage', {
        method:'post', payload: { chat_id: CHAT_ID, text: '📥 ' + (p.name||playerId) + ' subió: ' + file.getName() }, muteHttpExceptions: true
      });
    }
  } catch (_){}
  return { ok:true, fileId:file.getId(), name:file.getName() };
}

// =============== ADMIN (opcional) ===============
function sendPlayerLink_(chatId, playerId){
  const code = ensurePermanentCode_(playerId);
  const url  = ScriptApp.getService().getUrl() + '?code=' + encodeURIComponent(code);
  const msg  = 'Acceso a tu carpeta (sesión larga). Usa el botón del mensaje anterior.';
  if (!BOT_TOKEN && chatId) throw new Error('BOT_TOKEN no configurado');
  if (chatId) {
    UrlFetchApp.fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendMessage', {
      method:'post', payload:{ chat_id: String(chatId), text: msg }, muteHttpExceptions:true
    });
  }
  return {ok:true, url};
}

// =============== WEBAPP ROUTER ===============
function doGet(e){
  const p = e && e.parameter || {};
  if (p.code)        return HtmlService.createHtmlOutputFromFile('Player').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  if (p.admin==='1') return HtmlService.createHtmlOutputFromFile('Admin').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  if (p.clas==='1')  return HtmlService.createHtmlOutput(renderClasificacionHtml_()).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  const h = '<!doctype html><meta charset="utf-8"><title>Mini App</title><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:system-ui;padding:16px">Usa <code>?admin=1</code>, <code>?clas=1</code> o abre desde el bot.</p>';
  return HtmlService.createHtmlOutput(h).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function renderClasificacionHtml_(){
  const sh = sh_('clasificacion'); const data = sh.getDataRange().getValues(); const hdr = data.shift();
  const thead = '<tr>'+hdr.map(h=>`<th>${String(h||'')}</th>`).join('')+'</tr>';
  const rows  = data.map(r=>'<tr>'+r.map(c=>`<td>${String(c||'')}</td>`).join('')+'</tr>').join('');
  const html  = `
  <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Clasificación</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;padding:12px}
    h1{font-size:18px;margin:0 0 12px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #eee;padding:6px;font-size:14px;text-align:left}
    th{background:#fafafa}
  </style>
  <h1>Clasificación</h1>
  <table>${thead}${rows}</table>`;
  return html;
}

// =============== LOTE CARPETAS ===============
function ensureAllPlayerFolders_(){
  if (!PARENT_FOLDER_ID) throw new Error('Configura primero PARENT_FOLDER_ID en Admin.');
  const parent = DriveApp.getFolderById(PARENT_FOLDER_ID);
  const players = listPlayers_();
  let created = 0, linked = 0;
  const sh = sh_('players'); const hdr = sh.getRange(1,1,1,Math.max(1, sh.getLastColumn())).getValues()[0];
  let cFold = hdr.indexOf('driveFolderId'); if (cFold < 0) { cFold = hdr.length; sh.getRange(1, cFold+1).setValue('driveFolderId'); }
  const values = sh.getDataRange().getValues(); const cPid = hdr.indexOf('playerId');

  players.forEach(p=>{
    const expected = playerFolderName_(p); let folder = null;
    if (p.driveFolderId) { try { folder = DriveApp.getFolderById(p.driveFolderId); } catch(_){} }
    if (!folder) folder = findChildFolderByName_(parent, expected);
    if (!folder) folder = findChildFolderByPrefix_(parent, `${p.playerId} - `);
    if (!folder) { folder = parent.createFolder(expected); created++; } else { linked++; }
    for (let i=1;i<values.length;i++){ if (values[i][cPid] === p.playerId) { sh.getRange(i+1, cFold+1).setValue(folder.getId()); break; } }
  });
  return { ok:true, total: players.length, created, linked, parentFolderId: PARENT_FOLDER_ID };
}



