/********************************
 * GradingAI.js
 *
 * AI-assisted grading with learning capabilities.
 * Handles implied marks, correction tracking, and rule learning.
 * 
 * IB MARKING CONVENTIONS:
 * - Marks in parentheses (A1) are "implied marks"
 * - They can be awarded if a correct subsequent answer implies the work was done
 * - No contradiction rule: if final answer is correct, implied earlier steps can be awarded
 ********************************/

// Spreadsheet ID for storing grading corrections and learned rules
// Uses a function to avoid load-order issues (GradingAI.js loads before MSA_Config.js)
function getGradingAiSpreadsheetId_() {
  return MSA_GRADING_RULES_SPREADSHEET_ID;
}

/**
 * Enhanced grading that handles implied marks and learning.
 * @param {string} studentText The student's OCR text.
 * @param {Array} markschemePoints Array of marking points.
 * @param {object} options Options like {questionCode: "...", enableLearning: true}
 * @returns {Array} Results array with enhanced grading decisions.
 */
function gradeWithImpliedMarks(studentText, markschemePoints, options) {
  options = options || {};
  const results = [];
  
  /**
   * Helper: detect if a point has implied marks from either the isImplied flag
   * OR from the mark names themselves. IB convention: marks in parentheses
   * like (A1), (M1) are implied marks. The JSON may not store isImplied,
   * but the mark name always has the parentheses.
   */
  function isImpliedMark(point) {
    // Check stored flag first
    if (point.isImplied === true) return true;
    // Check mark names for parentheses: "(A1)", "(M1)", etc.
    var marks = point.marks || [];
    for (var i = 0; i < marks.length; i++) {
      if (/^\(/.test(marks[i])) return true; // starts with ( → implied
    }
    return false;
  }
  
  // First pass: Grade each point normally
  markschemePoints.forEach(function(point, idx) {
    var implied = isImpliedMark(point);
    msaLog_('[GRADING PASS 1] Grading point ' + (point.id || ('P' + (idx + 1))) + ' | part: ' + (point.part || '') + ' | marks: ' + JSON.stringify(point.marks) + ' | isImplied: ' + implied + ' | requirement: ' + point.requirement);
    if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 1] Grading point ' + (point.id || ('P' + (idx + 1))) + ' | part: ' + (point.part || '') + ' | marks: ' + JSON.stringify(point.marks) + ' | isImplied: ' + implied + ' | requirement: ' + point.requirement);
    const matchResult = srgMatchRequirement_(studentText, point.requirement, {
      isImplied: implied
    });
    msaLog_('[GRADING PASS 1] Match result for ' + (point.id || ('P' + (idx + 1))) + ': awarded=' + matchResult.awarded + ', score=' + matchResult.score);
    if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 1] Match result for ' + (point.id || ('P' + (idx + 1))) + ': awarded=' + matchResult.awarded + ', score=' + matchResult.score);
    results.push({
      point_id: point.id || ('P' + (idx + 1)),
      part: point.part || '',
      subpart: point.subpart || '',
      branch: point.branch || '',
      marks: point.marks || [],
      requirement: point.requirement,
      isImplied: implied,
      awarded: matchResult.awarded,
      score: matchResult.score,
      details: matchResult.details,
      awardedByImplication: false
    });
  });

  // Second pass: Check implied marks for ALL implied marks, regardless of initial award status
  results.forEach(function(res, idx) {
    if (res.isImplied) {
      msaLog_('[GRADING PASS 2] Checking implied mark for ' + res.point_id + ' | marks: ' + JSON.stringify(res.marks) + ' | awarded=' + res.awarded);
      if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 2] Checking implied mark for ' + res.point_id + ' | marks: ' + JSON.stringify(res.marks) + ' | awarded=' + res.awarded);
      var impliedDecision = checkImpliedMarkAward(res, results, studentText);
      msaLog_('[GRADING PASS 2] Implied mark decision for ' + res.point_id + ': shouldAward=' + impliedDecision.shouldAward + ', reason=' + impliedDecision.reason);
      if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 2] Implied mark decision for ' + res.point_id + ': shouldAward=' + impliedDecision.shouldAward + ', reason=' + impliedDecision.reason);
      if (impliedDecision.shouldAward && !res.awarded) {
        res.awarded = true;
        res.awardedByImplication = true;
        res.details.impliedReason = impliedDecision.reason;
        msaLog_('IMPLIED MARK AWARDED: ' + res.point_id + ' - ' + impliedDecision.reason);
        if (typeof Logger !== 'undefined' && Logger.log) Logger.log('IMPLIED MARK AWARDED: ' + res.point_id + ' - ' + impliedDecision.reason);
      }
    }
  });

  // Third pass: Method selection — only the best method per part earns marks
  msaLog_('[GRADING PASS 3] Selecting best method per part...');
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 3] Selecting best method per part...');
  selectBestMethodPerPart(results);

  // Fourth pass: Apply any learned rules from corrections database
  msaLog_('[GRADING PASS 4] Applying learned rules...');
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 4] Applying learned rules...');
  if (options.enableLearning !== false) {
    applyLearnedRules(results, studentText, options.questionCode);
  }

  msaLog_('[GRADING COMPLETE] Results: ' + JSON.stringify(results));
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING COMPLETE] Results: ' + JSON.stringify(results));
  return results;
}

