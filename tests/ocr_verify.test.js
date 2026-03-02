/**
 * MSA Grader – OCR Verification Tests
 *
 * Tests for the shape-based glyph-confusion OCR verification pass
 * defined in OCR_Verify.js.  These are pure-logic tests that don't
 * need any Google Apps Script services.
 */

// ── Reproduce the functions from OCR_Verify.js ─────────────────

// Glyph confusion matrix (same as the GAS file)
var GLYPH_CONFUSION = {
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
  'x': [{ g: '×', w: 0.80 }, { g: 'X', w: 0.55 }],
  'X': [{ g: '×', w: 0.65 }, { g: 'x', w: 0.55 }],
  '×': [{ g: 'x', w: 0.80 }, { g: 'X', w: 0.65 }],
  '-': [{ g: '−', w: 0.90 }, { g: '–', w: 0.85 }, { g: '—', w: 0.60 }],
  '−': [{ g: '-', w: 0.90 }, { g: '–', w: 0.85 }],
  '+': [{ g: 't', w: 0.15 }],
  '=': [{ g: '≡', w: 0.30 }, { g: '≈', w: 0.20 }]
};

function glyphConfusionWeight_(a, b) {
  if (a === b) return 1.0;
  var entry = GLYPH_CONFUSION[a];
  if (entry) {
    for (var i = 0; i < entry.length; i++) {
      if (entry[i].g === b) return entry[i].w;
    }
  }
  var entryB = GLYPH_CONFUSION[b];
  if (entryB) {
    for (var j = 0; j < entryB.length; j++) {
      if (entryB[j].g === a) return entryB[j].w;
    }
  }
  return 0;
}

function shapeSimilarityScore_(ocrStr, expectedStr) {
  if (ocrStr.length !== expectedStr.length) return 0;
  var score = 1.0;
  var diffCount = 0;
  var confusedChars = [];
  for (var i = 0; i < ocrStr.length; i++) {
    var oc = ocrStr[i];
    var ec = expectedStr[i];
    if (oc === ec) continue;
    diffCount++;
    var w = glyphConfusionWeight_(oc, ec);
    if (w === 0) return 0;
    score *= w;
    confusedChars.push({ position: i, ocrChar: oc, expectedChar: ec, weight: w });
  }
  if (diffCount === 0) return 1.0;
  if (diffCount > 2) return 0;
  return { score: score, diffCount: diffCount, confusedChars: confusedChars };
}

function extractNumericTokens_(text) {
  var re = /-?\d+(?:\.\d+)?/g;
  var tokens = [];
  var m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ value: parseFloat(m[0]), raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function extractExpectedValues_(markschemePoints) {
  var expected = [];
  var seenValues = {};
  (markschemePoints || []).forEach(function(point) {
    var req = String(point.requirement || '');
    var nums = req.match(/-?\d+(?:\.\d+)?/g) || [];
    nums.forEach(function(n) {
      if (!seenValues[n]) {
        seenValues[n] = true;
        expected.push({ raw: n, value: parseFloat(n), pointId: point.id || '', part: point.part || '', requirement: req });
      }
    });
  });
  return expected;
}

function ocrFindNearMisses(ocrText, expected) {
  var ocrTokens = extractNumericTokens_(ocrText);
  var nearMisses = [];

  // Build set of ALL expected values for the "is this already correct?" guard
  var expectedSet = {};
  expected.forEach(function(e) { expectedSet[e.raw] = true; });

  expected.forEach(function(exp) {
    var expectedStr = exp.raw;
    var exactRe = new RegExp('(?<![\\d.])' + expectedStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\d.])', 'g');
    if (exactRe.test(ocrText)) return;

    ocrTokens.forEach(function(tok) {
      // CRITICAL GUARD: If the OCR token is itself an expected mark-scheme value,
      // do NOT flag it as a near-miss for some other expected value.
      if (expectedSet[tok.raw]) return;

      // Only compare same-length tokens (no insertion/deletion)
      var lenDiff = Math.abs(tok.raw.length - expectedStr.length);
      if (lenDiff > 0) return;

      var result = shapeSimilarityScore_(tok.raw, expectedStr);

      if (result && result.score > 0) {
        nearMisses.push({
          ocrValue: tok.raw,
          expectedValue: expectedStr,
          confidence: result.score,
          diffCount: result.diffCount,
          confusedChars: result.confusedChars
        });
      }
    });
  });

  nearMisses.sort(function(a, b) { return b.confidence - a.confidence; });

  // Cap at 10
  return nearMisses.slice(0, 10);
}


