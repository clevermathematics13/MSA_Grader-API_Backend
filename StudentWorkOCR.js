/********************************
 * StudentWorkOCR.js
 * 
 * Improved pipeline for OCR of student work with human verification
 ********************************/

/**
 * Process a batch of student PDFs with OCR and verification workflow
 * @param {Folder} studentPdfsFolder Folder containing individual student PDFs
 * @param {Folder} outputFolder Folder to save OCR results
 * @param {object} options Processing options
 * @returns {object} Processing results
 */
function processStudentWorkBatch(studentPdfsFolder, outputFolder, options = {}) {
  const defaults = {
    confidenceThreshold: 0.85,  // Below this, flag for human review
    saveIntermediateImages: true,
    createVerificationReport: true,
    maxPagesPerPdf: 20
  };
  
  const opts = Object.assign({}, defaults, options);
  const results = {
    processed: [],
    needsReview: [],
    errors: [],
    stats: {
      totalFiles: 0,
      totalPages: 0,
      highConfidence: 0,
      lowConfidence: 0,
      failed: 0
    }
  };
  
  // Get all PDFs and images
  const files = studentPdfsFolder.getFiles();
  
  while (files.hasNext()) {
    const file = files.next();
    const mimeType = file.getMimeType();
    
    // Only process PDFs and images
    if (mimeType !== 'application/pdf' && !mimeType.startsWith('image/')) {
      continue;
    }
    
    results.stats.totalFiles++;
    
    try {
      msaLog_(`Processing: ${file.getName()}`);
      
      // Process the file
      const fileResult = processStudentWorkFile(file, outputFolder, opts);
      
      // Categorize based on confidence
      fileResult.pages.forEach(page => {
        results.stats.totalPages++;
        
        if (page.confidence >= opts.confidenceThreshold) {
          results.stats.highConfidence++;
          results.processed.push(page);
        } else {
          results.stats.lowConfidence++;
          results.needsReview.push(page);
        }
      });
      
    } catch (error) {
      msaWarn_(`Failed to process ${file.getName()}: ${error.message}`);
      results.errors.push({
        fileName: file.getName(),
        fileId: file.getId(),
        error: error.message
      });
      results.stats.failed++;
    }
  }
  
  // Create verification report if requested
  if (opts.createVerificationReport) {
    createVerificationReport(outputFolder, results);
  }
  
  return results;
}

/**
 * Process a single student work file (PDF or image)
 * @param {File} file The student work file
 * @param {Folder} outputFolder Folder to save results
 * @param {object} opts Processing options
 * @returns {object} File processing result
 */
function processStudentWorkFile(file, outputFolder, opts) {
  const studentName = extractStudentInfo(file.getName()).name;
  const fileId = file.getId();
  const pages = [];
  
  // Create student-specific subfolder
  const studentFolder = getOrCreateStudentFolder(outputFolder, studentName);
  
  if (file.getMimeType() === 'application/pdf') {
    // Convert PDF to images and OCR each page
    const pdfPages = convertPdfToImages(file, studentFolder, opts);
    
    pdfPages.forEach((imagePage, index) => {
      const pageNum = index + 1;
      const ocrResult = performOcrOnImage(imagePage.blob, imagePage.fileId);
      
      pages.push({
        studentName: studentName,
        sourceFileId: fileId,
        sourceFileName: file.getName(),
        pageNum: pageNum,
        imageFileId: imagePage.fileId,
        imageUrl: `https://drive.google.com/uc?id=${imagePage.fileId}`,
        ocrText: ocrResult.text,
        confidence: ocrResult.confidence,
        mathDetected: ocrResult.mathDetected,
        metadata: {
          width: ocrResult.width,
          height: ocrResult.height,
          processingTime: ocrResult.processingTime
        }
      });
      
      // Save OCR text to file
      const textFileName = `${studentName}_page${pageNum}_ocr.txt`;
      saveTextToFolder(studentFolder, textFileName, ocrResult.text);
    });
    
  } else {
    // Single image file
    const ocrResult = performOcrOnImage(file.getBlob(), fileId);
    
    pages.push({
      studentName: studentName,
      sourceFileId: fileId,
      sourceFileName: file.getName(),
      pageNum: 1,
      imageFileId: fileId,
      imageUrl: `https://drive.google.com/uc?id=${fileId}`,
      ocrText: ocrResult.text,
      confidence: ocrResult.confidence,
      mathDetected: ocrResult.mathDetected,
      metadata: {
        width: ocrResult.width,
        height: ocrResult.height,
        processingTime: ocrResult.processingTime
      }
    });
    
    const textFileName = `${studentName}_ocr.txt`;
    saveTextToFolder(studentFolder, textFileName, ocrResult.text);
  }
  
  // Save JSON summary
  const summaryFileName = `${studentName}_ocr_summary.json`;
  const summary = {
    studentName: studentName,
    sourceFile: file.getName(),
    sourceFileId: fileId,
    processedDate: new Date().toISOString(),
    totalPages: pages.length,
    averageConfidence: pages.reduce((sum, p) => sum + p.confidence, 0) / pages.length,
    pages: pages
  };
  saveJsonToFolder(studentFolder, summaryFileName, summary);
  
  return {
    studentName: studentName,
    sourceFileId: fileId,
    pages: pages
  };
}

