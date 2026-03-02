/********************************
 * OCR_Verify.js
 *
 * Shape-aware OCR verification pass.
 *
 * After Mathpix returns raw OCR text, this module cross-checks every
 * numeric value and mathematical symbol against:
 *   1. The mark-scheme's expected values ("anchors")
 *   2. A handwriting glyph-confusion matrix
 *
 * When a near-miss is detected (the OCR text differs by one or two
 * characters that are visually confusable in handwriting), the module
 * suggests a correction with a confidence score and an explanation.
 *
 * Entry points
 * ────────────
 *   ocrVerifyAndCorrect(ocrText, markschemePoints, opts)
 *     → { correctedText, corrections[], stats }
 *
 *   ocrFindNearMisses(ocrText, expectedValues)
 *     → [ { ocrValue, expected, confusedChars[], confidence } ]
 ********************************/

/* ═══════════════════════════════════════════════════════
 * 1.  GLYPH CONFUSION MATRIX
 *
 * Each key maps to an array of { glyph, weight } objects.
 * Weight ∈ (0,1] represents how likely a handwriting OCR
 * engine is to confuse the two shapes.  Higher = more likely.
 *
 * Sources:
 *   – MNIST/EMNIST misclassification statistics
 *   – Common IB examiner reports on handwriting legibility
 *   – Mathpix-specific error patterns observed in practice
 * ═══════════════════════════════════════════════════════ */

var GLYPH_CONFUSION = {
  // ── Digit ↔ Digit ──
  '0': [{ g: '6', w: 0.40 }, { g: '9', w: 0.30 }, { g: 'O', w: 0.75 }, { g: 'o', w: 0.65 }, { g: 'D', w: 0.20 }],
  '1': [{ g: '7', w: 0.70 }, { g: 'l', w: 0.80 }, { g: 'I', w: 0.75 }, { g: '|', w: 0.60 }, { g: 'i', w: 0.45 }],
  '2': [{ g: 'Z', w: 0.50 }, { g: 'z', w: 0.45 }, { g: '7', w: 0.30 }],
  '3': [{ g: '8', w: 0.55 }, { g: '5', w: 0.30 }],
  '4': [{ g: '9', w: 0.35 }, { g: 'A', w: 0.15 }],
  '5': [{ g: '6', w: 0.50 }, { g: 'S', w: 0.45 }, { g: 's', w: 0.40 }, { g: '3', w: 0.30 }],
  '6': [{ g: '0', w: 0.40 }, { g: 'b', w: 0.45 }, { g: '5', w: 0.50 }, { g: '8', w: 0.25 }],
  '7': [{ g: '1', w: 0.70 }, { g: '2', w: 0.30 }, { g: 'T', w: 0.20 }],
  '8': [{ g: '3', w: 0.55 }, { g: '6', w: 0.25 }, { g: '0', w: 0.20 }, { g: 'B', w: 0.30 }],
  '9': [{ g: '4', w: 0.35 }, { g: '0', w: 0.30 }, { g: 'q', w: 0.40 }, { g: 'g', w: 0.35 }],

  // ── Letter ↔ Digit ──
  'O': [{ g: '0', w: 0.75 }],
  'o': [{ g: '0', w: 0.65 }],
  'l': [{ g: '1', w: 0.80 }],
  'I': [{ g: '1', w: 0.75 }],
  'Z': [{ g: '2', w: 0.50 }],
  'z': [{ g: '2', w: 0.45 }],
  'S': [{ g: '5', w: 0.45 }],
  's': [{ g: '5', w: 0.40 }],
  'B': [{ g: '8', w: 0.30 }],
  'b': [{ g: '6', w: 0.45 }],
  'q': [{ g: '9', w: 0.40 }],
  'g': [{ g: '9', w: 0.35 }],
  'D': [{ g: '0', w: 0.20 }],

  // ── Math symbol confusion ──
  'x': [{ g: '×', w: 0.80 }, { g: 'X', w: 0.55 }],
  'X': [{ g: '×', w: 0.65 }, { g: 'x', w: 0.55 }],
  '×': [{ g: 'x', w: 0.80 }, { g: 'X', w: 0.65 }],
  '-': [{ g: '−', w: 0.90 }, { g: '–', w: 0.85 }, { g: '—', w: 0.60 }],
  '−': [{ g: '-', w: 0.90 }, { g: '–', w: 0.85 }],
  '+': [{ g: 't', w: 0.15 }],
  '=': [{ g: '≡', w: 0.30 }, { g: '≈', w: 0.20 }]
};

