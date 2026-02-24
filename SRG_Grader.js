/********************************
 * SRG_Grader.js (Student Response Grader)
 *
 * This script takes a student's handwritten work (as an image)
 * and grades it against a pre-processed MSA markscheme.
 ********************************/

/**
 * 🟢 RUN THIS FUNCTION TO TEST THE GRADER 🟢
 * 1. Fill in the IDs below.
 * 2. Select "runSingleGradeTest" from the function dropdown in the editor.
 * 3. Click "Run" and check the Execution Log for the grading report.
 */
function runSingleGradeTest() {
  // --- ⭐️ PASTE YOUR TEST DATA HERE ⭐️ ---

  // The File ID of the student's handwritten work image you uploaded to Drive.
  const STUDENT_WORK_IMAGE_ID = "1ELLBxY_kZKZDQ7OmHa8cyaz1oMBF8FyC";

  // The Doc ID of the markscheme Google Doc.
  const MARKSCHEME_DOC_ID = "1Q0j5sk0-2xQWPEAS4NIO6jBq02IJvnNFvjc4cJJQu88";

  // -----------------------------------------

  if (STUDENT_WORK_IMAGE_ID === "YOUR_IMAGE_FILE_ID_HERE" || MARKSCHEME_DOC_ID === "A_QUESTION_DOC_ID_FROM_YOUR_BATCH") {
    SpreadsheetApp.getUi().alert("Please open SRG_Grader.js and set the test IDs in the runSingleGradeTest function.");
    return;
  }

  // --- New Decoupled Workflow ---
  // 1. Ensure the markscheme OCR JSON exists.
  const ocrJsonFile = runOcrAndSaveToJson_(MARKSCHEME_DOC_ID);

  // 2. Parse the OCR JSON to get the structured points.
  const parsedResult = runParserFromJson_(ocrJsonFile.getId());
  const markschemePoints = parsedResult.points;

  // 3. Grade the student's work against the structured points.
  gradeStudentResponse(STUDENT_WORK_IMAGE_ID, MARKSCHEME_DOC_ID, markschemePoints);
}


/**
 * Main function to grade a single student response.
 * @param {string} studentWorkImageId The File ID of the student's work image.
 * @param {string} markschemeDocId The Doc ID of the question being answered.
 * @param {Array<Object>} markschemePoints The pre-parsed array of markscheme points.
 */
function gradeStudentResponse(studentWorkImageId, markschemeDocId, markschemePoints) {
  const t0 = Date.now();
  msaLog_("=== SRG (Student Response Grader) START ===");
  const cfg = msaGetConfig_();

  // 1. Find the output folder (still useful for saving student OCR).
  const questionFolder = msaGetOrCreateQuestionFolder_(cfg, markschemeDocId);
  msaLog_("SRG: Loaded " + markschemePoints.length + " markscheme points.");

  // 2. OCR the student's work
  msaLog_("SRG: OCR'ing student work image: " + studentWorkImageId);
  const studentOcr = msaMathpixOcrFromDriveImage_(studentWorkImageId, cfg, {});
  const studentText = studentOcr.text || "";
  msaLog_("SRG: Student OCR text length: " + studentText.length);

  // Save the student's OCR text to a file for easy review.
  const studentOcrFilename = `student_work_${studentWorkImageId}_ocr.txt`;
  msaUpsertTextFile_(questionFolder, studentOcrFilename, studentText);

  // 3. Grade each point against the student's work
  const results = [];
  markschemePoints.forEach(point => {
    const matchResult = srgMatchRequirement_(studentText, point.requirement);
    results.push({
      point_id: point.id,
      marks: point.marks,
      details: matchResult.details,
      awarded: matchResult.awarded,
      match_score: matchResult.score,
      requirement: point.requirement,
      part: point.part,
      branch: point.branch
    });
  });

  // 4. Calculate scores, correctly handling alternative methods
  const possibleScoreInfo = msaCalculateTotalPossibleScore_(markschemePoints);
  const awardedScoreInfo = srgCalculateAwardedScore_(results);

  // 5. Log the final report
  msaLog_("---  النهائية GRADING REPORT ---");
  msaLog_("Total Points Awarded: " + awardedScoreInfo.total + " / " + possibleScoreInfo.total);
  results.forEach(res => {
    const status = res.awarded ? "✅ AWARDED" : "❌ NOT AWARDED";
    msaLog_(status + " (" + (res.marks || []).join('') + ") - Match Score: " + res.match_score.toFixed(2) + " - ID: " + res.point_id);
    if (!res.awarded && res.details) {
      if (res.details.type === 'numeric') {
        const studentNumbers = res.details.student_numbers || [];
        if (studentNumbers.length > 0) {
          msaLog_(`   > Required: [${res.details.required.join(', ')}]. Student provided: [${studentNumbers.join(', ')}]. Missing from required: [${res.details.missing.join(', ')}].`);
        } else {
          msaLog_(`   > Required numbers: [${res.details.required.join(', ')}]. Student provided no numbers.`);
        }
      } else if (res.details.type === 'keyword') {
        msaLog_(`   > Required keywords: [${res.details.required.join(', ')}]. Found: [${res.details.found.join(', ')}]. Missing: [${res.details.missing.join(', ')}].`);
      }
    }
  });

  const dt = Math.round((Date.now() - t0) / 1000);
  msaLog_("=== SRG END === (duration " + dt + "s)");
}