// ── Tests ──────────────────────────────────────────────────────────

describe("glyphConfusionWeight_", () => {
  test("identical characters return 1.0", () => {
    expect(glyphConfusionWeight_('5', '5')).toBe(1.0);
  });

  test("1 ↔ 7 is highly confusable", () => {
    const w = glyphConfusionWeight_('1', '7');
    expect(w).toBeGreaterThanOrEqual(0.6);
  });

  test("3 ↔ 8 is confusable", () => {
    expect(glyphConfusionWeight_('3', '8')).toBeGreaterThan(0);
  });

  test("5 ↔ 6 is confusable", () => {
    expect(glyphConfusionWeight_('5', '6')).toBeGreaterThan(0);
  });

  test("1 ↔ l (letter ell) is confusable", () => {
    expect(glyphConfusionWeight_('1', 'l')).toBeGreaterThanOrEqual(0.7);
  });

  test("reverse lookup works (7 → 1)", () => {
    const forward = glyphConfusionWeight_('1', '7');
    const reverse = glyphConfusionWeight_('7', '1');
    expect(forward).toBe(reverse);
  });

  test("completely different glyphs return 0", () => {
    expect(glyphConfusionWeight_('1', '5')).toBe(0);
  });

  test("0 ↔ O is the highest digit/letter confusion", () => {
    expect(glyphConfusionWeight_('0', 'O')).toBeGreaterThanOrEqual(0.7);
  });
});


describe("shapeSimilarityScore_", () => {
  test("identical strings return 1.0", () => {
    expect(shapeSimilarityScore_("27", "27")).toBe(1.0);
  });

  test("single-digit confusion: 21 vs 27 (1↔7)", () => {
    const result = shapeSimilarityScore_("21", "27");
    expect(result).not.toBe(0);
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.diffCount).toBe(1);
    expect(result.confusedChars[0].ocrChar).toBe("1");
    expect(result.confusedChars[0].expectedChar).toBe("7");
  });

  test("double-digit confusion: 18 vs 73 (1↔7, 8↔3)", () => {
    const result = shapeSimilarityScore_("18", "73");
    expect(result).not.toBe(0);
    expect(result.diffCount).toBe(2);
  });

  test("different lengths return 0", () => {
    expect(shapeSimilarityScore_("27", "127")).toBe(0);
  });

  test("non-confusable chars return 0", () => {
    expect(shapeSimilarityScore_("55", "27")).toBe(0);
  });

  test("three-char diff returns 0 (too many diffs)", () => {
    // "138" vs "720": 1→7, 3→2, 8→0 = 3 diffs → 0
    expect(shapeSimilarityScore_("138", "720")).toBe(0);
  });
});


describe("extractNumericTokens_", () => {
  test("extracts integers", () => {
    const tokens = extractNumericTokens_("n = 27 and S = 2835");
    expect(tokens).toHaveLength(2);
    expect(tokens[0].raw).toBe("27");
    expect(tokens[1].raw).toBe("2835");
  });

  test("extracts decimals", () => {
    const tokens = extractNumericTokens_("x = 3.14");
    expect(tokens[0].raw).toBe("3.14");
    expect(tokens[0].value).toBeCloseTo(3.14);
  });

  test("extracts negative numbers", () => {
    const tokens = extractNumericTokens_("y = -7");
    expect(tokens[0].raw).toBe("-7");
    expect(tokens[0].value).toBe(-7);
  });

  test("tracks positions correctly", () => {
    const tokens = extractNumericTokens_("abc 42 def");
    expect(tokens[0].start).toBe(4);
    expect(tokens[0].end).toBe(6);
  });
});


