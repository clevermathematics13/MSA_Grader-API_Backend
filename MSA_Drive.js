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
 */
function msaLog_(msg) {
  Logger.log("ℹ️ " + msg);
}

function msaWarn_(msg) {
  Logger.log("⚠️ " + msg);
}

function msaErr_(msg) {
  Logger.log("❌ " + msg);
}
