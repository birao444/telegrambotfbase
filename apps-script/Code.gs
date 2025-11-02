// ======== CONFIG ========
// Prefer Script Properties. Constants serve only as fallbacks.
// Script Properties supported (set in Editor → Project Settings → Script Properties):
// - BOT_TOKEN: Telegram bot token
// - CHAT_ID: default Telegram chat ID
// - SHEET_ID: Spreadsheet ID for "files_log" sheet
// - ADMIN_EMAILS: comma-separated list of admin emails (optional)
// - PICKER_API_KEY, PICKER_CLIENT_ID, PICKER_APP_ID: Google Picker credentials (optional)
// - Other props you may already have (APP_SECRET, LAST_UPDATE_ID, SHEET_ID_CLASIFICACION, WEB_APP_URL) are ignored here.

const TELEGRAM_BOT_TOKEN = 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE';
const DEFAULT_TELEGRAM_CHAT_ID = 'PUT_DEFAULT_CHAT_ID_HERE';
const FILES_LOG_SPREADSHEET_ID = 'PUT_SPREADSHEET_ID_FOR_files_log_HERE';

// Admin control: only these emails see/operate the admin panel (fallback if ADMIN_EMAILS property is missing)
const ADMIN_EMAILS = [ 'admin1@club.com', 'admin2@club.com' ];

// Google Picker fallback values (prefer properties)
const PICKER_API_KEY = 'PUT_GOOGLE_PICKER_API_KEY_HERE';
const PICKER_CLIENT_ID = 'PUT_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com';
const PICKER_APP_ID = 'PUT_GCP_PROJECT_NUMBER_OR_APP_ID_HERE';

const SP_ = PropertiesService.getScriptProperties();

function prop_(key, fallback) {
  const v = SP_.getProperty(key);
  return (v !== null && v !== undefined && v !== '') ? v : fallback;
}

function cfg_() {
  const adminsStr = prop_('ADMIN_EMAILS', '').trim();
  const admins = adminsStr ? adminsStr.split(/[,;\s]+/).filter(Boolean) : ADMIN_EMAILS;
  return {
    botToken: prop_('BOT_TOKEN', TELEGRAM_BOT_TOKEN),
    defaultChatId: prop_('CHAT_ID', DEFAULT_TELEGRAM_CHAT_ID),
    sheetId: prop_('SHEET_ID', FILES_LOG_SPREADSHEET_ID),
    pickerApiKey: prop_('PICKER_API_KEY', PICKER_API_KEY),
    pickerClientId: prop_('PICKER_CLIENT_ID', PICKER_CLIENT_ID),
    pickerAppId: prop_('PICKER_APP_ID', PICKER_APP_ID),
    admins: admins,
  };
}

