/********************************
 * ExamSystem_Integration.js
 * 
 * Integration layer connecting the new Exam UI
 * with existing MSA and SRG systems
 ********************************/

/**
 * Modified doGet to serve either the old or new UI
 * Add ?ui=exam to URL to load the new Exam Management UI
 * Default (no params) shows the Exam Management UI
 */
function doGet(e) {
  const params = e.parameter || {};
  
  // Log for debugging
  Logger.log('doGet called with params: ' + JSON.stringify(params));
  
  // Add ?ui=msa to URL for the old MSA Validation & Repair UI
  if (params.ui === 'msa') {
    Logger.log('Serving MSA UI (Index.html)');
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('MSA Validation & Repair')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  
  // Default to Exam Management UI (the new one without banner)
  Logger.log('Serving Exam Management UI');
  return doGetExamUI(e);
}

/**
 * Wrapper function to run markscheme atomization
 * Integrates with existing MSA pipeline
 */
function runMarkschemeAtomizationWrapper(examFolderId) {
  try {
    return runMarkschemeAtomization(examFolderId);
  } catch (error) {
    msaError_('Atomization failed: ' + error.message);
    throw error;
  }
}

/**
 * Wrapper function to run student OCR
 * Uses new StudentWorkOCR module
 */
function runStudentWorkOcrWrapper(examFolderId) {
  try {
    return runStudentWorkOcr(examFolderId);
  } catch (error) {
    msaError_('Student OCR failed: ' + error.message);
    throw error;
  }
}

/**
 * Wrapper function to run grading
 * Integrates with existing SRG_Grader
 */
function runStudentGradingWrapper(examFolderId) {
  try {
    return runStudentGrading(examFolderId);
  } catch (error) {
    msaError_('Grading failed: ' + error.message);
    throw error;
  }
}

/**
 * Helper: Create a menu in Google Sheets/Docs to access both UIs
 * Add this to your onOpen() trigger
 */
function createExamSystemMenu() {
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    try {
      ui = DocumentApp.getUi();
    } catch (e2) {
      return; // Not in a Sheets/Docs context
    }
  }
  
  ui.createMenu('🎓 Exam System')
    .addItem('📊 Exam Management', 'openExamManagementUI')
    .addItem('🔧 MSA Validation', 'openMSAValidationUI')
    .addSeparator()
    .addItem('⚙️ Run Test', 'testExamSystem')
    .addToUi();
}

/**
 * onOpen trigger - automatically creates menu when opening Sheets/Docs
 * To install: Run once manually, then it auto-runs on every open
 */
function onOpen() {
  createExamSystemMenu();
}

/**
 * Open the new Exam Management UI in full screen modal (NO BANNER!)
 */
function openExamManagementUI() {
  const html = HtmlService.createHtmlOutputFromFile('ExamUI')
    .setWidth(1400)
    .setHeight(900);
  
  // Try Sheets first, fall back to Docs
  try {
    SpreadsheetApp.getUi().showModalDialog(html, 'Exam Management System');
  } catch (e) {
    try {
      DocumentApp.getUi().showModalDialog(html, 'Exam Management System');
    } catch (e2) {
      Logger.log('Could not open UI: ' + e2.message);
    }
  }
}

/**
 * Open the original MSA Validation UI in modal
 */
function openMSAValidationUI() {
  const html = HtmlService.createHtmlOutputFromFile('Index')
    .setWidth(1200)
    .setHeight(800);
  
  try {
    SpreadsheetApp.getUi().showModalDialog(html, 'MSA Validation & Repair');
  } catch (e) {
    try {
      DocumentApp.getUi().showModalDialog(html, 'MSA Validation & Repair');
    } catch (e2) {
      Logger.log('Could not open UI: ' + e2.message);
    }
  }
}

/**
 * Open configuration dialog
 */