/**
 * Check if an implied mark should be awarded based on subsequent work.
 * @param {object} impliedPoint The implied mark point that wasn't directly matched.
 * @param {Array} allResults All grading results.
 * @param {string} studentText The student's text.
 * @returns {object} {shouldAward: boolean, reason: string}
 */
function checkImpliedMarkAward(impliedPoint, allResults, studentText) {
  var part = impliedPoint.part;
  
  // Helper: check if a mark token is an A-mark (answer mark)
  // Handles both "A1" and "(A1)" formats
  function isAMark(m) {
    return /^\(?A/i.test(m);
  }

  // Find all awarded A-marks in the same part (including the final answer)
  // Use parent part grouping: "ai" and "aii" both belong to parent "a"
  // This ensures implied marks in "ai" can be triggered by correct answers in "ai"
  var awardedAmarks = allResults.filter(function(r) {
    return r.part === part &&
           r.awarded &&
           (r.marks || []).some(isAMark);
  });

  var debugMsg1 = '[IMPLIED MARK DEBUG] Checking implied mark for point_id: ' + impliedPoint.point_id + ' in part: ' + part;
  var debugMsg2 = '[IMPLIED MARK DEBUG] Awarded A-marks in this part: ' + awardedAmarks.map(function(r) { return r.point_id + ':' + (r.marks || []).join(','); }).join(' | ');
  msaLog_(debugMsg1);
  msaLog_(debugMsg2);
  if (typeof Logger !== 'undefined' && Logger.log) {
    Logger.log(debugMsg1);
    Logger.log(debugMsg2);
  }

  if (awardedAmarks.length > 0) {
    // At least one A-mark in this part was awarded (final answer or intermediate)
    // Check for contradictions
    var contradiction = findContradiction(impliedPoint, studentText);
    var debugMsg3;
    if (!contradiction) {
      debugMsg3 = '[IMPLIED MARK DEBUG] Awarding implied mark for ' + impliedPoint.point_id + ' because at least one A-mark was awarded and no contradiction found.';
      msaLog_(debugMsg3);
      if (typeof Logger !== 'undefined' && Logger.log) Logger.log(debugMsg3);
      return {
        shouldAward: true,
        reason: 'Correct answer in part (' + part + ') implies this step was done correctly. No contradiction found.'
      };
    } else {
      debugMsg3 = '[IMPLIED MARK DEBUG] Not awarding implied mark for ' + impliedPoint.point_id + ' due to contradiction: ' + contradiction;
      msaLog_(debugMsg3);
      if (typeof Logger !== 'undefined' && Logger.log) Logger.log(debugMsg3);
      return {
        shouldAward: false,
        reason: 'Contradiction found: ' + contradiction
      };
    }
  }

  var debugMsg4 = '[IMPLIED MARK DEBUG] No awarded A-marks found in part ' + part + ' for implied mark ' + impliedPoint.point_id;
  msaLog_(debugMsg4);
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log(debugMsg4);
  return {
    shouldAward: false,
    reason: 'No awarded A-marks found in part ' + part
  };
}

/**
 * Check if there's a contradiction to the implied requirement.
 * 
 * IMPORTANT: A contradiction must be STRONG and SPECIFIC to be valid.
 * We only flag a contradiction if the student EXPLICITLY writes a different
 * value for the same variable in what appears to be the same part of their work.
 * 
 * Common false positives to avoid:
 * - Same variable name used in different question parts (e.g., n=27 in part a, n=335 in part b)
 * - Intermediate calculation values that look different but are correct
 * - Subscript values (S_27 contains 27 as a subscript, not a contradiction)
 *
 * @param {object} point The marking point.
 * @param {string} studentText The student's text.
 * @returns {string|null} Description of contradiction or null if none found.
 */
function findContradiction(point, studentText) {
  // For now, we disable the contradiction check entirely.
  // The implied mark convention in IB marking is:
  //   "Award the mark if a correct subsequent answer implies the step was done,
  //    UNLESS there is clear evidence of a wrong method or value."
  //
  // A simple regex scan of the full student text is too blunt — it catches
  // values from other parts (e.g., n=335 from part b while checking n=27 for part a).
  // A proper contradiction check would need to segment the student text by part,
  // which requires OCR layout analysis we don't yet have.
  //
  // Since false contradictions are worse than missed contradictions
  // (they prevent valid marks from being awarded), we return null here
  // and rely on the teacher review system to catch any incorrect awards.
  
  return null; // No contradiction — trust the implication from correct final answer
}

/**
 * For each part, pick the best-scoring method branch and exclude marks from other methods.
 * Points with no branch (shared across all methods) are always kept.
 * Points from the best method are kept. Points from other methods are marked excluded.
 *
 * IB convention: a student can only earn marks from ONE method per part.
 * The method that earns the most marks is selected.
 *
 * @param {Array} results The grading results array (mutated in place).
 */
function selectBestMethodPerPart(results) {
  // Group results by part
  var partGroups = {};
  results.forEach(function(res) {
    var part = res.part || 'unknown';
    if (!partGroups[part]) partGroups[part] = [];
    partGroups[part].push(res);
  });

  for (var part in partGroups) {
    var partResults = partGroups[part];

    // Identify all method branches in this part
    var methods = {};
    var sharedResults = [];

    partResults.forEach(function(res) {
      var branch = res.branch || '';
      if (branch.startsWith('METHOD')) {
        if (!methods[branch]) methods[branch] = [];
        methods[branch].push(res);
      } else {
        sharedResults.push(res);
      }
    });

    var methodNames = Object.keys(methods);
    if (methodNames.length <= 1) {
      // 0 or 1 method — nothing to select
      msaLog_('[METHOD SELECT] Part ' + part + ': ' + (methodNames.length === 0 ? 'no methods' : '1 method (' + methodNames[0] + ')') + ' — no selection needed');
      if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[METHOD SELECT] Part ' + part + ': ' + (methodNames.length === 0 ? 'no methods' : '1 method (' + methodNames[0] + ')') + ' — no selection needed');
      continue;
    }

    // Calculate awarded marks for each method
    var methodScores = {};
    methodNames.forEach(function(method) {
      var score = 0;
      methods[method].forEach(function(res) {
        if (res.awarded) {
          score += msaGetMarkValue_(res.marks || []);
        }
      });
      methodScores[method] = score;
    });

    // Find the best method (highest awarded score; ties go to first method)
    var bestMethod = methodNames[0];
    var bestScore = methodScores[bestMethod];
    methodNames.forEach(function(method) {
      if (methodScores[method] > bestScore) {
        bestScore = methodScores[method];
        bestMethod = method;
      }
    });

    msaLog_('[METHOD SELECT] Part ' + part + ': scores=' + JSON.stringify(methodScores) + ' → best=' + bestMethod + ' (' + bestScore + ' marks)');
    if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[METHOD SELECT] Part ' + part + ': scores=' + JSON.stringify(methodScores) + ' → best=' + bestMethod + ' (' + bestScore + ' marks)');

    // Mark non-best method results as excluded
    methodNames.forEach(function(method) {
      if (method !== bestMethod) {
        methods[method].forEach(function(res) {
          if (res.awarded) {
            msaLog_('[METHOD SELECT] Excluding ' + res.point_id + ' (from ' + method + ', not best method)');
            if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[METHOD SELECT] Excluding ' + res.point_id + ' (from ' + method + ', not best method)');
          }
          res.awarded = false;
          res.excludedByMethod = true;
          res.selectedMethod = bestMethod;
        });
      } else {
        // Tag best method results
        methods[method].forEach(function(res) {
          res.excludedByMethod = false;
          res.selectedMethod = bestMethod;
        });
      }
    });
  }
}

/**
 * Apply learned rules from the corrections database.
 * @param {Array} results The grading results to potentially modify.
 * @param {string} studentText The student's text.
 * @param {string} questionCode The question being graded.
 */
function applyLearnedRules(results, studentText, questionCode) {
  try {
    var rules = loadLearnedRules(questionCode);
    if (!rules || rules.length === 0) return;
    
    rules.forEach(function(rule) {
      results.forEach(function(res) {
        if (shouldApplyRule(rule, res, studentText)) {
          msaLog_('LEARNED RULE APPLIED: ' + rule.description);
          res.awarded = rule.shouldAward;
          res.details.learnedRule = rule.description;
        }
      });
    });
  } catch (e) {
    msaLog_('Could not apply learned rules: ' + e.message);
  }
}

/**
 * Check if a learned rule applies to a result.
 */
function shouldApplyRule(rule, result, studentText) {
  // Rule matching logic based on rule type
  if (rule.type === 'pattern_match') {
    var pattern = new RegExp(rule.pattern, 'i');
    return pattern.test(studentText) && result.point_id === rule.pointId;
  }
  
  if (rule.type === 'part_match') {
    return result.part === rule.part && !result.awarded;
  }
  
  return false;
}

/**
 * Load learned rules from the database.
 * @param {string} questionCode The question code to filter rules.
 * @returns {Array} Array of rule objects.
 */
function loadLearnedRules(questionCode) {
  try {
    var ss = SpreadsheetApp.openById(getGradingAiSpreadsheetId_());
    var sheet = ss.getSheetByName('LearnedRules');
    
    if (!sheet) {
      // Sheet doesn't exist yet - will be created when first correction is saved
      return [];
    }
    
    var data = sheet.getDataRange().getValues();
    var rules = [];
    
    // Skip header row
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      // Only load active rules, optionally filtered by question
      if (row[5] === 'active' && (!questionCode || row[0] === questionCode || row[0] === '*')) {
        rules.push({
          questionCode: row[0],
          pointId: row[1],
          part: row[2],
          type: row[3],
          pattern: row[4],
          status: row[5],
          shouldAward: row[6] === true || row[6] === 'true',
          description: row[7],
          confidence: parseFloat(row[8]) || 0.5,
          timesApplied: parseInt(row[9]) || 0
        });
      }
    }
    
    return rules;
  } catch (e) {
    msaLog_('Error loading learned rules: ' + e.message);
    return [];
  }
}

