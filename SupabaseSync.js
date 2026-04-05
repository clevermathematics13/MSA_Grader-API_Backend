// ═══════════════════════════════════════════════════════════════
// SupabaseSync.js — Sync Google Sheets data to Supabase (PostgreSQL)
// ═══════════════════════════════════════════════════════════════

// ── Core Utilities ──────────────────────────────────────────────

/**
 * Makes an authenticated request to the Supabase REST API.
 * @param {string} method - HTTP method (GET, POST, PATCH, DELETE)
 * @param {string} table - Table name
 * @param {Object|null} data - Request body (for POST/PATCH)
 * @param {string} [queryString] - URL query params (e.g. "code=eq.22M.1.SL.TZ1.5")
 * @param {Object} [extraHeaders] - Additional headers to merge
 * @returns {Object} Parsed JSON response
 */
function supabaseRequest_(method, table, data, queryString, extraHeaders) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("SUPABASE_URL");
  var key = props.getProperty("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in Script Properties.");

  var endpoint = url + "/rest/v1/" + table;
  if (queryString) endpoint += "?" + queryString;

  var headers = {
    "apikey": key,
    "Authorization": "Bearer " + key,
    "Content-Type": "application/json"
  };
  if (extraHeaders) {
    for (var h in extraHeaders) headers[h] = extraHeaders[h];
  }

  var options = {
    method: method.toLowerCase(),
    headers: headers,
    muteHttpExceptions: true
  };
  if (data && (method === "POST" || method === "PATCH")) {
    options.payload = JSON.stringify(data);
  }

  var resp = UrlFetchApp.fetch(endpoint, options);
  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error("Supabase " + method + " " + table + " → " + code + ": " + body);
  }
  return body ? JSON.parse(body) : null;
}

/**
 * Upsert rows into a Supabase table.
 * @param {string} table - Table name
 * @param {Array<Object>} rows - Array of row objects
 * @param {string} onConflict - Comma-separated unique column(s) for conflict resolution
 * @returns {Object} Response
 */
function supabaseUpsert_(table, rows, onConflict) {
  if (!rows || rows.length === 0) return [];
  return supabaseRequest_("POST", table, rows, "on_conflict=" + onConflict, {
    "Prefer": "resolution=merge-duplicates,return=representation"
  });
}

/**
 * Test the Supabase connection by reading from a health-check endpoint.
 */
function testSupabaseConnection() {
  var ui = SpreadsheetApp.getUi();
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty("SUPABASE_URL");
    var key = props.getProperty("SUPABASE_SERVICE_KEY");
    if (!url || !key) {
      ui.alert("❌ Missing Config",
        "Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Script Properties.\n\n" +
        "Go to: Extensions → Apps Script → ⚙️ Project Settings → Script Properties",
        ui.ButtonSet.OK);
      return;
    }
    // Try to read questions table (limit 1)
    var result = supabaseRequest_("GET", "questions", null, "select=id&limit=1");
    ui.alert("✅ Connected!",
      "Supabase is reachable at:\n" + url + "\n\n" +
      "questions table returned " + (result ? result.length : 0) + " row(s) (limit 1).",
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Connection Failed", e.message, ui.ButtonSet.OK);
  }
}

// ── Schema Discovery ────────────────────────────────────────────

/**
 * Helper: write rows to SchemaExport sheet (append mode).
 * @param {Array<Array>} outputRows
 * @param {boolean} [clearFirst] - if true, clear sheet before writing
 */
function writeToSchemaExport_(outputRows, clearFirst) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = ss.getSheetByName("SchemaExport");
  if (!out) {
    out = ss.insertSheet("SchemaExport");
    clearFirst = false; // brand new sheet, no need to clear
  }
  if (clearFirst) out.clear();

  // Find first empty row to append
  var startRow = clearFirst ? 1 : (out.getLastRow() + 1);

  if (outputRows.length === 0) return;

  // Cap columns to 26 to avoid huge sparse writes on wide sheets
  var maxCols = 1;
  for (var r = 0; r < outputRows.length; r++) {
    if (outputRows[r].length > maxCols) maxCols = outputRows[r].length;
  }
  maxCols = Math.min(maxCols, 26);

  for (var r2 = 0; r2 < outputRows.length; r2++) {
    // Truncate wide rows, pad short rows
    if (outputRows[r2].length > maxCols) outputRows[r2] = outputRows[r2].slice(0, maxCols);
    while (outputRows[r2].length < maxCols) outputRows[r2].push("");
  }
  out.getRange(startRow, 1, outputRows.length, maxCols).setValues(outputRows);
}

/**
 * Fast dump of one sheet: name, dimensions, and first 3 rows (capped to 26 cols).
 * Skips expensive getMergedRanges() to stay within GAS time limits.
 * @param {Sheet} sheet
 * @returns {Array<Array>}
 */