/* ═══════════════════════════════════════════════════════
 * 2.  HELPERS
 * ═══════════════════════════════════════════════════════ */

/**
 * Return the confusion weight between two single characters.
 * 0 means "not confusable", >0 means "confusable" (higher = more likely).
 */
function glyphConfusionWeight_(a, b) {
  if (a === b) return 1.0;
  var entry = GLYPH_CONFUSION[a];
  if (entry) {
    for (var i = 0; i < entry.length; i++) {
      if (entry[i].g === b) return entry[i].w;
    }
  }
  // Check reverse direction
  var entryB = GLYPH_CONFUSION[b];
  if (entryB) {
    for (var j = 0; j < entryB.length; j++) {
      if (entryB[j].g === a) return entryB[j].w;
    }
  }
  return 0;
}

/**
 * Given two strings of equal length, compute a shape-similarity score
 * (product of per-character confusion weights).  Returns 0 if any
 * character pair is completely non-confusable.
 */
function shapeSimilarityScore_(ocrStr, expectedStr) {
  if (ocrStr.length !== expectedStr.length) return 0;
  var score = 1.0;
  var diffCount = 0;
  var confusedChars = [];

  for (var i = 0; i < ocrStr.length; i++) {
    var oc = ocrStr[i];
    var ec = expectedStr[i];
    if (oc === ec) continue; // identical — no confusion needed
    diffCount++;
    var w = glyphConfusionWeight_(oc, ec);
    if (w === 0) return 0; // not confusable at all → no match
    score *= w;
    confusedChars.push({
      position: i,
      ocrChar: oc,
      expectedChar: ec,
      weight: w
    });
  }

  if (diffCount === 0) return 1.0;              // identical strings
  if (diffCount > 2) return 0;                   // too many diffs — not a near-miss

  return { score: score, diffCount: diffCount, confusedChars: confusedChars };
}

/**
 * Extract all distinct numeric tokens from a text string.
 * Returns objects with { value, raw, start, end } so we know where they are.
 */
