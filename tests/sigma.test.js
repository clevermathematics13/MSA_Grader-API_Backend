/**
 * MSA Grader – Sigma Expression Equivalence Tests
 *
 * Tests for the sigma/summation equivalence checker added to
 * SRG_Grader.js.  These verify that algebraically equivalent
 * sigma expressions with different index variables, bounds, or
 * integrand forms are correctly detected.
 */

// ── Reproduce the functions from SRG_Grader.js ─────────────────

function normaliseBody_(raw, v) {
  var s = raw
    .replace(/^\(|\)$/g, '')
    .replace(/\s+/g, '')
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '(($1)/($2))')
    .replace(/\\left|\\right/g, '')
    .replace(/[{}]/g, '');
  var re = new RegExp('(\\d)(' + v + ')', 'g');
  s = s.replace(re, '$1*$2');
  re = new RegExp('(' + v + ')(\\d)', 'g');
  s = s.replace(re, '$1*$2');
  return s;
}

function parseSigmaExpression_(text) {
  if (!text) return null;
  var t = String(text)
    .replace(/\\sum\\limits/g, '∑')
    .replace(/\\sum/g, '∑')
    .replace(/Σ/g, '∑')
    .replace(/\\left|\\right/g, '')
    .replace(/\\cdot/g, '*')
    .replace(/\\times/g, '*')
    .replace(/\\{|\\}/g, '')
    .replace(/\s+/g, ' ');

  var patA = /∑\s*_?\s*\{?\s*([a-zA-Z])\s*=\s*(-?\d+)\s*\}?\s*\^?\s*\{?\s*(-?\d+)\s*\}?\s*(.+?)(?:\s+or\s+|$)/i;
  var mA = t.match(patA);
  if (!mA) {
    patA = /∑\s*_?\s*\{?\s*([a-zA-Z])\s*=\s*(-?\d+)\s*\}?\s*\^?\s*\{?\s*(-?\d+)\s*\}?\s*(.+)/i;
    mA = t.match(patA);
  }
  if (mA) {
    return {
      variable: mA[1],
      lower: parseInt(mA[2], 10),
      upper: parseInt(mA[3], 10),
      body: normaliseBody_(mA[4].trim(), mA[1])
    };
  }
  return null;
}

function tokenise_(s) {
  var tokens = [];
  var i = 0;
  while (i < s.length) {
    var ch = s[i];
    if (ch === ' ') { i++; continue; }
    if (/\d/.test(ch) || (ch === '-' && (tokens.length === 0 ||
        tokens[tokens.length - 1].type === 'op' ||
        tokens[tokens.length - 1].type === '('))) {
      var start = i;
      if (ch === '-') i++;
      while (i < s.length && /[\d.]/.test(s[i])) i++;
      tokens.push({ type: 'num', value: parseFloat(s.substring(start, i)) });
      continue;
    }
    if ('+-*/'.indexOf(ch) >= 0) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    if (ch === '(') { tokens.push({ type: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: ')' }); i++; continue; }
    return null;
  }
  return tokens;
}
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
function parseAtom_(tokens, pos) {
  if (pos.i >= tokens.length) return null;
  var tok = tokens[pos.i];
  if (tok.type === 'num') { pos.i++; return tok.value; }
  if (tok.type === '(') {
    pos.i++;
    var val = parseAddSub_(tokens, pos);
    if (val === null) return null;
    if (pos.i >= tokens.length || tokens[pos.i].type !== ')') return null;
    pos.i++;
    return val;
  }
  return null;
}
function evaluateSimpleExpression_(expr, varName, varValue) {
  var s = expr.replace(new RegExp(varName, 'g'), String(varValue));
  var tokens = tokenise_(s);
  if (!tokens) return null;
  var pos = { i: 0 };
  var result = parseAddSub_(tokens, pos);
  if (pos.i !== tokens.length) return null;
  return result;
}
function evaluateSigma_(sigma) {
  if (!sigma || sigma.lower > sigma.upper) return null;
  if (sigma.upper - sigma.lower > 10000) return null;
  try {
    var total = 0;
    for (var k = sigma.lower; k <= sigma.upper; k++) {
      var val = evaluateSimpleExpression_(sigma.body, sigma.variable, k);
      if (val === null) return null;
      total += val;
    }
    return total;
  } catch (e) { return null; }
}


// ── Tests ──────────────────────────────────────────────────────────

describe("parseSigmaExpression_", () => {
  test("parses LaTeX-style ∑_{n=1}^{27}(7+7n)", () => {
    var result = parseSigmaExpression_("∑_{n=1}^{27}(7+7n)");
    expect(result).not.toBeNull();
    expect(result.variable).toBe("n");
    expect(result.lower).toBe(1);
    expect(result.upper).toBe(27);
    expect(result.body).toContain("7*n");
  });

  test("parses \\sum_{i=2}^{28} 7i", () => {
    var result = parseSigmaExpression_("\\sum_{i=2}^{28} 7i");
    expect(result).not.toBeNull();
    expect(result.variable).toBe("i");
    expect(result.lower).toBe(2);
    expect(result.upper).toBe(28);
    expect(result.body).toBe("7*i");
  });

  test("parses ∑_{k=1}^{27}(7+7k) with spaces", () => {
    var result = parseSigmaExpression_("∑ _{k=1}^{27} (7+7k)");
    expect(result).not.toBeNull();
    expect(result.variable).toBe("k");
    expect(result.lower).toBe(1);
    expect(result.upper).toBe(27);
  });

  test("parses Σ (capital sigma) variant", () => {
    var result = parseSigmaExpression_("Σ_{n=1}^{27}(7+7n)");
    expect(result).not.toBeNull();
    expect(result.variable).toBe("n");
  });

  test("handles 'or equivalent' suffix", () => {
    var result = parseSigmaExpression_("∑_{n=1}^{27}(7+7n) or equivalent");
    expect(result).not.toBeNull();
    expect(result.body).not.toContain("or");
  });

  test("returns null for non-sigma text", () => {
    expect(parseSigmaExpression_("n = 27")).toBeNull();
    expect(parseSigmaExpression_("")).toBeNull();
    expect(parseSigmaExpression_(null)).toBeNull();
  });
});