/**
 * The core matching engine. Compares student text to a markscheme requirement.
 * This is a simple keyword-based approach and can be improved over time.
 * @param {string} studentOcrText The full OCR text from the student's work.
 * @param {string} requirementText The requirement text from a single markscheme point.
 * @param {object} options Additional options like {isImplied: true, dependsOn: [...], allResults: [...]}
 * @returns {{awarded: boolean, score: number}}
 */
function srgMatchRequirement_(studentOcrText, requirementText, options) {
  options = options || {};
  const getNumbers = (text) => (String(text || "").match(/-?\d+(\.\d+)?/g) || []);

  // --- STRATEGY 0: Sigma / Summation Equivalence ---
  // IB mark schemes often say "∑(expression) or equivalent".
  // Students may use a different index variable, different bounds, or
  // a simplified integrand that is algebraically identical.
  // We evaluate both sigma expressions numerically and compare.
  if (/sum|\\sum|∑|Σ/i.test(requirementText) && /sum|\\sum|∑|Σ/i.test(studentOcrText)) {
    var sigmaResult = srgMatchSigmaExpressions_(studentOcrText, requirementText);
    if (sigmaResult && sigmaResult.awarded) {
      return sigmaResult;
    }
  }

  // --- STRATEGY 1: Exact Assignment Match (e.g., "n=27") ---
  // This is high confidence and is checked against the whole document.
  const normalizedRequirement = String(requirementText || "").replace(/[\\()]/g, "").trim();
  const assignmentMatch = normalizedRequirement.match(/\b([a-z])\s*=\s*(-?\d+(\.\d+)?)\b/i);
  if (assignmentMatch) {
    const varName = assignmentMatch[1];
    const reqValue = assignmentMatch[2];
    const studentAssignmentRegex = new RegExp(`\\b${varName}\\s*=\\s*${reqValue}\\b`, "i");
    const normalizedStudentText = String(studentOcrText || "").replace(/[\\()]/g, "");
    if (studentAssignmentRegex.test(normalizedStudentText)) {
      return { awarded: true, score: 1.0, details: { type: 'assignment', required: `${varName}=${reqValue}`, found: `${varName}=${reqValue}`, missing: [] } };
    }
  }

  // --- STRATEGY 2: Contextual Number Match ---
  // If the requirement has a part marker like (i), look for the number on the same line as that marker in the student's work.
  const partMarkerMatch = String(requirementText || "").match(/^\s*(\(\s*[ivx]+\s*\))/);
  const requirementNumbers = getNumbers(requirementText);
  if (partMarkerMatch && requirementNumbers.length > 0) {
    const partMarker = partMarkerMatch[1]; // e.g., "(i)"
    const escapedPartMarker = partMarker.replace('(', '\\(').replace(')', '\\)');
    const partMarkerRegex = new RegExp(escapedPartMarker);
    const studentLines = (studentOcrText || "").split(/\r?\n/);

    for (const line of studentLines) {
      if (partMarkerRegex.test(line)) {
        // This line in the student's work contains the part marker.
        // Does it also contain ALL the required numbers?
        const lineNumbers = new Set(getNumbers(line));
        const allNumbersFound = requirementNumbers.every(num => lineNumbers.has(num));
        if (allNumbersFound) {
          return { awarded: true, score: 1.0, details: { type: 'contextual_numeric', required: requirementNumbers, found: requirementNumbers, missing: [] } };
        }
      }
    }
  }

  // --- STRATEGY 3: Global Numeric Match (Fallback) ---
  // This is the broad search, now used as a last resort for numeric checks.
  if (requirementNumbers.length > 0) {
    const studentNumbers = new Set(getNumbers(studentOcrText));
    const foundNumbers = requirementNumbers.filter(num => studentNumbers.has(num));
    const numberMatchRatio = foundNumbers.length / requirementNumbers.length;

    // If all required numbers are found, it's a very strong match.
    if (numberMatchRatio === 1.0) {
      return { awarded: true, score: 1.0, details: { type: 'numeric', required: requirementNumbers, found: foundNumbers, missing: [], student_numbers: Array.from(studentNumbers) } };
    }
    // If some but not all numbers are found, it's a partial match.
    // We can use this score directly.
    return {
      awarded: numberMatchRatio > 0.8,
      score: numberMatchRatio,
      details: {
        type: 'numeric',
        required: requirementNumbers,
        found: foundNumbers,
        missing: requirementNumbers.filter(num => !studentNumbers.has(num)),
        student_numbers: Array.from(studentNumbers)
      }
    };
  }

  // --- STRATEGY 4: Keyword Match ---
  // For non-numeric requirements (e.g., "evidence of substitution").
  const getWords = (text) => new Set(String(text || "").toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !/^\d+$/.test(w)));
  const studentWords = getWords(studentOcrText);
  const requirementWords = Array.from(getWords(requirementText));

  if (requirementWords.length > 0) {
    const foundWords = requirementWords.filter(word => studentWords.has(word));
    const wordMatchRatio = foundWords.length / requirementWords.length;
    const THRESHOLD = 0.75; // 75% of keywords must match.
    return {
      awarded: wordMatchRatio >= THRESHOLD,
      score: wordMatchRatio,
      details: {
        type: 'keyword',
        required: requirementWords,
        found: foundWords,
        missing: requirementWords.filter(word => !studentWords.has(word))
      }
    };
  }

  // If the requirement has no numbers and no keywords, we cannot grade it automatically.
  return { awarded: false, score: 0, details: { type: 'none' } };
}

