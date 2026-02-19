/********************************
 * ExamUI_Backend.js
 * 
 * Backend functions for the Exam Management UI
 ********************************/

/**
 * Serves the new Exam UI
 */
function doGetExamUI(e) {
  return HtmlService.createHtmlOutputFromFile('ExamUI')
    .setTitle('Exam Management System')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Get the web app URL for navigation
 * @returns {string} The current web app deployment URL
 */
function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

/**
 * Configuration: Define your class folders structure
 * UPDATE THIS with your actual folder IDs
 */
function _getExamSystemConfig() {
  return {
    // Root folder containing all class folders
    ROOT_FOLDER_ID: "11oErECAiXboY4mp0AkbBBawnZSJ-k7XE",
    
    // Patterns to identify current vs past classes
    // Classes with these keywords in their name are considered "current"
    CURRENT_CLASS_KEYWORDS: ["2025-2026", "Current", "Active"],
    
    // Classes with these keywords are considered "past"
    PAST_CLASS_KEYWORDS: ["2024-2025", "2023-2024", "Past", "Archive"],
    
    // Expected subfolder names in each exam folder
    STUDENT_WORK_FOLDER_NAME: "Student Work",
    INDIVIDUAL_PDFS_FOLDER_NAME: "Individual PDFs",
    MARKSCHEME_FILENAME_PATTERN: /mark.*scheme|ms/i,
    EXAM_FILENAME_PATTERN: /exam|test|quiz/i
  };
}

/**
 * Get list of classes (current and optionally past)
 * @param {boolean} includePast Whether to include past classes
 * @returns {Array<{id: string, name: string, isPast: boolean}>}
 */
function getClasses(includePast) {
  const config = _getExamSystemConfig();
  const rootFolder = DriveApp.getFolderById(config.ROOT_FOLDER_ID);
  const classes = [];
  
  const folders = rootFolder.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    const name = folder.getName();
    
    // Determine if it's a past class
    const isPast = config.PAST_CLASS_KEYWORDS.some(keyword => 
      name.toLowerCase().includes(keyword.toLowerCase())
    );
    
    // Skip past classes if not included
    if (isPast && !includePast) continue;
    
    classes.push({
      id: folder.getId(),
      name: name,
      isPast: isPast
    });
  }
  
  // Sort: current classes first, then alphabetically
  classes.sort((a, b) => {
    if (a.isPast !== b.isPast) return a.isPast ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  
  return classes;
}

/**
 * Get list of exams for a given class
 * @param {string} classFolderId The folder ID of the class
 * @returns {Array<{id: string, name: string}>}
 */
function getExamsForClass(classFolderId) {
  const classFolder = DriveApp.getFolderById(classFolderId);
  const exams = [];
  
  const folders = classFolder.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    exams.push({
      id: folder.getId(),
      name: folder.getName()
    });
  }
  
  // Sort alphabetically
  exams.sort((a, b) => a.name.localeCompare(b.name));
  
  return exams;
}

/**
 * Run markscheme atomization for an exam
 * @param {string} examFolderId The folder ID of the exam
 * @returns {object} Result summary
 */
function runMarkschemeAtomization(examFolderId) {
  const config = _getExamSystemConfig();
  const examFolder = DriveApp.getFolderById(examFolderId);
  
  // Find the markscheme document
  const markschemeDoc = _findMarkschemeInFolder(examFolder, config);
  if (!markschemeDoc) {
    throw new Error("No markscheme document found in exam folder");
  }
  
  msaLog_("Starting atomization for: " + markschemeDoc.getName());
  
  // Run the existing MSA pipeline
  const result = runMSA_VR_One(markschemeDoc.getId());
  
  return {
    success: true,
    markschemeTitle: markschemeDoc.getName(),
    pointsCount: result.pointsCount || 0
  };
}

/**
 * Run Student Work OCR with human verification
 * @param {string} examFolderId The folder ID of the exam
 * @returns {object} Result with pages needing review
 */
function runStudentWorkOcr(examFolderId) {
  const config = _getExamSystemConfig();
  const examFolder = DriveApp.getFolderById(examFolderId);
  
  // Find student work folder
  const studentWorkFolder = _findSubfolderByName(examFolder, config.STUDENT_WORK_FOLDER_NAME);
  if (!studentWorkFolder) {
    throw new Error("Student Work folder not found in exam folder");
  }
  
  // Find individual PDFs folder
  const individualPdfsFolder = _findSubfolderByName(studentWorkFolder, config.INDIVIDUAL_PDFS_FOLDER_NAME);
  if (!individualPdfsFolder) {
    throw new Error("Individual PDFs folder not found in Student Work folder");
  }
  
  const ocrResults = [];
  const files = individualPdfsFolder.getFiles();
  
  while (files.hasNext()) {
    const file = files.next();
    const mimeType = file.getMimeType();
    
    // Process PDF or image files
    if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) {
      msaLog_("Processing: " + file.getName());
      
      // Convert PDF to images if needed, then OCR each page
      const pages = _extractAndOcrPages(file);
      
      pages.forEach(page => {
        ocrResults.push({
          id: file.getId() + "_page_" + page.pageNum,
          studentName: _extractStudentNameFromFilename(file.getName()),
          fileName: file.getName(),
          pageNum: page.pageNum,
          text: page.ocrText,
          imageUrl: page.imageUrl,
          confidence: page.confidence
        });
      });
    }
  }
  
  // Filter pages that need human review (low confidence)
  const needsReview = ocrResults.filter(page => page.confidence < 0.85);
  
  return {
    success: true,
    count: ocrResults.length,
    requiresReview: needsReview.length > 0,
    pages: needsReview
  };
}

