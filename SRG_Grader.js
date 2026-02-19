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
    const message = "Please open SRG_Grader.js and set the test IDs in the runSingleGradeTest function.";
    throw new Error(message);
  }

  // 1. Find the pre-processed markscheme points JSON file.
  // 1. Find the pre-processed markscheme points JSON file for faster testing.
  const cfg = msaGetConfig_();
  const questionFolder = msaFindQuestionFolderByDocId_(cfg, MARKSCHEME_DOC_ID);
  if (!questionFolder) throw new Error(`Could not find output folder for MARKSCHEME_DOC_ID: ${MARKSCHEME_DOC_ID}`);
  
  const markscheme = msaReadJsonFileIfExists_(questionFolder, "markscheme_points_best.json");
  if (!markscheme || !markscheme.points) throw new Error(`Could not load or parse markscheme_points_best.json from folder: ${questionFolder.getName()}`);
  const markschemePoints = markscheme.points;

  // 2. Grade the student's work against the structured points.
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

  msaLog_("SRG: Loaded " + markschemePoints.length + " markscheme points.");
  const questionFolder = msaGetOrCreateQuestionFolder_(cfg, markschemeDocId);

  // 2. OCR the student's work
  msaLog_("SRG: OCR'ing student work image: " + studentWorkImageId);
  const studentOcr = msaMathpixOcrFromDriveImage_(studentWorkImageId, cfg, {});
  if (!studentOcr) {
    throw new Error("OCR failed: msaMathpixOcrFromDriveImage_ returned null. Check that the image ID is valid and Mathpix API is configured.");
  }
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
 * @returns {{awarded: boolean, score: number}}
 */
function srgMatchRequirement_(studentOcrText, requirementText) {
  const getNumbers = (text) => (String(text || "").match(/-?\d+(\.\d+)?/g) || []);

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
