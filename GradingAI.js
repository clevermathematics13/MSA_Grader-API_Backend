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
  
  // First pass: Grade each point normally
  markschemePoints.forEach(function(point, idx) {
    msaLog_('[GRADING PASS 1] Grading point ' + (point.id || ('P' + (idx + 1))) + ' | part: ' + (point.part || '') + ' | requirement: ' + point.requirement);
    if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 1] Grading point ' + (point.id || ('P' + (idx + 1))) + ' | part: ' + (point.part || '') + ' | requirement: ' + point.requirement);
    const matchResult = srgMatchRequirement_(studentText, point.requirement, {
      isImplied: point.isImplied || false
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
      isImplied: point.isImplied || false,
      awarded: matchResult.awarded,
      score: matchResult.score,
      details: matchResult.details,
      awardedByImplication: false
    });
  });

  // Second pass: Check implied marks for ALL implied marks, regardless of initial award status
  results.forEach(function(res, idx) {
    if (res.isImplied) {
      msaLog_('[GRADING PASS 2] Checking implied mark for ' + res.point_id + ' | awarded=' + res.awarded);
      if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 2] Checking implied mark for ' + res.point_id + ' | awarded=' + res.awarded);
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

  // Third pass: Apply any learned rules from corrections database
  msaLog_('[GRADING PASS 3] Applying learned rules...');
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[GRADING PASS 3] Applying learned rules...');
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

  // Find all A-marks in the same part that were awarded (including the final answer)
  var awardedAmarks = allResults.filter(function(r) {
    return r.part === part &&
           r.awarded &&
           (r.marks || []).some(function(m) { return m.startsWith('A'); });
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
 * @param {object} point The marking point.
 * @param {string} studentText The student's text.
 * @returns {string|null} Description of contradiction or null if none found.
 */
function findContradiction(point, studentText) {
  var requirement = point.requirement || '';
  
  // Extract the expected value from the requirement (e.g., "n=27" -> 27)
  var expectedMatch = requirement.match(/([a-z])\s*=\s*(-?\d+(\.\d+)?)/i);
  if (expectedMatch) {
    var varName = expectedMatch[1];
    var expectedValue = expectedMatch[2];
    
    // Look for the same variable with a DIFFERENT value in student work
    var contradictionRegex = new RegExp(varName + '\\s*=\\s*(-?\\d+(\\.\\d+)?)', 'gi');
    var matches = studentText.match(contradictionRegex);
    
    if (matches) {
      for (var i = 0; i < matches.length; i++) {
        var foundValue = matches[i].match(/(-?\d+(\.\d+)?)/)[0];
        if (foundValue !== expectedValue) {
          return 'Student wrote ' + varName + '=' + foundValue + ' but expected ' + varName + '=' + expectedValue;
        }
      }
    }
  }
  
  return null; // No contradiction found
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
