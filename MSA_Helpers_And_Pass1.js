/**
 * MSA_Helpers_And_Pass1.gs
 * Implements missing core functions for MSA_RunAndValidate.js
 */

// --- CONFIG & RULES ---
function msaGetConfig_() {
  // Returns the global constants defined in MSA_Config.js
  return {
    MSA_PARENT_FOLDER_ID: typeof MSA_PARENT_FOLDER_ID !== 'undefined' ? MSA_PARENT_FOLDER_ID : "",
    MSA_OCR_JSON_OUTPUT_FOLDER_ID: typeof MSA_OCR_JSON_OUTPUT_FOLDER_ID !== 'undefined' ? MSA_OCR_JSON_OUTPUT_FOLDER_ID : "",
    MSA_GRADING_RULES_SPREADSHEET_ID: typeof MSA_GRADING_RULES_SPREADSHEET_ID !== 'undefined' ? MSA_GRADING_RULES_SPREADSHEET_ID : "",
    MSA_GRADING_RULES_SHEET_NAME: typeof MSA_GRADING_RULES_SHEET_NAME !== 'undefined' ? MSA_GRADING_RULES_SHEET_NAME : "rules",
    MSA_PASS2_COVERAGE_TRIGGER: typeof MSA_PASS2_TRIGGER_MIN_COVERAGE_RATIO !== 'undefined' ? MSA_PASS2_TRIGGER_MIN_COVERAGE_RATIO : 0.7,
    MSA_PASS2_STRUCTURE_TRIGGER: typeof MSA_PASS2_TRIGGER_MIN_STRUCTURE_SCORE !== 'undefined' ? MSA_PASS2_TRIGGER_MIN_STRUCTURE_SCORE : 0.85,
    MSA_PASS2_DUP_REQ_TRIGGER: 0.3, // Default
    MSA_PASS2_NOTE_ONLY_TRIGGER: 0.5 // Default
  };
}

function msaLoadGradingRules_(cfg) {
  const defaults = msaDefaultRules_();
  let source = "defaults";
  let url = "";
  let sheetRules = [];

  try {
    if (cfg.MSA_GRADING_RULES_SPREADSHEET_ID) {
      const ss = SpreadsheetApp.openById(cfg.MSA_GRADING_RULES_SPREADSHEET_ID);
      url = ss.getUrl();
      const sheet = ss.getSheetByName(cfg.MSA_GRADING_RULES_SHEET_NAME);
      if (sheet) {
        const data = sheet.getDataRange().getValues();
        const header = data[0].map(h => String(h || "").toLowerCase().trim());

        const idxKey = header.indexOf("rule_key");
        const idxEnabled = header.indexOf("enabled");
        const idxPattern = header.indexOf("pattern");
        const idxAction = header.indexOf("action");
        const idxNotes = header.indexOf("notes");

        if (idxPattern > -1 && idxAction > -1) {
          for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const isEnabled = (idxEnabled > -1) ? String(row[idxEnabled]).toLowerCase() === 'true' : true;
            if (!isEnabled) continue;

            sheetRules.push({
              rule_key: idxKey > -1 ? row[idxKey] : "sheet_rule_" + i,
              enabled: true,
              pattern: row[idxPattern],
              action: row[idxAction],
              notes: idxNotes > -1 ? row[idxNotes] : ""
            });
          }
          if (sheetRules.length > 0) {
            source = "sheet";
          }
        }
      }
    }
  } catch (e) {
    msaWarn_("Could not load rules from sheet, falling back to defaults: " + e.message);
  }

  const finalRules = (source === "sheet" && sheetRules.length > 0) ? sheetRules : defaults;

  // Pre-compile regexes for performance
  finalRules.forEach(rule => {
    try {
      rule._re = new RegExp(rule.pattern, "i"); // Case-insensitive by default
    } catch (e) {
      msaWarn_(`Invalid regex for rule '${rule.rule_key}': ${rule.pattern}`);
      rule.enabled = false; // Disable rule with bad regex
    }
  });

  return {
    rules: finalRules.filter(r => r.enabled),
    source: source,
    url: url
  };
}

function msaGetDocMeta_(cfg, docId) {
  try {
    var file = DriveApp.getFileById(docId);
    return { title: file.getName(), id: docId };
  } catch (e) {
    return { title: "Unknown Doc", id: docId };
  }
}