// ======== WEB APP ENTRYPOINTS ========
function doGet(e) {
  if (!isAdmin_()) {
    return HtmlService.createHtmlOutput('No autorizado. Pide acceso al entrenador.');
  }
  const tpl = HtmlService.createTemplateFromFile('index');
  return tpl.evaluate()
    .setTitle('Panel Admin · Google Picker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Optional external integration: accept JSON payloads to trigger send/log
// Body JSON example: { fileId, caption, chatId }
function doPost(e) {
  try {
    const contentType = (e.postData && e.postData.type) || '';
    if (contentType.indexOf('application/json') !== -1) {
      const body = JSON.parse(e.postData.contents || '{}');
      return ContentService.createTextOutput(JSON.stringify(handleSelection_(body)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // Basic form-data support (caption, chatId, fileId)
    const params = e.parameter || {};
    const payload = {
      fileId: params.fileId,
      caption: params.caption,
      chatId: params.chatId,
    };
    return ContentService.createTextOutput(JSON.stringify(handleSelection_(payload)))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ======== SERVER METHODS CALLED FROM CLIENT ========
function getConfig() {
  if (!isAdmin_()) throw new Error('No autorizado');
  const c = cfg_();
  const isUnset = function (v) {
    return !v || /^PUT_/i.test(String(v));
  };
  const missingPicker = [];
  if (isUnset(c.pickerApiKey)) missingPicker.push('PICKER_API_KEY');
  if (isUnset(c.pickerClientId)) missingPicker.push('PICKER_CLIENT_ID');
  if (isUnset(c.pickerAppId)) missingPicker.push('PICKER_APP_ID');
  return {
    pickerApiKey: c.pickerApiKey,
    pickerClientId: c.pickerClientId,
    pickerAppId: c.pickerAppId,
    defaultChatId: c.defaultChatId,
    pickerReady: missingPicker.length === 0,
    missingPicker: missingPicker,
  };
}

function getOAuthToken() {
  if (!isAdmin_()) throw new Error('No autorizado');
  return ScriptApp.getOAuthToken();
}

// Invoked by client after Picker selection
// payload: { fileId, name?, mimeType?, url?, caption?, chatId? }
function handleSelection_(payload) {
  if (!payload || !payload.fileId) throw new Error('fileId requerido');
  // If called from client UI, enforce admin. doPost may be used backend-to-backend.
  // For safety, we also enforce admin if there is a current user.
  if (Session.getActiveUser().getEmail()) {
    if (!isAdmin_()) throw new Error('No autorizado');
  }

  const fileId = payload.fileId;
  const caption = payload.caption || '';
  const chatId = payload.chatId || cfg_().defaultChatId;

  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob().setName(file.getName());

  const tg = sendToTelegramDocument_(blob, caption, chatId);
  const actor = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || 'system';
  const logRes = logFileAction_({
    actor,
    action: 'post_document',
    fileId,
    name: file.getName(),
    mimeType: blob.getContentType(),
    chatId,
    caption,
    telegramMessageId: (tg && tg.result && tg.result.message_id) || '',
  });

  return { ok: true, telegram: tg, log: logRes };
}

// ======== HELPERS ========
function isAdmin_() {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) return false; // For consumer accounts, may be empty unless domain/GWA; enforce deny.
    const admins = cfg_().admins || [];
    return admins.indexOf(email) !== -1;
  } catch (e) {
    return false;
  }
}

function sendToTelegramDocument_(blob, caption, chatId) {
  const token = cfg_().botToken;
  if (!token || /^PUT_/i.test(token)) {
    throw new Error('Configura BOT_TOKEN en Script Properties o TELEGRAM_BOT_TOKEN');
  }
  const url = 'https://api.telegram.org/bot' + token + '/sendDocument';
  const payload = {
    chat_id: String(chatId || ''),
    caption: caption || '',
    document: blob,
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Telegram error ' + code + ': ' + text);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return { ok: false, raw: text };
  }
}

function getOrCreateSheet_(ssId, sheetName) {
  const ss = SpreadsheetApp.openById(ssId);
  let sh = ss.getSheetByName(sheetName);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.appendRow([
      'timestamp', 'actorEmail', 'action', 'fileId', 'name', 'mimeType', 'chatId', 'telegramMessageId', 'caption'
    ]);
  }
  return sh;
}

function logFileAction_(entry) {
  const sheetId = cfg_().sheetId;
  if (!sheetId || /^PUT_/i.test(sheetId)) {
    throw new Error('Configura SHEET_ID en Script Properties o FILES_LOG_SPREADSHEET_ID');
  }
  const sh = getOrCreateSheet_(sheetId, 'files_log');
  const row = [
    new Date(),
    entry.actor || '',
    entry.action || '',
    entry.fileId || '',
    entry.name || '',
    entry.mimeType || '',
    entry.chatId || '',
    entry.telegramMessageId || '',
    entry.caption || '',
  ];
  sh.appendRow(row);
  return { ok: true };
}

// Utility for HTML templating includes if needed
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
