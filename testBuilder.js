// =============================
// EXPERIMENTAL: Scalable Batch PDF Controller
// =============================

// Delete all existing triggers for a given function to avoid GAS trigger limit
function clearTriggersForFunction_(fnName) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === fnName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  // Main streamlined menu
  ui.createMenu('Exam Factory')
    .addItem('Step 1: Generate All PDFs (Batch, Robust)', 'startBatchPDFWorkflow')
    .addItem('Step 1b: Resume Batch PDF Workflow', 'resumeBatchPDFWorkflow')
    .addItem('Step 2: Finalize Exam Batch', 'finalizeExamBatch')
    .addToUi();
// Resume batch workflow from last incomplete batch
function resumeBatchPDFWorkflow() {
  var props = PropertiesService.getScriptProperties();
  var batchIndex = Number(props.getProperty('batchIndex')) || 0;
  var totalStudents = Number(props.getProperty('totalStudents'));
  var batchSize = Number(props.getProperty('batchSize'));
  var timingLog = JSON.parse(props.getProperty('timingLog') || '[]');
  if (!totalStudents || !batchSize) {
    SpreadsheetApp.getUi().alert('No incomplete batch workflow found. Please start a new batch.');
    return;
  }
  Logger.log(`[EXPERIMENTAL] Resuming batch PDF workflow: batchIndex=${batchIndex}, totalStudents=${totalStudents}, batchSize=${batchSize}`);
  clearTriggersForFunction_('runBatchPDFStep');
  ScriptApp.newTrigger('runBatchPDFStep').timeBased().after(1000).create();
}

  // Legacy detailed menu restored as a second menu
  ui.createMenu('Legacy Exam Tools')
    // ...existing code...
    .addToUi();
}

function startBatchPDFWorkflow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var workflowLog = [];
  var workflowStart = new Date();

  function wlog(msg) {
    var entry = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss') + '  ' + msg;
    workflowLog.push(entry);
    Logger.log(msg);
  }

  wlog('========== BATCH PDF WORKFLOW STARTED ==========');
  wlog('Spreadsheet: ' + ss.getName());

  // Sync student names from source
  syncStudentNames(ss);
  wlog('Student names synced from source');

  var namesSheet = ss.getSheetByName("Names");
  var data = namesSheet.getRange(2, 1, namesSheet.getLastRow() - 1, 3).getValues();
  // Filter to valid students only (must have email AND name)
  var validStudents = data.filter(function(row) { return row[0] && row[1]; });
  var totalStudents = validStudents.length;
  var MAX_BATCH_SIZE = 7; // Hard cap: 7 students × ~25s ≈ 175s, safe under 360s GAS limit
  var dynamicBatchSize = Number(PropertiesService.getScriptProperties().getProperty('dynamicBatchSize'));
  var batchSize = dynamicBatchSize && dynamicBatchSize > 0 ? Math.min(dynamicBatchSize, MAX_BATCH_SIZE) : MAX_BATCH_SIZE;

  wlog('Valid students found: ' + totalStudents);
  wlog('Batch size: ' + batchSize);
  wlog('Total batches planned: ' + Math.ceil(totalStudents / batchSize));

  // Initialize globals
  classCodeFinder();
  chooseOutputFolder();
  choosePaperTemplate();
  wlog('Globals initialized — classCode: ' + classCode + ', testName: ' + testName);

  // Create exam folder (same as legacy workflow)
  var examFolder = getOrCreateFolder(parentFolder, testName);
  wlog('Exam folder created: ' + examFolder.getName() + ' (ID: ' + examFolder.getId() + ')');

  // Create master deck inside exam folder
  ss.toast('Building master slide deck...', 'Step 1/3', -1);
  var masterDeckFile = createMasterSlideDeck(examFolder);
  var masterDeckId = masterDeckFile.getId();
  wlog('Master slide deck created: ' + masterDeckId);

  // Export Master PDF
  ss.toast('Exporting master PDF...', 'Step 2/3', -1);
  var masterPdf = masterDeckFile.getAs(MimeType.PDF);
  examFolder.createFile(masterPdf).setName(testName + ' [Master].pdf');
  wlog('Master PDF exported');

  // Build Mark Scheme
  ss.toast('Building mark scheme...', 'Step 3/3', -1);
  buildMarkSchemePDF(examFolder);
  wlog('Mark scheme built');

  var setupDuration = ((new Date()) - workflowStart) / 1000;
  wlog('Setup phase completed in ' + setupDuration.toFixed(1) + 's');
  wlog('--- Starting batch processing ---');

  // Write filtered valid students to a temp property so batches use the same list
  PropertiesService.getScriptProperties().setProperties({
    batchIndex: '0',
    totalStudents: String(totalStudents),
    batchSize: String(batchSize),
    timingLog: JSON.stringify([]),
    masterDeckId: masterDeckId,
    examFolderId: examFolder.getId(),
    validStudentData: JSON.stringify(validStudents),
    workflowLog: JSON.stringify(workflowLog),
    workflowStartTime: workflowStart.toISOString()
  });

  // Clear previous progress/error logs and re-add headers
  var progressSheet = ss.getSheetByName('BatchProgressLog');
  if (progressSheet) {
    progressSheet.clear();
    progressSheet.appendRow(['Batch', 'Student Name', 'Email', 'Status', 'Message']);
  }
  var errorSheet = ss.getSheetByName('BatchErrorLog');
  if (errorSheet) {
    errorSheet.clear();
    errorSheet.appendRow(['Batch', 'Student Name', 'Email', 'Error Message']);
  }

  ss.toast('Batch PDF started: ' + totalStudents + ' valid students in batches of ' + batchSize, 'Batch Started', 10);
  clearTriggersForFunction_('runBatchPDFStep');
  ScriptApp.newTrigger('runBatchPDFStep').timeBased().after(1000).create();
}

