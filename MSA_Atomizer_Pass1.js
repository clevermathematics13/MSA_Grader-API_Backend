/***********************
 * MSA_Atomizer_Pass1.gs (updated)
 ***********************/

function msaAtomizePass1_(pagesOcr, rules, skipMapByPart) {
  msaLog_("PASS1 VERSION: 2026-02-12 lookahead-v1");
  const warnings = [];
  const points = [];

  for (let p = 0; p < pagesOcr.length; p++) {
    const pageNum = p + 1;
    const rawText = (pagesOcr[p] && pagesOcr[p].text) ? pagesOcr[p].text : "";

    // Add logging to inspect raw OCR text
    msaLog_(`Page ${pageNum} rawText length: ${rawText.length}`);
    msaLog_(`Page ${pageNum} rawText tail (300 chars): "...${rawText.slice(-300)}"`);
    const nEqualsLines = rawText.split(/\r?\n/).filter(l => /n\s*=\s*\d+/i.test(l));
    if (nEqualsLines.length > 0) {
        msaLog_(`Page ${pageNum} found lines matching 'n = ...': ${JSON.stringify(nEqualsLines)}`);
    } else {
        msaLog_(`Page ${pageNum} did NOT find any lines matching 'n = ...'`);
    }

    const lines = msaPreprocessLines_(rawText, rules);

    const parsed = msaParsePointsFromLines_(lines, pageNum, skipMapByPart, warnings);
    for (let i = 0; i < parsed.length; i++) points.push(parsed[i]);
  }

  return {
    pass: "pass1",
    points: msaAssignIds_(points),
    warnings: warnings
  };
}

function msaPreprocessLines_(text, rules) {
  const raw = String(text || "").split(/\r?\n/);

  // Apply DROP_LINE rules to remove totals/headers
  const dropRules = rules.filter(r => r.enabled && r.action === "DROP_LINE" && r._re);
  const out = [];

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];

    let drop = false;
    for (let j = 0; j < dropRules.length; j++) {
      if (dropRules[j]._re.test(line)) {
        drop = true;
        break;
      }
    }
    if (!drop) out.push(line);
  }

  return out;
}

