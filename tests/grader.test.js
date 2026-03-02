/**
 * MSA Grader – Starter Tests
 *
 * These tests exercise pure-logic helpers that don't depend on
 * Google Apps Script services (DriveApp, SpreadsheetApp, etc.).
 * They run in Node.js via Jest on every push through GitHub Actions.
 */

// ── Helpers that mirror logic in the GAS codebase ──────────────────

/**
 * Normalise LaTeX / math text for comparison.
 * Mirrors the lightweight normaliser used in SRG_Grader & GradingAI.
 */
function normaliseExpression(expr) {
  if (!expr) return "";
  return expr
    .replace(/\\text\{([^}]*)\}/g, "$1")  // strip \text{}
    .replace(/\\left|\\right/g, "")        // strip \left \right
    .replace(/\s+/g, "")                   // collapse whitespace
    .toLowerCase();
}

/**
 * Compare two numeric values with a tolerance.
 * Returns true when |a - b| <= tol.
 */
function numericMatch(a, b, tol) {
  if (tol === undefined) tol = 0.001;
  return Math.abs(a - b) <= tol;
}

/**
 * Determine if a mark type is an "implied" (answer) mark.
 * IB convention: A1, (A1), AG, etc.
 */
function isImpliedMark(markType) {
  if (!markType) return false;
  const mt = markType.trim().toUpperCase();
  return /^\(?A\d\)?$/.test(mt) || mt === "AG";
}

/**
 * Select the best scoring method per part.
 * Given an array of { part, method, score } objects, returns
 * only the entries belonging to the highest-scoring method for
 * each part.
 */