/**
 * Calculates the total awarded score from a list of graded results,
 * correctly awarding points for the best-scoring METHOD branch.
 * @param {Array<Object>} results The array of graded results.
 * @returns {number} The total awarded score.
 */
function srgCalculateAwardedScore_(results) {
  const byPart = {};
  results.forEach(res => {
    if (!res.awarded) return; // Only consider awarded points
    // Group by the parent part. e.g., 'ai' and 'aii' both group under 'a'.
    const partStr = res.part || 'unknown';
    const romanNumeralMatch = partStr.match(/[ivx]/);
    const partKey = romanNumeralMatch ? partStr.substring(0, romanNumeralMatch.index) : partStr;
    if (!byPart[partKey]) byPart[partKey] = [];
    byPart[partKey].push(res);
  });
 
  let totalAwarded = 0;
  const breakdown = [];
  for (const part in byPart) {
    const partResults = byPart[part];

    // 🟢 NEW: Heuristic for N marks.
    const hasAwardedN = partResults.some(res => (res.marks || []).some(m => m.startsWith("N")));
    if (hasAwardedN) {
      // If any N mark is awarded, the score for this part is ONLY the sum of awarded N marks.
      const nScore = partResults
        .filter(res => (res.marks || []).some(m => m.startsWith("N")))
        .reduce((sum, res) => sum + msaGetMarkValue_(res.marks || []), 0);
      totalAwarded += nScore;
      breakdown.push(`Part '${part}': ${nScore} marks (N-marks rule)`);
      continue; // Move to next part
    }

    const branchGroups = {};
    let nonBranchScore = 0;
 
    partResults.forEach(res => {
      const value = msaGetMarkValue_(res.marks || []);
      const branch = res.branch || "";

      if (branch.startsWith("METHOD")) {
        if (!branchGroups.METHOD) branchGroups.METHOD = {};
        if (!branchGroups.METHOD[branch]) branchGroups.METHOD[branch] = 0;
        branchGroups.METHOD[branch] += value;
      } else if (branch === "EITHER" || branch === "OR") {
        if (!branchGroups.EITHER_OR) branchGroups.EITHER_OR = {};
        if (!branchGroups.EITHER_OR[branch]) branchGroups.EITHER_OR[branch] = 0;
        branchGroups.EITHER_OR[branch] += value;
      } else {
        nonBranchScore += value;
      }
    });
 
    let partScore = nonBranchScore;
    // For each group of alternative branches (like METHOD or EITHER_OR),
    // find the score of the highest-scoring branch and add it to the part's score.
    for (const group in branchGroups) {
      const groupScores = Object.values(branchGroups[group]); // e.g., [2, 2, 2] for METHODs
      partScore += groupScores.length > 0 ? Math.max(...groupScores) : 0;
    }
    totalAwarded += partScore;
    breakdown.push(`Part '${part}': ${partScore} marks`);
  }
  return {
    total: totalAwarded,
    breakdown: breakdown
  };
}