function runBatchPDFStep() {
  var props = PropertiesService.getScriptProperties();
  var batchIndex = Number(props.getProperty('batchIndex'));
  var totalStudents = Number(props.getProperty('totalStudents'));
  var batchSize = Number(props.getProperty('batchSize'));
  var timingLog = JSON.parse(props.getProperty('timingLog') || '[]');
  var masterDeckId = props.getProperty('masterDeckId');
  var examFolderId = props.getProperty('examFolderId');
  var workflowLog = JSON.parse(props.getProperty('workflowLog') || '[]');

  function wlog(msg) {
    var entry = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss') + '  ' + msg;
    workflowLog.push(entry);
    Logger.log(msg);
  }

  // Use the pre-filtered valid student list
  var validStudents = JSON.parse(props.getProperty('validStudentData') || '[]');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var startIdx = batchIndex * batchSize;
  var endIdx = Math.min(startIdx + batchSize, totalStudents);
  var batchData = validStudents.slice(startIdx, endIdx);
  var totalBatches = Math.ceil(totalStudents / batchSize);

  var start = new Date();
  wlog('--- BATCH ' + (batchIndex + 1) + '/' + totalBatches + ' ---');
  wlog('Students ' + startIdx + ' to ' + (endIdx - 1) + ' (' + batchData.length + ' students)');
  for (var s = 0; s < batchData.length; s++) {
    wlog('  Student: ' + batchData[s][1] + ' (' + batchData[s][0] + ')');
  }

  ss.toast('Processing batch ' + (batchIndex + 1) + ' of ' + totalBatches + ' (' + batchData.length + ' students)', 'Batch Progress', 10);

  try {
    processClassBatchExperimental(batchData, batchIndex, masterDeckId, examFolderId);
    wlog('Batch ' + (batchIndex + 1) + ' completed successfully');
  } catch (e) {
    wlog('ERROR in batch ' + (batchIndex + 1) + ': ' + e.message);
  }

  var end = new Date();
  var duration = (end - start) / 1000;
  timingLog.push({ batch: batchIndex, duration: duration, batchSize: batchSize });
  wlog('Batch ' + (batchIndex + 1) + ' duration: ' + duration.toFixed(1) + 's');

  batchIndex++;
  props.setProperty('batchIndex', String(batchIndex));
  props.setProperty('timingLog', JSON.stringify(timingLog));
  props.setProperty('workflowLog', JSON.stringify(workflowLog));

  if (batchIndex * batchSize < totalStudents) {
    clearTriggersForFunction_('runBatchPDFStep');
    ScriptApp.newTrigger('runBatchPDFStep').timeBased().after(1000).create();
  } else {
    // ========== ALL BATCHES COMPLETE ==========
    wlog('');
    wlog('========== ALL BATCHES COMPLETE ==========');
    wlog('Total students processed: ' + totalStudents);
    wlog('Total batches: ' + totalBatches);

    outputTimingLogToSheet(timingLog);
    var avgDuration = timingLog.reduce(function(sum, entry) { return sum + entry.duration; }, 0) / timingLog.length;
    var totalBatchDuration = timingLog.reduce(function(sum, entry) { return sum + entry.duration; }, 0);
    var newBatchSize = batchSize;
    var MAX_BATCH_SIZE = 7;
    if (avgDuration < 180) {
      newBatchSize = Math.min(batchSize + 2, MAX_BATCH_SIZE);
    } else if (avgDuration > 300) {
      newBatchSize = Math.max(batchSize - 2, 2);
    }

    wlog('Average batch duration: ' + avgDuration.toFixed(1) + 's');
    wlog('Total batch processing time: ' + totalBatchDuration.toFixed(1) + 's');

    // Cleanup: trash the TEMP_MASTER deck
    try {
      DriveApp.getFileById(masterDeckId).setTrashed(true);
      wlog('TEMP_MASTER trashed');
    } catch (cleanErr) {
      wlog('TEMP_MASTER cleanup failed: ' + cleanErr.message);
    }

    // Create ZIP of all individual PDFs in the Class Batch folder
    var zipPdfCount = 0;
    var pdfBlobs = [];
    try {
      var examFolder = DriveApp.getFolderById(examFolderId);
      var batchFolder = getOrCreateFolder(examFolder, 'Class Batch');
      var pdfFiles = batchFolder.getFilesByType(MimeType.PDF);
      while (pdfFiles.hasNext()) {
        pdfBlobs.push(pdfFiles.next().getBlob());
      }
      zipPdfCount = pdfBlobs.length;
      if (pdfBlobs.length > 0) {
        var zipBlob = Utilities.zip(pdfBlobs, testName + ' - Class Batch.zip');
        examFolder.createFile(zipBlob);
        wlog('ZIP created with ' + pdfBlobs.length + ' PDFs');
      }
    } catch (zipErr) {
      wlog('ZIP creation failed: ' + zipErr.message);
    }

    // Merge all student PDFs into one combined PDF
    try {
      if (pdfBlobs.length > 0) {
        var mergedBlob = mergeStudentPDFs(pdfBlobs, testName + ' - All Students.pdf', wlog);
        if (mergedBlob) {
          var examFolderForMerge = DriveApp.getFolderById(examFolderId);
          examFolderForMerge.createFile(mergedBlob);
          wlog('Merged PDF created: ' + mergedBlob.getName());
        }
      }
    } catch (mergeErr) {
      wlog('PDF merge failed: ' + mergeErr.message);
    }

    // Calculate total workflow duration
    var workflowStartTime = props.getProperty('workflowStartTime');
    var totalWorkflowDuration = workflowStartTime
      ? ((new Date()) - new Date(workflowStartTime)) / 1000
      : totalBatchDuration;
    wlog('Total workflow duration (setup + batches): ' + totalWorkflowDuration.toFixed(1) + 's (' + (totalWorkflowDuration / 60).toFixed(1) + ' min)');
    wlog('Next recommended batch size: ' + newBatchSize);

    // Read error and progress logs from sheets for the email
    var errorSheet = ss.getSheetByName('BatchErrorLog');
    var errorCount = 0;
    if (errorSheet && errorSheet.getLastRow() > 1) {
      var errorData = errorSheet.getRange(1, 1, errorSheet.getLastRow(), errorSheet.getLastColumn()).getValues();
      errorCount = errorSheet.getLastRow() - 1;
      wlog('');
      wlog('========== ERRORS (' + errorCount + ') ==========');
      for (var e = 1; e < errorData.length; e++) {
        wlog('  Batch ' + errorData[e][0] + ' | ' + errorData[e][1] + ' | ' + errorData[e][3]);
      }
    }

    var progressSheet = ss.getSheetByName('BatchProgressLog');
    var successCount = 0;
    var failCount = 0;
    if (progressSheet && progressSheet.getLastRow() > 1) {
      var progressData = progressSheet.getRange(1, 1, progressSheet.getLastRow(), progressSheet.getLastColumn()).getValues();
      wlog('');
      wlog('========== STUDENT RESULTS ==========');
      for (var p = 1; p < progressData.length; p++) {
        var status = progressData[p][3];
        if (status === 'Success') successCount++;
        else failCount++;
        wlog('  ' + progressData[p][1] + ' — ' + status + (progressData[p][4] ? ' (' + progressData[p][4] + ')' : ''));
      }
    }

    wlog('');
    wlog('========== SUMMARY ==========');
    wlog('Exam: ' + testName);
    wlog('Students: ' + totalStudents + ' | Success: ' + successCount + ' | Failed: ' + failCount);
    wlog('PDFs in ZIP: ' + zipPdfCount);
    wlog('Total time: ' + (totalWorkflowDuration / 60).toFixed(1) + ' minutes');
    wlog('========== WORKFLOW COMPLETE ==========');

    // Clean up batch properties but preserve dynamicBatchSize
    props.deleteProperty('batchIndex');
    props.deleteProperty('totalStudents');
    props.deleteProperty('batchSize');
    props.deleteProperty('timingLog');
    props.deleteProperty('masterDeckId');
    props.deleteProperty('examFolderId');
    props.deleteProperty('validStudentData');
    props.deleteProperty('workflowLog');
    props.deleteProperty('workflowStartTime');
    props.setProperty('dynamicBatchSize', String(newBatchSize));

    // Build the full log text for email attachment
    var logText = workflowLog.join('\n');
    var logBlob = Utilities.newBlob(logText, 'text/plain', testName + ' - Workflow Log.txt');

    // Send completion email with log attachment
    try {
      var subject = '✅ ' + testName + ' — Batch PDF Complete (' + successCount + '/' + totalStudents + ' students)';
      var body = testName + ' — Exam Generation Complete\n\n'
        + 'Students processed: ' + totalStudents + '\n'
        + 'Successful PDFs: ' + successCount + '\n'
        + 'Failed: ' + failCount + '\n'
        + 'PDFs in ZIP: ' + zipPdfCount + '\n'
        + 'Total duration: ' + (totalWorkflowDuration / 60).toFixed(1) + ' minutes\n'
        + 'Average batch: ' + avgDuration.toFixed(1) + 's\n'
        + 'Next batch size: ' + newBatchSize + '\n\n'
        + (failCount > 0 ? '⚠️ ' + failCount + ' student(s) failed — see attached log for details.\n\n' : '')
        + 'Full workflow log is attached.';
      MailApp.sendEmail({
        to: 'paulsclevenger@gmail.com',
        subject: subject,
        body: body,
        attachments: [logBlob]
      });
    } catch (mailErr) {
      Logger.log('[BATCH] Email notification failed: ' + mailErr.message);
    }

    // Clear UI indication
    ss.toast('✅ COMPLETE — ' + successCount + '/' + totalStudents + ' PDFs generated. Check email for full log.', 'Workflow Complete', 60);
  }
}

