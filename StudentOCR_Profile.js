/********************************
 * StudentOCR_Profile.js
 *
 * Writer-adaptive OCR correction engine.
 *
 * Research shows that tailoring recognition to a specific writer's
 * style yields a 5-7% accuracy gain over global models, because it
 * targets the character discrepancies unique to that individual.
 *
 * This module maintains a PER-STUDENT correction profile keyed by
 * the student ID decoded from the QR code on each exam page.
 * It is architecturally separate from the global OCR_Learn.js system:
 *
 *   OCR_Learn.js  → global rules (class-wide patterns everyone makes)
 *   This file     → personal rules (this student's handwriting quirks)
 *
 * Data Model
 * ──────────
 * A single Google Sheet ("MSA Student OCR Profiles") with two tabs:
 *
 *   student_rules:
 *     StudentId | Pattern | Replacement | Frequency | LastSeen |
 *     FirstSeen | Context | Type | QuestionCode
 *
 *   student_log:
 *     Timestamp | StudentId | FileId | QuestionCode | Type |
 *     Original | Corrected | Context
 *
 * Entry Points
 * ────────────
 *   saveStudentCorrections_(studentId, corrections, meta)
 *     → { saved, updated, total }
 *
 *   loadStudentRules_(studentId, opts)
 *     → [ { pattern, replacement, frequency, … } ]
 *
 *   applyStudentCorrections_(studentId, ocrText, opts)
 *     → { text, applied, stats }
 *
 *   getStudentProfileSummary_(studentId)
 *     → { totalRules, topRules[], correctionCount }
 *
 *   listAllStudentProfiles_()
 *     → [ { studentId, ruleCount, lastActive } ]
 ********************************/


/* ═══════════════════════════════════════════════════════
 * 0.  CONSTANTS
 * ═══════════════════════════════════════════════════════ */

// Minimum frequency for a STUDENT-level rule to auto-apply.
// Lower than the global threshold because student patterns are
// more targeted (less risk of false positives).
var STUDENT_OCR_MIN_FREQUENCY_ = (typeof MSA_STUDENT_OCR_MIN_FREQUENCY !== 'undefined')
  ? MSA_STUDENT_OCR_MIN_FREQUENCY : 1;

// Maximum Levenshtein distance for fuzzy matching (0 = exact only)
var STUDENT_OCR_FUZZY_DISTANCE_ = (typeof MSA_STUDENT_OCR_FUZZY_DISTANCE !== 'undefined')
  ? MSA_STUDENT_OCR_FUZZY_DISTANCE : 0;


/* ═══════════════════════════════════════════════════════
 * 1.  SPREADSHEET MANAGEMENT
 * ═══════════════════════════════════════════════════════ */

/**
 * Get or create the per-student OCR profiles spreadsheet.
 * Separate from the global corrections sheet so the two systems
 * can be inspected, debugged, and cleared independently.
 *
 * @returns {SpreadsheetApp.Spreadsheet}
 */