function dumpOneSheet_(sheet) {
  var rows = [];
  var name = sheet.getName();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  rows.push([]);
  rows.push(["  SHEET: " + name,
    "Rows: " + lastRow,
    "Cols: " + lastCol,
    "Frozen: " + sheet.getFrozenRows() + "R/" + sheet.getFrozenColumns() + "C"]);

  if (lastRow === 0 || lastCol === 0) {
    rows.push(["    (empty sheet)"]);
    return rows;
  }

  // Read only first 3 rows, capped at 26 columns for speed
  var readRows = Math.min(lastRow, 3);
  var readCols = Math.min(lastCol, 26);
  var data = sheet.getRange(1, 1, readRows, readCols).getDisplayValues();

  for (var r = 0; r < data.length; r++) {
    var label = "    Row " + (r + 1) + ": ";
    rows.push([label].concat(data[r]));
  }

  if (lastRow > 3) rows.push(["    ... " + (lastRow - 3) + " more rows"]);
  if (lastCol > 26) rows.push(["    ... " + (lastCol - 26) + " more columns (truncated at Z)"]);

  return rows;
}

/**
 * Step 1: Dump LOCAL sheets only (the active spreadsheet).
 * Clears SchemaExport and writes fresh data.
 */
function dumpLocalSheetSchemas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var outputRows = [];
  outputRows.push(["=== SCHEMA EXPORT ===", "Generated: " + new Date().toISOString()]);
  outputRows.push([]);
  outputRows.push(["── ACTIVE SPREADSHEET: " + ss.getName() + " ──"]);

  var sheets = ss.getSheets();
  var count = 0;
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === "SchemaExport") continue;
    outputRows = outputRows.concat(dumpOneSheet_(sheets[i]));
    count++;
  }

  writeToSchemaExport_(outputRows, true);
  ui.alert("✅ Local Schemas Done",
    "Dumped " + count + " local sheets to 'SchemaExport'.\n\n" +
    "Now run 'Dump External Schemas' to add external spreadsheets.",
    ui.ButtonSet.OK);
}

/**
 * Step 2: Dump EXTERNAL spreadsheets (appends to SchemaExport).
 */
function dumpExternalSheetSchemas() {
  var ui = SpreadsheetApp.getUi();
  var outputRows = [];
  outputRows.push([]);
  outputRows.push(["── EXTERNAL SPREADSHEETS ──"]);

  var externals = [
    { id: "1fc7cWtM83oxQ8rMIX8F_sgjN1xCkLpqdbeTzIG33kPU", label: "Question Metadata / Database" },
    { id: "1bQoToVwjbszmmsoQNmPrpNpb0dT3ZNJTBM6sS49slXU", label: "Student Source" },
    { id: "1lrgFrwEpHhT6Cenfsj8dQ5VeseNa_V8RLWyQabBt1n4", label: "MSA Grading Rules" }
  ];

  for (var e = 0; e < externals.length; e++) {
    outputRows.push([]);
    outputRows.push(["  ── " + externals[e].label + " (" + externals[e].id + ") ──"]);
    try {
      var extSS = SpreadsheetApp.openById(externals[e].id);
      var extSheets = extSS.getSheets();
      for (var j = 0; j < extSheets.length; j++) {
        outputRows = outputRows.concat(dumpOneSheet_(extSheets[j]));
      }
    } catch (err) {
      outputRows.push(["    ERROR: " + err.message]);
    }
  }

  // Also check auto-created OCR spreadsheets
  var props = PropertiesService.getScriptProperties();
  var ocrId = props.getProperty("OCR_CORRECTIONS_SHEET_ID");
  if (ocrId) {
    outputRows.push([]);
    outputRows.push(["  ── OCR Corrections (" + ocrId + ") ──"]);
    try {
      var ocrSS = SpreadsheetApp.openById(ocrId);
      var ocrSheets = ocrSS.getSheets();
      for (var k = 0; k < ocrSheets.length; k++) {
        outputRows = outputRows.concat(dumpOneSheet_(ocrSheets[k]));
      }
    } catch (err) {
      outputRows.push(["    ERROR: " + err.message]);
    }
  }

  var spId = props.getProperty("STUDENT_OCR_PROFILES_SHEET_ID");
  if (spId) {
    outputRows.push([]);
    outputRows.push(["  ── Student OCR Profiles (" + spId + ") ──"]);
    try {
      var spSS = SpreadsheetApp.openById(spId);
      var spSheets = spSS.getSheets();
      for (var m = 0; m < spSheets.length; m++) {
        outputRows = outputRows.concat(dumpOneSheet_(spSheets[m]));
      }
    } catch (err) {
      outputRows.push(["    ERROR: " + err.message]);
    }
  }

  writeToSchemaExport_(outputRows, false);
  ui.alert("✅ External Schemas Done",
    "Appended external spreadsheet schemas to 'SchemaExport'.",
    ui.ButtonSet.OK);
}

/**
 * Combined: runs both local + external (kept for backward compat).
 * May time out on large workbooks — use the split functions instead.
 */