// Output timing log to a dedicated sheet for analysis
function outputTimingLogToSheet(timingLog) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'BatchTimingLog';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  } else {
    sheet.clear();
  }
  sheet.appendRow(['Batch', 'Duration (s)', 'Batch Size']);
  for (var i = 0; i < timingLog.length; i++) {
    var entry = timingLog[i];
    sheet.appendRow([entry.batch, entry.duration, entry.batchSize]);
  }
  Logger.log('[EXPERIMENTAL] Timing log written to BatchTimingLog sheet.');
}

// Merge multiple PDF blobs into a single combined PDF using pdf.co API
// Requires 'PDF_MERGE_API_KEY' set in Script Properties (get one at https://pdf.co)
// Returns merged PDF blob, or null if merge is not available/fails
function mergeStudentPDFs(pdfBlobs, outputName, wlog) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('PDF_MERGE_API_KEY');
  if (!apiKey) {
    wlog('PDF merge skipped — no PDF_MERGE_API_KEY in Script Properties');
    return null;
  }

  wlog('Starting PDF merge (' + pdfBlobs.length + ' files)...');

  // Step 1: Upload each PDF to pdf.co and collect temp URLs
  var uploadedUrls = [];
  for (var i = 0; i < pdfBlobs.length; i++) {
    var blob = pdfBlobs[i];
    var base64Data = Utilities.base64Encode(blob.getBytes());
    var uploadResp = UrlFetchApp.fetch('https://api.pdf.co/v1/file/upload/base64', {
      method: 'post',
      headers: { 'x-api-key': apiKey },
      contentType: 'application/json',
      payload: JSON.stringify({ file: base64Data, name: blob.getName() || ('student_' + i + '.pdf') }),
      muteHttpExceptions: true
    });
    var uploadResult = JSON.parse(uploadResp.getContentText());
    if (uploadResult.error === false && uploadResult.url) {
      uploadedUrls.push(uploadResult.url);
    } else {
      wlog('Upload failed for PDF ' + i + ': ' + (uploadResult.message || uploadResp.getContentText()));
      return null;
    }
  }
  wlog('Uploaded ' + uploadedUrls.length + ' PDFs to merge service');

  // Step 2: Merge all uploaded PDFs
  var mergeResp = UrlFetchApp.fetch('https://api.pdf.co/v1/pdf/merge2', {
    method: 'post',
    headers: { 'x-api-key': apiKey },
    contentType: 'application/json',
    payload: JSON.stringify({ urls: uploadedUrls, name: outputName, async: false }),
    muteHttpExceptions: true
  });
  var mergeResult = JSON.parse(mergeResp.getContentText());
  if (mergeResult.error === true || !mergeResult.url) {
    wlog('Merge API error: ' + (mergeResult.message || mergeResp.getContentText()));
    return null;
  }

  // Step 3: Download the merged PDF
  var downloadResp = UrlFetchApp.fetch(mergeResult.url, { muteHttpExceptions: true });
  if (downloadResp.getResponseCode() !== 200) {
    wlog('Download failed for merged PDF: HTTP ' + downloadResp.getResponseCode());
    return null;
  }

  var mergedBlob = downloadResp.getBlob().setName(outputName);
  wlog('PDF merge complete: ' + outputName);
  return mergedBlob;
}