function getOrCreateStudentProfileSheet_() {
  // 1. Try config constant
  if (typeof MSA_STUDENT_PROFILES_SPREADSHEET_ID !== 'undefined' && MSA_STUDENT_PROFILES_SPREADSHEET_ID) {
    try {
      return SpreadsheetApp.openById(MSA_STUDENT_PROFILES_SPREADSHEET_ID);
    } catch (e) {
      msaLog_('Config student profile spreadsheet not found: ' + e.message);
    }
  }

  // 2. Try Script Properties
  var props = PropertiesService.getScriptProperties();
  var storedId = props.getProperty('STUDENT_OCR_PROFILES_SHEET_ID');
  if (storedId) {
    try {
      return SpreadsheetApp.openById(storedId);
    } catch (e) {
      msaLog_('Stored student profile spreadsheet not found: ' + e.message);
    }
  }

  // 3. Create new spreadsheet
  msaLog_('📋 Creating new Student OCR Profiles spreadsheet...');
  var ss = SpreadsheetApp.create('MSA Student OCR Profiles');

  // ── "student_rules" tab — per-student correction dictionary ──
  var rulesSheet = ss.getActiveSheet();
  rulesSheet.setName('student_rules');
  rulesSheet.getRange(1, 1, 1, 9).setValues([[
    'StudentId', 'Pattern', 'Replacement', 'Frequency', 'LastSeen',
    'FirstSeen', 'Context', 'Type', 'QuestionCode'
  ]]);
  rulesSheet.setFrozenRows(1);
  rulesSheet.getRange('A1:I1').setFontWeight('bold');
  rulesSheet.setColumnWidth(1, 120);
  rulesSheet.setColumnWidth(2, 250);
  rulesSheet.setColumnWidth(3, 250);
  rulesSheet.setColumnWidth(7, 300);

  // ── "student_log" tab — full audit trail ──
  var logSheet = ss.insertSheet('student_log');
  logSheet.getRange(1, 1, 1, 8).setValues([[
    'Timestamp', 'StudentId', 'FileId', 'QuestionCode',
    'Type', 'Original', 'Corrected', 'Context'
  ]]);
  logSheet.setFrozenRows(1);
  logSheet.getRange('A1:H1').setFontWeight('bold');

  // ── "student_summary" tab — quick-lookup aggregate ──
  var summarySheet = ss.insertSheet('student_summary');
  summarySheet.getRange(1, 1, 1, 5).setValues([[
    'StudentId', 'TotalRules', 'TotalCorrections', 'LastActive', 'TopPatterns'
  ]]);
  summarySheet.setFrozenRows(1);
  summarySheet.getRange('A1:E1').setFontWeight('bold');

  // Move to MSA parent folder
  try {
    var cfg = msaGetConfig_();
    var parentFolder = DriveApp.getFolderById(cfg.MSA_PARENT_FOLDER_ID);
    var file = DriveApp.getFileById(ss.getId());
    parentFolder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  } catch (e) {
    msaLog_('Could not move student profiles sheet to parent folder: ' + e.message);
  }

  // Store ID for future use
  props.setProperty('STUDENT_OCR_PROFILES_SHEET_ID', ss.getId());
  msaLog_('Created student profiles spreadsheet: ' + ss.getId());
  msaLog_('💡 Add to MSA_Config.js: const MSA_STUDENT_PROFILES_SPREADSHEET_ID = "' + ss.getId() + '";');

  return ss;
}


/* ═══════════════════════════════════════════════════════
 * 2.  SAVE — Persist student-specific correction patterns
 * ═══════════════════════════════════════════════════════ */

/**
 * Save correction patterns to the student's personal profile.
 * Identical corrections increment the frequency counter (reinforcement).
 * Brand-new patterns are added with frequency = 1.
 *
 * Safety guards (inherited from OCR_Learn.js logic):
 *   - Skip patterns ≤3 chars for deletions (unless CJK)
 *   - Skip single digits, single letters, operators
 *   - Skip patterns >100 chars (too specific)
 *
 * @param {string}  studentId    The student identifier from QR decode
 * @param {Array}   corrections  Array from extractCorrections_()
 * @param {object}  meta         { fileId, questionCode }
 * @returns {object} { saved, updated, total }
 */