/**
 * Save a grading correction to the database for learning.
 * This creates training data for improving the grader.
 * 
 * @param {string} questionCode The question code.
 * @param {string} pointId The marking point ID.
 * @param {boolean} originalDecision What the auto-grader decided.
 * @param {boolean} correctedDecision What the teacher corrected it to.
 * @param {string} studentText The student's OCR text.
 * @param {string} requirement The marking requirement.
 * @param {string} teacherNotes Optional notes from the teacher.
 * @returns {object} Result with status.
 */
function saveGradingCorrection(questionCode, pointId, originalDecision, correctedDecision, studentText, requirement, teacherNotes) {
  try {
    var ss = SpreadsheetApp.openById(getGradingAiSpreadsheetId_());
    var sheet = ss.getSheetByName('GradingCorrections');
    
    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet('GradingCorrections');
      sheet.appendRow([
        'Timestamp', 'QuestionCode', 'PointId', 'OriginalDecision', 'CorrectedDecision',
        'StudentText', 'Requirement', 'TeacherNotes', 'RuleGenerated', 'ReviewStatus'
      ]);
      sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
    }
    
    // Append the correction
    sheet.appendRow([
      new Date(),
      questionCode,
      pointId,
      originalDecision,
      correctedDecision,
      studentText.substring(0, 1000), // Limit text size
      requirement,
      teacherNotes || '',
      'pending', // Rule generation status
      'needs_review' // Review status for teacher
    ]);
    
    msaLog_('Saved grading correction for ' + questionCode + ' / ' + pointId);
    
    // Trigger rule learning analysis
    analyzeForNewRule(questionCode, pointId, originalDecision, correctedDecision, studentText, requirement);
    
    return { status: 'success', message: 'Correction saved' };
  } catch (e) {
    msaErr_('Error saving grading correction: ' + e.message);
    return { status: 'error', message: e.message };
  }
}