function dumpAllSheetSchemas() {
  dumpLocalSheetSchemas();
  dumpExternalSheetSchemas();
}

// ── Question Sync ───────────────────────────────────────────────

/**
 * Reads questions from Bank, HL list, and SL list tabs,
 * parses them, and upserts to the Supabase `questions` table.
 */
function syncQuestionsToSupabase() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var tabNames = ["Bank", "HL list", "SL list"];
  var allQuestions = [];
  var errors = [];

  for (var t = 0; t < tabNames.length; t++) {
    var sheet = ss.getSheetByName(tabNames[t]);
    if (!sheet) {
      errors.push("Tab '" + tabNames[t] + "' not found — skipped.");
      continue;
    }
    try {
      var questions = parseQuestionsFromList_(sheet, tabNames[t]);
      allQuestions = allQuestions.concat(questions);
    } catch (e) {
      errors.push(tabNames[t] + ": " + e.message);
    }
  }

  if (allQuestions.length === 0) {
    ui.alert("⚠️ No Questions Found",
      "Could not parse any questions from Bank/HL list/SL list.\n\n" +
      (errors.length > 0 ? "Errors:\n" + errors.join("\n") : ""),
      ui.ButtonSet.OK);
    return;
  }

  // Upsert to Supabase in batches of 500
  var batchSize = 500;
  var total = 0;
  for (var i = 0; i < allQuestions.length; i += batchSize) {
    var batch = allQuestions.slice(i, i + batchSize);
    supabaseUpsert_("questions", batch, "code");
    total += batch.length;
  }

  var msg = "✅ Synced " + total + " questions to Supabase.\n\n" +
    "Breakdown:\n" + tabNames.map(function(name) {
      var count = allQuestions.filter(function(q) { return q.source_list === name; }).length;
      return "  " + name + ": " + count;
    }).join("\n");

  if (errors.length > 0) msg += "\n\nWarnings:\n" + errors.join("\n");
  ui.alert("Question Sync Complete", msg, ui.ButtonSet.OK);
}

/**
 * Parses questions from a chooser list sheet (Bank, HL list, SL list).
 * These sheets use zone logic with merged cells in row 4.
 * Each zone contains: marks column, code column, syllabus column.
 *
 * @param {Sheet} sheet
 * @param {string} sourceList - "Bank", "HL list", or "SL list"
 * @returns {Array<Object>} Array of question objects ready for Supabase upsert
 */
function parseQuestionsFromList_(sheet, sourceList) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 5 || lastCol < 3) return [];

  // Read all data at once for performance
  var allData = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var questions = [];
  var seenCodes = {};

  // Scan every column looking for question codes
  // Question codes match the IB pattern: YYS.P.LEVEL.TZ#.Q (e.g. 22M.1.SL.TZ1.5)
  var codePattern = /^\d{2}[MNm]\.\d\.\w+\.TZ\d/;

  for (var col = 0; col < lastCol; col++) {
    // Scan rows 4+ for question codes
    for (var row = 4; row < lastRow; row++) {
      var cell = allData[row][col];
      if (!cell || !codePattern.test(cell)) continue;

      var code = cell.toString().trim();
      if (seenCodes[code]) continue;
      seenCodes[code] = true;

      // Parse the code components
      var parsed = parseQuestionCode_(code);

      // Look for marks in adjacent column (MARKS_OFFSET = -1)
      var marksCol = col - 1;
      var marks = (marksCol >= 0 && allData[row][marksCol]) ?
        parseInt(allData[row][marksCol], 10) : null;

      // Look for syllabus code in adjacent column (SYLLABUS_OFFSET = +1)
      var syllCol = col + 1;
      var syllabus = (syllCol < lastCol && allData[row][syllCol]) ?
        allData[row][syllCol].toString().trim() : null;

      // Gather all parts of this question (same core code in consecutive rows)
      var parts = [];
      var totalMarks = 0;
      var coreCode = parsed.core_code;

      for (var pr = row; pr < lastRow; pr++) {
        var partCode = allData[pr][col] ? allData[pr][col].toString().trim() : "";
        if (!partCode || (pr > row && !partCode.startsWith(coreCode))) break;

        var partMarks = (marksCol >= 0 && allData[pr][marksCol]) ?
          parseInt(allData[pr][marksCol], 10) || 0 : 0;
        var partSyllabus = (syllCol < lastCol && allData[pr][syllCol]) ?
          allData[pr][syllCol].toString().trim() : "";

        // Extract part label from the difference between full code and core code
        var partLabel = partCode.replace(coreCode, "").replace(/^[._]/, "");

        parts.push({
          part: partLabel || "main",
          marks: partMarks,
          syllabus_code: partSyllabus
        });
        totalMarks += partMarks;

        // Mark this code as seen so we don't double-count
        seenCodes[partCode] = true;
      }

      questions.push({
        code: code,
        core_code: coreCode,
        year: parsed.year,
        session: parsed.session,
        paper: parsed.paper,
        level: parsed.level,
        timezone: parsed.timezone,
        question_number: parsed.question_number,
        parts: JSON.stringify(parts),
        total_marks: totalMarks || (marks || 0),
        source_list: sourceList
      });
    }
  }

  return questions;
}