function msaParsePointsFromLines_(lines, pageNum, skipMapByPart, warnings) {
    const DEBUG_PASS1 = true; // Set to true for verbose parsing logs.

    msaLog_("PASS1 PARSER VERSION: 2026-02-12 lookahead-v1");
    let part = "unknown";
    let lastLetterPart = "unknown";
    let branch = null;
    let buffer = [];
    let lastPoint = null;
    const points = [];
    let pendingMarks = []; // Holds marks from mark-only lines.

    const flushBuffer = (terminatingMarks = [], lineIndex) => {
        if (buffer.length === 0 && pendingMarks.length > 0 && lastPoint) {
            // Pending marks with no buffer attach to the previous point.
            msaLog_(`Pass1: Attaching pending marks [${pendingMarks.join(',')}] to previous point as no new requirement was found.`);
            lastPoint.marks.push(...pendingMarks);
            pendingMarks = [];
            return;
        }
        if (buffer.length === 0) return;

        let allMarks = [...pendingMarks, ...terminatingMarks];
        if (allMarks.length === 0) {
            if (DEBUG_PASS1 && buffer.length > 0) {
                msaLog_(`Pass1: Discarding dangling buffer with no mark. Content: "${buffer.slice(0, 2).join(' ')}..."`);
            }
            warnings.push(`Pass1: Dangling buffer with no mark: "${buffer.join(' ')}"`);
            buffer = [];
            return;
        }

        const pt = {
            page: pageNum,
            part: part,
            branch: branch,
            marks: allMarks,
            requirement: msaTrimBlock_(buffer.join("\n")),
            notes: [],
            source_line_index: lineIndex
        };

        // Post-process to extract notes from the requirement.
        const reqLines = (pt.requirement || "").split('\n');
        const finalReqLines = [];
        let isStrippingNotes = true;
        for (const currentLine of reqLines) {
            if (isStrippingNotes && /^\s*(Note:|Accept|Award|\[\s*\d+\s*marks?\s*\]|Total)/i.test(currentLine)) {
                pt.notes.push(currentLine.trim());
            } else {
                isStrippingNotes = false;
                finalReqLines.push(currentLine);
            }
        }
        pt.requirement = finalReqLines.join('\n').trim();

        if (pt.requirement || pt.marks.length > 1) {
            points.push(pt);
            lastPoint = pt;
        }

        buffer = [];
        pendingMarks = [];
    };

    for (let i = 0; i < lines.length; i++) {
        let line = String(lines[i] || "");

        const mPart = line.match(/^\s*((?:\(\s*[a-z]\s*\)\s*|\(\s*[ivx]+\s*\)\s*)+)/i);
        if (mPart) {
            flushBuffer([], i);
            const rawPart = mPart[1].replace(/[\s\(\)]/g, "").toLowerCase();
            if (/^[ivx]+$/.test(rawPart)) {
                part = lastLetterPart + rawPart;
            } else {
                part = rawPart;
                const primaryLetterMatch = rawPart.match(/^[a-z]/);
                if (primaryLetterMatch) lastLetterPart = primaryLetterMatch[0];
            }
            branch = null;
            line = line.substring(mPart[0].length).trim();
        }

        if (/^\s*EITHER\s*$/i.test(line)) { flushBuffer([], i); branch = "EITHER"; continue; }
        if (/^\s*OR\s*$/i.test(line)) { flushBuffer([], i); branch = "OR"; continue; }
        if (/^\s*THEN\s*$/i.test(line)) { flushBuffer([], i); branch = "THEN"; continue; }
        const mMethod = line.match(/^\s*METHOD\s+(\d+)\s*$/i);
        if (mMethod) {
            flushBuffer([], i);
            branch = "METHOD" + mMethod[1];
            continue;
        }

        const markInfo = msaDetectMarkTag_(line);
        // MARK-ONLY line (no requirementPart)
        if (markInfo && !markInfo.requirementPart) {
             // If we have a buffer, this mark terminates it.
             if (buffer.length > 0) {
                 msaLog_(`Pass1: Mark-only line [${markInfo.marks.join(',')}] is flushing buffer.`);
                 flushBuffer(markInfo.marks, i);
                 continue;
             }
 
             // If no buffer, this is an "orphan" mark.
             // If it follows a point, it's likely the answer mark for that point's work.
             // Create a NEW point for it.
             if (lastPoint && lastPoint.requirement) {
                const originalReq = lastPoint.requirement;
                const { workText, answerText } = msaSplitWorkAndAnswer_(originalReq, DEBUG_PASS1);

                 // Problem A Fix: Remove the answer from the previous point's requirement.
                 if (answerText) {
                    // Mutate the previous point:
                    lastPoint.requirement = workText;
                    if (DEBUG_PASS1) {
                        msaLog_(`Pass1: Split point. New work length: ${lastPoint.requirement.length}. Extracted answer: "${answerText}"`);
                    }
                 }
 
                 const newPt = {
                     page: pageNum,
                     part: lastPoint.part,
                     branch: lastPoint.branch,
                    marks: markInfo.marks,
                    requirement: answerText || "Final answer", // Fallback requirement
                     notes: [],
                    source_line_index: i
                 };
                 points.push(newPt);
                 lastPoint = newPt; // This new answer point is now the last point.
                 continue;
             }
 
             // If no buffer and no lastPoint, it's a pending mark for the *next* requirement.
             msaLog_(`Pass1: Found pending mark(s) [${markInfo.marks.join(',')}] on line ${i} (no current buffer or last point).`);
             pendingMarks.push(...markInfo.marks);
             continue;
        }

        if (markInfo && markInfo.requirementPart) {
            buffer.push(markInfo.requirementPart);
            flushBuffer(markInfo.marks, i);
            continue;
        }

        if (line.trim()) {
            const trimmedLine = line.trim();
            // Problem B Fix: Normalize line by removing LaTeX wrappers before checking.
            const normalizedLine = trimmedLine.replace(/^\\\(\s*|\s*\\\)$/g, "").trim();
            const isUnmarkedAnswer = lastPoint && lastPoint.marks.some(m => m.startsWith('A')) && /^\s*n\s*=\s*\d+\s*$/.test(normalizedLine);

            if (DEBUG_PASS1) {

                msaLog_(`Pass1: Checking unmarked line. Raw: "${trimmedLine}", Norm: "${normalizedLine}", Match: ${isUnmarkedAnswer}`);
            }

            // Unmarked final answer rule
            if (isUnmarkedAnswer) {
                msaLog_(`Pass1: Appending unmarked answer "${trimmedLine}" to previous A-point's requirement.`);
                lastPoint.requirement += "\n" + trimmedLine; // Append the answer
                // Don't add to buffer, we've consumed it.
                continue;
            }
            buffer.push(line);
        }
    }



    flushBuffer([], lines.length);
    return points;
}

/**
 * Extracts the "answer" part from a requirement block.
 * It looks for the last line that seems like a final calculation or result.
 * @param {string} requirement The full requirement text block.
 * @returns {string} The extracted answer line, or a fallback.
 */