describe("normaliseBody_", () => {
  test("inserts multiplication before variable: 7n → 7*n", () => {
    expect(normaliseBody_("7n", "n")).toBe("7*n");
  });

  test("strips outer parentheses: (7+7n) → 7+7*n", () => {
    expect(normaliseBody_("(7+7n)", "n")).toBe("7+7*n");
  });

  test("preserves plain variable: n → n", () => {
    expect(normaliseBody_("n", "n")).toBe("n");
  });

  test("handles complex body: (2*n+14) → 2*n+14", () => {
    expect(normaliseBody_("(2*n+14)", "n")).toBe("2*n+14");
  });
});


describe("evaluateSimpleExpression_", () => {
  test("evaluates 7+7*n with n=1 → 14", () => {
    expect(evaluateSimpleExpression_("7+7*n", "n", 1)).toBe(14);
  });

  test("evaluates 7*i with i=2 → 14", () => {
    expect(evaluateSimpleExpression_("7*i", "i", 2)).toBe(14);
  });

  test("evaluates 7*i with i=28 → 196", () => {
    expect(evaluateSimpleExpression_("7*i", "i", 28)).toBe(196);
  });

  test("evaluates parenthesised expression (7+7*n) with n=27 → 196", () => {
    expect(evaluateSimpleExpression_("(7+7*n)", "n", 27)).toBe(196);
  });

  test("handles subtraction: 10-n with n=3 → 7", () => {
    expect(evaluateSimpleExpression_("10-n", "n", 3)).toBe(7);
  });

  test("handles division: n/2 with n=10 → 5", () => {
    expect(evaluateSimpleExpression_("n/2", "n", 10)).toBe(5);
  });
});


describe("evaluateSigma_", () => {
  test("∑(7+7n) from n=1 to 27 = 2835", () => {
    var sigma = { variable: "n", lower: 1, upper: 27, body: "7+7*n" };
    expect(evaluateSigma_(sigma)).toBe(2835);
  });

  test("∑7i from i=2 to 28 = 2835", () => {
    var sigma = { variable: "i", lower: 2, upper: 28, body: "7*i" };
    expect(evaluateSigma_(sigma)).toBe(2835);
  });

  test("both equivalent forms produce the same value", () => {
    var markscheme = { variable: "n", lower: 1, upper: 27, body: "7+7*n" };
    var student    = { variable: "i", lower: 2, upper: 28, body: "7*i" };
    expect(evaluateSigma_(markscheme)).toBe(evaluateSigma_(student));
  });

  test("simple ∑n from n=1 to 10 = 55", () => {
    var sigma = { variable: "n", lower: 1, upper: 10, body: "n" };
    expect(evaluateSigma_(sigma)).toBe(55);
  });

  test("∑(2*n) from n=1 to 5 = 30", () => {
    var sigma = { variable: "n", lower: 1, upper: 5, body: "2*n" };
    expect(evaluateSigma_(sigma)).toBe(30);
  });

  test("returns null for invalid sigma (lower > upper)", () => {
    var sigma = { variable: "n", lower: 10, upper: 1, body: "n" };
    expect(evaluateSigma_(sigma)).toBeNull();
  });

  test("returns null for null input", () => {
    expect(evaluateSigma_(null)).toBeNull();
  });
});


describe("end-to-end sigma equivalence", () => {
  test("mark scheme ∑_{n=1}^{27}(7+7n) matches student ∑_{i=2}^{28} 7i", () => {
    var reqSigma = parseSigmaExpression_("∑_{n=1}^{27}(7+7n) or equivalent");
    var stuSigma = parseSigmaExpression_("\\sum_{i=2}^{28} 7i");

    expect(reqSigma).not.toBeNull();
    expect(stuSigma).not.toBeNull();

    var reqVal = evaluateSigma_(reqSigma);
    var stuVal = evaluateSigma_(stuSigma);

    expect(reqVal).toBe(2835);
    expect(stuVal).toBe(2835);
    expect(reqVal).toBe(stuVal);
  });

  test("non-equivalent sums do NOT match: ∑7n from n=1..27 ≠ ∑(7+7n) from n=1..27", () => {
    var wrong   = parseSigmaExpression_("∑_{n=1}^{27} 7n");     // = 7×(1+2+...+27) = 2646
    var correct = parseSigmaExpression_("∑_{n=1}^{27}(7+7n)");  // = 2835

    expect(evaluateSigma_(wrong)).toBe(2646);
    expect(evaluateSigma_(correct)).toBe(2835);
    expect(evaluateSigma_(wrong)).not.toBe(evaluateSigma_(correct));
  });

  test("∑_{n=0}^{26}(14+7n) is yet another equivalent form", () => {
    // 14+7(0)=14, 14+7(1)=21, ..., 14+7(26)=196
    var alt = parseSigmaExpression_("∑_{n=0}^{26}(14+7n)");
    expect(alt).not.toBeNull();
    expect(evaluateSigma_(alt)).toBe(2835);
  });
});
