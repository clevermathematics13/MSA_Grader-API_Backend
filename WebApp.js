/********************************
 * WebApp.gs
 *
 * Server-side logic for the MSA Validation & Repair UI.
 * 
 * NOTE: The main doGet() is now in ExamSystem_Integration.js
 * which serves the new Exam Management UI by default.
 ********************************/

function _findDocByTitle(title) {
  const cfg = msaGetConfig_();
  const sourceFolderId = cfg.MSA_PARENT_FOLDER_ID;
  if (!sourceFolderId) {
    throw new Error("The MSA_PARENT_FOLDER_ID is not set in your MSA_Config.js file.");
  }
  const folder = DriveApp.getFolderById(sourceFolderId);
  const files = folder.getFilesByName(title);
  if (!files.hasNext()) {
    throw new Error(`Document with title "${title}" not found in the parent folder.`);
  }
  const file = files.next();
  if (files.hasNext()) {
    msaWarn_(`Multiple documents found with title "${title}". Using the first one found.`);
  }
  return file;
}

/**
 * Called by the UI to process a single document.
 * This is the entry point for the initial OCR and parse.
 */
function processSingleDocByTitle(title) {
  const file = _findDocByTitle(title);
  return runMSA_VR_One_ForWebApp(file.getId());
}

/**
 * Called by the UI to re-process a document with corrected OCR text.
 */
function reprocessWithCorrection(docId, correctedOcrText, originalOcrPages) {
  // The user edited the combined text. We will replace the text of all pages with this single block,
  // treating it as a single, corrected page. This is simple and robust.
  const correctedPages = [{
    page: 1,
    text: correctedOcrText,
    // Preserve metadata from the original first page for consistency
    fileName: (originalOcrPages && originalOcrPages[0]) ? originalOcrPages[0].fileName : 'corrected_page_1.png',
    fileId: (originalOcrPages && originalOcrPages[0]) ? originalOcrPages[0].fileId : '',
    latex_styled: correctedOcrText, // Use corrected text as fallback
    confidence: 1.0, // Manually corrected, so confidence is 1.0
    request_id: "manual_correction",
    data: [] // Data field is complex, safe to clear it for corrected text
  }];
  return _runMsaPipeline(docId, correctedPages);
}

/**
 * Called by the UI to get the data needed for the comparison view.
 * @param {string} title The title (question code) of the document to compare.
 * @returns {object} An object containing the source doc URL and the preview HTML.
 */
function getPreviewDataByTitle(title) {
  const file = _findDocByTitle(title);
  const docId = file.getId();

  const cfg = msaGetConfig_();
  // Assumes msaFindQuestionFolderByDocId_ is available from MSA_Helpers_And_Pass1.js
  const folder = msaFindQuestionFolderByDocId_(cfg, docId);
  if (!folder) {
    // Instead of throwing, return a specific status object for the UI to handle.
    return { status: 'NOT_PROCESSED', docId: docId, title: title, message: "Output folder not found. Please process the document first." };
  }

  const sourceDocUrl = DriveApp.getFileById(docId).getUrl();

  const previewFileIterator = folder.getFilesByName("markscheme_preview.html");
  if (!previewFileIterator.hasNext()) {
    // This is also a state where processing is incomplete.
    return { status: 'NOT_PROCESSED', docId: docId, title: title, message: "'markscheme_preview.html' not found. Please re-process the document." };
  }
  const previewHtml = previewFileIterator.next().getBlob().getDataAsString();

  // Also fetch the new structured preview, if it exists.
  const structuredPreviewFileIterator = folder.getFilesByName("markscheme_structured_preview.html");
  let structuredPreviewHtml = null;
  if (structuredPreviewFileIterator.hasNext()) {
    structuredPreviewHtml = structuredPreviewFileIterator.next().getBlob().getDataAsString();
  }

  return { status: 'SUCCESS', sourceDocUrl: sourceDocUrl, previewHtml: previewHtml, structuredPreviewHtml: structuredPreviewHtml };
}

/**
 * Called by the UI to run a batch process on unreconciled documents.
 * To prevent timeouts, this will only process a limited number of documents at a time.
 * @param {number} [limit=5] The maximum number of documents to process in this batch.
 * @returns {string} A summary message of the batch operation.
 */