/**
 * Parses an IB question code into components.
 * Example: "22M.1.SL.TZ1.5" → { year: 2022, session: "M", paper: 1, ... }
 * Example: "19M.1.AH.TZ0.H_5" → { year: 2019, session: "M", paper: 1, level: "AH", ... }
 *
 * @param {string} code
 * @returns {Object}
 */
function parseQuestionCode_(code) {
  var parts = code.split(".");
  var yearSession = parts[0] || "";
  var year = parseInt("20" + yearSession.substring(0, 2), 10) || 0;
  var session = yearSession.substring(2, 3) || "";
  var paper = parseInt(parts[1], 10) || 0;
  var level = parts[2] || "";
  var timezone = parts[3] || "";
  // Everything after timezone is the question number (may contain underscores, letters)
  var questionNumber = parts.slice(4).join(".") || "";
  // Core code is everything up to and including timezone
  var coreCode = parts.slice(0, 4).join(".");

  return {
    year: year,
    session: session,
    paper: paper,
    level: level,
    timezone: timezone,
    question_number: questionNumber,
    core_code: coreCode
  };
}

// ── Exam Sync ───────────────────────────────────────────────────

/**
 * Syncs the current PPQselector exam + all archived exams to Supabase.
 */
function syncExamsToSupabase() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var exams = [];
  var examQuestions = [];

  // 1) Current exam from PPQselector
  var ppq = ss.getSheetByName("PPQselector");
  if (ppq) {
    var current = parseCurrentExam_(ppq);
    if (current) {
      exams.push(current.exam);
      examQuestions = examQuestions.concat(current.questions);
    }
  }

  // 2) Archived exams from archive sheet
  var archiveSheet = ss.getSheetByName("archive");
  if (archiveSheet) {
    var archived = parseArchivedExams_(archiveSheet);
    exams = exams.concat(archived.exams);
    examQuestions = examQuestions.concat(archived.questions);
  }

  if (exams.length === 0) {
    ui.alert("⚠️ No Exams Found", "No exam data in PPQselector or archive sheet.", ui.ButtonSet.OK);
    return;
  }

  // Deduplicate exams by exam_code (current PPQ takes priority over archive)
  var seenExams = {};
  var uniqueExams = [];
  for (var i = 0; i < exams.length; i++) {
    if (!seenExams[exams[i].exam_code]) {
      seenExams[exams[i].exam_code] = true;
      uniqueExams.push(exams[i]);
    }
  }
  exams = uniqueExams;

  // Deduplicate exam_questions
  var seenEQ = {};
  var uniqueEQ = [];
  for (var i = 0; i < examQuestions.length; i++) {
    var eqKey = examQuestions[i].exam_code + "|" + examQuestions[i].question_code;
    if (!seenEQ[eqKey]) {
      seenEQ[eqKey] = true;
      uniqueEQ.push(examQuestions[i]);
    }
  }
  examQuestions = uniqueEQ;

  // Upsert exams
  supabaseUpsert_("exams", exams, "exam_code");

  // Upsert exam_questions (need exam IDs from Supabase)
  if (examQuestions.length > 0) {
    // Fetch exam IDs by code
    var examCodes = exams.map(function(e) { return e.exam_code; });
    var examLookup = supabaseRequest_("GET", "exams", null,
      "select=id,exam_code&exam_code=in.(" + examCodes.join(",") + ")");
    var examIdMap = {};
    if (examLookup) {
      examLookup.forEach(function(e) { examIdMap[e.exam_code] = e.id; });
    }

    // Map exam_code to exam_id in junction rows
    var mappedQuestions = examQuestions.map(function(eq) {
      return {
        exam_id: examIdMap[eq.exam_code] || null,
        question_code: eq.question_code,
        position: eq.position
      };
    }).filter(function(eq) { return eq.exam_id; });

    if (mappedQuestions.length > 0) {
      supabaseUpsert_("exam_questions", mappedQuestions, "exam_id,question_code");
    }
  }

  ui.alert("Exam Sync Complete",
    "✅ Synced " + exams.length + " exam(s) and " + examQuestions.length + " exam-question link(s).",
    ui.ButtonSet.OK);
}

/**
 * Parse the current exam from PPQselector.
 */