/* ═══════════════════════════════════════════════════════
 * SIGMA EXPRESSION EQUIVALENCE CHECKER
 *
 * Parses sigma/summation expressions from both mark-scheme and student
 * text, evaluates them numerically, and compares the results.
 *
 * Handles common IB forms:
 *   ∑_{n=1}^{27}(7+7n)          mark scheme
 *   ∑_{i=2}^{28} 7i             student (index-shifted equivalent)
 *   \sum_{k=1}^{27}(7+7k)       LaTeX variant
 *   ∑7i  with limits i=2..28    OCR variant
 * ═══════════════════════════════════════════════════════ */

/**
 * Try to match a sigma expression in the student text against one
 * in the requirement text by evaluating both numerically.
 *
 * @param {string} studentText  Full student OCR text
 * @param {string} reqText      Requirement text from mark scheme
 * @returns {object|null}  { awarded, score, details } or null if
 *   we can't parse a sigma expression from either side.
 */
function srgMatchSigmaExpressions_(studentText, reqText) {
  // 1. Parse sigma expression(s) from the requirement
  var reqSigma = parseSigmaExpression_(reqText);
  if (!reqSigma) return null;

  // 2. Parse sigma expression(s) from the student text
  //    The student may have written it on one line near the part marker,
  //    or spread across the whole text.  Try the full text.
  var stuSigma = parseSigmaExpression_(studentText);
  if (!stuSigma) return null;

  // 3. Evaluate both expressions numerically
  var reqValue = evaluateSigma_(reqSigma);
  var stuValue = evaluateSigma_(stuSigma);

  if (reqValue === null || stuValue === null) return null;

  msaLog_('[SIGMA MATCH] Requirement: ∑(' + reqSigma.body + '), ' +
    reqSigma.variable + '=' + reqSigma.lower + '..' + reqSigma.upper +
    ' → ' + reqValue);
  msaLog_('[SIGMA MATCH] Student:     ∑(' + stuSigma.body + '), ' +
    stuSigma.variable + '=' + stuSigma.lower + '..' + stuSigma.upper +
    ' → ' + stuValue);

  // 4. Compare
  var tol = Math.abs(reqValue) * 1e-9 + 1e-9; // relative + absolute tolerance
  if (Math.abs(reqValue - stuValue) <= tol) {
    return {
      awarded: true,
      score: 1.0,
      details: {
        type: 'sigma_equivalence',
        required: reqSigma,
        found: stuSigma,
        reqValue: reqValue,
        stuValue: stuValue,
        missing: []
      }
    };
  }

  // Values don't match — not equivalent
  msaLog_('[SIGMA MATCH] Values differ: ' + reqValue + ' ≠ ' + stuValue);
  return null; // fall through to other strategies
}