// Experimental: process a batch of students (subset of processClassBatch)
// masterDeckId: cached master deck file ID to avoid creating duplicates
// examFolderId: the exam folder ID created in startBatchPDFWorkflow
function processClassBatchExperimental(batchData, batchIndex, masterDeckId, examFolderId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Setup error and progress log sheets
  var errorSheetName = 'BatchErrorLog';
  var progressSheetName = 'BatchProgressLog';
  var errorSheet = ss.getSheetByName(errorSheetName);
  if (!errorSheet) {
    errorSheet = ss.insertSheet(errorSheetName);
    errorSheet.appendRow(['Batch', 'Student Name', 'Email', 'Error Message']);
  }
  var progressSheet = ss.getSheetByName(progressSheetName);
  if (!progressSheet) {
    progressSheet = ss.insertSheet(progressSheetName);
    progressSheet.appendRow(['Batch', 'Student Name', 'Email', 'Status', 'Message']);
  }

  var mainFolder = DriveApp.getFolderById(examFolderId);
  var testName = ss.getSheetByName('PPQselector').getRange(1,7).getValue();
  // Use cached master deck if available (passed from runBatchPDFStep)
  var masterDeckFile;
  if (masterDeckId) {
    masterDeckFile = DriveApp.getFileById(masterDeckId);
  } else {
    masterDeckFile = getMasterDeckFile(mainFolder, testName);
  }
  var qCodes = getRowDataClean(6);
  var generatedBlobs = [];
  var batchFolder = getOrCreateFolder(mainFolder, "Class Batch");

  // Pre-fetch QR codes for this batch
  var qrRequests = [];
  var qrKeyMap = {};
  for (var vi = 0; vi < batchData.length; vi++) {
    var sid = batchData[vi][0].split('@')[0];
    for (var q = 0; q < qCodes.length; q++) {
      var payload = JSON.stringify({ s: sid, q: qCodes[q], e: testName });
      qrKeyMap[vi + "_" + q] = qrRequests.length;
      qrRequests.push({ url: "https://quickchart.io/qr?size=150&text=" + encodeURIComponent(payload), muteHttpExceptions: true });
    }
  }
  var qrResponses = qrRequests.length > 0 ? UrlFetchApp.fetchAll(qrRequests) : [];
  var qrBlobs = [];
  for (var vi = 0; vi < batchData.length; vi++) {
    qrBlobs[vi] = [];
    for (var q = 0; q < qCodes.length; q++) {
      var resp = qrResponses[qrKeyMap[vi + "_" + q]];
      qrBlobs[vi][q] = (resp && resp.getResponseCode() === 200) ? resp.getBlob() : null;
    }
  }
  Logger.log(`[EXPERIMENTAL] QR batch fetched for batch ${batchIndex}: ${qrRequests.length} codes`);

  // Process each student in this batch
  for (var i = 0; i < batchData.length; i++) {
    var email = batchData[i][0];
    var name = batchData[i][1];
    var extraTimePct = batchData[i][2];
    if (name && email) {
      ss.toast(`Stamping: ${name} (Batch ${batchIndex})`, "Batching", -1);
      var tempFile, tempDeck, pdfBlob;
      var studentStatus = 'Success';
      var studentMessage = '';
      try {
        // Retry logic: up to 2 attempts for Slides operations
        var attempts = 0, maxAttempts = 2, success = false;
        while (attempts < maxAttempts && !success) {
          try {
            tempFile = masterDeckFile.makeCopy(testName + " - " + name, batchFolder);
            tempDeck = SlidesApp.openById(tempFile.getId());
            stampStudentData(tempDeck, name, email.split('@')[0], qCodes, qrBlobs[i]);
            // Apply extra time accommodation on cover slide if applicable
            var marksData = getRowDataClean(2);
            var baseTotalMarks = marksData.reduce(function(a, b) { return a + Number(b); }, 0);
            var baseMinutes = Math.ceil(baseTotalMarks * 12 / 11);
            if (extraTimePct && Number(extraTimePct) > 0) {
              // Sheets stores 10% as 0.1; if value < 1 treat as decimal, else as integer %
              var pct = Number(extraTimePct);
              var multiplier = (pct < 1) ? pct : pct / 100;
              var adjustedMinutes = Math.ceil(baseMinutes * (1 + multiplier));
              tempDeck.replaceAllText(baseMinutes + " minutes", adjustedMinutes + " minutes (including accommodations)");
            }
            tempDeck.saveAndClose();
            pdfBlob = tempFile.getAs(MimeType.PDF);
            pdfBlob.setName(testName + " - " + name + ".pdf");
            batchFolder.createFile(pdfBlob);
            generatedBlobs.push(pdfBlob);
            tempFile.setTrashed(true);
            success = true;
            studentStatus = 'Success';
            studentMessage = 'PDF generated';
          } catch (e) {
            attempts++;
            Logger.log(`[EXPERIMENTAL][ERROR] Slides operation failed for student: ${name}, file: ${tempFile ? tempFile.getId() : 'N/A'}, attempt: ${attempts}, error: ${e.message}`);
            if (tempFile) { try { tempFile.setTrashed(true); } catch (err) {} }
            if (attempts >= maxAttempts) {
              Logger.log(`[EXPERIMENTAL][ERROR] Skipping student: ${name} after ${attempts} failed attempts.`);
              studentStatus = 'Failed';
              studentMessage = `Slides operation failed after ${attempts} attempts: ${e.message}`;
              // Log error to error sheet
              errorSheet.appendRow([batchIndex, name, email, studentMessage]);
            } else {
              Utilities.sleep(1000); // Wait 1s before retry
            }
          }
        }
      } catch (outerErr) {
        Logger.log(`[EXPERIMENTAL][FATAL] Could not process student: ${name}, error: ${outerErr.message}`);
        studentStatus = 'Failed';
        studentMessage = `Fatal error: ${outerErr.message}`;
        // Log error to error sheet
        errorSheet.appendRow([batchIndex, name, email, studentMessage]);
      }
      // Log progress for this student
      progressSheet.appendRow([batchIndex, name, email, studentStatus, studentMessage]);
    }
  }
  Logger.log(`[EXPERIMENTAL] Batch ${batchIndex} complete: ${generatedBlobs.length} PDFs generated.`);
}

// Helper: get or create output folder (reuse logic from chooseOutputFolder)
function chooseOutputFolderExperimental() {
  classCodeFinder();
  chooseOutputFolder();
  if (!parentFolder) {
    throw new Error('chooseOutputFolderExperimental: parentFolder is undefined. classCode=' + classCode + ', testName=' + testName);
  }
  return parentFolder;
}

// Helper: get master deck file for batch (reuse logic from createTestInSlides)
function getMasterDeckFile(mainFolder, testName) {
  // Try to find an existing master deck, or create a new one
  var files = mainFolder.getFilesByName(testName + " [Master].pdf");
  if (files.hasNext()) {
    var masterPdf = files.next();
    var masterDeckName = testName + " [TEMP_MASTER]";
    var deckFiles = mainFolder.getFilesByName(masterDeckName);
    if (deckFiles.hasNext()) {
      var deckFile = deckFiles.next();
      return deckFile;
    }
  }
  // Fallback: create new master deck
  return createMasterSlideDeck(mainFolder);
}
/**
 * ==============================================================================
 * 🏆 FINAL PRODUCTION SCRIPT (v12 - REST API EDITION)
 * ==============================================================================
 * 1. 🛡️ HYBRID BUILDER: Uses FormApp.create() to guarantee "Published" status.
 * 2. 🤖 REST API PATCH: Uses UrlFetchApp to force "Verified" emails.
 * 3. 🚚 MOVE LOGIC: Moves the form to the School Folder after creation.
 * ==============================================================================
 */

var ppqSelector = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PPQselector');

// --- ROW CONFIGURATION ---
var codeCell = ppqSelector.getRange("G6"); 
var codeCellRow = codeCell.getRow();
var codeCellColumn = codeCell.getColumn();
var testName = ppqSelector.getRange(1,7).getValue(); 
var templateFile; 
var parentFolder;
var scriptProperties = PropertiesService.getScriptProperties();
var templateId = "1C2tHSaN2mgJA9IU0FPbyTeo_Yk33j_6C13B5nUsK7Bg";
var classCode;
var MASTER_DATABASE_ID = "1sONUu-uxPHsp-VuNxa3d1pM7x_HdNBjftRjLE0BI9KA";


// STEP 1: Generate all PDFs (no form, no DB, no cleanup)
// Legacy generateAllPDFs is now disabled. Use startBatchPDFWorkflow instead for all PDF generation.