function selectBestMethods(entries) {
  const methodTotals = {};
  entries.forEach(function (e) {
    const key = (e.part || "") + "|" + (e.method || "1");
    methodTotals[key] = (methodTotals[key] || 0) + (e.score || 0);
  });

  // For each part, find the method with the highest total
  const bestMethod = {};
  Object.keys(methodTotals).forEach(function (key) {
    const part = key.split("|")[0];
    const method = key.split("|")[1];
    if (!bestMethod[part] || methodTotals[key] > methodTotals[bestMethod[part].key]) {
      bestMethod[part] = { method: method, key: key };
    }
  });

  return entries.filter(function (e) {
    const part = e.part || "";
    const method = e.method || "1";
    return bestMethod[part] && bestMethod[part].method === method;
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("normaliseExpression", () => {
  test("strips \\text{} wrappers", () => {
    expect(normaliseExpression("\\text{hello}")).toBe("hello");
  });

  test("strips \\left and \\right", () => {
    expect(normaliseExpression("\\left(x\\right)")).toBe("(x)");
  });

  test("collapses whitespace and lowercases", () => {
    expect(normaliseExpression("  A  +  B  ")).toBe("a+b");
  });

  test("handles empty / null input", () => {
    expect(normaliseExpression("")).toBe("");
    expect(normaliseExpression(null)).toBe("");
    expect(normaliseExpression(undefined)).toBe("");
  });
});

describe("numericMatch", () => {
  test("exact match", () => {
    expect(numericMatch(27, 27)).toBe(true);
  });

  test("within tolerance", () => {
    expect(numericMatch(27.0001, 27, 0.001)).toBe(true);
  });

  test("outside tolerance", () => {
    expect(numericMatch(27.01, 27, 0.001)).toBe(false);
  });

  test("negative numbers", () => {
    expect(numericMatch(-3, -3.0005, 0.001)).toBe(true);
  });
});

describe("isImpliedMark", () => {
  test("recognises A1", () => {
    expect(isImpliedMark("A1")).toBe(true);
  });

  test("recognises (A1)", () => {
    expect(isImpliedMark("(A1)")).toBe(true);
  });

  test("recognises AG", () => {
    expect(isImpliedMark("AG")).toBe(true);
  });

  test("rejects M1", () => {
    expect(isImpliedMark("M1")).toBe(false);
  });

  test("rejects null / empty", () => {
    expect(isImpliedMark(null)).toBe(false);
    expect(isImpliedMark("")).toBe(false);
  });
});

describe("selectBestMethods", () => {
  test("picks the higher-scoring method per part", () => {
    const entries = [
      { part: "a", method: "1", score: 2 },
      { part: "a", method: "1", score: 1 },
      { part: "a", method: "2", score: 1 },
      { part: "a", method: "2", score: 0 },
      { part: "b", method: "1", score: 3 },
    ];
    const result = selectBestMethods(entries);
    // Method 1 for part a has total 3, method 2 has total 1 → keep method 1
    expect(result).toEqual([
      { part: "a", method: "1", score: 2 },
      { part: "a", method: "1", score: 1 },
      { part: "b", method: "1", score: 3 },
    ]);
  });

  test("handles single method gracefully", () => {
    const entries = [
      { part: "ai", method: "1", score: 1 },
      { part: "ai", method: "1", score: 1 },
    ];
    const result = selectBestMethods(entries);
    expect(result).toHaveLength(2);
  });
});


// ── Part-segmentation helper (mirrors SRG_Grader.js getTextForPart_) ──

function getTextForPart_(studentText, partLabel) {
  if (!partLabel || !studentText) return studentText;
  var mainPart = partLabel.charAt(0).toLowerCase();
  var lines = studentText.split('\n');
  var partBoundaries = [];
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/\(\s*([a-z])\s*\)/i);
    if (m) {
      var part = m[1].toLowerCase();
      var alreadySeen = partBoundaries.some(function(b) { return b.part === part; });
      if (!alreadySeen) {
        partBoundaries.push({ part: part, lineIdx: i });
      }
    }
  }
  if (partBoundaries.length === 0) return studentText;
  var targetIdx = -1;
  for (var j = 0; j < partBoundaries.length; j++) {
    if (partBoundaries[j].part === mainPart) { targetIdx = j; break; }
  }
  if (targetIdx === -1) return studentText;
  var startLine = partBoundaries[targetIdx].lineIdx;
  var endLine = lines.length;
  if (targetIdx + 1 < partBoundaries.length) {
    endLine = partBoundaries[targetIdx + 1].lineIdx;
  }
  return lines.slice(startLine, endLine).join('\n');
}

describe("getTextForPart_", () => {
  const studentText = [
    '(a) (i)',
    'u_n = 7n + 7',
    'n = 27',
    'S_{13} = 728',
    '(a)(ii)',
    'sum stuff here',
    '(b)',
    'u_n = 1000 + (n-1)(-6)',
    'n = 335',
    'n = 1003',
    '3n = 1003'
  ].join('\n');

  test("extracts part (a) segment up to part (b)", () => {
    const seg = getTextForPart_(studentText, 'ai');
    expect(seg).toContain('n = 27');
    expect(seg).toContain('sum stuff here');
    expect(seg).not.toContain('n = 335');
    expect(seg).not.toContain('n = 1003');
  });

  test("extracts part (b) segment to end", () => {
    const seg = getTextForPart_(studentText, 'b');
    expect(seg).toContain('n = 335');
    expect(seg).toContain('n = 1003');
    expect(seg).not.toContain('n = 27');
  });

  test("returns full text when no part markers found", () => {
    const plainText = 'just some text\nno markers';
    expect(getTextForPart_(plainText, 'ai')).toBe(plainText);
  });

  test("returns full text when target part not found", () => {
    expect(getTextForPart_(studentText, 'c')).toBe(studentText);
  });

  test("handles null/empty gracefully", () => {
    expect(getTextForPart_(null, 'a')).toBeNull();
    expect(getTextForPart_('text', '')).toBe('text');
    expect(getTextForPart_('text', null)).toBe('text');
  });
});

describe("part-aware numeric matching (anti cross-part leak)", () => {
  // Simulate the exact scenario from the user's screenshot:
  // Student writes n=27 in part (a)(i) and n=335, 1003 in part (b).
  // A Method 3 requirement for part (ai) should NOT match 1003 from part (b).
  const studentText = [
    '(a) (i)',
    'u_n = 7n + 7',
    'n = 27',
    'S = 2835',
    '(b)',
    'u_n = 1000 + (n-1)(-6)',
    'n = 335',
    '3n = 1003',
  ].join('\n');

  test("part (ai) segment contains 27 and 2835 but NOT 1003 or 335", () => {
    const seg = getTextForPart_(studentText, 'ai');
    const nums = (seg.match(/-?\d+(\.\d+)?/g) || []);
    expect(nums).toContain('27');
    expect(nums).toContain('2835');
    expect(nums).not.toContain('1003');
    expect(nums).not.toContain('335');
  });

  test("part (b) segment contains 335 and 1003 but NOT 27 or 2835", () => {
    const seg = getTextForPart_(studentText, 'b');
    const nums = (seg.match(/-?\d+(\.\d+)?/g) || []);
    expect(nums).toContain('335');
    expect(nums).toContain('1003');
    expect(nums).not.toContain('27');
    expect(nums).not.toContain('2835');
  });
});