/**
 * Parse a sigma expression from text.
 * Handles many OCR / LaTeX variants:
 *
 *   ∑_{n=1}^{27}(7+7n)     →  { variable:'n', lower:1, upper:27, body:'7+7*n' }
 *   \sum_{i=2}^{28} 7i      →  { variable:'i', lower:2, upper:28, body:'7*i' }
 *   ∑7i (with i=2..28)      →  { variable:'i', lower:2, upper:28, body:'7*i' }
 *
 * @param {string} text
 * @returns {object|null}  { variable, lower, upper, body } or null
 */
function parseSigmaExpression_(text) {
  if (!text) return null;

  // Normalise common OCR/LaTeX sigma representations
  var t = String(text)
    .replace(/\\sum\\limits/g, '∑')
    .replace(/\\sum/g, '∑')
    .replace(/Σ/g, '∑')
    .replace(/\\left|\\right/g, '')
    .replace(/\\cdot/g, '*')
    .replace(/\\times/g, '*')
    .replace(/\\{|\\}/g, '')
    .replace(/\s+/g, ' ');

  // Pattern A:  ∑ _{var=lower}^{upper} body
  // Covers:  ∑_{n=1}^{27}(7+7n)   and   ∑ _{i=2}^{28} 7i
  //
  // The body capture must be BOUNDED so it doesn't swallow the rest
  // of a long student OCR string.  We stop at:
  //   - " or "          (mark-scheme "or equivalent")
  //   - \)  or  \\)     (LaTeX inline-math closer)
  //   - \]  or  \\]     (LaTeX display-math closer)
  //   - (a) (b) (i) etc (next part marker)
  //   - end of string
  var BODY_TERMINATORS = '(?:\\s+or\\s+|\\\\\\)|\\\\\\]|\\\\\\(|\\$|\\(\\s*[a-z]\\s*\\)|\\(\\s*[ivx]+\\s*\\)|$)';

  var patA = new RegExp(
    '∑\\s*_?\\s*\\{?\\s*([a-zA-Z])\\s*=\\s*(-?\\d+)\\s*\\}?\\s*\\^?\\s*\\{?\\s*(-?\\d+)\\s*\\}?\\s*' +
    '(.+?)' + BODY_TERMINATORS, 'i'
  );
  var mA = t.match(patA);

  if (mA) {
    var rawBody = mA[4].trim();
    // If the body is empty after trimming, the regex grabbed nothing useful
    if (!rawBody) return null;
    return {
      variable: mA[1],
      lower: parseInt(mA[2], 10),
      upper: parseInt(mA[3], 10),
      body: normaliseBody_(rawBody, mA[1])
    };
  }

  return null;
}

/**
 * Normalise the body of a sigma expression into something we can evaluate.
 *   "7+7n"    → "7+7*n"
 *   "7i"      → "7*i"
 *   "(7+7n)"  → "7+7*n"
 *   "7 + 7n"  → "7+7*n"
 *
 * @param {string} raw   The raw body text
 * @param {string} v     The summation variable (e.g. 'n', 'i')
 * @returns {string}  Evaluatable expression
 */
function normaliseBody_(raw, v) {
  var s = raw
    .replace(/^\(|\)$/g, '')         // strip outer parens
    .replace(/\s+/g, '')             // remove spaces
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '(($1)/($2))')  // \frac{a}{b} → (a)/(b)
    .replace(/\\left|\\right/g, '')
    .replace(/[{}]/g, '');

  // Insert multiplication before the variable where implied:
  //   "7n"  → "7*n"    "7i" → "7*i"
  //   but not "7+n" or "7-n" (those already have an operator)
  var re = new RegExp('(\\d)(' + v + ')', 'g');
  s = s.replace(re, '$1*$2');

  // Also handle variable followed by digit (rare but possible)
  re = new RegExp('(' + v + ')(\\d)', 'g');
  s = s.replace(re, '$1*$2');

  return s;
}

/**
 * Evaluate a parsed sigma expression by iterating from lower to upper.
 * Uses a simple safe-eval approach (no `eval`).
 *
 * @param {object} sigma  { variable, lower, upper, body }
 * @returns {number|null}  The numeric sum, or null if evaluation fails.
 */