describe("ocrFindNearMisses", () => {
  test("no near-miss when exact match exists", () => {
    const ocrText = "n = 27, S = 2835";
    const expected = [{ raw: "27", value: 27, pointId: "P1", part: "a", requirement: "n=27" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses).toHaveLength(0);
  });

  test("detects 21 → 27 (1↔7 confusion)", () => {
    const ocrText = "n = 21, S = 2835";
    const expected = [{ raw: "27", value: 27, pointId: "P1", part: "a", requirement: "n=27" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses.length).toBeGreaterThanOrEqual(1);
    const hit = misses.find(m => m.ocrValue === "21" && m.expectedValue === "27");
    expect(hit).toBeDefined();
    expect(hit.confidence).toBeGreaterThan(0.5);
  });

  test("detects 2835 → 2835 is an exact match (no near-miss)", () => {
    const ocrText = "S = 2835";
    const expected = [{ raw: "2835", value: 2835, pointId: "P2", part: "a", requirement: "S=2835" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses).toHaveLength(0);
  });

  test("detects 2835 → 2885 (3↔8 confusion)", () => {
    const ocrText = "S = 2885";
    const expected = [{ raw: "2835", value: 2835, pointId: "P2", part: "a", requirement: "S=2835" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses.length).toBeGreaterThanOrEqual(1);
    expect(misses[0].ocrValue).toBe("2885");
    expect(misses[0].expectedValue).toBe("2835");
  });

  test("no false positive for completely different number", () => {
    const ocrText = "x = 999";
    const expected = [{ raw: "27", value: 27, pointId: "P1", part: "a", requirement: "n=27" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses).toHaveLength(0);
  });

  test("handles multiple expected values", () => {
    const ocrText = "(a)(i) n = 21\n(a)(ii) S = 2835";
    const expected = [
      { raw: "27", value: 27, pointId: "P1", part: "ai", requirement: "n=27" },
      { raw: "2835", value: 2835, pointId: "P2", part: "aii", requirement: "S=2835" }
    ];
    const misses = ocrFindNearMisses(ocrText, expected);
    // 27 is not present but 21 is a near-miss for 27; 2835 is an exact match
    expect(misses).toHaveLength(1);
    expect(misses[0].ocrValue).toBe("21");
    expect(misses[0].expectedValue).toBe("27");
  });

  test("does NOT flag OCR value that is itself a mark-scheme value", () => {
    // Student wrote 1003 correctly — mark scheme expects both 1003 AND 196.
    // Old logic would flag 1003 as a near-miss for 196 (same length, shape confusion).
    // New logic: 1003 is IN expectedSet, so it must not be flagged at all.
    const ocrText = "The answer is 1003";
    const expected = [
      { raw: "1003", value: 1003, pointId: "P1", part: "a", requirement: "n=1003" },
      { raw: "1006", value: 1006, pointId: "P2", part: "b", requirement: "S=1006" }
    ];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses).toHaveLength(0);
  });

  test("different-length tokens are NOT flagged (no insertion/deletion)", () => {
    // 7 should not be flagged as a near-miss for 27 (different lengths)
    const ocrText = "x = 7";
    const expected = [{ raw: "27", value: 27, pointId: "P1", part: "a", requirement: "n=27" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses).toHaveLength(0);
  });

  test("caps results at 10", () => {
    // Generate a text with many tokens that are all same-length near-misses
    const tokens = [];
    for (let i = 10; i < 30; i++) tokens.push(i);
    const ocrText = tokens.join(" ");
    // Expected value that none of these match exactly
    const expected = [{ raw: "18", value: 18, pointId: "P1", part: "a", requirement: "n=18" }];
    const misses = ocrFindNearMisses(ocrText, expected);
    expect(misses.length).toBeLessThanOrEqual(10);
  });
});


describe("extractExpectedValues_", () => {
  test("pulls numbers from requirement text", () => {
    const points = [
      { id: "P1", part: "a", requirement: "n = 27" },
      { id: "P2", part: "a", requirement: "S_{27} = 2835" }
    ];
    const vals = extractExpectedValues_(points);
    const raws = vals.map(v => v.raw);
    expect(raws).toContain("27");
    expect(raws).toContain("2835");
  });

  test("de-duplicates same number across points", () => {
    const points = [
      { id: "P1", requirement: "27" },
      { id: "P2", requirement: "27" }
    ];
    const vals = extractExpectedValues_(points);
    expect(vals).toHaveLength(1);
  });
});