function runBatchOnUnreconciled(limit) {
  const BATCH_LIMIT = limit || 5;
  msaLog_(`Starting batch process with a limit of ${BATCH_LIMIT} documents.`);

  try {
    const cfg = msaGetConfig_();
    const sourceFolderId = cfg.MSA_PARENT_FOLDER_ID;
    if (!sourceFolderId) {
      throw new Error("The MSA_PARENT_FOLDER_ID is not set in your MSA_Config.js file.");
    }

    const folder = DriveApp.getFolderById(sourceFolderId);
    const files = folder.getFilesByType(MimeType.GOOGLE_DOCS);
    
    const unreconciledIds = [];
    while (files.hasNext()) {
      const file = files.next();
      const docId = file.getId();
      // The msaCheckIfReconciled_ function returns true if a "_RECONCILED.txt" file exists.
      if (!msaCheckIfReconciled_(cfg, docId)) {
        unreconciledIds.push(docId);
      }
    }

    const totalUnreconciled = unreconciledIds.length;
    if (totalUnreconciled === 0) {
      msaLog_("Batch complete: No unreconciled documents found.");
      return "Batch complete: No unreconciled documents found.";
    }

    const docsToProcess = unreconciledIds.slice(0, BATCH_LIMIT);
    let successCount = 0;
    let errorCount = 0;

    msaLog_(`Found ${totalUnreconciled} unreconciled documents. Processing the first ${docsToProcess.length}.`);

    docsToProcess.forEach(docId => {
      try {
        msaLog_(`Batch processing: ${docId}`);
        runMSA_VR_One_ForWebApp(docId);
        successCount++;
      } catch (e) {
        msaErr_(`Error processing ${docId} in batch: ${e.message}`);
        errorCount++;
      }
    });

    const remaining = totalUnreconciled - docsToProcess.length;
    const summary = `Batch finished. Processed: ${successCount}. Errors: ${errorCount}. Remaining unreconciled: ${remaining}.`;
    msaLog_(summary);
    return summary;

  } catch (e) {
    msaErr_(`Fatal error during batch process: ${e.stack}`);
    throw new Error(`Batch process failed. Details: ${e.message}`);
  }
}

/**
 * Test OCR on a single student work image (for MSA UI testing).
 * This provides a single-question test case for the full exam system workflow.
 * @param {string} fileId The Google Drive File ID of the student work image.
 * @param {object} options Optional settings like {detectMarkers: true}
 * @returns {object} OCR result with image URL, text, confidence, etc.
 */
function testStudentWorkOcr(fileId, options = {}) {
  try {
    const file = DriveApp.getFileById(fileId);
    const mimeType = file.getMimeType();
    
    // Verify it's an image
    if (!mimeType.startsWith('image/')) {
      throw new Error('File must be an image. PDF support coming soon.');
    }
    
    const t0 = Date.now();
    
    // Use the Mathpix OCR function on the ORIGINAL file (TIFF, PNG, JPG, etc.)
    const cfg = msaGetConfig_();
    
    let cropInfo = null;
    let markersDetected = false;
    let ocrResult;
    
    // Check if manual crop region was provided
    if (options.cropRegion) {
      cropInfo = options.cropRegion;
      markersDetected = true; // Manual region counts as "detected"
      msaLog_('Using manually specified crop region: (' + cropInfo.x1 + ',' + cropInfo.y1 + ') to (' + cropInfo.x2 + ',' + cropInfo.y2 + ')');
      
      // Run OCR directly on the specified region
      ocrResult = msaMathpixOcrFromDriveImage_(fileId, cfg, {
        include_line_data: true,
        region: {
          top_left_x: cropInfo.x1,
          top_left_y: cropInfo.y1,
          width: cropInfo.width,
          height: cropInfo.height
        }
      });
      
    } else {
      // Auto-detect markers approach
      // First pass: detect markers by running OCR with geometry data
      const detectionResult = msaMathpixOcrFromDriveImage_(fileId, cfg, { 
        include_line_data: true,
        include_geometry: true 
      });
      
      // Try to detect corner markers in the OCR result
      ocrResult = detectionResult;
      
      if (options.detectMarkers !== false) {
        const markers = findCornerMarkersInOcrResult(detectionResult);
        if (markers.length === 4) {
          cropInfo = calculateBoundingRectFromMarkers(markers);
          markersDetected = true;
          msaLog_('Markers detected at: TL(' + markers[0].x + ',' + markers[0].y + '), TR(' + markers[1].x + ',' + markers[1].y + '), BL(' + markers[2].x + ',' + markers[2].y + '), BR(' + markers[3].x + ',' + markers[3].y + ')');
          msaLog_('Re-running OCR on cropped region: (' + cropInfo.x1 + ',' + cropInfo.y1 + ') to (' + cropInfo.x2 + ',' + cropInfo.y2 + ')');
          
          // Re-run OCR with region parameter to only process the answer box area
          ocrResult = msaMathpixOcrFromDriveImage_(fileId, cfg, {
            include_line_data: true,
            region: {
              top_left_x: cropInfo.x1,
              top_left_y: cropInfo.y1,
              width: cropInfo.width,
              height: cropInfo.height
            }
          });
          
          msaLog_('OCR complete on cropped region');
        } else {
          msaLog_('Found ' + markers.length + ' markers (need 4), using full image OCR');
        }
      }
    }
    
    const processingTime = Date.now() - t0;
    
    // For preview, handle TIFF files specially since browsers don't support them
    let imageDataUrl;
    
    if (mimeType === 'image/tiff' || mimeType === 'image/tif') {
      // TIFF files: Use Drive's thumbnail capability for preview
      try {
        const thumbnail = Drive.Files.get(fileId, { fields: 'thumbnailLink' });
        if (thumbnail.thumbnailLink) {
          // Use thumbnail URL (requires authentication but works in this context)
          imageDataUrl = thumbnail.thumbnailLink.replace('=s220', '=s800'); // Larger thumbnail
        } else {
          // Fallback: indicate TIFF can't be previewed
          imageDataUrl = null;
        }
      } catch (e) {
        msaLog_('Could not get thumbnail for TIFF: ' + e.message);
        imageDataUrl = null;
      }
    } else {
      // For other image types (PNG, JPG, etc.), embed directly as base64
      const blob = file.getBlob();
      const base64Image = Utilities.base64Encode(blob.getBytes());
      imageDataUrl = `data:${mimeType};base64,${base64Image}`;
    }
    
    // Calculate confidence from OCR result
    let confidence = ocrResult.confidence || 0.9; // Default if not provided
    
    // Detect if math is present
    const mathDetected = (ocrResult.text || '').includes('\\') || (ocrResult.latex_styled || '').includes('\\');
    
    return {
      status: 'success',
      fileId: fileId,
      fileName: file.getName(),
      imageUrl: imageDataUrl,
      isTiff: (mimeType === 'image/tiff' || mimeType === 'image/tif'),
      ocrText: ocrResult.text || '',
      latexStyled: ocrResult.latex_styled || '',
      confidence: confidence,
      mathDetected: mathDetected,
      processingTime: processingTime,
      cropInfo: cropInfo,  // Include crop information if markers detected
      markersDetected: markersDetected,
      metadata: {
        width: ocrResult.image_width || null,
        height: ocrResult.image_height || null,
        lineCount: (ocrResult.line_data || []).length
      }
    };
  } catch (e) {
    msaErr_(`Error in testStudentWorkOcr: ${e.message}`);
    return {
      status: 'error',
      message: e.message
    };
  }
}