// STEP 2: Post-processing (form, DB, cleanup)
function finalizeExamBatch() {
  var props = PropertiesService.getScriptProperties();
  var step = props.getProperty('finalizeStep') || 'start';
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Re-initialize globals on every trigger re-entry (globals are lost between executions)
  classCodeFinder();
  chooseOutputFolder();
  var logSheetName = 'FinalizeBatchLog';
  var logSheet = ss.getSheetByName(logSheetName);
  if (!logSheet) {
    logSheet = ss.insertSheet(logSheetName);
    logSheet.appendRow(['Timestamp', 'Step', 'Status', 'Message']);
  }
  function log(status, message) {
    logSheet.appendRow([new Date(), step, status, message]);
  }
  try {
    if (step === 'start') {
      Logger.log("🔵 STEP 2: Finalizing exam batch");
      choosePaperTemplate();
      props.setProperty('finalizeStep', 'getExamFolder');
      log('Success', 'Initial setup complete');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'getExamFolder') {
      var examFolder = getOrCreateFolder(parentFolder, testName);
      props.setProperty('examFolderId', examFolder.getId());
      props.setProperty('finalizeStep', 'createForm');
      log('Success', 'Exam folder ready');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'createForm') {
      var examFolder = DriveApp.getFolderById(props.getProperty('examFolderId'));
      var form = FormApp.create(testName + " marks achieved");
      props.setProperty('formId', form.getId());
      props.setProperty('finalizeStep', 'moveForm');
      log('Success', 'Form created: ' + form.getId());
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'moveForm') {
      var formId = props.getProperty('formId');
      var examFolder = DriveApp.getFolderById(props.getProperty('examFolderId'));
      var formFile = DriveApp.getFileById(formId);
      formFile.moveTo(examFolder);
      props.setProperty('finalizeStep', 'setVerifiedEmail');
      log('Success', 'Form moved to exam folder');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'setVerifiedEmail') {
      var formId = props.getProperty('formId');
      setVerifiedEmailViaRest(formId);
      props.setProperty('finalizeStep', 'connectDB');
      log('Success', 'Verified email enabled');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'connectDB') {
      var formId = props.getProperty('formId');
      var masterSS = SpreadsheetApp.openById(MASTER_DATABASE_ID);
      var oldSheets = masterSS.getSheets().map(function(s) { return s.getSheetId(); });
      var form = FormApp.openById(formId);
      form.setDestination(FormApp.DestinationType.SPREADSHEET, MASTER_DATABASE_ID);
      SpreadsheetApp.flush();
      Utilities.sleep(2000);
      props.setProperty('finalizeStep', 'renameResponseTab');
      log('Success', 'Form connected to master database');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'renameResponseTab') {
      var masterSS = SpreadsheetApp.openById(MASTER_DATABASE_ID);
      var testNameVal = testName;
      var cleanSheetName = testNameVal.replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
      var responseTabName = cleanSheetName + "_res";
      var allSheets = masterSS.getSheets();
      var oldSheets = [];
      // Try to find the new response sheet (the one not in oldSheets)
      var responseSheet = allSheets.find(function(s) { return s.getName().indexOf(responseTabName) === -1; });
      if (responseSheet) {
        var existing = masterSS.getSheetByName(responseTabName);
        if (existing) {
          existing.setName(responseTabName + "_old_" + Date.now());
          existing.hideSheet();
          log('Info', 'Old response tab renamed and hidden');
        }
        responseSheet.setName(responseTabName);
        log('Success', 'Response tab renamed: ' + responseTabName);
      }
      props.setProperty('finalizeStep', 'createGradeTab');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'createGradeTab') {
      var masterSS = SpreadsheetApp.openById(MASTER_DATABASE_ID);
      var testNameVal = testName;
      var cleanSheetName = testNameVal.replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
      var gradeSheet = masterSS.getSheetByName(cleanSheetName);
      if (!gradeSheet) {
        gradeSheet = masterSS.insertSheet(cleanSheetName);
        gradeSheet.getRange("A4").setValue("Email");
        gradeSheet.getRange("B4").setValue("Name");
        gradeSheet.getRange("A5").setFormula("={'Students'!A2:B}");
        log('Success', 'Grade tab created: ' + cleanSheetName);
      } else {
        log('Info', 'Grade tab already exists');
      }
      props.setProperty('finalizeStep', 'registerStudentSheet');
      clearTriggersForFunction_('finalizeExamBatch');
      ScriptApp.newTrigger('finalizeExamBatch').timeBased().after(1000).create();
      return;
    }
    if (step === 'registerStudentSheet') {
      var masterSS = SpreadsheetApp.openById(MASTER_DATABASE_ID);
      var testNameVal = testName;
      var cleanSheetName = testNameVal.replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
      var responseTabName = cleanSheetName + "_res";
      var formId = props.getProperty('formId');
      var form = FormApp.openById(formId);
      var studentSheet = masterSS.getSheetByName("Students");
      var textFinder = studentSheet.createTextFinder(testNameVal);
      if (!textFinder.findNext()) {
        studentSheet.appendRow([
          "", "", "", "", "", "", "",
          testNameVal,
          responseTabName,
          form.getPublishedUrl(),
          "✅ Active"
        ]);
        log('Success', 'Registered in Students sheet');
      } else {
        log('Info', 'Already registered in Students sheet');
      }
      props.deleteProperty('finalizeStep');
      props.deleteProperty('examFolderId');
      props.deleteProperty('formId');
      Logger.log("🏁 STEP 2: Finalization complete.");
      log('Success', 'Finalization complete');
      ss.toast("Exam batch finalized! Form and DB registered.", "Step 2 Done", 10);
      return;
    }
  } catch (e) {
    log('Error', e.message);
    ss.toast("⚠️ Finalization error: " + e.message, "Error", 10);
    Logger.log("❌ Finalization error: " + e.message);
    // Leave step in place for retry
  }
}

// Legacy entry point — starts batch PDF workflow only.
// Finalization should be run separately after all batches complete.
function testBuilder() {
  startBatchPDFWorkflow();
}
// Add custom menu for both steps
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  // Main streamlined menu
  ui.createMenu('Exam Factory')
    .addItem('Step 1: Generate All PDFs (Batch, Robust)', 'startBatchPDFWorkflow')
    .addItem('Step 1b: Resume Batch PDF Workflow', 'resumeBatchPDFWorkflow')
    .addItem('Step 2: Finalize Exam Batch', 'finalizeExamBatch')
    .addToUi();

  // Legacy detailed menu restored as a second menu
  ui.createMenu('Legacy Exam Tools')
    // Submenu: Tools for finding questions
    .addSubMenu(ui.createMenu('🔍 Question Chooser')
      .addItem('🔄 Update List from Database', 'updateChooserSheet')
      .addItem('🌪️ Filter Questions (Regex)', 'applyRegexFilterV6_3')
      .addItem('👀 Show All Rows (Reset)', 'resetFilterV6_3'))

    // Submenu: Managing the selection area
    .addSubMenu(ui.createMenu('🏗️ PPQ Workspace')
      .addItem('🧹 Clear Workspace', 'resetIteration'))

    // Submenu: Building the actual test
    .addSubMenu(ui.createMenu('📝 Exam Assembly')
      .addItem('🆔 Fetch Doc IDs', 'returnAllID')
      .addItem('📓 Export to Gradebook', 'exportToGradebook')
      .addSeparator()
      .addItem('🚀 Build Exam', 'testBuilder')
      .addItem('📄 Update Cover Page', 'editCoverPage')
      .addSeparator()
      .addItem('📦 Archive to History', 'archiveCurrentExam')
      .addItem('📥 Restore Archived Exam', 'restoreArchivedExam')
      .addSeparator()
      .addItem('♻️ Reset Builder Form', 'resetBuilder')
      .addItem('🧨 Nuke Everything', 'clearAll'))

    // Submenu: Database sync tools
    .addSubMenu(ui.createMenu('🗄️ Database Tools')
      .addItem('📋 Dump Sheet Schemas', 'dumpAllSheetSchemas')
      .addSeparator()
      .addItem('🔗 Test DB Connection', 'testSupabaseConnection')
      .addItem('🔄 Sync Questions to DB', 'syncQuestionsToSupabase')
      .addItem('🔄 Sync Exams to DB', 'syncExamsToSupabase')
      .addItem('🔄 Sync Students to DB', 'syncStudentsToSupabase')
      .addItem('🔄 Sync All to DB', 'syncAllToSupabase')
      .addSeparator()
      .addItem('✅ Verify DB Sync', 'verifySupabaseSync'))

    .addToUi();
}