function parseCurrentExam_(ppq) {
  var examCode = ppq.getRange("G1").getDisplayValue().trim();
  if (!examCode) return null;

  var date = ppq.getRange("I1").getDisplayValue().trim();
  var time = ppq.getRange("J1").getDisplayValue().trim();
  var duration = ppq.getRange("F1").getDisplayValue().trim();

  // Read question codes from row 6
  var lastCol = ppq.getLastColumn();
  if (lastCol < 7) return { exam: { exam_code: examCode, date: date || null, time: time || null, duration_minutes: parseInt(duration, 10) || null }, questions: [] };

  var codes = ppq.getRange(6, 7, 1, lastCol - 6).getDisplayValues()[0]
    .filter(function(c) { return c && c.trim(); });

  var exam = {
    exam_code: examCode,
    date: date || null,
    time: time || null,
    duration_minutes: parseInt(duration, 10) || null,
    class_code: extractClassCode_(examCode)
  };

  var questions = codes.map(function(code, idx) {
    return {
      exam_code: examCode,
      question_code: code.trim(),
      position: idx + 1
    };
  });

  return { exam: exam, questions: questions };
}

/**
 * Parse all archived exams from the archive sheet.
 * Archive blocks are separated by pink (#F4CCCC) rows.
 */
function parseArchivedExams_(archiveSheet) {
  var lastRow = archiveSheet.getLastRow();
  var lastCol = archiveSheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return { exams: [], questions: [] };

  var data = archiveSheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var bgs = archiveSheet.getRange(1, 1, lastRow, 1).getBackgrounds();

  var exams = [];
  var allQuestions = [];
  var blockStart = 0;

  for (var r = 0; r <= lastRow; r++) {
    var isPink = (r < lastRow && bgs[r] && bgs[r][0] && bgs[r][0].toLowerCase() === "#f4cccc");
    var isEnd = (r === lastRow);

    if ((isPink || isEnd) && r > blockStart) {
      // Process block from blockStart to r-1
      var block = data.slice(blockStart, r);
      if (block.length >= 2 && block[0][1]) {
        var examCode = block[0][1]; // B column = exam code
        var date = block[0][2] || null; // C column = date
        var time = block[0][3] || null; // D column = time
        var duration = block[0][0] || null; // A column = duration

        exams.push({
          exam_code: examCode,
          date: date,
          time: time,
          duration_minutes: parseInt(duration, 10) || null,
          class_code: extractClassCode_(examCode)
        });

        // Row index 5 in block = PPQ row 6 (full codes), but block is 0-indexed
        // Archive body starts at block row 3 (rows 4+ = PPQ rows 5-40)
        // PPQ row 6 = block index 4 (row 3 is PPQ row 5, row 4 is PPQ row 6)
        if (block.length > 4) {
          var codeRow = block[4]; // PPQ row 6 equivalent
          for (var c = 0; c < codeRow.length; c++) {
            var code = codeRow[c] ? codeRow[c].toString().trim() : "";
            if (code && /^\d{2}[MNm]/.test(code)) {
              allQuestions.push({
                exam_code: examCode,
                question_code: code,
                position: c + 1
              });
            }
          }
        }
      }
      blockStart = r + 1;
    } else if (isPink) {
      blockStart = r + 1;
    }
  }

  return { exams: exams, questions: allQuestions };
}

/**
 * Extract class code (e.g. "27AH") from exam name.
 */
function extractClassCode_(examName) {
  if (!examName) return null;
  var match = examName.match(/(\d{2}AH|\d{2}AS|\d{2}IH|\d{2}IS)/i);
  return match ? match[1].toUpperCase() : null;
}

// ── Student Sync ────────────────────────────────────────────────

/**
 * Syncs students from the Names sheet to Supabase.
 */
function syncStudentsToSupabase() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var names = ss.getSheetByName("Names");
  if (!names) {
    ui.alert("⚠️ Names sheet not found.", "", ui.ButtonSet.OK);
    return;
  }

  var lastRow = names.getLastRow();
  if (lastRow < 2) {
    ui.alert("⚠️ No students in Names sheet.", "", ui.ButtonSet.OK);
    return;
  }

  var data = names.getRange(2, 1, lastRow - 1, 3).getDisplayValues(); // Skip header row
  var students = [];

  for (var i = 0; i < data.length; i++) {
    var email = data[i][0] ? data[i][0].toString().trim() : "";
    var name = data[i][1] ? data[i][1].toString().trim() : "";
    if (!email) continue;

    var accomm = data[i][2] ? parseFloat(data[i][2]) : null;
    // Normalize: if > 1, assume it's a percentage (e.g. 25 → 0.25)
    if (accomm && accomm > 1) accomm = accomm / 100;

    students.push({
      email: email,
      name: name,
      accommodation_pct: accomm
    });
  }

  if (students.length === 0) {
    ui.alert("⚠️ No valid student rows found.", "", ui.ButtonSet.OK);
    return;
  }

  supabaseUpsert_("students", students, "email");
  ui.alert("Student Sync Complete", "✅ Synced " + students.length + " student(s) to Supabase.", ui.ButtonSet.OK);
}

// ── Sync All ────────────────────────────────────────────────────

/**
 * Runs all sync operations in sequence.
 */