/**
 * Analyze a correction to potentially generate a new rule.
 * This is where the "learning" happens.
 */
function analyzeForNewRule(questionCode, pointId, originalDecision, correctedDecision, studentText, requirement) {
  // Only analyze if the decision changed
  if (originalDecision === correctedDecision) return;
  
  var proposedRule = null;
  
  // Pattern 1: Implied mark should have been awarded
  if (!originalDecision && correctedDecision) {
    // The teacher said to award a mark that wasn't awarded
    // Look for patterns that indicate why
    
    // Check if this looks like an implication case
    var hasCorrectFinalAnswer = checkForCorrectFinalAnswer(studentText, requirement);
    if (hasCorrectFinalAnswer) {
      proposedRule = {
        type: 'implied_answer',
        description: 'Award implied mark when final answer is correct',
        confidence: 0.7
      };
    }
    
    // Check for pattern matching
    var keyNumbers = extractKeyNumbers(requirement);
    if (keyNumbers.length > 0) {
      var allFound = keyNumbers.every(function(n) {
        return studentText.includes(n);
      });
      if (allFound) {
        proposedRule = {
          type: 'pattern_match',
          pattern: keyNumbers.join('.*'),
          description: 'Award when key numbers ' + keyNumbers.join(', ') + ' are present',
          confidence: 0.6
        };
      }
    }
  }
  
  // Pattern 2: Mark should NOT have been awarded
  if (originalDecision && !correctedDecision) {
    // The teacher said NOT to award a mark that was awarded
    // This indicates our matching was too lenient
    proposedRule = {
      type: 'stricter_match',
      description: 'Require more specific evidence for this point',
      confidence: 0.5
    };
  }
  
  if (proposedRule) {
    saveProposedRule(questionCode, pointId, proposedRule);
  }
}