/**
 * Save corrected OCR text for a student work file.
 * @param {string} fileId The Google Drive File ID.
 * @param {string} correctedText The corrected OCR text.
 * @returns {object} Success status.
 */
function saveStudentOcrCorrection(fileId, correctedText) {
  try {
    const cfg = msaGetConfig_();
    const file = DriveApp.getFileById(fileId);
    
    // Save to a designated folder for OCR corrections
    const parentFolderId = cfg.MSA_PARENT_FOLDER_ID || DriveApp.getRootFolder().getId();
    const parentFolder = DriveApp.getFolderById(parentFolderId);
    
    // Create or get OCR corrections folder
    let correctionsFolderIterator = parentFolder.getFoldersByName('_OCR_Corrections');
    let correctionsFolder;
    if (correctionsFolderIterator.hasNext()) {
      correctionsFolder = correctionsFolderIterator.next();
    } else {
      correctionsFolder = parentFolder.createFolder('_OCR_Corrections');
    }
    
    // Save the corrected text
    const correctionFileName = `${file.getName()}_corrected.txt`;
    const existingFiles = correctionsFolder.getFilesByName(correctionFileName);
    
    if (existingFiles.hasNext()) {
      // Update existing file
      const existingFile = existingFiles.next();
      existingFile.setContent(correctedText);
    } else {
      // Create new file
      correctionsFolder.createFile(correctionFileName, correctedText);
    }
    
    msaLog_(`Saved OCR correction for ${file.getName()}`);
    return { status: 'success' };
  } catch (e) {
    msaErr_(`Error saving OCR correction: ${e.message}`);
    throw new Error(`Failed to save correction: ${e.message}`);
  }
}

/**
 * Find corner markers in OCR detection result
 * @param {object} ocrResult The OCR detection result
 * @returns {Array} Array of marker positions {x, y, corner}
 */