function openConfigDialog() {
  const config = _getExamSystemConfig();
  
  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; }
      .config-item { margin-bottom: 15px; }
      .config-item label { display: block; font-weight: bold; margin-bottom: 5px; }
      .config-item input { width: 100%; padding: 8px; }
      .save-btn { background: #4285f4; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
    </style>
    <h2>Exam System Configuration</h2>
    <div class="config-item">
      <label>Root Folder ID:</label>
      <input type="text" id="rootFolderId" value="${config.ROOT_FOLDER_ID}">
    </div>
    <div class="config-item">
      <label>Student Work Folder Name:</label>
      <input type="text" id="studentWorkFolder" value="${config.STUDENT_WORK_FOLDER_NAME}">
    </div>
    <div class="config-item">
      <label>Individual PDFs Folder Name:</label>
      <input type="text" id="individualPdfsFolder" value="${config.INDIVIDUAL_PDFS_FOLDER_NAME}">
    </div>
    <p><em>Note: To update configuration, edit ExamUI_Backend.js directly.</em></p>
    <button class="save-btn" onclick="google.script.host.close()">Close</button>
  `).setWidth(500).setHeight(400);
  
  SpreadsheetApp.getUi().showModalDialog(html, 'System Configuration');
}

/**
 * Quick test function to verify the new system works
 */
function testExamSystem() {
  Logger.log('=== Testing Exam System ===');
  
  // Test 1: Load classes
  try {
    const classes = getClasses(false);
    Logger.log(`✓ Loaded ${classes.length} classes`);
  } catch (e) {
    Logger.log(`✗ Failed to load classes: ${e.message}`);
    return;
  }
  
  // Test 2: Check config
  try {
    const config = _getExamSystemConfig();
    Logger.log(`✓ Config loaded: ROOT_FOLDER_ID = ${config.ROOT_FOLDER_ID}`);
    
    if (config.ROOT_FOLDER_ID === "YOUR_ROOT_FOLDER_ID_HERE") {
      Logger.log(`⚠ WARNING: ROOT_FOLDER_ID not configured! Please update ExamUI_Backend.js`);
      return;
    }
  } catch (e) {
    Logger.log(`✗ Failed to load config: ${e.message}`);
    return;
  }
  
  // Test 3: Check folder access
  try {
    const config = _getExamSystemConfig();
    const rootFolder = DriveApp.getFolderById(config.ROOT_FOLDER_ID);
    Logger.log(`✓ Root folder accessible: "${rootFolder.getName()}"`);
  } catch (e) {
    Logger.log(`✗ Cannot access root folder: ${e.message}`);
    return;
  }
  
  Logger.log('=== All Tests Passed ===');
  Logger.log('You can now use the Exam Management UI!');
}

/**
 * Initialize the exam system (run once after setup)
 */
function initializeExamSystem() {
  Logger.log('Initializing Exam Management System...');
  
  const config = _getExamSystemConfig();
  
  // Verify configuration
  if (config.ROOT_FOLDER_ID === "YOUR_ROOT_FOLDER_ID_HERE") {
    throw new Error('Please configure ROOT_FOLDER_ID in ExamUI_Backend.js');
  }
  
  // Verify root folder access
  try {
    const rootFolder = DriveApp.getFolderById(config.ROOT_FOLDER_ID);
    Logger.log(`Root folder found: ${rootFolder.getName()}`);
  } catch (e) {
    throw new Error('Cannot access root folder. Check ROOT_FOLDER_ID and permissions.');
  }
  
  // Create necessary folders if they don't exist
  // (Add any initialization logic here)
  
  Logger.log('✓ Initialization complete!');
  Logger.log('Run testExamSystem() to verify everything works.');
}

/**
 * Batch process all exams in a class
 * Useful for end-of-term bulk grading
 */
function batchProcessClass(classFolderId) {
  Logger.log('Starting batch processing for class...');
  
  const exams = getExamsForClass(classFolderId);
  const results = {
    total: exams.length,
    successful: 0,
    failed: 0,
    errors: []
  };
  
  exams.forEach(exam => {
    try {
      Logger.log(`Processing exam: ${exam.name}`);
      
      // Step 1: Atomize markscheme
      runMarkschemeAtomization(exam.id);
      
      // Step 2: OCR student work (skip human review for batch)
      runStudentWorkOcr(exam.id);
      
      // Step 3: Grade students
      runStudentGrading(exam.id);
      
      results.successful++;
      Logger.log(`✓ Completed: ${exam.name}`);
      
    } catch (error) {
      results.failed++;
      results.errors.push({
        exam: exam.name,
        error: error.message
      });
      Logger.log(`✗ Failed: ${exam.name} - ${error.message}`);
    }
  });
  
  Logger.log('=== Batch Processing Complete ===');
  Logger.log(`Successful: ${results.successful}/${results.total}`);
  Logger.log(`Failed: ${results.failed}/${results.total}`);
  
  return results;
}