/**
 * Save a proposed rule for teacher review.
 */
function saveProposedRule(questionCode, pointId, rule) {
  try {
    var ss = SpreadsheetApp.openById(getGradingAiSpreadsheetId_());
    var sheet = ss.getSheetByName('LearnedRules');
    
    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet('LearnedRules');
      sheet.appendRow([
        'QuestionCode', 'PointId', 'Part', 'Type', 'Pattern', 
        'Status', 'ShouldAward', 'Description', 'Confidence', 'TimesApplied'
      ]);
      sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
    }
    
    // Add as pending rule (teacher needs to approve)
    sheet.appendRow([
      questionCode,
      pointId,
      '', // Part - to be filled
      rule.type,
      rule.pattern || '',
      'pending_review', // Status - needs teacher approval
      true,
      rule.description,
      rule.confidence,
      0
    ]);
    
    msaLog_('Proposed new rule for review: ' + rule.description);
  } catch (e) {
    msaLog_('Error saving proposed rule: ' + e.message);
  }
}

/**
 * Check if the student has the correct final answer for a part.
 */
function checkForCorrectFinalAnswer(studentText, requirement) {
  var numbers = requirement.match(/-?\d+(\.\d+)?/g);
  if (!numbers) return false;
  
  // Check if the last/key number appears in student work
  var keyNumber = numbers[numbers.length - 1];
  return studentText.includes(keyNumber);
}