function saveStudentCorrections_(studentId, corrections, meta) {
  if (!studentId) {
    msaLog_('⚠️ saveStudentCorrections_: no studentId — skipping');
    return { saved: 0, updated: 0, total: 0 };
  }
  if (!corrections || corrections.length === 0) {
    return { saved: 0, updated: 0, total: 0 };
  }

  var ss = getOrCreateStudentProfileSheet_();
  var rulesSheet = ss.getSheetByName('student_rules');
  var logSheet = ss.getSheetByName('student_log');
  var now = new Date();
  var stats = { saved: 0, updated: 0, total: 0 };

  // Build lookup map for THIS student's existing rules
  // Key: "studentId||pattern||replacement"
  var existingData = rulesSheet.getDataRange().getValues();
  var ruleMap = {};
  var studentRuleCount = 0;

  for (var r = 1; r < existingData.length; r++) {
    var rowStudentId = existingData[r][0];
    if (rowStudentId !== studentId) continue;

    studentRuleCount++;
    var key = studentId + '||' + existingData[r][1] + '||' + existingData[r][2];
    ruleMap[key] = { row: r + 1, frequency: existingData[r][3] || 0 };
  }

  var newRows = [];
  var logRows = [];

  for (var i = 0; i < corrections.length; i++) {
    var c = corrections[i];

    // ── Safety guards (same as OCR_Learn.js) ──
    if (!c.original && !c.corrected) continue;
    if (c.original === c.corrected) continue;
    if (c.type === 'insert') continue;
    if ((c.original || '').length > 100) continue;

    // Skip dangerously short deletion patterns
    if (c.type === 'delete' && (c.original || '').length <= 3) {
      var hasCJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(c.original);
      if (!hasCJK) continue;
    }

    // Skip common single-token LaTeX / operators
    var UNSAFE = /^(\\?[a-zA-Z]|\d|[+\-=()\[\]{}.,;:!?\/<>|\\])$/;
    if (UNSAFE.test((c.original || '').trim())) continue;

    // Skip single-char case-only diffs
    if (c.original && c.corrected &&
        c.original.length === 1 && c.corrected.length === 1 &&
        c.original.toLowerCase() === c.corrected.toLowerCase()) continue;

    var key = studentId + '||' + (c.original || '') + '||' + (c.corrected || '');

    if (ruleMap[key]) {
      // Reinforce existing rule
      var rowIdx = ruleMap[key].row;
      var newFreq = ruleMap[key].frequency + 1;
      rulesSheet.getRange(rowIdx, 4).setValue(newFreq);   // Frequency (col D)
      rulesSheet.getRange(rowIdx, 5).setValue(now);        // LastSeen  (col E)
      ruleMap[key].frequency = newFreq;
      stats.updated++;
    } else {
      // New rule for this student
      newRows.push([
        studentId,                          // A: StudentId
        c.original || '',                   // B: Pattern
        c.corrected || '',                  // C: Replacement
        1,                                  // D: Frequency
        now,                                // E: LastSeen
        now,                                // F: FirstSeen
        c.context || '',                    // G: Context
        c.type || 'replace',                // H: Type
        (meta && meta.questionCode) || ''   // I: QuestionCode
      ]);
      ruleMap[key] = { row: existingData.length + newRows.length, frequency: 1 };
      stats.saved++;
    }

    // Audit log entry
    logRows.push([
      now,
      studentId,
      (meta && meta.fileId) || '',
      (meta && meta.questionCode) || '',
      c.type || 'replace',
      c.original || '',
      c.corrected || '',
      c.context || ''
    ]);
  }

  // Batch-write new rules
  if (newRows.length > 0) {
    var startRow = rulesSheet.getLastRow() + 1;
    rulesSheet.getRange(startRow, 1, newRows.length, 9).setValues(newRows);
  }

  // Batch-write log entries
  if (logRows.length > 0) {
    var logStart = logSheet.getLastRow() + 1;
    logSheet.getRange(logStart, 1, logRows.length, 8).setValues(logRows);
  }

  // Update summary row
  stats.total = studentRuleCount + stats.saved;
  updateStudentSummary_(ss, studentId, stats.total, now);

  msaLog_('👤 [' + studentId + '] Saved corrections: ' +
    stats.saved + ' new, ' + stats.updated + ' reinforced (' + stats.total + ' total rules)');

  return stats;
}

/**
 * Update the student_summary tab with latest aggregate info.
 * @param {Spreadsheet} ss  The profiles spreadsheet
 * @param {string} studentId
 * @param {number} totalRules
 * @param {Date}   lastActive
 */