function findCornerMarkersInOcrResult(ocrResult) {
  var markers = [];
  
  // Look for QR code text: TL, TR, BL, BR
  if (ocrResult.line_data && Array.isArray(ocrResult.line_data)) {
    msaLog_('Scanning ' + ocrResult.line_data.length + ' lines for QR code markers...');
    
    ocrResult.line_data.forEach(function(line, idx) {
      var bbox = line.bbox || line.bounding_box;
      if (!bbox || bbox.length < 4) return;
      
      var width = bbox[2] - bbox[0];
      var height = bbox[3] - bbox[1];
      var text = (line.text || '').trim().toUpperCase();
      
      // Look for QR code markers: exact match for TL, TR, BL, BR
      var markerLabels = ['TL', 'TR', 'BL', 'BR'];
      var foundLabel = null;
      
      for (var i = 0; i < markerLabels.length; i++) {
        if (text === markerLabels[i]) {
          foundLabel = markerLabels[i];
          break;
        }
      }
      
      // Also check if it's a small square image region (QR code without OCR text)
      var isSmallSquare = width < 50 && height < 50 && Math.abs(width - height) < 20;
      var isImageType = line.type === 'image' || line.cnt_type === 'image';
      
      if (foundLabel || (isImageType && isSmallSquare)) {
        var centerX = (bbox[0] + bbox[2]) / 2;
        var centerY = (bbox[1] + bbox[3]) / 2;
        
        markers.push({
          x: centerX,
          y: centerY,
          bbox: bbox,
          width: width,
          height: height,
          text: foundLabel || '',
          detectedAs: foundLabel ? 'qr-text' : 'small-image'
        });
        
        msaLog_('Found marker: ' + (foundLabel || 'unknown') + ' at (' + centerX.toFixed(0) + ',' + centerY.toFixed(0) + '), detected as: ' + (foundLabel ? 'qr-text' : 'small-image'));
      }
    });
  }
  
  msaLog_('Found ' + markers.length + ' potential markers');
  
  // If we found exactly 4 markers with labels, use them directly
  if (markers.length === 4) {
    // Try to match markers to corners by their labels
    var labeledMarkers = {};
    markers.forEach(function(m) {
      if (m.text) labeledMarkers[m.text] = m;
    });
    
    // If all 4 have correct labels, assign corners based on labels
    if (labeledMarkers.TL && labeledMarkers.TR && labeledMarkers.BL && labeledMarkers.BR) {
      labeledMarkers.TL.corner = 'top-left';
      labeledMarkers.TR.corner = 'top-right';
      labeledMarkers.BL.corner = 'bottom-left';
      labeledMarkers.BR.corner = 'bottom-right';
      
      markers = [labeledMarkers.TL, labeledMarkers.TR, labeledMarkers.BL, labeledMarkers.BR];
      
      msaLog_('QR markers identified by labels: TL(' + labeledMarkers.TL.x.toFixed(0) + ',' + labeledMarkers.TL.y.toFixed(0) + 
             '), TR(' + labeledMarkers.TR.x.toFixed(0) + ',' + labeledMarkers.TR.y.toFixed(0) + 
             '), BL(' + labeledMarkers.BL.x.toFixed(0) + ',' + labeledMarkers.BL.y.toFixed(0) + 
             '), BR(' + labeledMarkers.BR.x.toFixed(0) + ',' + labeledMarkers.BR.y.toFixed(0) + ')');
    } else {
      // Fall back to position-based detection
      markers.sort(function(a, b) {
        if (Math.abs(a.y - b.y) < 50) return a.x - b.x;
        return a.y - b.y;
      });
      
      var topTwo = markers.slice(0, 2).sort(function(a, b) { return a.x - b.x; });
      var bottomTwo = markers.slice(2, 4).sort(function(a, b) { return a.x - b.x; });
      
      topTwo[0].corner = 'top-left';
      topTwo[1].corner = 'top-right';
      bottomTwo[0].corner = 'bottom-left';
      bottomTwo[1].corner = 'bottom-right';
      
      msaLog_('Markers classified by position');
    }
  }
  
  return markers;
}

/**
 * Calculate bounding rectangle from corner markers
 * @param {Array} markers Array of 4 marker objects
 * @returns {object} Bounds {x1, y1, x2, y2, width, height}
 */
function calculateBoundingRectFromMarkers(markers) {
  var xs = markers.map(function(m) { return m.x; });
  var ys = markers.map(function(m) { return m.y; });
  
  var minX = Math.min.apply(Math, xs);
  var minY = Math.min.apply(Math, ys);
  var maxX = Math.max.apply(Math, xs);
  var maxY = Math.max.apply(Math, ys);
  
  // QR codes are OUTSIDE the corners, so we need to move inward
  // Original positioning: marker is fSize + gap pixels away from corner
  // fSize = 6pt, gap = 2pt, so total offset = 8pt
  var offset = 8;
  
  var x1 = Math.round(minX + offset);
  var y1 = Math.round(minY + offset);
  var x2 = Math.round(maxX - offset);
  var y2 = Math.round(maxY - offset);
  
  return {
    x1: Math.max(0, x1),
    y1: Math.max(0, y1),
    x2: x2,
    y2: y2,
    width: x2 - x1,
    height: y2 - y1
  };
}