/**
 * Save corrected OCR text
 * @param {string} pageId Unique identifier for the page
 * @param {string} correctedText Human-verified OCR text
 */
function saveOcrCorrection(pageId, correctedText) {
  // Parse the pageId to get file ID and page number
  const parts = pageId.split('_page_');
  const fileId = parts[0];
  const pageNum = parseInt(parts[1]);
  
  // Save to a corrections folder or database
  const file = DriveApp.getFileById(fileId);
  const parentFolder = file.getParents().next();
  
  // Create or get corrections folder
  let correctionsFolder = _findSubfolderByName(parentFolder, "OCR_Corrections");
  if (!correctionsFolder) {
    correctionsFolder = parentFolder.createFolder("OCR_Corrections");
  }
  
  // Save the corrected text
  const correctionFileName = file.getName().replace(/\.[^.]+$/, '') + '_page_' + pageNum + '_corrected.txt';
  const existingFiles = correctionsFolder.getFilesByName(correctionFileName);
  
  if (existingFiles.hasNext()) {
    // Update existing
    const existingFile = existingFiles.next();
    existingFile.setContent(correctedText);
  } else {
    // Create new
    correctionsFolder.createFile(correctionFileName, correctedText, MimeType.PLAIN_TEXT);
  }
  
  msaLog_("Saved correction for: " + correctionFileName);
  return { success: true };
}

/**
 * Run Student Response Grader for all students
 * @param {string} examFolderId The folder ID of the exam
 * @returns {object} Grading results summary
 */
function runStudentGrading(examFolderId) {
  const config = _getExamSystemConfig();
  const examFolder = DriveApp.getFolderById(examFolderId);
  
  // Find markscheme
  const markschemeDoc = _findMarkschemeInFolder(examFolder, config);
  if (!markschemeDoc) {
    throw new Error("No markscheme document found");
  }
  
  // Load pre-processed markscheme points
  const msaConfig = msaGetConfig_();
  const questionFolder = msaFindQuestionFolderByDocId_(msaConfig, markschemeDoc.getId());
  if (!questionFolder) {
    throw new Error("Markscheme not atomized yet. Please run Markscheme Atomization first.");
  }
  
  const markscheme = msaReadJsonFileIfExists_(questionFolder, "markscheme_points_best.json");
  if (!markscheme || !markscheme.points) {
    throw new Error("Markscheme points not found. Please run atomization first.");
  }
  
  // Find student work
  const studentWorkFolder = _findSubfolderByName(examFolder, config.STUDENT_WORK_FOLDER_NAME);
  if (!studentWorkFolder) {
    throw new Error("Student Work folder not found");
  }
  
  const individualPdfsFolder = _findSubfolderByName(studentWorkFolder, config.INDIVIDUAL_PDFS_FOLDER_NAME);
  if (!individualPdfsFolder) {
    throw new Error("Individual PDFs folder not found");
  }
  
  // Grade each student
  const gradingResults = [];
  const files = individualPdfsFolder.getFiles();
  
  while (files.hasNext()) {
    const file = files.next();
    const studentName = _extractStudentNameFromFilename(file.getName());
    
    msaLog_("Grading: " + studentName);
    
    try {
      // This would integrate with your existing gradeStudentResponse function
      const result = gradeStudentResponse(file.getId(), markschemeDoc.getId(), markscheme.points);
      gradingResults.push({
        studentName: studentName,
        score: result.awardedScore,
        maxScore: result.possibleScore
      });
    } catch (e) {
      msaWarn_("Failed to grade " + studentName + ": " + e.message);
    }
  }
  
  // Calculate statistics
  const totalStudents = gradingResults.length;
  const averageScore = gradingResults.reduce((sum, r) => sum + (r.score / r.maxScore * 100), 0) / totalStudents;
  
  return {
    success: true,
    studentCount: totalStudents,
    averageScore: averageScore,
    results: gradingResults
  };
}

// ========== Helper Functions ==========

function _findMarkschemeInFolder(folder, config) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (config.MARKSCHEME_FILENAME_PATTERN.test(file.getName())) {
      return file;
    }
  }
  return null;
}

function _findSubfolderByName(parentFolder, name) {
  const folders = parentFolder.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    if (folder.getName() === name) {
      return folder;
    }
  }
  return null;
}

function _extractStudentNameFromFilename(filename) {
  // Extract student name from filename (customize based on your naming convention)
  // Example: "Smith_John_Q1.pdf" -> "Smith, John"
  const baseName = filename.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  
  if (parts.length >= 2) {
    return parts[0] + ', ' + parts[1];
  }
  
  return baseName;
}

function _extractAndOcrPages(file) {
  const cfg = msaGetConfig_();
  const pages = [];
  
  // If it's a PDF, convert to images first
  if (file.getMimeType() === 'application/pdf') {
    // Use Drive API or convert to images
    // For now, simplified: treat as single image
    const imageBlob = file.getBlob();
    const ocrResult = msaMathpixOCR_(imageBlob, {});
    
    pages.push({
      pageNum: 1,
      ocrText: ocrResult.text || '',
      imageUrl: 'https://drive.google.com/uc?id=' + file.getId(),
      confidence: ocrResult.confidence || 0.5
    });
  } else {
    // It's an image file
    const ocrResult = msaMathpixOcrFromDriveImage_(file.getId(), cfg, {});
    
    pages.push({
      pageNum: 1,
      ocrText: ocrResult.text || '',
      imageUrl: 'https://drive.google.com/uc?id=' + file.getId(),
      confidence: ocrResult.confidence || 0.5
    });
  }
  
  return pages;
}