function syncAllToSupabase() {
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert("Sync All Data",
    "This will sync Questions, Exams, and Students to Supabase.\n\nContinue?",
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  syncQuestionsToSupabase();
  syncExamsToSupabase();
  syncStudentsToSupabase();

  ui.alert("✅ Full Sync Complete", "All data synced to Supabase.", ui.ButtonSet.OK);
}

// ── Verify Sync ─────────────────────────────────────────────────

/**
 * Compares row counts between spreadsheet and Supabase.
 */
function verifySupabaseSync() {
  var ui = SpreadsheetApp.getUi();
  try {
    var lines = [];

    // Questions count
    var qResult = supabaseRequest_("GET", "questions", null, "select=id&limit=10000");
    lines.push("Questions in DB: " + (qResult ? qResult.length : 0));

    // Exams count
    var eResult = supabaseRequest_("GET", "exams", null, "select=id&limit=10000");
    lines.push("Exams in DB: " + (eResult ? eResult.length : 0));

    // Students count
    var sResult = supabaseRequest_("GET", "students", null, "select=id&limit=10000");
    lines.push("Students in DB: " + (sResult ? sResult.length : 0));

    // Exam-questions count
    var eqResult = supabaseRequest_("GET", "exam_questions", null, "select=exam_id&limit=10000");
    lines.push("Exam-Question links in DB: " + (eqResult ? eqResult.length : 0));

    // Box coordinates count
    var bcResult = supabaseRequest_("GET", "box_coordinates", null, "select=id&limit=10000");
    lines.push("Box Coordinates in DB: " + (bcResult ? bcResult.length : 0));

    // Grades count
    var gResult = supabaseRequest_("GET", "grades", null, "select=id&limit=10000");
    lines.push("Grades in DB: " + (gResult ? gResult.length : 0));

    ui.alert("📊 Supabase Data Summary", lines.join("\n"), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Verify Failed", e.message, ui.ButtonSet.OK);
  }
}

// ── Box Coordinates Sync ────────────────────────────────────────

/**
 * Reads box coordinates from the Audit Sheet (BoxCoordinates tab)
 * and upserts them to the Supabase `box_coordinates` table.
 *
 * Audit Sheet ID is defined in createTestAndMS.js as DATABASE_SS_ID.
 */
function syncBoxCoordinatesToSupabase() {
  var ui = SpreadsheetApp.getUi();
  var AUDIT_SS_ID = "1fc7cWtM83oxQ8rMIX8F_sgjN1xCkLpqdbeTzIG33kPU";

  try {
    var dbSS = SpreadsheetApp.openById(AUDIT_SS_ID);
    var sheet = dbSS.getSheetByName("BoxCoordinates");
    if (!sheet) {
      ui.alert("⚠️ No BoxCoordinates tab found in the Audit Sheet.", "", ui.ButtonSet.OK);
      return;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      ui.alert("⚠️ BoxCoordinates tab is empty (no data rows).", "", ui.ButtonSet.OK);
      return;
    }

    // Header: ExamName, QuestionCode, Position, X_Pct, Y_Pct, Width_Pct, Height_Pct, X_Pts, Y_Pts, Width_Pts, Height_Pts, Timestamp
    var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
    var rows = [];

    for (var i = 0; i < data.length; i++) {
      var examCode = data[i][0] ? data[i][0].toString().trim() : "";
      var questionCode = data[i][1] ? data[i][1].toString().trim() : "";
      if (!examCode || !questionCode) continue;

      rows.push({
        exam_code: examCode,
        question_code: questionCode,
        position: data[i][2] ? data[i][2].toString().trim() : null,
        x_pct: parseFloat(data[i][3]) || 0,
        y_pct: parseFloat(data[i][4]) || 0,
        width_pct: parseFloat(data[i][5]) || 0,
        height_pct: parseFloat(data[i][6]) || 0,
        x_pts: parseFloat(data[i][7]) || 0,
        y_pts: parseFloat(data[i][8]) || 0,
        width_pts: parseFloat(data[i][9]) || 0,
        height_pts: parseFloat(data[i][10]) || 0
      });
    }

    if (rows.length === 0) {
      ui.alert("⚠️ No valid box coordinate rows found.", "", ui.ButtonSet.OK);
      return;
    }

    // Upsert in batches of 500
    var batchSize = 500;
    var total = 0;
    for (var i = 0; i < rows.length; i += batchSize) {
      var batch = rows.slice(i, i + batchSize);
      supabaseUpsert_("box_coordinates", batch, "exam_code,question_code");
      total += batch.length;
    }

    ui.alert("Box Coordinates Sync Complete",
      "✅ Synced " + total + " box coordinate(s) to Supabase.",
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Box Coordinates Sync Failed", e.message, ui.ButtonSet.OK);
  }
}

// ── Grades Sync ─────────────────────────────────────────────────

/**
 * Reads grading data from The Exam Portal (MASTER_DATABASE_ID) for
 * a specific exam and upserts it to the Supabase `grades` table.
 *
 * The grade tab layout (written by exportToGradebook):
 *   Row 1: Exam name
 *   Row 2: "", "Total", marks_per_question...
 *   Row 3: "Email", "Name", question_labels...
 *   Row 4+: student_email, student_name, marks...
 *
 * Prompts for which exam tab to sync (or syncs the current PPQselector exam).
 */
function syncGradesToSupabase() {
  var ui = SpreadsheetApp.getUi();
  var MASTER_DB_ID = "1sONUu-uxPHsp-VuNxa3d1pM7x_HdNBjftRjLE0BI9KA";

  try {
    // Determine exam name from PPQselector
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ppq = ss.getSheetByName("PPQselector");
    var defaultExam = ppq ? ppq.getRange("G1").getDisplayValue().trim() : "";

    var response = ui.prompt("Sync Grades to Supabase",
      "Enter the exam name to sync (must match a tab in The Exam Portal).\n\n" +
      "Current PPQselector exam: " + (defaultExam || "(none)"),
      ui.ButtonSet.OK_CANCEL);

    if (response.getSelectedButton() !== ui.Button.OK) return;
    var examName = response.getResponseText().trim() || defaultExam;
    if (!examName) {
      ui.alert("⚠️ No exam name provided.", "", ui.ButtonSet.OK);
      return;
    }

    // Open the grade tab in The Exam Portal
    var masterSS = SpreadsheetApp.openById(MASTER_DB_ID);
    var cleanSheetName = examName.replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
    var gradeSheet = masterSS.getSheetByName(cleanSheetName);

    if (!gradeSheet) {
      ui.alert("⚠️ Grade tab '" + cleanSheetName + "' not found in The Exam Portal.\n\n" +
        "Run 'Export to Gradebook' first, then try again.", "", ui.ButtonSet.OK);
      return;
    }

    var lastRow = gradeSheet.getLastRow();
    var lastCol = gradeSheet.getLastColumn();
    if (lastRow < 6 || lastCol < 3) {
      ui.alert("⚠️ Grade tab has no student data (need rows 6+ with at least 3 columns).", "", ui.ButtonSet.OK);
      return;
    }

    // Read header rows (5-row legacy format)
    // Row 2: Bank Code (System) — full IB question codes
    var row2 = gradeSheet.getRange(2, 1, 1, lastCol).getValues()[0];
    // Row 3: Max Points — marks per question
    var row3 = gradeSheet.getRange(3, 1, 1, lastCol).getValues()[0];

    // Get question codes from row 2 (Bank Code) of the grade tab itself
    var qCodes = [];
    for (var c = 2; c < lastCol; c++) {
      var code = row2[c] ? row2[c].toString().trim() : "";
      if (code) qCodes.push(code);
      else qCodes.push("");
    }

    // Columns C onward (index 2+) are question columns
    var numQuestions = lastCol - 2;
    if (numQuestions <= 0) {
      ui.alert("⚠️ No question columns found in grade tab.", "", ui.ButtonSet.OK);
      return;
    }

    // Read student data (row 6 onward)
    var studentData = gradeSheet.getRange(6, 1, lastRow - 5, lastCol).getValues();
    var grades = [];

    for (var i = 0; i < studentData.length; i++) {
      var email = studentData[i][0] ? studentData[i][0].toString().trim() : "";
      if (!email) continue;

      for (var q = 0; q < numQuestions; q++) {
        var marksAwarded = studentData[i][q + 2];
        // Skip empty cells (not yet graded)
        if (marksAwarded === "" || marksAwarded === null || marksAwarded === undefined) continue;

        var questionCode = (q < qCodes.length && qCodes[q]) ? qCodes[q] : "Q" + (q + 1);
        var marksPossible = parseFloat(row3[q + 2]) || null;

        grades.push({
          exam_code: examName,
          student_email: email,
          question_code: questionCode,
          marks_awarded: parseFloat(marksAwarded) || 0,
          marks_possible: marksPossible,
          grader_type: "human"
        });
      }
    }

    if (grades.length === 0) {
      ui.alert("⚠️ No grade data found (all cells empty). Grade students first, then sync.", "", ui.ButtonSet.OK);
      return;
    }

    // Upsert in batches of 500
    var batchSize = 500;
    var total = 0;
    for (var i = 0; i < grades.length; i += batchSize) {
      var batch = grades.slice(i, i + batchSize);
      supabaseUpsert_("grades", batch, "exam_code,student_email,question_code");
      total += batch.length;
    }

    ui.alert("Grades Sync Complete",
      "✅ Synced " + total + " grade(s) for exam '" + examName + "' to Supabase.",
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Grades Sync Failed", e.message, ui.ButtonSet.OK);
  }
}

// ── Student Self-Report (Replaces Google Forms) ─────────────────

/**
 * Fetches exam part data for the student self-report UI.
 * Called from StudentReport.html via google.script.run.
 *
 * Reads from The Exam Portal (MASTER_DATABASE_ID) grade tab:
 *   Row 1: labels (1a, 1b, 2, 3a...)
 *   Row 2: bank codes
 *   Row 3: max points
 *   Row 4: syllabus codes
 *
 * @param {string} examCode - The exam name (e.g. "27AH K05 [SL] P2")
 * @returns {Object} { examCode, parts: [{label, code, maxMarks}], error? }
 */
function getExamPartsForStudentReport(examCode) {
  try {
    if (!examCode) return { error: "No exam code provided." };

    var MASTER_DB_ID = "1sONUu-uxPHsp-VuNxa3d1pM7x_HdNBjftRjLE0BI9KA";
    var masterSS = SpreadsheetApp.openById(MASTER_DB_ID);
    var cleanSheetName = examCode.replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
    var gradeSheet = masterSS.getSheetByName(cleanSheetName);

    if (!gradeSheet) return { error: "Exam '" + examCode + "' not found. Ask your teacher." };

    var lastCol = gradeSheet.getLastColumn();
    if (lastCol < 3) return { error: "Exam has no questions configured." };

    var row1 = gradeSheet.getRange(1, 1, 1, lastCol).getValues()[0]; // labels
    var row3 = gradeSheet.getRange(3, 1, 1, lastCol).getValues()[0]; // max points

    var parts = [];
    for (var c = 2; c < lastCol; c++) {
      var label = row1[c] ? row1[c].toString() : "";
      var maxMarks = row3[c];
      if (!label) continue;
      parts.push({
        label: label,
        maxMarks: (maxMarks !== "" && maxMarks !== null) ? parseFloat(maxMarks) : null
      });
    }

    if (parts.length === 0) return { error: "No question parts found for this exam." };

    return { examCode: examCode, parts: parts };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Submits a student's self-reported marks to Supabase.
 * Called from StudentReport.html via google.script.run.
 *
 * @param {Object} submission - { examCode, studentEmail, marks: [{label, value}] }
 * @returns {Object} { success, count, error? }
 */
function submitStudentMarks(submission) {
  try {
    if (!submission || !submission.examCode || !submission.studentEmail || !submission.marks) {
      return { error: "Missing required fields." };
    }

    var email = submission.studentEmail.toString().trim().toLowerCase();
    if (!email || email.indexOf("@") === -1) {
      return { error: "Please enter a valid email address." };
    }

    var rows = [];
    for (var i = 0; i < submission.marks.length; i++) {
      var m = submission.marks[i];
      var val = parseFloat(m.value);
      if (isNaN(val) || val < 0) continue; // skip blank/invalid

      rows.push({
        exam_code: submission.examCode,
        student_email: email,
        question_label: m.label,
        marks_reported: val
      });
    }

    if (rows.length === 0) {
      return { error: "No valid marks entered." };
    }

    // Check for existing submission — prevent duplicates
    var existing = supabaseRequest_("GET", "student_responses", null,
      "exam_code=eq." + encodeURIComponent(submission.examCode) +
      "&student_email=eq." + encodeURIComponent(email) +
      "&select=id&limit=1");

    if (existing && existing.length > 0) {
      return { error: "You have already submitted marks for this exam. Contact your teacher if you need to re-submit." };
    }

    // Insert (not upsert — one submission per student per exam)
    supabaseRequest_("POST", "student_responses", rows);

    return { success: true, count: rows.length };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Gets a list of active exams available for student self-reporting.
 * Reads from the Students sheet in The Exam Portal.
 *
 * @returns {Object} { exams: [{code, name}], error? }
 */
function getActiveExamsForReport() {
  try {
    var MASTER_DB_ID = "1sONUu-uxPHsp-VuNxa3d1pM7x_HdNBjftRjLE0BI9KA";
    var masterSS = SpreadsheetApp.openById(MASTER_DB_ID);
    var studentSheet = masterSS.getSheetByName("Students");
    if (!studentSheet) return { exams: [] };

    var lastRow = studentSheet.getLastRow();
    if (lastRow < 2) return { exams: [] };

    // Column H = exam name, Column K = status
    var data = studentSheet.getRange(2, 8, lastRow - 1, 4).getValues();
    var exams = [];

    for (var i = 0; i < data.length; i++) {
      var name = data[i][0] ? data[i][0].toString().trim() : "";
      var status = data[i][3] ? data[i][3].toString().trim() : "";
      if (name && status.indexOf("Active") !== -1) {
        exams.push({ code: name, name: name });
      }
    }

    return { exams: exams };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Shows the student self-report URL for the current exam.
 * Menu action: Database Tools → Get Student Report Link
 */
function showStudentReportLink() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ppq = ss.getSheetByName("PPQselector");
  var examName = ppq ? ppq.getRange("G1").getDisplayValue().trim() : "";

  if (!examName) {
    ui.alert("⚠️ No exam name in G1. Build an exam first.");
    return;
  }

  var webAppUrl = ScriptApp.getService().getUrl();
  var reportUrl = webAppUrl + "?ui=report&exam=" + encodeURIComponent(examName);

  ui.alert("📝 Student Report Link",
    "Share this URL with students to self-report their marks:\n\n" +
    reportUrl + "\n\n" +
    "Exam: " + examName,
    ui.ButtonSet.OK);
}
