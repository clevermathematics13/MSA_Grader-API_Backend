/**
 * MSA Grader – Student Profile Tests
 *
 * Tests for the writer-adaptive per-student OCR correction engine
 * defined in StudentOCR_Profile.js.  These are pure-logic tests
 * that don't need any Google Apps Script services.
 *
 * Run: npm test -- student_profile
 */

// ── Reproduce pure-logic functions from StudentOCR_Profile.js ──────

/**
 * Levenshtein edit distance (same as StudentOCR_Profile.js)
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
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Fuzzy rule application (same as StudentOCR_Profile.js)
 */
function fuzzyApplyRule_(text, rule, maxDist) {
  var pattern = rule.pattern;
  var replacement = rule.replacement;

  if (pattern.length < 5) return { text: text, count: 0, matches: [] };

  var pLen = pattern.length;
  var tokens = text.split(/(\s+)/);
  var rebuilt = [];
  var matchCount = 0;
  var matchDetails = [];

  for (var t = 0; t < tokens.length; t++) {
    var token = tokens[t];
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

/**
 * Safety guard: patterns that should be blocked from saving.
 * Reproduces the guard logic from saveStudentCorrections_().
 */
function shouldBlockPattern(correction) {
  var c = correction;
  if (!c.original && !c.corrected) return true;
  if (c.original === c.corrected) return true;
  if (c.type === 'insert') return true;
  if ((c.original || '').length > 100) return true;

  if (c.type === 'delete' && (c.original || '').length <= 3) {
    var hasCJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(c.original);
    if (!hasCJK) return true;
  }

  var UNSAFE = /^(\\?[a-zA-Z]|\d|[+\-=()\[\]{}.,;:!?\/<>|\\])$/;
  if (UNSAFE.test((c.original || '').trim())) return true;

  if (c.original && c.corrected &&
      c.original.length === 1 && c.corrected.length === 1 &&
      c.original.toLowerCase() === c.corrected.toLowerCase()) return true;

  return false;
}

/**
 * Exact-match rule application.
 * Reproduces the core loop from applyStudentCorrections_().
 */
function applyExactRules(text, rules) {
  var applied = [];
  var totalReplacements = 0;

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule.pattern) continue;

    var escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re;
    try {
      re = new RegExp(escaped, 'g');
    } catch (e) { continue; }

    var matches = text.match(re);
    if (matches && matches.length > 0) {
      text = text.replace(re, rule.replacement);
      applied.push({
        pattern: rule.pattern,
        replacement: rule.replacement,
        count: matches.length,
        frequency: rule.frequency
      });
      totalReplacements += matches.length;
    }
  }

  return { text: text, applied: applied, totalReplacements: totalReplacements };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('levenshteinDistance_', () => {
  test('identical strings → 0', () => {
    expect(levenshteinDistance_('alpha', 'alpha')).toBe(0);
  });

  test('empty vs non-empty', () => {
    expect(levenshteinDistance_('', 'abc')).toBe(3);
    expect(levenshteinDistance_('abc', '')).toBe(3);
  });

  test('single substitution', () => {
    // "kitten" → "sitten" = 1 sub
    expect(levenshteinDistance_('kitten', 'sitten')).toBe(1);
  });

  test('classic kitten → sitting = 3', () => {
    expect(levenshteinDistance_('kitten', 'sitting')).toBe(3);
  });

  test('one insertion', () => {
    expect(levenshteinDistance_('abc', 'abcd')).toBe(1);
  });

  test('one deletion', () => {
    expect(levenshteinDistance_('abcd', 'abc')).toBe(1);
  });

  test('LaTeX-relevant: \\alpha vs \\Alpha (case diff in one char)', () => {
    expect(levenshteinDistance_('\\alpha', '\\Alpha')).toBe(1);
  });

  test('digit confusion: 2835 vs 2885', () => {
    expect(levenshteinDistance_('2835', '2885')).toBe(1);
  });
});

describe('fuzzyApplyRule_', () => {
  test('replaces token within edit distance', () => {
    // \aplha → \alpha is a transposition (distance 2 in standard Levenshtein)
    var result = fuzzyApplyRule_(
      'the answer is \\aplha = 5',
      { pattern: '\\alpha', replacement: '\\alpha' },
      2 // transposition = 2 edits in standard Levenshtein
    );
    expect(result.count).toBe(1);
    expect(result.text).toContain('\\alpha');
    expect(result.matches[0].found).toBe('\\aplha');
    expect(result.matches[0].distance).toBe(2);
  });

  test('does NOT match if distance > maxDist', () => {
    var result = fuzzyApplyRule_(
      'the answer is \\apxxha = 5',
      { pattern: '\\alpha', replacement: '\\alpha' },
      1
    );
    expect(result.count).toBe(0);
  });

  test('skips patterns shorter than 5 chars (too risky)', () => {
    var result = fuzzyApplyRule_(
      'x = 5',
      { pattern: 'x', replacement: 'y' },
      1
    );
    expect(result.count).toBe(0);
    expect(result.text).toBe('x = 5');
  });

  test('handles multiple fuzzy matches in one text', () => {
    var result = fuzzyApplyRule_(
      '\\aplha + \\aplha = 10',
      { pattern: '\\alpha', replacement: '\\alpha' },
      2 // transposition = 2 edits
    );
    expect(result.count).toBe(2);
  });

  test('single substitution (true distance-1)', () => {
    // \betta → \betta has 'tt' instead of 'ta' — distance 1
    var result = fuzzyApplyRule_(
      'x = \\betaa',
      { pattern: '\\betab', replacement: '\\betab' },
      1
    );
    expect(result.count).toBe(1);
    expect(result.matches[0].distance).toBe(1);
  });

  test('does NOT touch exact matches (dist must be > 0)', () => {
    var result = fuzzyApplyRule_(
      'the value is \\alpha = 3',
      { pattern: '\\alpha', replacement: '\\beta' },
      1
    );
    // exact match has dist=0 which is excluded from fuzzy (that's the exact pass's job)
    expect(result.count).toBe(0);
  });
});

describe('shouldBlockPattern (safety guards)', () => {
  test('blocks empty patterns', () => {
    expect(shouldBlockPattern({ original: '', corrected: '', type: 'replace' })).toBe(true);
  });

  test('blocks identical patterns', () => {
    expect(shouldBlockPattern({ original: 'abc', corrected: 'abc', type: 'replace' })).toBe(true);
  });

  test('blocks pure insertions', () => {
    expect(shouldBlockPattern({ original: '', corrected: 'new text', type: 'insert' })).toBe(true);
  });

  test('blocks very long patterns (>100 chars)', () => {
    var long = 'a'.repeat(101);
    expect(shouldBlockPattern({ original: long, corrected: 'short', type: 'replace' })).toBe(true);
  });

  test('blocks short deletion: single digit', () => {
    expect(shouldBlockPattern({ original: '1', corrected: '', type: 'delete' })).toBe(true);
  });

  test('blocks short deletion: "M"', () => {
    expect(shouldBlockPattern({ original: 'M', corrected: '', type: 'delete' })).toBe(true);
  });

  test('allows CJK deletion even if short', () => {
    expect(shouldBlockPattern({ original: '演', corrected: '', type: 'delete' })).toBe(false);
  });

  test('blocks single-token LaTeX command: \\x', () => {
    expect(shouldBlockPattern({ original: '\\x', corrected: '', type: 'delete' })).toBe(true);
  });

  test('blocks single operator: +', () => {
    expect(shouldBlockPattern({ original: '+', corrected: '', type: 'delete' })).toBe(true);
  });

  test('blocks case-only single-char diff', () => {
    expect(shouldBlockPattern({ original: 'a', corrected: 'A', type: 'replace' })).toBe(true);
  });

  test('allows legitimate multi-token replacement', () => {
    expect(shouldBlockPattern({ original: '\\quad M 1', corrected: '', type: 'delete' })).toBe(false);
  });

  test('allows legitimate substitution: \\aplha → \\alpha', () => {
    expect(shouldBlockPattern({ original: '\\aplha', corrected: '\\alpha', type: 'replace' })).toBe(false);
  });

  test('allows numeric correction: 2885 → 2835', () => {
    expect(shouldBlockPattern({ original: '2885', corrected: '2835', type: 'replace' })).toBe(false);
  });
});

describe('applyExactRules', () => {
  test('applies a single rule', () => {
    var rules = [{ pattern: '\\aplha', replacement: '\\alpha', frequency: 3 }];
    var result = applyExactRules('x = \\aplha + \\aplha', rules);
    expect(result.text).toBe('x = \\alpha + \\alpha');
    expect(result.totalReplacements).toBe(2);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].count).toBe(2);
  });

  test('applies multiple rules in sequence', () => {
    var rules = [
      { pattern: '\\aplha', replacement: '\\alpha', frequency: 5 },
      { pattern: '\\bata', replacement: '\\beta', frequency: 2 }
    ];
    var result = applyExactRules('\\aplha + \\bata = 3', rules);
    expect(result.text).toBe('\\alpha + \\beta = 3');
    expect(result.applied).toHaveLength(2);
  });

  test('handles regex special characters in patterns', () => {
    var rules = [{ pattern: '\\frac{a}{b}', replacement: '\\frac{x}{y}', frequency: 1 }];
    var result = applyExactRules('answer: \\frac{a}{b}', rules);
    expect(result.text).toBe('answer: \\frac{x}{y}');
  });

  test('no match → text unchanged', () => {
    var rules = [{ pattern: 'NONEXISTENT', replacement: 'XXX', frequency: 1 }];
    var result = applyExactRules('nothing matches here', rules);
    expect(result.text).toBe('nothing matches here');
    expect(result.applied).toHaveLength(0);
  });

  test('deletion rule (empty replacement)', () => {
    var rules = [{ pattern: '\\quad M 1', replacement: '', frequency: 4 }];
    var result = applyExactRules('x = 5 \\quad M 1', rules);
    expect(result.text).toBe('x = 5 ');
    expect(result.totalReplacements).toBe(1);
  });

  test('student-specific: consistently writes a as α', () => {
    // This student always writes "a" where they mean alpha,
    // but only in a specific LaTeX context
    var rules = [{ pattern: '= a +', replacement: '= \\alpha +', frequency: 7 }];
    var result = applyExactRules('y = a + b', rules);
    expect(result.text).toBe('y = \\alpha + b');
  });
});