// --- HELPER FUNCTIONS ---
function classCodeFinder() {
  if (testName.toString().includes("27AH")) { 
    classCode = "27AH"; 
  } else {
    var match = testName.match(/(\d{2}AH)/);
    classCode = match ? match[1] : "UNKNOWN";
  }
}

function chooseOutputFolder() {
  if (classCode == "26AH") { parentFolder = DriveApp.getFolderById("13fQddh2NNWkXNu9oLtZUnUB_Aa64dc89"); }
  if (classCode == "27AH") { parentFolder = DriveApp.getFolderById("1K1BL-3FhAIQLSrE2jJUimClGDzRV8ZaQ"); } 
  if (classCode == "24AH") { parentFolder = DriveApp.getFolderById("1SySkSBE_2lcenlAo1Jllg3G3rY6G-tr6"); }
  if (classCode == "25AH") { parentFolder = DriveApp.getFolderById("1A2gqeqooC0LO4ds57M-ElZ-RN6J-ScnA"); }
}

function choosePaperTemplate() {
  if (testName.toString().includes("P1")) { templateFile = DriveApp.getFileById("1C2tHSaN2mgJA9IU0FPbyTeo_Yk33j_6C13B5nUsK7Bg"); }
  if (testName.toString().includes("P2")) { templateFile = DriveApp.getFileById("135Eh2gVHvnum6Vq6GahPJhmnwNrb4dp4S7t6F1RondY"); }
  if (testName.toString().includes("P3")) { templateFile = DriveApp.getFileById("1tj44_JYJx1kGV64N1NItA8y3aHYBvNkPdpTb6o1dqR4"); }
}

function getRowDataClean(rowNumber) {
  var lastCol = ppqSelector.getLastColumn();
  if (lastCol < 7) return [];
  var data = ppqSelector.getRange(rowNumber, 7, 1, lastCol - 6).getValues()[0];
  return data.filter(function(cell) { return cell !== "" && cell !== null; });
}

function resetIteration() {
  // 1. Clear Row 2 ONLY (Total Marks)
  ppqSelector.getRange("G2:AZ2").clearContent();
  
  // 2. Clear Row 4 down to the bottom (Syllabus, Codes, Docs, Parts, Marks)
  // This explicitly PROTECTS Row 3 (Question Labels)
  ppqSelector.getRange("G4:AZ50").clearContent(); 
  
  // Reset Column Counter to 6 (Column F) so the next click starts at 7 (G)
  ppqSelector.getRange(1,2).setValue(6);
}

function linkToDriveFolder() {
  codeCell = ppqSelector.getRange("G6");
  var codeCellColumn = codeCell.getColumn();
  var codeCellRow = codeCell.getRow();
  const rangeToAddLink = ppqSelector.getRange(codeCellRow - 5, codeCellColumn); 
  const richText = SpreadsheetApp.newRichTextValue().setText(testName).build();
  rangeToAddLink.setRichTextValue(richText);
}

function storeVariable(idToStore) { scriptProperties.setProperty('Id', idToStore); }

/**
 * 🆔 Fetch Doc IDs
 * Looks up Google Doc IDs for questions and mark schemes by matching
 * question codes (row 6) against filenames in the exam/MS folders.
 */
function returnAllID() {
  try {
    returnFileID();
    returnMSfileID();
    SpreadsheetApp.getUi().alert("✅ Doc IDs Populated Successfully");
  } catch (e) {
    SpreadsheetApp.getUi().alert("❌ Error: " + e.message);
  }
}

function returnFileID() {
  var examFolder = DriveApp.getFolderById('18vwi-jz_0vur8MjixNnTkKdb0lHygNV3'); 
  var examCodes = getRowDataClean(6); 
  if (examCodes.length === 0) return;

  var outputRow = 7; 
  var codeOutputRow = 5; 
  var startCol = 7; 
  
  var files = examFolder.getFiles();
  var fileMap = {};
  while (files.hasNext()) {
    var f = files.next();
    fileMap[f.getName()] = f.getId();
  }

  for (var i = 0; i < examCodes.length; i++) {
    var rawCode = examCodes[i];
    var strippedCode = rawCode;
    var codeEnd = strippedCode.slice(-1);
    while (isNaN(parseFloat(codeEnd)) && !isFinite(codeEnd) && strippedCode.length > 0) {
      strippedCode = strippedCode.slice(0,-1);
      codeEnd = strippedCode.slice(-1);
    }
    
    ppqSelector.getRange(codeOutputRow, startCol + i).setValue(strippedCode);

    var fileId = fileMap[strippedCode];
    var cell = ppqSelector.getRange(outputRow, startCol + i);
    
    if (fileId) {
      cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(fileId).setLinkUrl("https://docs.google.com/document/d/" + fileId).build());
    } else {
      cell.setValue("File Not Found");
    }
  }
}

function returnMSfileID() {
  var msFolder = DriveApp.getFolderById('1GDGql-mIeH2YoD1OfnFa0UhxUdaXsY4D'); 
  var examCodes = getRowDataClean(6); 
  if (examCodes.length === 0) return;

  var outputRow = 8; 
  var startCol = 7; 
  
  var files = msFolder.getFiles();
  var fileMap = {}; 
  while (files.hasNext()) {
    var f = files.next();
    fileMap[f.getName()] = f.getId();
  }

  for (var i = 0; i < examCodes.length; i++) {
    var rawCode = examCodes[i];
    var strippedCode = rawCode;
    var codeEnd = strippedCode.slice(-1);
    while (isNaN(parseFloat(codeEnd)) && !isFinite(codeEnd) && strippedCode.length > 0) {
      strippedCode = strippedCode.slice(0,-1);
      codeEnd = strippedCode.slice(-1);
    }
    
    var fileId = fileMap[strippedCode];
    var cell = ppqSelector.getRange(outputRow, startCol + i);
    
    if (fileId) {
      cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(fileId).setLinkUrl("https://docs.google.com/document/d/"+fileId).build());
    } else {
      cell.setValue("MS Not Found");
    }
  }
}

/**
 * 📓 Export to Gradebook
 * Reads question data from PPQselector and writes a grading template
 * into the master database spreadsheet.
 */