function updateStudentSummary_(ss, studentId, totalRules, lastActive) {
  var summarySheet = ss.getSheetByName('student_summary');
  if (!summarySheet) return;

  var data = summarySheet.getDataRange().getValues();
  var existingRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === studentId) { existingRow = i + 1; break; }
  }

  // Count total correction events from the log
  var logSheet = ss.getSheetByName('student_log');
  var totalCorrections = 0;
  if (logSheet) {
    var logData = logSheet.getDataRange().getValues();
    for (var j = 1; j < logData.length; j++) {
      if (logData[j][1] === studentId) totalCorrections++;
    }
  }

  // Get top 5 patterns by frequency
  var rulesSheet = ss.getSheetByName('student_rules');
  var rulesData = rulesSheet.getDataRange().getValues();
  var studentRules = [];
  for (var k = 1; k < rulesData.length; k++) {
    if (rulesData[k][0] === studentId) {
      studentRules.push({ pattern: rulesData[k][1], replacement: rulesData[k][2], freq: rulesData[k][3] || 0 });
    }
  }
  studentRules.sort(function(a, b) { return b.freq - a.freq; });
  var topStr = studentRules.slice(0, 5).map(function(r) {
    return '"' + r.pattern + '"→"' + r.replacement + '" (×' + r.freq + ')';
  }).join('; ');

  var rowData = [studentId, totalRules, totalCorrections, lastActive, topStr];

  if (existingRow > 0) {
    summarySheet.getRange(existingRow, 1, 1, 5).setValues([rowData]);
  } else {
    summarySheet.appendRow(rowData);
  }
}


/* ═══════════════════════════════════════════════════════
 * 3.  LOAD — Retrieve rules for a specific student
 * ═══════════════════════════════════════════════════════ */

/**
 * Load correction rules for a specific student.
 * Returns rules sorted by frequency (most common quirks first).
 *
 * @param {string} studentId  The student identifier
 * @param {object} opts       { minFrequency: 1 }
 * @returns {Array} Array of { pattern, replacement, frequency, type, questionCode }
 */
function loadStudentRules_(studentId, opts) {
  if (!studentId) return [];

  opts = opts || {};
  var minFreq = opts.minFrequency || STUDENT_OCR_MIN_FREQUENCY_;

  try {
    var ss = getOrCreateStudentProfileSheet_();
    var rulesSheet = ss.getSheetByName('student_rules');
    var data = rulesSheet.getDataRange().getValues();
    var rules = [];

    for (var r = 1; r < data.length; r++) {
      // Filter: must match this student
      if (data[r][0] !== studentId) continue;

      var frequency = data[r][3] || 0;
      if (frequency < minFreq) continue;

      var pattern = data[r][1];
      var replacement = data[r][2];
      if (!pattern && !replacement) continue;

      rules.push({
        pattern: pattern,
        replacement: replacement || '',
        frequency: frequency,
        type: data[r][7] || 'replace',
        questionCode: data[r][8] || '',
        lastSeen: data[r][4],
        context: data[r][6]
      });
    }

    rules.sort(function(a, b) { return b.frequency - a.frequency; });

    msaLog_('👤 [' + studentId + '] Loaded ' + rules.length + ' student rules (freq >= ' + minFreq + ')');
    return rules;
  } catch (e) {
    msaLog_('Could not load student rules for ' + studentId + ': ' + e.message);
    return [];
  }
}


/* ═══════════════════════════════════════════════════════
 * 4.  APPLY — Run student-specific corrections on OCR text
 * ═══════════════════════════════════════════════════════ */

/**
 * Apply a student's personal correction rules to OCR text.
 *
 * Two matching strategies:
 *   1. Exact literal match (default) — fast, no false positives
 *   2. Fuzzy match via Levenshtein distance (optional) — catches
 *      slight variations of the same handwriting quirk.
 *
 * This runs AFTER the global applyLearnedCorrections_() so that
 * student-specific fixes can override or supplement global ones.
 *
 * @param {string} studentId  Student identifier from QR
 * @param {string} ocrText    OCR text (possibly already globally corrected)
 * @param {object} opts       { minFrequency: 1, fuzzyDistance: 0 }
 * @returns {object} { text, applied, stats }
 */