describe('end-to-end: student profile correction flow', () => {
  test('simulates a student with known handwriting quirks', () => {
    // Student "jsmith" consistently:
    // 1. Writes alpha as "aplha" (Mathpix misread)
    // 2. Has mark annotations leak through OCR
    // 3. Uses a distinctive fraction style that Mathpix misreads
    var studentRules = [
      { pattern: '\\aplha', replacement: '\\alpha', frequency: 8 },
      { pattern: '\\quad M 1', replacement: '', frequency: 5 },
      { pattern: '\\frac(', replacement: '\\frac{', frequency: 3 }
    ];

    var ocrText = '\\aplha = \\frac(x}{2} \\quad M 1';

    // Apply exact rules (simulating applyStudentCorrections_)
    var result = applyExactRules(ocrText, studentRules);

    expect(result.text).toBe('\\alpha = \\frac{x}{2} ');
    expect(result.applied).toHaveLength(3);
    expect(result.totalReplacements).toBe(3);
  });

  test('different students get different corrections', () => {
    // Student A always writes theta as "thata"
    var studentA_rules = [
      { pattern: '\\thata', replacement: '\\theta', frequency: 6 }
    ];

    // Student B always writes theta correctly but misses subscripts
    var studentB_rules = [
      { pattern: 'x1', replacement: 'x_1', frequency: 4 }
    ];

    var ocrText = '\\thata = x1 + 5';

    var resultA = applyExactRules(ocrText, studentA_rules);
    expect(resultA.text).toBe('\\theta = x1 + 5');   // only fixes theta

    var resultB = applyExactRules(ocrText, studentB_rules);
    expect(resultB.text).toBe('\\thata = x_1 + 5');  // only fixes subscript
  });
});