function msaSplitWorkAndAnswer_(requirement, debug) {
    if (!requirement) return { workText: "", answerText: "" };

    const lines = requirement.split(/\r?\n/);
    let answerIndex = -1;
    let answerText = "";

    // Find the last "answer-like" line, ignoring LaTeX wrappers
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line || /^\s*\\(begin|end){array}|\\\[|\\\]\s*$/.test(line)) {
            continue; // Skip empty lines and array wrappers
        }

        if (/^\s*=?\s*([nx]\s*=|=|\d)/.test(line) || /^-?\d+(\.\d+)?$/.test(line)) {
            answerIndex = i;
            answerText = line;
            break;
        }
    }

    if (answerIndex === -1) {
        return { workText: requirement, answerText: "" };
    }

    // Reconstruct the work text, excluding the answer line
    const workLines = lines.filter((_, index) => index !== answerIndex);
    
    // Clean trailing '\\' from the line that is now last before the end of the array
    if (answerIndex > 0 && workLines[answerIndex - 1]) {
        workLines[answerIndex - 1] = workLines[answerIndex - 1].replace(/\\\\\s*$/, '');
    }
    
    const workText = workLines.join('\n');

    if (debug) {
        msaLog_(`msaSplitWorkAndAnswer_: workText includes \\end{array}: ${workText.includes('\\end{array}')}`);
        msaLog_(`msaSplitWorkAndAnswer_: workText includes \\]: ${workText.includes('\\]')}`);
        msaLog_(`msaSplitWorkAndAnswer_: answerText: "${answerText}"`);
    }

    return { workText: workText, answerText: answerText };
}

function _escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function msaDetectMarkTag_(line) {
  const s = String(line || "").trim();
  
  // NEW: Handle single mark-only lines with/without parens first.
  if (/^\(\s*[AMRN]\d+\s*\)$/.test(s) || /^[AMRN]\d+$/.test(s)) {
    return { marks: [s], requirementPart: null };
  }
  
  // Case 1: Handle simple cases like (AG) or AG
  if (/^\(?\s*AG\s*\)?$/.test(s)) {
    return { marks: [s], requirementPart: null };
  }
  
  // Find all potential mark tokens on the line
  const markTokens = s.match(/[AMRN]\d+/g);

  if (!markTokens) {
    return null;
  }

  // Case 2: Check if it's a mark-only line (e.g., "(M1)" or "A1, A1")
  const stripped = s.replace(/[AMRN]\d+/g, "").replace(/[\s,;()]/g, "").trim();
  if (stripped.length === 0) {
    return {
      marks: markTokens,
      requirementPart: null // Indicates no requirement on this line
    };
  }

  // Case 3: Check for marks in parentheses at the end of a line with content.
  // e.g., "some text (A1)" or "other text (A1,A1)"
  // NOTE: Marks in parentheses are "implied marks" - they can be awarded if
  // a correct subsequent answer implies this step was done correctly.
  const endOfLineMatch = s.match(/^(.*)\s+\((.*)\)$/);
  if (endOfLineMatch) {
    const requirementPart = endOfLineMatch[1].trim();
    const marksPart = endOfLineMatch[2];

    // Validate that the part in parentheses *only* contains mark tokens and separators.
    const marksPartTokens = marksPart.match(/[AMRN]\d+/g);
    if (!marksPartTokens) {
      // The content in parentheses was not a mark, e.g., "some text (see note)".
      return null;
    }

    const marksPartStripped = marksPart.replace(/[AMRN]\d+/g, "").replace(/[\s,;()]/g, "").trim();
    if (marksPartStripped.length === 0) {
      // This is a valid end-of-line mark construct.
      // Marks in parentheses are IMPLIED marks per IB marking convention.
      return {
        marks: marksPartTokens, // Use the tokens from inside the parens
        requirementPart: requirementPart,
        isImplied: true  // Flag that these marks can be awarded by implication
      };
    }
  }

  return null;
}

function msaTrimBlock_(s) {
  s = String(s || "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function msaAssignIds_(points) {
  // stable-ish id scheme: p{page}_{index}_{part}_{mark}[_{k}]
  const counters = {};
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const key = ["p" + msaPad2_(pt.page), pt.part || "x", (pt.marks || ["X"]).join(''), pt.branch || ""].join("_");
    counters[key] = (counters[key] || 0) + 1;
    const n = counters[key];

    let id = "p" + msaPad2_(pt.page) + "_" + msaPad2_(i + 1) + "_" + (pt.part || "x") + "_" + ((pt.marks || ["X"]).join(''));
    if (pt.branch) id += "_" + pt.branch;
    if (n > 1) id += "_" + n;

    pt.id = id;
  }
  return points;
}