function extractNumericTokens_(text) {
  var re = /-?\d+(?:\.\d+)?/g;
  var tokens = [];
  var seen = {};
  var m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({
      value: parseFloat(m[0]),
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return tokens;
}

/**
 * Extract variable-assignment tokens  (e.g. "n = 27", "x=3.5")
 * Returns objects with { variable, value, raw, start, end }
 */
function extractAssignmentTokens_(text) {
  var re = /\b([a-zA-Z])\s*=\s*(-?\d+(?:\.\d+)?)\b/g;
  var tokens = [];
  var m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({
      variable: m[1],
      value: parseFloat(m[2]),
      raw: m[0],
      numericRaw: m[2],
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return tokens;
}

/**
 * Collect all "expected values" from the mark-scheme points.
 * These are the numeric anchors we expect to find in the student's work.
 */
function extractExpectedValues_(markschemePoints) {
  var expected = [];
  var seenValues = {};

  (markschemePoints || []).forEach(function(point) {
    var req = String(point.requirement || '');

    // Pull raw numbers from the requirement text
    var nums = req.match(/-?\d+(?:\.\d+)?/g) || [];
    nums.forEach(function(n) {
      if (!seenValues[n]) {
        seenValues[n] = true;
        expected.push({
          raw: n,
          value: parseFloat(n),
          pointId: point.id || '',
          part: point.part || '',
          requirement: req
        });
      }
    });

    // Also pull variable assignments  (e.g. "n = 27")
    var assigns = req.match(/\b([a-zA-Z])\s*=\s*(-?\d+(?:\.\d+)?)\b/g) || [];
    assigns.forEach(function(a) {
      var parts = a.match(/([a-zA-Z])\s*=\s*(-?\d+(?:\.\d+)?)/);
      if (parts) {
        var key = parts[1] + '=' + parts[2];
        if (!seenValues[key]) {
          seenValues[key] = true;
          expected.push({
            raw: parts[2],
            value: parseFloat(parts[2]),
            variable: parts[1],
            pointId: point.id || '',
            part: point.part || '',
            requirement: req
          });
        }
      }
    });
  });

  return expected;
}

/* ═══════════════════════════════════════════════════════
 * 3.  NEAR-MISS FINDER
 * ═══════════════════════════════════════════════════════ */

/**
 * For each expected value from the mark scheme, search the OCR text for
 * exact matches. If an exact match is NOT found, look for "shape near-misses"
 * — numbers that differ by 1-2 visually confusable characters.
 *
 * @param {string} ocrText   The raw OCR text.
 * @param {Array}  expected  Array from extractExpectedValues_().
 * @returns {Array} Near-miss objects with correction suggestions.
 */
function ocrFindNearMisses(ocrText, expected) {
  var ocrTokens = extractNumericTokens_(ocrText);
  var nearMisses = [];

  // Build a set of ALL expected values (strings) for quick "is this already correct?" checks.
  // If the OCR text contains "1003" and "1003" IS an expected value, we must NOT
  // flag it as a near-miss for some other expected value like "196".
  var expectedSet = {};
  expected.forEach(function(e) { expectedSet[e.raw] = true; });

  expected.forEach(function(exp) {
    var expectedStr = exp.raw;

    // 1. Check if the exact value already appears in the OCR text
    //    Use a regex with word boundaries so "27" doesn't match inside "271"
    var exactRe = new RegExp('(?<![\\d.])' + expectedStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\d.])', 'g');
    if (exactRe.test(ocrText)) {
      return; // exact match found — no correction needed
    }

    // 2. Look for near-misses among OCR numeric tokens
    ocrTokens.forEach(function(tok) {
      // CRITICAL GUARD: If the OCR token is itself an expected mark-scheme value,
      // do NOT flag it. The student wrote a correct value for another part —
      // it makes no sense to "correct" 1003 → 196.
      if (expectedSet[tok.raw]) return;

      // Only compare tokens of the same length (±0)
      // Length-mismatch comparisons (insertion/deletion) produce far too many
      // false positives (e.g. 335→2835, 7→27) so we disable them entirely.
      var lenDiff = Math.abs(tok.raw.length - expectedStr.length);
      if (lenDiff > 0) return;

      // Same length — character-by-character shape comparison
      var result = shapeSimilarityScore_(tok.raw, expectedStr);

      if (result && result.score > 0) {
        nearMisses.push({
          ocrValue: tok.raw,
          ocrPosition: { start: tok.start, end: tok.end },
          expectedValue: expectedStr,
          expectedNumeric: exp.value,
          variable: exp.variable || null,
          pointId: exp.pointId,
          part: exp.part,
          requirement: exp.requirement,
          confidence: result.score,
          diffCount: result.diffCount,
          confusedChars: result.confusedChars
        });
      }
    });
  });

  // Sort by confidence descending
  nearMisses.sort(function(a, b) { return b.confidence - a.confidence; });

  // De-duplicate: if the same OCR token is a near-miss for multiple expected
  // values, keep the one with the highest confidence.
  var bestByOcr = {};
  nearMisses.forEach(function(nm) {
    var key = nm.ocrPosition.start + ':' + nm.ocrPosition.end;
    if (!bestByOcr[key] || nm.confidence > bestByOcr[key].confidence) {
      bestByOcr[key] = nm;
    }
  });

  // Cap at 10 to avoid overwhelming the teacher with noise
  var finalList = Object.keys(bestByOcr).map(function(k) { return bestByOcr[k]; });
  finalList.sort(function(a, b) { return b.confidence - a.confidence; });
  return finalList.slice(0, 10);
}

/**
 * Try all single-character insertion/deletion alignments between two strings
 * that differ in length by exactly 1.  Return the best shape-similarity result.
 *
 * e.g.  OCR "835" vs expected "2835" — try inserting each possible char at each position
 */
function bestAlignmentScore_(shorter, longer) {
  if (shorter.length > longer.length) {
    var tmp = shorter; shorter = longer; longer = tmp;
  }
  if (longer.length - shorter.length !== 1) return null;

  var best = null;

  // Try removing each character from the longer string to see if the
  // remainder is shape-similar to the shorter string
  for (var i = 0; i < longer.length; i++) {
    var reduced = longer.substring(0, i) + longer.substring(i + 1);
    var sim = shapeSimilarityScore_(shorter, reduced);
    if (sim && sim.score > 0) {
      // Account for the missing/extra character
      var adjustedScore = sim.score * 0.6; // penalty for length mismatch
      var result = {
        score: adjustedScore,
        diffCount: sim.diffCount + 1,
        confusedChars: sim.confusedChars.concat([{
          position: i,
          ocrChar: shorter.length < longer.length ? '∅' : longer[i],
          expectedChar: shorter.length < longer.length ? longer[i] : '∅',
          weight: 0.6,
          type: shorter.length < longer.length ? 'missing_digit' : 'extra_digit'
        }])
      };
      if (!best || result.score > best.score) {
        best = result;
      }
    }
  }

  return best;
}


/* ═══════════════════════════════════════════════════════
 * 4.  MAIN VERIFY-AND-CORRECT PASS
 * ═══════════════════════════════════════════════════════ */

/**
 * Run the full OCR verification pass.
 *
 * @param {string} ocrText            Raw OCR text from Mathpix.
 * @param {Array}  markschemePoints   Parsed mark-scheme points array.
 * @param {object} [opts]             Options.
 * @param {number} [opts.autoCorrectThreshold=0.55]
 *   Minimum confusion confidence to auto-correct.  Below this the correction
 *   is suggested but not applied.
 * @param {boolean} [opts.dryRun=false]
 *   If true, return corrections but don't modify the text.
 * @param {string} [opts.latexText]
 *   If provided, also cross-reference numbers from the LaTeX-styled OCR output.
 *
 * @returns {object}
 *   { correctedText, corrections[], stats: { checked, corrected, flagged } }
 */
function ocrVerifyAndCorrect(ocrText, markschemePoints, opts) {
  opts = opts || {};
  var threshold = (typeof opts.autoCorrectThreshold === 'number') ? opts.autoCorrectThreshold : 0.55;
  var dryRun = !!opts.dryRun;

  // 1. Collect expected values from mark scheme
  var expected = extractExpectedValues_(markschemePoints);
  msaLog_('[OCR_VERIFY] Expected values from mark scheme: ' +
    expected.map(function(e) { return e.raw + (e.variable ? ' (' + e.variable + ')' : ''); }).join(', '));

  // 2. Cross-reference with LaTeX output for extra confidence
  //    If both text and latex agree on a "wrong" number, that's stronger evidence
  //    the student actually wrote that number (not an OCR error).
  var latexTokens = null;
  if (opts.latexText) {
    latexTokens = extractNumericTokens_(opts.latexText);
  }

  // 3. Find near-misses
  var nearMisses = ocrFindNearMisses(ocrText, expected);
  msaLog_('[OCR_VERIFY] Found ' + nearMisses.length + ' near-miss(es)');

  // 4. Cross-check each near-miss against the latex output (if available)
  nearMisses.forEach(function(nm) {
    nm.latexAgreement = null;
    if (latexTokens) {
      // Does the LATEX output also have the same "wrong" number?
      var latexHasOcrValue = latexTokens.some(function(lt) { return lt.raw === nm.ocrValue; });
      // Does the LATEX output have the expected (correct) number?
      var latexHasExpected = latexTokens.some(function(lt) { return lt.raw === nm.expectedValue; });

      if (latexHasExpected) {
        // LaTeX got it right — strong evidence the OCR text is wrong
        nm.confidence = Math.min(1.0, nm.confidence * 1.5);
        nm.latexAgreement = 'latex_has_correct';
      } else if (latexHasOcrValue) {
        // Both OCR outputs agree on the "wrong" value — maybe the student actually wrote it
        nm.confidence *= 0.4;
        nm.latexAgreement = 'both_agree_on_ocr_value';
      }
    }
  });

  // 5. Apply corrections (or flag them)
  var correctedText = ocrText;
  var corrections = [];
  var stats = { checked: expected.length, corrected: 0, flagged: 0 };

  // Sort near-misses by position descending so we can replace from end to start
  // without invalidating earlier offsets.
  nearMisses.sort(function(a, b) { return b.ocrPosition.start - a.ocrPosition.start; });

  nearMisses.forEach(function(nm) {
    var action;
    if (nm.latexAgreement === 'both_agree_on_ocr_value') {
      // Both OCR engines say the same thing — student probably wrote this
      action = 'keep_original';
    } else if (nm.confidence >= threshold && !dryRun) {
      action = 'auto_corrected';
      // Replace the OCR value with the expected value
      correctedText = correctedText.substring(0, nm.ocrPosition.start) +
                      nm.expectedValue +
                      correctedText.substring(nm.ocrPosition.end);
      stats.corrected++;
    } else {
      action = 'flagged_for_review';
      stats.flagged++;
    }

    corrections.push({
      ocrValue: nm.ocrValue,
      expectedValue: nm.expectedValue,
      variable: nm.variable,
      confidence: nm.confidence,
      action: action,
      pointId: nm.pointId,
      part: nm.part,
      confusedChars: nm.confusedChars,
      latexAgreement: nm.latexAgreement,
      explanation: buildCorrectionExplanation_(nm, action)
    });
  });

  // Log corrections
  corrections.forEach(function(c) {
    var level = c.action === 'auto_corrected' ? 'CORRECTED' :
                c.action === 'flagged_for_review' ? 'FLAGGED' : 'KEPT';
    msaLog_('[OCR_VERIFY] ' + level + ': "' + c.ocrValue + '" → "' + c.expectedValue +
      '" (conf=' + c.confidence.toFixed(2) + ', ' + c.explanation + ')');
  });

  return {
    correctedText: correctedText,
    corrections: corrections,
    stats: stats,
    originalText: ocrText
  };
}


/* ═══════════════════════════════════════════════════════
 * 5.  HUMAN-READABLE EXPLANATION BUILDER
 * ═══════════════════════════════════════════════════════ */

/**
 * Build a short human-readable explanation of a correction.
 */
function buildCorrectionExplanation_(nm, action) {
  var chars = (nm.confusedChars || []).map(function(c) {
    if (c.type === 'missing_digit') {
      return 'missing digit "' + c.expectedChar + '"';
    }
    if (c.type === 'extra_digit') {
      return 'extra digit "' + c.ocrChar + '"';
    }
    return '"' + c.ocrChar + '" looks like "' + c.expectedChar + '" in handwriting (shape weight ' + c.weight.toFixed(2) + ')';
  });

  var base = chars.join('; ');

  if (nm.latexAgreement === 'both_agree_on_ocr_value') {
    base += ' — but both OCR engines agree on "' + nm.ocrValue + '", so the student probably wrote this value';
  } else if (nm.latexAgreement === 'latex_has_correct') {
    base += ' — LaTeX OCR output has the correct value, strengthening the correction';
  }

  return base;
}


/* ═══════════════════════════════════════════════════════
 * 6.  INTEGRATION HOOK — call from grading pipeline
 * ═══════════════════════════════════════════════════════ */

/**
 * Convenience wrapper that runs OCR verify on student text before grading.
 * Designed to be called from gradeStudentWork() in WebApp.js.
 *
 * @param {string}  studentOcrText    Raw OCR text
 * @param {string}  latexStyledText   LaTeX-styled OCR text (or null)
 * @param {Array}   markschemePoints  Parsed mark-scheme points
 * @param {object}  [opts]            Pass-through options
 * @returns {object} { verifiedText, corrections[], stats }
 */
function ocrVerifyStudentWork(studentOcrText, latexStyledText, markschemePoints, opts) {
  opts = opts || {};
  opts.latexText = latexStyledText || null;

  msaLog_('=== OCR VERIFICATION PASS START ===');
  var result = ocrVerifyAndCorrect(studentOcrText, markschemePoints, opts);
  msaLog_('=== OCR VERIFICATION PASS END === corrections=' + result.stats.corrected +
    ', flagged=' + result.stats.flagged);

  return {
    verifiedText: result.correctedText,
    corrections: result.corrections,
    stats: result.stats,
    originalText: result.originalText
  };
}