function evaluateSigma_(sigma) {
  if (!sigma || sigma.lower > sigma.upper) return null;
  // Safety: don't evaluate huge sums
  if (sigma.upper - sigma.lower > 10000) return null;

  try {
    var total = 0;
    for (var k = sigma.lower; k <= sigma.upper; k++) {
      var val = evaluateSimpleExpression_(sigma.body, sigma.variable, k);
      if (val === null) return null;
      total += val;
    }
    return total;
  } catch (e) {
    return null;
  }
}

/**
 * Evaluate a simple arithmetic expression with one variable replaced by a value.
 * Supports: +, -, *, /, parentheses, integers, decimals.
 * Does NOT use eval() for safety.
 *
 * @param {string} expr   e.g. "7+7*n"
 * @param {string} varName  e.g. "n"
 * @param {number} varValue  e.g. 3
 * @returns {number|null}
 */
function evaluateSimpleExpression_(expr, varName, varValue) {
  // Replace the variable with its numeric value
  var s = expr.replace(new RegExp(varName, 'g'), String(varValue));

  // Tokenise
  var tokens = tokenise_(s);
  if (!tokens) return null;

  // Parse with standard precedence: +- then */
  var pos = { i: 0 };
  var result = parseAddSub_(tokens, pos);
  if (pos.i !== tokens.length) return null; // leftover tokens → bad parse
  return result;
}

/**
 * Tokeniser for simple arithmetic expressions.
 * Returns array of { type: 'num'|'op'|'('|')', value }
 */
function tokenise_(s) {
  var tokens = [];
  var i = 0;
  while (i < s.length) {
    var ch = s[i];
    if (ch === ' ') { i++; continue; }

    // Number (including negation at start or after '(' or operator)
    if (/\d/.test(ch) || (ch === '-' && (tokens.length === 0 ||
        tokens[tokens.length - 1].type === 'op' ||
        tokens[tokens.length - 1].type === '('))) {
      var start = i;
      if (ch === '-') i++;
      while (i < s.length && /[\d.]/.test(s[i])) i++;
      tokens.push({ type: 'num', value: parseFloat(s.substring(start, i)) });
      continue;
    }

    if ('+-*/'.indexOf(ch) >= 0) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    if (ch === '(') { tokens.push({ type: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: ')' }); i++; continue; }

    // Unknown character — fail
    return null;
  }
  return tokens;
}

/** Parse addition / subtraction (lowest precedence) */
function parseAddSub_(tokens, pos) {
  var left = parseMulDiv_(tokens, pos);
  if (left === null) return null;
  while (pos.i < tokens.length && tokens[pos.i].type === 'op' &&
         (tokens[pos.i].value === '+' || tokens[pos.i].value === '-')) {
    var op = tokens[pos.i].value;
    pos.i++;
    var right = parseMulDiv_(tokens, pos);
    if (right === null) return null;
    left = op === '+' ? left + right : left - right;
  }
  return left;
}

/** Parse multiplication / division */
function parseMulDiv_(tokens, pos) {
  var left = parseAtom_(tokens, pos);
  if (left === null) return null;
  while (pos.i < tokens.length && tokens[pos.i].type === 'op' &&
         (tokens[pos.i].value === '*' || tokens[pos.i].value === '/')) {
    var op = tokens[pos.i].value;
    pos.i++;
    var right = parseAtom_(tokens, pos);
    if (right === null) return null;
    left = op === '*' ? left * right : left / right;
  }
  return left;
}

/** Parse an atom: number or parenthesised sub-expression */
function parseAtom_(tokens, pos) {
  if (pos.i >= tokens.length) return null;
  var tok = tokens[pos.i];
  if (tok.type === 'num') {
    pos.i++;
    return tok.value;
  }
  if (tok.type === '(') {
    pos.i++; // skip (
    var val = parseAddSub_(tokens, pos);
    if (val === null) return null;
    if (pos.i >= tokens.length || tokens[pos.i].type !== ')') return null;
    pos.i++; // skip )
    return val;
  }
  return null;
}