function exportToGradebook() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ppq = ss.getSheetByName("PPQselector");
  
  var testNameVal = ppq.getRange(1, 7).getValue(); // G1 = test name
  if (!testNameVal) {
    SpreadsheetApp.getUi().alert("❌ No test name found in G1. Build an exam first.");
    return;
  }

  var masterSS = SpreadsheetApp.openById(MASTER_DATABASE_ID);
  
  // Clean sheet name (same convention as createFormAndRegister)
  var cleanSheetName = testNameVal.toString().replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
  
  // Get or create the grade tab
  var gradeSheet = masterSS.getSheetByName(cleanSheetName);
  if (!gradeSheet) {
    gradeSheet = masterSS.insertSheet(cleanSheetName);
  } else {
    // Clear existing content below headers
    if (gradeSheet.getLastRow() > 3) {
      gradeSheet.getRange(4, 1, gradeSheet.getLastRow() - 3, gradeSheet.getLastColumn()).clearContent();
    }
  }
  
  // Read PPQselector data
  var qCodes = getRowDataClean(6);   // Row 6: question codes
  var qMarks = getRowDataClean(2);   // Row 2: total marks per question
  var qLabels = getRowDataClean(3);  // Row 3: question labels
  
  if (qCodes.length === 0) {
    SpreadsheetApp.getUi().alert("❌ No questions found in PPQselector row 6.");
    return;
  }

  // Build header rows
  // Row 1: Test name
  gradeSheet.getRange(1, 1).setValue(testNameVal);
  
  // Row 2: "Total" label + total marks per question
  var row2 = ["", "Total"];
  for (var i = 0; i < qMarks.length; i++) {
    row2.push(qMarks[i]);
  }
  gradeSheet.getRange(2, 1, 1, row2.length).setValues([row2]);
  
  // Row 3: "Email", "Name", then question labels or codes
  var row3 = ["Email", "Name"];
  for (var i = 0; i < qCodes.length; i++) {
    row3.push(qLabels[i] || qCodes[i]);
  }
  gradeSheet.getRange(3, 1, 1, row3.length).setValues([row3]);
  
  // Row 4+: Pull student list
  var studentSheet = masterSS.getSheetByName("Students");
  if (studentSheet && studentSheet.getLastRow() > 1) {
    var students = studentSheet.getRange(2, 1, studentSheet.getLastRow() - 1, 2).getValues();
    var studentRows = students.filter(function(r) { return r[0] !== ""; });
    if (studentRows.length > 0) {
      gradeSheet.getRange(4, 1, studentRows.length, 2).setValues(studentRows);
    }
  }
  
  SpreadsheetApp.getActiveSpreadsheet().toast("✅ Gradebook exported: " + cleanSheetName, "Success", 5);
}

/**
 * ♻️ Reset Builder Form
 * Resets the PPQselector to a clean state, clearing all question data
 * but preserving the sheet structure and Row 3 labels.
 */
function resetBuilder() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ppq = ss.getSheetByName("PPQselector");
  
  // Clear Row 1 (test name, column counter, config) except structure
  ppq.getRange("G1:AZ1").clearContent();
  
  // Clear Row 2 (total marks)
  ppq.getRange("G2:AZ2").clearContent();
  
  // Row 3 is PROTECTED (question labels) — do not touch
  
  // Clear Rows 4 onward (syllabus, codes, doc IDs, parts, marks)
  ppq.getRange("G4:AZ50").clearContent();
  
  // Reset column counter to 6 (next click writes to col G = 7)
  ppq.getRange(1, 2).setValue(6);
  
  // Clear stored script properties
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('Id');
  
  // Reset checkboxes on HL list and SL list
  var hlSheet = ss.getSheetByName("HL list");
  var slSheet = ss.getSheetByName("SL list");
  
  if (hlSheet) {
    var hlLast = hlSheet.getLastRow();
    var hlLastCol = hlSheet.getLastColumn();
    if (hlLast > 0 && hlLastCol > 0) {
      var hlData = hlSheet.getRange(1, 1, hlLast, hlLastCol).getValues();
      for (var r = 0; r < hlData.length; r++) {
        for (var c = 0; c < hlData[r].length; c++) {
          if (hlData[r][c] === true) {
            hlSheet.getRange(r + 1, c + 1).setValue(false);
          }
        }
      }
    }
  }
  
  if (slSheet) {
    var slLast = slSheet.getLastRow();
    var slLastCol = slSheet.getLastColumn();
    if (slLast > 0 && slLastCol > 0) {
      var slData = slSheet.getRange(1, 1, slLast, slLastCol).getValues();
      for (var r = 0; r < slData.length; r++) {
        for (var c = 0; c < slData[r].length; c++) {
          if (slData[r][c] === true) {
            slSheet.getRange(r + 1, c + 1).setValue(false);
          }
        }
      }
    }
  }
  
  ss.toast("♻️ Builder form reset. Checkboxes cleared.", "Reset Complete", 3);
}

/**
 * 🧨 Nuke Everything
 * Aggressively clears ALL workspace data across PPQselector,
 * HL list, SL list checkboxes, and chooser sheets.
 */
function clearAll() {
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert(
    "🧨 Nuke Everything",
    "This will clear ALL data in PPQselector (including Row 3 labels), " +
    "reset all checkboxes, and clear chooser sheets.\n\nAre you sure?",
    ui.ButtonSet.YES_NO
  );
  
  if (confirm !== ui.Button.YES) {
    return;
  }
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ppq = ss.getSheetByName("PPQselector");
  
  // 1. Nuke PPQselector — ALL rows including Row 3
  ppq.getRange("G1:AZ50").clearContent();
  ppq.getRange(1, 2).setValue(6); // Reset column counter
  
  // 2. Clear stored properties
  var props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  
  // 3. Reset ALL checkboxes on HL list
  var hlSheet = ss.getSheetByName("HL list");
  if (hlSheet) {
    var hlLast = hlSheet.getLastRow();
    var hlLastCol = hlSheet.getLastColumn();
    if (hlLast > 0 && hlLastCol > 0) {
      var hlData = hlSheet.getRange(1, 1, hlLast, hlLastCol).getValues();
      for (var r = 0; r < hlData.length; r++) {
        for (var c = 0; c < hlData[r].length; c++) {
          if (hlData[r][c] === true) {
            hlSheet.getRange(r + 1, c + 1).setValue(false);
          }
        }
      }
    }
  }
  
  // 4. Reset ALL checkboxes on SL list
  var slSheet = ss.getSheetByName("SL list");
  if (slSheet) {
    var slLast = slSheet.getLastRow();
    var slLastCol = slSheet.getLastColumn();
    if (slLast > 0 && slLastCol > 0) {
      var slData = slSheet.getRange(1, 1, slLast, slLastCol).getValues();
      for (var r = 0; r < slData.length; r++) {
        for (var c = 0; c < slData[r].length; c++) {
          if (slData[r][c] === true) {
            slSheet.getRange(r + 1, c + 1).setValue(false);
          }
        }
      }
    }
  }
  
  // 5. Clear chooser sheets
  var hlChooser = ss.getSheetByName("HL chooser");
  if (hlChooser && hlChooser.getLastRow() > 1) {
    hlChooser.getRange(2, 1, hlChooser.getLastRow() - 1, hlChooser.getLastColumn()).clearContent();
  }
  
  var slChooser = ss.getSheetByName("SL chooser");
  if (slChooser && slChooser.getLastRow() > 1) {
    slChooser.getRange(2, 1, slChooser.getLastRow() - 1, slChooser.getLastColumn()).clearContent();
  }
  
  ss.toast("🧨 Everything nuked. All data cleared.", "Nuke Complete", 5);
}

/**
 * 🆕 CREATE FORM AND REGISTER IN DATABASE
 * Creates a Google Form, connects it to the master database, and registers it.
 */
