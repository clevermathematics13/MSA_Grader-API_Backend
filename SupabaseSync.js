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
 * Scans all sheets in the active + external spreadsheets,
 * dumps headers and sample rows to a "SchemaExport" sheet.
 */
function dumpAllSheetSchemas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  // Create or clear the output sheet
  var out = ss.getSheetByName("SchemaExport");
  if (out) {
    out.clear();
  } else {
    out = ss.insertSheet("SchemaExport");
  }

  var outputRows = [];
  outputRows.push(["=== SCHEMA EXPORT ===", "Generated: " + new Date().toISOString()]);
  outputRows.push([]);

  // 1) Active spreadsheet tabs
  outputRows.push(["── ACTIVE SPREADSHEET: " + ss.getName() + " ──"]);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    if (sheet.getName() === "SchemaExport") continue;
    outputRows = outputRows.concat(dumpOneSheet_(sheet));
  }

  // 2) External spreadsheets
  var externals = [
    { id: "1fc7cWtM83oxQ8rMIX8F_sgjN1xCkLpqdbeTzIG33kPU", label: "Question Metadata / Database" },
    { id: "1bQoToVwjbszmmsoQNmPrpNpb0dT3ZNJTBM6sS49slXU", label: "Student Source" },
    { id: "1lrgFrwEpHhT6Cenfsj8dQ5VeseNa_V8RLWyQabBt1n4", label: "MSA Grading Rules" }
  ];

  for (var e = 0; e < externals.length; e++) {
    outputRows.push([]);
    outputRows.push(["── EXTERNAL: " + externals[e].label + " (" + externals[e].id + ") ──"]);
    try {
      var extSS = SpreadsheetApp.openById(externals[e].id);
      var extSheets = extSS.getSheets();
      for (var j = 0; j < extSheets.length; j++) {
        outputRows = outputRows.concat(dumpOneSheet_(extSheets[j]));
      }
    } catch (err) {
      outputRows.push(["  ERROR opening: " + err.message]);
    }
  }

  // 3) Check for auto-created OCR spreadsheets in Script Properties
  var props = PropertiesService.getScriptProperties();
  var ocrId = props.getProperty("OCR_CORRECTIONS_SHEET_ID");
  if (ocrId) {
    outputRows.push([]);
    outputRows.push(["── EXTERNAL: OCR Corrections (" + ocrId + ") ──"]);
    try {
      var ocrSS = SpreadsheetApp.openById(ocrId);
      var ocrSheets = ocrSS.getSheets();
      for (var k = 0; k < ocrSheets.length; k++) {
        outputRows = outputRows.concat(dumpOneSheet_(ocrSheets[k]));
      }
    } catch (err) {
      outputRows.push(["  ERROR opening: " + err.message]);
    }
  }

  var studentProfileId = props.getProperty("STUDENT_OCR_PROFILES_SHEET_ID");
  if (studentProfileId) {
    outputRows.push([]);
    outputRows.push(["── EXTERNAL: Student OCR Profiles (" + studentProfileId + ") ──"]);
    try {
      var spSS = SpreadsheetApp.openById(studentProfileId);
      var spSheets = spSS.getSheets();
      for (var m = 0; m < spSheets.length; m++) {
        outputRows = outputRows.concat(dumpOneSheet_(spSheets[m]));
      }
    } catch (err) {
      outputRows.push(["  ERROR opening: " + err.message]);
    }
  }

  // Write to SchemaExport sheet
  if (outputRows.length > 0) {
    // Pad rows to same width
    var maxCols = 1;
    for (var r = 0; r < outputRows.length; r++) {
      if (outputRows[r].length > maxCols) maxCols = outputRows[r].length;
    }
    for (var r2 = 0; r2 < outputRows.length; r2++) {
      while (outputRows[r2].length < maxCols) outputRows[r2].push("");
    }
    out.getRange(1, 1, outputRows.length, maxCols).setValues(outputRows);
  }

  // Auto-resize first column
  out.autoResizeColumn(1);

  ui.alert("✅ Schema Export Complete",
    "Dumped " + sheets.length + " local sheets + " + externals.length + " external spreadsheets.\n\n" +
    "Check the 'SchemaExport' tab.",
    ui.ButtonSet.OK);
}

/**
 * Dumps one sheet's structure: name, dimensions, frozen rows/cols,
 * header row, merge info, and 3 sample data rows.
 * @param {Sheet} sheet
 * @returns {Array<Array>} rows to append to output
 */
function dumpOneSheet_(sheet) {
  var rows = [];
  var name = sheet.getName();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var frozenRows = sheet.getFrozenRows();
  var frozenCols = sheet.getFrozenColumns();

  rows.push([]);
  rows.push(["  SHEET: " + name,
    "Rows: " + lastRow,
    "Cols: " + lastCol,
    "Frozen: " + frozenRows + "R/" + frozenCols + "C"]);

  if (lastRow === 0 || lastCol === 0) {
    rows.push(["    (empty sheet)"]);
    return rows;
  }

  // Read up to 5 rows of data (headers + samples)
  var readRows = Math.min(lastRow, 5);
  var data = sheet.getRange(1, 1, readRows, lastCol).getDisplayValues();

  for (var r = 0; r < data.length; r++) {
    var label = (r === 0) ? "    Row 1 (header): " : "    Row " + (r + 1) + ": ";
    rows.push([label].concat(data[r]));
  }

  // Check for merged ranges in first 5 rows (important for zone logic)
  try {
    var merges = sheet.getRange(1, 1, Math.min(lastRow, 5), lastCol).getMergedRanges();
    if (merges.length > 0) {
      var mergeInfo = [];
      for (var m = 0; m < Math.min(merges.length, 10); m++) {
        mergeInfo.push(merges[m].getA1Notation());
      }
      rows.push(["    Merges (first 5 rows): " + mergeInfo.join(", ")]);
      if (merges.length > 10) rows.push(["    ... and " + (merges.length - 10) + " more merges"]);
    }
  } catch (e) {
    // getMergedRanges can fail on some protected sheets
  }

  // If sheet has more rows, show a count
  if (lastRow > 5) {
    rows.push(["    ... " + (lastRow - 5) + " more rows"]);
  }

  return rows;
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

    ui.alert("📊 Supabase Data Summary", lines.join("\n"), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Verify Failed", e.message, ui.ButtonSet.OK);
  }
}