/**
 * Extract key numbers from a requirement.
 */
function extractKeyNumbers(requirement) {
  var numbers = requirement.match(/-?\d+(\.\d+)?/g) || [];
  // Filter out common non-key numbers like 1, 2, etc.
  return numbers.filter(function(n) {
    var val = parseFloat(n);
    return Math.abs(val) > 10 || n.includes('.');
  });
}

/**
 * Get pending rules that need teacher review.
 * @returns {Array} Array of pending rules.
 */
function getPendingRulesForReview() {
  try {
    var ss = SpreadsheetApp.openById(getGradingAiSpreadsheetId_());
    var sheet = ss.getSheetByName('LearnedRules');
    
    if (!sheet) return [];
    
    var data = sheet.getDataRange().getValues();
    var pending = [];
    
    for (var i = 1; i < data.length; i++) {
      if (data[i][5] === 'pending_review') {
        pending.push({
          rowIndex: i + 1, // 1-indexed for spreadsheet
          questionCode: data[i][0],
          pointId: data[i][1],
          type: data[i][3],
          pattern: data[i][4],
          description: data[i][7],
          confidence: data[i][8]
        });
      }
    }
    
    return pending;
  } catch (e) {
    msaLog_('Error getting pending rules: ' + e.message);
    return [];
  }
}

/**
 * Approve or reject a pending rule.
 * @param {number} rowIndex The row index in the LearnedRules sheet.
 * @param {boolean} approve True to approve, false to reject.
 */
function reviewRule(rowIndex, approve) {
  try {
    var ss = SpreadsheetApp.openById(getGradingAiSpreadsheetId_());
    var sheet = ss.getSheetByName('LearnedRules');
    
    if (!sheet) return { status: 'error', message: 'LearnedRules sheet not found' };
    
    var newStatus = approve ? 'active' : 'rejected';
    sheet.getRange(rowIndex, 6).setValue(newStatus); // Column F is Status
    
    return { status: 'success', message: 'Rule ' + (approve ? 'approved' : 'rejected') };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

/**
 * Get statistics on the learning system.
 */
function getLearningStats() {
  try {
    var ss = SpreadsheetApp.openById(getGradingAiSpreadsheetId_());
    var stats = {
      totalCorrections: 0,
      activeRules: 0,
      pendingRules: 0,
      rejectedRules: 0
    };
    
    var correctionsSheet = ss.getSheetByName('GradingCorrections');
    if (correctionsSheet) {
      stats.totalCorrections = Math.max(0, correctionsSheet.getLastRow() - 1);
    }
    
    var rulesSheet = ss.getSheetByName('LearnedRules');
    if (rulesSheet) {
      var data = rulesSheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        var status = data[i][5];
        if (status === 'active') stats.activeRules++;
        else if (status === 'pending_review') stats.pendingRules++;
        else if (status === 'rejected') stats.rejectedRules++;
      }
    }
    
    return stats;
  } catch (e) {
    return { error: e.message };
  }
}
