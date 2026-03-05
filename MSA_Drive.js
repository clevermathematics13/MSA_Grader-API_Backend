/*************
 * MSA_Drive.gs
 *************/

function msaGetParentFolder_() {
  if (!MSA_PARENT_FOLDER_ID) {
    throw new Error("MSA_PARENT_FOLDER_ID is blank. Set it in MSA_Config.gs");
  }
  return DriveApp.getFolderById(MSA_PARENT_FOLDER_ID);
}

function msaGetOrCreateChildFolder_(parentFolder, name) {
  const it = parentFolder.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parentFolder.createFolder(name);
}

function msaUpsertTextFile_(folder, filename, text) {
  const files = folder.getFilesByName(filename);
  let file;
  if (files.hasNext()) {
    file = files.next();
    file.setContent(text);
    return file;
  }
  return folder.createFile(filename, text, MimeType.PLAIN_TEXT);
}

function msaUpsertJsonFile_(folder, filename, obj) {
  return msaUpsertTextFile_(folder, filename, JSON.stringify(obj, null, 2));
}

function msaReadJsonFileIfExists_(folder, filename) {
  const files = folder.getFilesByName(filename);
  if (!files.hasNext()) return null;
  const file = files.next();
  try {
    return JSON.parse(file.getBlob().getDataAsString());
  } catch (e) {
    msaWarn_("Could not parse JSON from " + filename + ": " + e.message);
    return null;
  }
}

function msaMoveFileToFolder_(fileId, folder) {
  const file = DriveApp.getFileById(fileId);
  folder.addFile(file);

  // Optional: remove from root if it's there (avoid clutter)
  try {
    DriveApp.getRootFolder().removeFile(file);
  } catch (e) {
    // Non-fatal; file might not be in root
  }
  return file;
}

function msaEnsureFolderPath_(parentFolder, pathParts) {
  let cur = parentFolder;
  (pathParts || []).forEach(function (p) {
    cur = msaGetOrCreateChildFolder_(cur, p);
  });
  return cur;
}

/**
 * Central logging helpers so we never crash on missing log functions.
 * Use these everywhere (msaLog_, msaWarn_, msaErr_).
 *
 * When a log session is active (via startLogSession_ / setLogSession_),
 * log messages are also buffered to CacheService so the client can
 * poll getServerLogs() and display them in real time.
 */

/** @type {string|null} Active log-session key (null = no streaming) */
var currentLogSessionKey_ = null;
/** @type {number} Auto-incrementing sequence counter for dedup */
var logSeq_ = 0;
/** @type {number} Epoch ms when setLogSession_ was called (for relative timing) */
var logT0_ = 0;

/**
 * Create a new server-side log session. Returns the session ID.
 * Call this from the client BEFORE starting a long-running function,
 * then pass the sessionId into the function's options.
 */
function startLogSession() {
  var id = Utilities.getUuid();
  // Seed the cache entry so getServerLogs doesn't 404
  CacheService.getScriptCache().put('slog_' + id, JSON.stringify([]), 600); // 10 min TTL
  return id;
}

/**
 * Activate streaming for this execution context.
 * Called at the top of long-running server functions.
 */
function setLogSession_(sessionId) {
  currentLogSessionKey_ = sessionId ? ('slog_' + sessionId) : null;
  logSeq_ = 0;
  logT0_ = Date.now();
}

/**
 * Append a single message to the CacheService log buffer.
 * Each entry gets an auto-incrementing `seq` for client-side dedup
 * and a `dt` (ms since session start) for precise timing.
 * Keeps only the last 200 entries and stays under 100 KB.
 */
function appendToLogSession_(level, msg) {
  if (!currentLogSessionKey_) return;
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get(currentLogSessionKey_);
    var arr = raw ? JSON.parse(raw) : [];
    arr.push({
      seq: logSeq_++,
      dt: Date.now() - logT0_,
      t: new Date().toLocaleTimeString(),
      l: level,
      m: String(msg)
    });
    // Keep tail — CacheService items max 100 KB
    if (arr.length > 200) arr = arr.slice(arr.length - 200);
    var json = JSON.stringify(arr);
    if (json.length < 95000) {
      cache.put(currentLogSessionKey_, json, 600);
    }
  } catch (e) {
    // Never let log buffering crash the real work
  }
}

/**
 * Poll endpoint: client calls this to get new log entries.
 * Returns entries from `fromIndex` onward (JSON string).
 */
function getServerLogs(sessionId, fromIndex) {
  if (!sessionId) return '[]';
  try {
    var raw = CacheService.getScriptCache().get('slog_' + sessionId);
    if (!raw) return '[]';
    var arr = JSON.parse(raw);
    var slice = arr.slice(fromIndex || 0);
    return JSON.stringify(slice);
  } catch (e) {
    return '[]';
  }
}

function msaLog_(msg) {
  Logger.log("ℹ️ " + msg);
  appendToLogSession_('info', msg);
}

function msaWarn_(msg) {
  Logger.log("⚠️ " + msg);
  appendToLogSession_('warn', msg);
}

function msaErr_(msg) {
  Logger.log("❌ " + msg);
  appendToLogSession_('error', msg);
}