// --- DRIVE IO ---
function msaGetOrCreateQuestionFolder_(cfg, docId) {
  const parent = DriveApp.getFolderById(cfg.MSA_PARENT_FOLDER_ID);
  const meta = msaGetDocMeta_(cfg, docId);
  // Sanitize the title to remove characters that are invalid in folder names
  const cleanTitle = (meta.title || "Untitled").replace(/[\\/:"*?<>|]/g, '_');
  const name = "MSA_Q_" + docId + "_" + cleanTitle;
  const iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

/**
 * Finds the MSA output folder for a given question docId.
 * Moved from SRG_Grader to be a shared utility.
 * @param {object} cfg The configuration object.
 * @param {string} questionDocId The Google Doc ID of the question.
 * @returns {Drive.Folder|null} The folder object or null if not found.
 */
function msaFindQuestionFolderByDocId_(cfg, questionDocId) {
  const parentFolder = DriveApp.getFolderById(cfg.MSA_PARENT_FOLDER_ID);
  const folderIterator = parentFolder.searchFolders('title contains "' + questionDocId + '"');

  if (folderIterator.hasNext()) {
    return folderIterator.next();
  }

  msaWarn_("Could not find an MSA output folder for docId: " + questionDocId);
  return null;
}

function msaCheckIfReconciled_(cfg, docId) {
  const parentFolder = DriveApp.getFolderById(cfg.MSA_PARENT_FOLDER_ID);
  const meta = msaGetDocMeta_(cfg, docId);
  const cleanTitle = (meta.title || "Untitled").replace(/[\\/:"*?<>|]/g, '_');
  const folderName = "MSA_Q_" + docId + "_" + cleanTitle;

  const folderIterator = parentFolder.getFoldersByName(folderName);
  if (!folderIterator.hasNext()) {
    return false; // Folder doesn't even exist, so not reconciled.
  }

  const folder = folderIterator.next();
  const fileIterator = folder.getFilesByName("_RECONCILED.txt");

  return fileIterator.hasNext(); // Returns true if the file exists.
}

function msaDeleteFileIfExists_(folder, filename) {
  const files = folder.getFilesByName(filename);
  if (files.hasNext()) {
    const file = files.next();
    file.setTrashed(true);
  }
}

function msaWritePreviewArtifacts_(cfg, docId, folder, pages) {
  if (typeof msaBuildPreviewHtml_ !== 'function') {
    msaLog_("msaBuildPreviewHtml_ not found (MSA_Preview.gs missing?). Skipping preview.");
    return;
  }

  try {
    var meta = msaGetDocMeta_(cfg, docId);
    var html = msaBuildPreviewHtml_(meta.title, docId, pages);
    msaUpsertTextFile_(folder, "markscheme_preview.html", html);
  } catch (e) {
    msaWarn_("Failed to write preview HTML: " + e.message);
  }
}

// --- SCORING HELPERS (MOVED FROM SRG) ---

/**
 * Calculates the total possible score from a list of markscheme points,
 * correctly handling alternative METHOD branches.
 * @param {Array<Object>} points The array of points from markscheme_points_best.json.
 * @returns {number} The total possible score.
 */
function msaCalculateTotalPossibleScore_(points) {
  const byPart = {};
  (points || []).forEach(p => {
    // Group by the parent part. e.g., 'ai' and 'aii' both group under 'a'.
    const partStr = p.part || 'unknown';
    const romanNumeralMatch = partStr.match(/[ivx]/);
    const partKey = romanNumeralMatch ? partStr.substring(0, romanNumeralMatch.index) : partStr;
    if (!byPart[partKey]) byPart[partKey] = [];
    byPart[partKey].push(p);
  });

  let totalScore = 0;
  const breakdown = [];
  for (const part in byPart) {
    const partPoints = byPart[part];

    // Heuristic for N marks. If N marks exist, they are the only score for this part.
    const nPoints = partPoints.filter(p => (p.marks || []).some(m => m.startsWith("N")));
    if (nPoints.length > 0) {
      const partScore = nPoints.reduce((sum, p) => sum + msaGetMarkValue_(p.marks || []), 0);
      totalScore += partScore;
      breakdown.push(`Part '${part}': ${partScore} marks (N-marks rule)`);
      continue; // Move to the next part
    }

    const branchGroups = {};
    let nonBranchScore = 0;

    partPoints.forEach(p => {
      const value = msaGetMarkValue_(p.marks || []);
      const branch = p.branch || "";

      if (branch.startsWith("METHOD")) {
        // Group all METHODs together to find the max among them
        if (!branchGroups.METHOD) branchGroups.METHOD = {};
        if (!branchGroups.METHOD[branch]) branchGroups.METHOD[branch] = 0;
        branchGroups.METHOD[branch] += value;
      } else if (branch === "EITHER" || branch === "OR") {
        // Group EITHER/OR together
        if (!branchGroups.EITHER_OR) branchGroups.EITHER_OR = {};
        if (!branchGroups.EITHER_OR[branch]) branchGroups.EITHER_OR[branch] = 0;
        branchGroups.EITHER_OR[branch] += value;
      } else {
        // Accumulate points not in an alternative branch
        nonBranchScore += value;
      }
    });

    // Add the non-branch score for the part
    let partScore = nonBranchScore;
    // For each group of alternative branches (like METHOD or EITHER_OR),
    // find the score of the highest-scoring branch and add it to the part's score.
    for (const group in branchGroups) {
      // e.g., for METHOD, groupScores might be [2, 2, 2] for METHOD1, METHOD2, METHOD3
      const groupScores = Object.values(branchGroups[group]);
      partScore += groupScores.length > 0 ? Math.max(...groupScores) : 0;
    }
    totalScore += partScore;
    breakdown.push(`Part '${part}': ${partScore} marks`);
  }

  return {
    total: totalScore,
    breakdown: breakdown
  };
}

/**
 * Extracts the integer value from a mark token (e.g., "A2" -> 2).
 * Also handles compound marks like "M1A1" -> 2.
 * @param {string} mark The mark token.
 * @returns {number} The integer value of the mark.
 */
function msaGetMarkValue_(marks) {
  const markArray = marks || [];
  if (markArray.length === 0) return 0;

  return markArray.reduce((sum, token) => {
    if (token === 'AG' || token === '(AG)') return sum; // AG (Answer Given) is a checkpoint, not a score. It's worth 0 marks.
    const m = token.match(/\d+/); // Find any sequence of digits in the token.
    return sum + (m ? parseInt(m[0], 10) : 0);
  }, 0);
}

// --- IMAGES & OCR ---
function msaExtractPageImagesFromDoc_(cfg, docId, folder) {
  // NOTE: Google Docs API doesn't export pages as images directly.
  // This fallback extracts INLINE images (e.g. pasted screenshots).
  
  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();
  var images = body.getImages();
  var results = [];
  
  for (var i = 0; i < images.length; i++) {
    var image = images[i];
    var blob = image.getBlob();
    var name = "page_" + (i + 1) + ".png";
    blob.setName(name);
    var file = folder.createFile(blob);
    results.push({
      page: i + 1,
      fileName: name,
      fileId: file.getId(),
      width: image.getWidth(),
      height: image.getHeight()
    });
  }
  
  if (results.length === 0) {
    msaWarn_("No inline images found in Doc. If the Doc is text-based, OCR might not be needed or this step requires PDF conversion.");
  }
  
  return results;
}

function msaMathpixOcrFromDriveImage_(fileId, cfg, options) {
  // ── Cache check: avoid re-calling Mathpix for the same file ──
  var cacheKey = 'mathpix_ocr_' + fileId;
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) {
      msaLog_('Mathpix OCR: cache HIT for ' + fileId);
      return JSON.parse(cached);
    }
  } catch (cacheErr) {
    // cache miss or parse error — proceed with live call
  }

  msaLog_('Mathpix OCR: cache MISS for ' + fileId + ', calling API...');

  // Fetch the image blob from Drive
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  
  // Call the actual Mathpix logic defined in MSA_Mathpix.gs
  var result = msaMathpixOCR_(blob, options);

  // ── Cache the result (up to 100KB, 6-hour TTL) ──
  try {
    var json = JSON.stringify(result);
    if (json.length < 100000) {
      CacheService.getScriptCache().put(cacheKey, json, 21600); // 6 hours
      msaLog_('Mathpix OCR: cached result (' + Math.round(json.length/1024) + 'KB)');
    } else {
      msaLog_('Mathpix OCR: result too large to cache (' + Math.round(json.length/1024) + 'KB)');
    }
  } catch (cacheWriteErr) {
    msaLog_('Mathpix OCR: cache write failed: ' + cacheWriteErr.message);
  }

  return result;
}

function msaBuildCombinedOcr_(cfg, docId, folder, ocrPages) {
  var fullText = ocrPages.map(function(p) { return p.text; }).join("\n\n");
  // 🟢 DEBUG LOGGING START
  msaLog_(`msaBuildCombinedOcr_: Combined text length is ${fullText.length}.`);
  // 🟢 DEBUG LOGGING END
  return {
    readable: fullText,
    json: ocrPages
  };
}

function msaExtractTextFromDocDirectly_(docId) {
  try {
    var doc = DocumentApp.openById(docId);
    var text = doc.getBody().getText();
    return [{
      page: 1,
      text: text,
      confidence: 1.0,
      latex_styled: text, // Fallback
      request_id: "direct_text_extraction"
    }];
  } catch (e) {
    msaWarn_("Direct text extraction failed: " + e.message);
    return [];
  }
}