/**
 * Convert PDF to individual page images
 * @param {File} pdfFile The PDF file
 * @param {Folder} outputFolder Folder to save images
 * @param {object} opts Options
 * @returns {Array} Array of {blob, fileId} objects
 */
function convertPdfToImages(pdfFile, outputFolder, opts) {
  // This is a simplified version - in production you'd use:
  // 1. Google Drive API's export feature
  // 2. Or a third-party PDF-to-image service
  // 3. Or split PDF using Drive's built-in viewer
  
  const pages = [];
  
  try {
    // Attempt to use Slides API to convert (one approach)
    // For now, we'll create a placeholder that saves the PDF as-is
    // and treats it as a single page
    
    const imageName = pdfFile.getName().replace('.pdf', '_page1.png');
    
    // In a real implementation, you would:
    // - Use DriveApp to export PDF pages as images
    // - Or use an external service like CloudConvert API
    // - Or use Google Slides to import PDF and export as images
    
    // Placeholder: just reference the PDF itself
    pages.push({
      blob: pdfFile.getBlob(),
      fileId: pdfFile.getId(),
      pageNum: 1
    });
    
    msaLog_(`PDF conversion: Treating ${pdfFile.getName()} as single image (expand this function for multi-page PDFs)`);
    
  } catch (error) {
    throw new Error(`PDF conversion failed: ${error.message}`);
  }
  
  return pages;
}

/**
 * Perform OCR on an image blob
 * @param {Blob} imageBlob The image to OCR
 * @param {string} imageFileId Optional file ID for caching
 * @returns {object} OCR result with text and confidence
 */
function performOcrOnImage(imageBlob, imageFileId) {
  const t0 = Date.now();
  const cfg = msaGetConfig_();
  
  try {
    // Use existing Mathpix OCR function
    const result = msaMathpixOCR_(imageBlob, {
      formats: ['text', 'latex_styled', 'data'],
      math_inline_delimiters: ['$', '$'],
      math_display_delimiters: ['$$', '$$']
    });
    
    // Calculate confidence score based on various factors
    const confidence = calculateOcrConfidence(result);
    
    // Detect if mathematical notation is present
    const mathDetected = detectMathContent(result.text);
    
    return {
      text: result.text || '',
      latexStyled: result.latex_styled || '',
      confidence: confidence,
      mathDetected: mathDetected,
      width: result.image_width || 0,
      height: result.image_height || 0,
      processingTime: Date.now() - t0,
      rawResult: result
    };
    
  } catch (error) {
    msaWarn_(`OCR failed for image: ${error.message}`);
    return {
      text: '',
      confidence: 0,
      mathDetected: false,
      error: error.message,
      processingTime: Date.now() - t0
    };
  }
}

/**
 * Calculate OCR confidence score
 * @param {object} ocrResult Raw OCR result from Mathpix
 * @returns {number} Confidence score 0-1
 */