function createFormAndRegister(examFolder) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.toast("Creating exam form...", "Working", -1);
    
    // 1. Create the form
    var form = FormApp.create(testName + " marks achieved");
    var formId = form.getId();
    var formFile = DriveApp.getFileById(formId);
    
    Logger.log("✅ Form created: " + formId);
    
    // 2. Move form to exam folder
    var targetFolder = examFolder || parentFolder;
    formFile.moveTo(targetFolder);
    Logger.log("✅ Form moved to exam folder");
    
    // 3. Set verified email requirement
    setVerifiedEmailViaRest(formId);
    Logger.log("✅ Verified email enabled");
    
    // 4. Connect form to master database
    var masterSS = SpreadsheetApp.openById(MASTER_DATABASE_ID);
    var oldSheets = masterSS.getSheets().map(function(s) { return s.getSheetId(); });
    
    form.setDestination(FormApp.DestinationType.SPREADSHEET, MASTER_DATABASE_ID);
    SpreadsheetApp.flush();
    Utilities.sleep(2000);
    
    Logger.log("✅ Form connected to master database");
    
    // 5. Rename the response tab
    var cleanSheetName = testName.replace(/ \[/, "_").replace(/\] /, "_").replace(/ /g, "_");
    var responseTabName = cleanSheetName + "_res";
    
    var allSheets = masterSS.getSheets();
    var responseSheet = allSheets.find(function(s) { return !oldSheets.includes(s.getSheetId()); });
    
    if (responseSheet) {
      var existing = masterSS.getSheetByName(responseTabName);
      if (existing) {
        // Rename old sheet instead of deleting — deletion fails if a form is still linked
        existing.setName(responseTabName + "_old_" + Date.now());
        existing.hideSheet();
        Logger.log("ℹ️ Old response tab renamed and hidden");
      }
      responseSheet.setName(responseTabName);
      Logger.log("✅ Response tab renamed: " + responseTabName);
    }
    
    // 6. Create grade tab if it doesn't exist
    var gradeSheet = masterSS.getSheetByName(cleanSheetName);
    if (!gradeSheet) {
      gradeSheet = masterSS.insertSheet(cleanSheetName);
      gradeSheet.getRange("A4").setValue("Email");
      gradeSheet.getRange("B4").setValue("Name");
      gradeSheet.getRange("A5").setFormula("={'Students'!A2:B}");
      Logger.log("✅ Grade tab created: " + cleanSheetName);
    }
    
    // 7. Register in Students sheet
    var studentSheet = masterSS.getSheetByName("Students");
    var textFinder = studentSheet.createTextFinder(testName);
    
    if (!textFinder.findNext()) {
      studentSheet.appendRow([
        "", "", "", "", "", "", "",
        testName,
        responseTabName,
        form.getPublishedUrl(),
        "✅ Active"
      ]);
      Logger.log("✅ Registered in Students sheet");
    } else {
      Logger.log("ℹ️ Already registered in Students sheet");
    }
    
    ss.toast("✅ Form created and registered in database", "Success", 5);
    
  } catch (e) {
    Logger.log("❌ Form creation error: " + e.message);
    SpreadsheetApp.getActiveSpreadsheet().toast("⚠️ Form creation failed: " + e.message, "Error", 10);
  }
}

/**
 * 🤖 SET VERIFIED EMAIL VIA REST API
 * This uses UrlFetchApp to bypass the limitations of FormApp service.
 * Requires scopes in appsscript.json.
 */
function setVerifiedEmailViaRest(formId) {
  var url = "https://forms.googleapis.com/v1/forms/" + formId + ":batchUpdate";
  var payload = {
    "requests": [
      {
        "updateSettings": {
          "settings": {
            "emailCollectionType": "VERIFIED"
          },
          "updateMask": "emailCollectionType"
        }
      }
    ]
  };
  
  var options = {
    "method": "post",
    "contentType": "application/json",
    "headers": {
      "Authorization": "Bearer " + ScriptApp.getOAuthToken()
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  
  if (responseCode !== 200) {
    throw new Error("Forms API returned " + responseCode + ": " + response.getContentText());
  }
}

function editCoverPage() {
  // Retrieve the ID of the last created doc (stored by testBuilder)
  var storedId = scriptProperties.getProperty('Id');
  
  if (!storedId) {
    SpreadsheetApp.getActiveSpreadsheet().toast("❌ No recent document found. Run testBuilder first.", "Error", 5);
    return;
  }

  var doc = DocumentApp.openById(storedId);
  var body = doc.getBody();
  var paragraphs = body.getParagraphs();

  // 1. Update Test Name (Paragraph 5)
  try {
    paragraphs[5].setText(testName);
    paragraphs[5].setAttributes({FONT_SIZE: 11, BOLD: false});
  } catch (e) { Logger.log("Index 5 (Name) not found"); }

  // 2. Calculate Total Marks from Row 2
  var marksData = getRowDataClean(2);
  var marks = marksData.reduce((a, b) => a + Number(b), 0);

  // 3. Update Marks (Paragraph 18)
  try {
    paragraphs[18].appendText(" [" + marks + " marks].");
    paragraphs[18].setAttributes({FONT_SIZE: 11, BOLD: true});
  } catch (e) { Logger.log("Index 18 (Marks) not found"); }

  // 4. Calculate & Update Time (Paragraph 7)
  // Logic: 1.1 minutes per mark
  var minutes = Math.ceil(marks * 12 / 11);
  try {
    paragraphs[7].setText(minutes + " minutes");
    paragraphs[7].setAttributes({FONT_SIZE: 11});
  } catch (e) { Logger.log("Index 7 (Time) not found"); }

  // 5. 📄 RESTORED: Page Count (Paragraph 46)
  // This exports the Doc as a PDF blob to count the pages reliably.
  try {
    var pdfBlob = DriveApp.getFileById(storedId).getBlob();
    var pdfText = pdfBlob.getDataAsString();
    // The "split" hack counts the number of page content streams in the PDF structure
    var pages = pdfText.split("/Contents").length - 2; 
    
    // Safety check: Ensure the value isn't negative or weird
    if (pages < 1) pages = 1; 

    if (paragraphs.length > 46) {
      paragraphs[46].setText(pages + " pages");
      paragraphs[46].setAttributes({FONT_SIZE: 11});
      Logger.log("✅ Page count updated: " + pages);
    } else {
      Logger.log("⚠️ Paragraph 46 does not exist. Doc is too short.");
    }
  } catch (e) {
    Logger.log("❌ Error counting pages: " + e.message);
  }

  // 6. Cleanup "Section B" placeholders
  // (Removes extra section headers if they exist)
  var secB = body.getText().indexOf("Section B", 400);
  while (secB > 0) {
    try {
       // Only deletes if found.
       // Note: This requires careful indexing. Disabling delete for safety is an option.
       // doc.editAsText().deleteText(secB, secB + 105); 
    } catch (e) {}
    secB = body.getText().indexOf("Section B", secB + 1);
  }
  
  doc.saveAndClose();
  SpreadsheetApp.getActiveSpreadsheet().toast("✅ Cover Page Updated (Title, Marks, Time, Pages)", "Success", 3);
}