function applyStudentCorrections_(studentId, ocrText, opts) {
  var emptyResult = {
    text: ocrText,
    applied: [],
    stats: { rulesLoaded: 0, rulesApplied: 0, totalReplacements: 0, studentId: studentId || null }
  };

  if (!studentId || !ocrText) return emptyResult;

  opts = opts || {};
  var rules = loadStudentRules_(studentId, opts);

  if (rules.length === 0) {
    emptyResult.stats.rulesLoaded = 0;
    return emptyResult;
  }

  var correctedText = ocrText;
  var applied = [];
  var totalReplacements = 0;
  var fuzzyDist = opts.fuzzyDistance || STUDENT_OCR_FUZZY_DISTANCE_;

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule.pattern) continue;

    // ── Strategy 1: Exact literal match ──
    var escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re;
    try {
      re = new RegExp(escaped, 'g');
    } catch (e) {
      continue;
    }

    var matches = correctedText.match(re);
    if (matches && matches.length > 0) {
      correctedText = correctedText.replace(re, rule.replacement);
      applied.push({
        pattern: rule.pattern,
        replacement: rule.replacement,
        count: matches.length,
        frequency: rule.frequency,
        strategy: 'exact'
      });
      totalReplacements += matches.length;
      continue; // exact hit — skip fuzzy for this rule
    }

    // ── Strategy 2: Fuzzy match (if enabled) ──
    if (fuzzyDist > 0) {
      var fuzzyResult = fuzzyApplyRule_(correctedText, rule, fuzzyDist);
      if (fuzzyResult.count > 0) {
        correctedText = fuzzyResult.text;
        applied.push({
          pattern: rule.pattern,
          replacement: rule.replacement,
          count: fuzzyResult.count,
          frequency: rule.frequency,
          strategy: 'fuzzy',
          fuzzyMatches: fuzzyResult.matches
        });
        totalReplacements += fuzzyResult.count;
      }
    }
  }

  if (applied.length > 0) {
    msaLog_('👤 [' + studentId + '] Applied ' + applied.length +
      ' student rules (' + totalReplacements + ' replacements)');
  }

  return {
    text: correctedText,
    applied: applied,
    stats: {
      rulesLoaded: rules.length,
      rulesApplied: applied.length,
      totalReplacements: totalReplacements,
      studentId: studentId
    }
  };
}


/* ═══════════════════════════════════════════════════════
 * 5.  FUZZY MATCHING — Levenshtein-based near-match
 * ═══════════════════════════════════════════════════════ */

/**
 * Compute Levenshtein edit distance between two strings.
 * Used for fuzzy matching of student handwriting patterns.
 *
 * @param {string} a  First string
 * @param {string} b  Second string
 * @returns {number}  Edit distance
 */