function calculateOcrConfidence(ocrResult) {
  let confidence = 0.5; // Base confidence
  
  // Factor 1: Mathpix confidence if available
  if (ocrResult.confidence) {
    confidence = ocrResult.confidence;
  }
  
  // Factor 2: Text length (very short or very long text might be suspicious)
  const textLength = (ocrResult.text || '').length;
  if (textLength > 50 && textLength < 5000) {
    confidence += 0.1;
  } else if (textLength < 10) {
    confidence -= 0.2;
  }
  
  // Factor 3: Presence of common OCR errors
  const text = ocrResult.text || '';
  const errorPatterns = [
    /[|]{3,}/,  // Multiple consecutive pipes (common OCR error)
    /\s{5,}/,   // Excessive spaces
    /[^\x00-\x7F]{20,}/  // Long sequences of non-ASCII (might be encoding issues)
  ];
  
  errorPatterns.forEach(pattern => {
    if (pattern.test(text)) {
      confidence -= 0.15;
    }
  });
  
  // Factor 4: Math notation quality (if LaTeX available)
  if (ocrResult.latex_styled && ocrResult.latex_styled.length > 20) {
    confidence += 0.1;
  }
  
  // Clamp between 0 and 1
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Detect if text contains mathematical content
 * @param {string} text The OCR text
 * @returns {boolean} True if math detected
 */
function detectMathContent(text) {
  const mathIndicators = [
    /[\\][a-z]+/,  // LaTeX commands
    /\$.*?\$/,      // Inline math delimiters
    /\d+\s*[+\-*/÷×]\s*\d+/,  // Basic arithmetic
    /[=≠<>≤≥]/,     // Math symbols
    /\^\{.*?\}/,    // Superscripts
    /_{.*?}/        // Subscripts
  ];
  
  return mathIndicators.some(pattern => pattern.test(text));
}

/**
 * Extract student information from filename
 * @param {string} filename The file name
 * @returns {object} Student info {name, id, etc}
 */
function extractStudentInfo(filename) {
  // Customize based on your naming convention
  // Examples:
  // "LastName_FirstName_StudentID_Q1.pdf"
  // "Smith_John_12345_Q1.pdf"
  
  const baseName = filename.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  
  let name = baseName;
  let id = null;
  let question = null;
  
  if (parts.length >= 2) {
    name = `${parts[0]}, ${parts[1]}`;
    if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
      id = parts[2];
    }
    if (parts.length >= 4) {
      question = parts[3];
    }
  }
  
  return {
    name: name,
    id: id,
    question: question,
    originalFilename: filename
  };
}

/**
 * Get or create a student-specific subfolder
 * @param {Folder} parentFolder Parent output folder
 * @param {string} studentName Student name
 * @returns {Folder} Student folder
 */
function getOrCreateStudentFolder(parentFolder, studentName) {
  const safeName = studentName.replace(/[^a-zA-Z0-9_\-,\s]/g, '');
  const folders = parentFolder.getFoldersByName(safeName);
  
  if (folders.hasNext()) {
    return folders.next();
  } else {
    return parentFolder.createFolder(safeName);
  }
}

/**
 * Save text content to a folder
 * @param {Folder} folder Target folder
 * @param {string} filename File name
 * @param {string} content Text content
 */
function saveTextToFolder(folder, filename, content) {
  const existingFiles = folder.getFilesByName(filename);
  
  if (existingFiles.hasNext()) {
    existingFiles.next().setContent(content);
  } else {
    folder.createFile(filename, content, MimeType.PLAIN_TEXT);
  }
}

/**
 * Save JSON content to a folder
 * @param {Folder} folder Target folder
 * @param {string} filename File name
 * @param {object} data JSON data
 */
function saveJsonToFolder(folder, filename, data) {
  const jsonString = JSON.stringify(data, null, 2);
  saveTextToFolder(folder, filename, jsonString);
}

/**
 * Create a verification report for human review
 * @param {Folder} outputFolder Output folder
 * @param {object} results Processing results
 */
function createVerificationReport(outputFolder, results) {
  const report = [];
  
  report.push('=== STUDENT WORK OCR VERIFICATION REPORT ===');
  report.push(`Generated: ${new Date().toISOString()}`);
  report.push('');
  report.push('=== STATISTICS ===');
  report.push(`Total Files Processed: ${results.stats.totalFiles}`);
  report.push(`Total Pages: ${results.stats.totalPages}`);
  report.push(`High Confidence: ${results.stats.highConfidence}`);
  report.push(`Needs Review: ${results.stats.lowConfidence}`);
  report.push(`Failed: ${results.stats.failed}`);
  report.push('');
  
  if (results.needsReview.length > 0) {
    report.push('=== PAGES NEEDING REVIEW ===');
    results.needsReview.forEach((page, index) => {
      report.push(`${index + 1}. ${page.studentName} - Page ${page.pageNum}`);
      report.push(`   Confidence: ${(page.confidence * 100).toFixed(1)}%`);
      report.push(`   Image: https://drive.google.com/file/d/${page.imageFileId}/view`);
      report.push(`   Preview: ${page.ocrText.substring(0, 100)}...`);
      report.push('');
    });
  }
  
  if (results.errors.length > 0) {
    report.push('=== ERRORS ===');
    results.errors.forEach((error, index) => {
      report.push(`${index + 1}. ${error.fileName}`);
      report.push(`   Error: ${error.error}`);
      report.push('');
    });
  }
  
  const reportText = report.join('\n');
  saveTextToFolder(outputFolder, 'OCR_Verification_Report.txt', reportText);
  
  msaLog_('Verification report created');
}