function levenshteinDistance_(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  var matrix = [];
  for (var i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (var j = 0; j <= a.length; j++) { matrix[0][j] = j; }

  for (var i = 1; i <= b.length; i++) {
    for (var j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,  // substitution
          matrix[i][j - 1] + 1,       // insertion
          matrix[i - 1][j] + 1        // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Scan text for tokens that are within `maxDist` edits of a rule's pattern,
 * and replace them. Only triggers if the pattern is ≥5 chars (to avoid
 * false positives on short tokens).
 *
 * @param {string} text     The OCR text to scan
 * @param {object} rule     { pattern, replacement }
 * @param {number} maxDist  Maximum Levenshtein distance
 * @returns {object} { text, count, matches }
 */
function fuzzyApplyRule_(text, rule, maxDist) {
  var pattern = rule.pattern;
  var replacement = rule.replacement;

  // Fuzzy only makes sense for patterns ≥5 chars
  if (pattern.length < 5) return { text: text, count: 0, matches: [] };

  // Sliding window: scan for substrings close in length to the pattern
  var pLen = pattern.length;
  var result = text;
  var matchCount = 0;
  var matchDetails = [];

  // Tokenize by whitespace and check each token (avoids O(n²) scanning)
  var tokens = text.split(/(\s+)/);
  var rebuilt = [];

  for (var t = 0; t < tokens.length; t++) {
    var token = tokens[t];
    // Only check non-whitespace tokens of similar length
    if (token.trim() && Math.abs(token.length - pLen) <= maxDist) {
      var dist = levenshteinDistance_(token, pattern);
      if (dist > 0 && dist <= maxDist) {
        matchDetails.push({ found: token, distance: dist });
        rebuilt.push(replacement);
        matchCount++;
        continue;
      }
    }
    rebuilt.push(token);
  }

  return {
    text: matchCount > 0 ? rebuilt.join('') : text,
    count: matchCount,
    matches: matchDetails
  };
}


/* ═══════════════════════════════════════════════════════
 * 6.  DIAGNOSTICS — Profile summaries for UI display
 * ═══════════════════════════════════════════════════════ */

/**
 * Get a summary of a specific student's OCR profile.
 * Used for UI display when a student's work is loaded.
 *
 * @param {string} studentId
 * @returns {object} { studentId, totalRules, topRules[], correctionCount, lastActive }
 */
function getStudentProfileSummary_(studentId) {
  if (!studentId) return { studentId: null, totalRules: 0, topRules: [], correctionCount: 0, lastActive: null };

  try {
    var ss = getOrCreateStudentProfileSheet_();
    var rulesSheet = ss.getSheetByName('student_rules');
    var data = rulesSheet.getDataRange().getValues();

    var rules = [];
    var lastActive = null;

    for (var r = 1; r < data.length; r++) {
      if (data[r][0] !== studentId) continue;
      var freq = data[r][3] || 0;
      var lastSeen = data[r][4];
      rules.push({
        pattern: data[r][1],
        replacement: data[r][2],
        frequency: freq
      });
      if (!lastActive || (lastSeen && lastSeen > lastActive)) {
        lastActive = lastSeen;
      }
    }

    rules.sort(function(a, b) { return b.frequency - a.frequency; });

    // Count log entries
    var logSheet = ss.getSheetByName('student_log');
    var correctionCount = 0;
    if (logSheet) {
      var logData = logSheet.getDataRange().getValues();
      for (var j = 1; j < logData.length; j++) {
        if (logData[j][1] === studentId) correctionCount++;
      }
    }

    return {
      studentId: studentId,
      totalRules: rules.length,
      topRules: rules.slice(0, 10),
      correctionCount: correctionCount,
      lastActive: lastActive
    };
  } catch (e) {
    msaLog_('Could not load student profile summary for ' + studentId + ': ' + e.message);
    return { studentId: studentId, totalRules: 0, topRules: [], correctionCount: 0, lastActive: null };
  }
}

/**
 * List all students who have profiles, with summary stats.
 * Used for admin/dashboard views.
 *
 * @returns {Array} [ { studentId, ruleCount, correctionCount, lastActive } ]
 */
function listAllStudentProfiles_() {
  try {
    var ss = getOrCreateStudentProfileSheet_();
    var summarySheet = ss.getSheetByName('student_summary');
    if (!summarySheet) return [];

    var data = summarySheet.getDataRange().getValues();
    var profiles = [];

    for (var r = 1; r < data.length; r++) {
      if (!data[r][0]) continue;
      profiles.push({
        studentId: data[r][0],
        ruleCount: data[r][1] || 0,
        correctionCount: data[r][2] || 0,
        lastActive: data[r][3],
        topPatterns: data[r][4] || ''
      });
    }

    return profiles;
  } catch (e) {
    msaLog_('Could not list student profiles: ' + e.message);
    return [];
  }
}
