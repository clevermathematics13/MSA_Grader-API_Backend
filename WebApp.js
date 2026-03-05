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
  // Activate log streaming if client passed a session ID
  if (options.logSessionId) {
    setLogSession_(options.logSessionId);
  }
  try {
    msaLog_('═══════════════════════════════════════════');
    msaLog_('▶ STUDENT WORK OCR PIPELINE — starting');
    msaLog_('  Pipeline: Image → Mathpix OCR → QR Decode → Crop → Clean → Corrections → Package');
    msaLog_('  fileId: ' + fileId);
    msaLog_('═══════════════════════════════════════════');

    const file = DriveApp.getFileById(fileId);
    const mimeType = file.getMimeType();
    const fileName = file.getName();
    msaLog_('📂 [1/7 FETCH] File: "' + fileName + '" (' + mimeType + ', ' + Math.round(file.getSize() / 1024) + 'KB)');
    
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
    let detectedQuestionCode = options.questionCode || null;
    let detectedStudentId = options.studentId || null;
    let detectedExamName = options.examName || null;
    let detectedPosition = options.position || null;
    
    msaLog_('───────────────────────────────────────────');
    msaLog_('🔬 [2/7 OCR] Calling Mathpix OCR on original image (include_line_data + geometry)');
    msaLog_('  Mathpix returns: LaTeX text, line coordinates, confidence, image dimensions');
    msaLog_('  Results are cached in CacheService (6h TTL) — cache HIT skips the ~9s API call');

    // Always run full OCR first to get all content and marker positions
    const fullOcrResult = msaMathpixOcrFromDriveImage_(fileId, cfg, { 
      include_line_data: true,
      include_geometry: true 
    });
    
    ocrResult = fullOcrResult;
    const imageWidth = fullOcrResult.image_width || 1000;
    const imageHeight = fullOcrResult.image_height || 1000;
    msaLog_('  → Image: ' + imageWidth + '×' + imageHeight + 'px, ' + (fullOcrResult.line_data || []).length + ' text lines detected');
    
    // AUTO-DETECT: If no question code provided, try to read it from the QR code
    if (!detectedQuestionCode) {
      msaLog_('───────────────────────────────────────────');
      msaLog_('📱 [3/7 QR] No question code provided — scanning image for QR code');
      msaLog_('  QR encodes: {s: studentId, q: questionCode, e: examName}');
      msaLog_('  Results cached in CacheService (6h TTL) — cache HIT skips ~5s decode');
      var qrData = decodeQrFromImage(fileId);
      if (qrData) {
        // Accept both questionCode and q
        if (qrData.questionCode) {
          detectedQuestionCode = qrData.questionCode;
          msaLog_('Detected question code from QR (questionCode): ' + detectedQuestionCode);
        } else if (qrData.q) {
          detectedQuestionCode = qrData.q;
          msaLog_('Detected question code from QR (q): ' + detectedQuestionCode);
        }
        // Capture student ID and exam name from QR
        detectedStudentId = qrData.studentId || qrData.s || detectedStudentId;
        detectedExamName = qrData.examName || qrData.e || detectedExamName;
        if (detectedStudentId) msaLog_('Detected student ID from QR: ' + detectedStudentId);
        if (detectedExamName) msaLog_('Detected exam name from QR: ' + detectedExamName);
      }
    }
    
    // AUTO-DETECT: Determine if Q1 or Q2+ from "Section A" header
    if (!detectedPosition) {
      var isQ1 = detectIfQ1FromOcr(fullOcrResult);
      detectedPosition = isQ1 ? "Q1" : "Q2+";
      msaLog_('Auto-detected position: ' + detectedPosition);
    }
    
    msaLog_('───────────────────────────────────────────');
    msaLog_('✂️ [4/7 CROP] Isolating answer region from full page');
    msaLog_('  Strategy cascade: Stored coords → Corner markers → Manual crop → Full page');

    // OPTION 1: Try to look up stored box coordinates by question code
    if (detectedQuestionCode) {
      const storedCoords = lookupBoxCoordinates(detectedQuestionCode, detectedPosition);
      if (storedCoords) {
        // Convert percentages to pixels based on actual image size
        cropInfo = {
          x1: Math.round(imageWidth * storedCoords.xPct / 100),
          y1: Math.round(imageHeight * storedCoords.yPct / 100),
          x2: Math.round(imageWidth * (storedCoords.xPct + storedCoords.widthPct) / 100),
          y2: Math.round(imageHeight * (storedCoords.yPct + storedCoords.heightPct) / 100)
        };
        cropInfo.width = cropInfo.x2 - cropInfo.x1;
        cropInfo.height = cropInfo.y2 - cropInfo.y1;
        markersDetected = true;
        msaLog_('Using stored box coordinates for ' + detectedQuestionCode + ' (' + detectedPosition + '): (' + cropInfo.x1 + ',' + cropInfo.y1 + ') to (' + cropInfo.x2 + ',' + cropInfo.y2 + ')');
        ocrResult = filterOcrResultsByRegion(fullOcrResult, cropInfo);
      }
    }
    
    // OPTION 2: Try to detect corner markers in OCR
    if (!markersDetected && options.detectMarkers !== false) {
      const markers = findCornerMarkersInOcrResult(fullOcrResult);
      
      if (markers.length === 4) {
        cropInfo = calculateBoundingRectFromMarkers(markers);
        markersDetected = true;
        msaLog_('Markers detected! Crop region: (' + cropInfo.x1 + ',' + cropInfo.y1 + ') to (' + cropInfo.x2 + ',' + cropInfo.y2 + ')');
        ocrResult = filterOcrResultsByRegion(fullOcrResult, cropInfo);
        msaLog_('Filtered to ' + (ocrResult.line_data || []).length + ' lines inside answer box');
      } else {
        msaLog_('Found ' + markers.length + ' markers (need 4)');
      }
    }
    
    // OPTION 3: Check if manual crop region was provided
    if (!markersDetected && options.cropRegion) {
      cropInfo = options.cropRegion;
      markersDetected = true;
      msaLog_('Using manual crop region: (' + cropInfo.x1 + ',' + cropInfo.y1 + ') to (' + cropInfo.x2 + ',' + cropInfo.y2 + ')');
      ocrResult = filterOcrResultsByRegion(fullOcrResult, cropInfo);
    }
    
    // OPTION 4: No crop available - return all OCR content
    if (!markersDetected) {
      msaLog_('No crop info available, returning full OCR (no filtering)');
      // Don't filter at all - just use the full OCR result
      ocrResult = fullOcrResult;
      markersDetected = false; // Indicate no markers/coords found
      msaLog_('Using full image - no crop applied');
    }
    
    msaLog_('───────────────────────────────────────────');
    msaLog_('🧹 [5/7 CLEAN] Post-processing OCR text');
    msaLog_('  Step A: Crossed-off detection (CJK \\text{} blocks from scribbles)');
    msaLog_('  Step B: Global learned corrections (OCR_Learn.js → corrections spreadsheet)');
    msaLog_('  Step C: Per-student corrections (StudentOCR_Profile.js → student patterns)');

    // ── Crossed-off detection ──
    var crossedOffResult = flagCrossedOffLines_(ocrResult);

    // ── Apply learned corrections (patterns seen ≥ N times) ──
    var learnedResult = { text: crossedOffResult.cleanedText, applied: [], stats: { rulesLoaded: 0, rulesApplied: 0, totalReplacements: 0 } };
    try {
      learnedResult = applyLearnedCorrections_(
        crossedOffResult.cleanedText,
        { minFrequency: (typeof MSA_OCR_LEARN_MIN_FREQUENCY !== 'undefined') ? MSA_OCR_LEARN_MIN_FREQUENCY : 2 }
      );
      // Log what the rules actually did
      if (learnedResult.applied && learnedResult.applied.length > 0) {
        learnedResult.applied.forEach(function(a) {
          msaLog_('  📘 "' + a.pattern.substring(0, 40) + '" → "' + (a.replacement || '').substring(0, 40) + '" (×' + a.count + ')');
        });
      }
    } catch (learnErr) {
      msaLog_('Learned corrections pass skipped: ' + learnErr.message);
    }

    // ── Per-student corrections (writer-adaptive) ──
    // Runs AFTER global corrections so student-specific fixes
    // can override or supplement class-wide patterns.
    var studentProfileResult = { text: learnedResult.text, applied: [], stats: { rulesLoaded: 0, rulesApplied: 0, totalReplacements: 0, studentId: null } };
    var studentProfileSummary = null;
    if (detectedStudentId) {
      try {
        studentProfileResult = applyStudentCorrections_(
          detectedStudentId,
          learnedResult.text,
          { minFrequency: (typeof MSA_STUDENT_OCR_MIN_FREQUENCY !== 'undefined') ? MSA_STUDENT_OCR_MIN_FREQUENCY : 1 }
        );
        studentProfileSummary = getStudentProfileSummary_(detectedStudentId);
      } catch (profileErr) {
        msaLog_('Student profile corrections skipped: ' + profileErr.message);
      }
    }

    msaLog_('───────────────────────────────────────────');
    msaLog_('📊 [5/7 CLEAN] Corrections summary:');
    msaLog_('  Crossed-off: ' + (crossedOffResult.stats ? crossedOffResult.stats.cjkTextBlocks || 0 : 0) + ' CJK block(s) stripped');
    msaLog_('  Global rules: ' + learnedResult.stats.rulesLoaded + ' loaded, ' + learnedResult.stats.rulesApplied + ' applied (' + learnedResult.stats.totalReplacements + ' replacements)');
    msaLog_('  Student rules: ' + studentProfileResult.stats.rulesLoaded + ' loaded, ' + studentProfileResult.stats.rulesApplied + ' applied (' + studentProfileResult.stats.totalReplacements + ' replacements)');
    msaLog_('📍 Elapsed: ' + (Date.now() - t0) + 'ms');

    const processingTime = Date.now() - t0;
    
    msaLog_('───────────────────────────────────────────');
    msaLog_('📸 [6/7 IMAGE] Preparing image preview for browser');
    msaLog_('  Large images (>500KB): fetch Drive thumbnail at s800, encode as base64');
    msaLog_('  Small images: encode original as base64 data URL');

    // For preview, handle TIFF files specially since browsers don\'t support them
    let imageDataUrl;
    
    if (mimeType === 'image/tiff' || mimeType === 'image/tif') {
      // TIFF files: Browsers can't display TIFF natively. Fetch a Drive
      // thumbnail as base64 so the client gets a viewable PNG preview.
      msaLog_('📸 [Image] TIFF detected — fetching Drive thumbnail as base64 for browser preview…');
      try {
        var token = ScriptApp.getOAuthToken();
        var thumbUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink';
        var thumbResp = UrlFetchApp.fetch(thumbUrl, {
          headers: { Authorization: 'Bearer ' + token }
        });
        var thumbData = JSON.parse(thumbResp.getContentText());
        if (thumbData.thumbnailLink) {
          var fetchUrl = thumbData.thumbnailLink.replace('=s220', '=s800');
          var blobResp = UrlFetchApp.fetch(fetchUrl, {
            headers: { Authorization: 'Bearer ' + token },
            muteHttpExceptions: true
          });
          if (blobResp.getResponseCode() === 200) {
            var tBytes = blobResp.getContent();
            var tMime = blobResp.getHeaders()['Content-Type'] || 'image/png';
            imageDataUrl = 'data:' + tMime + ';base64,' + Utilities.base64Encode(tBytes);
            msaLog_('📸 [Image] TIFF thumbnail OK (' + Math.round(tBytes.length / 1024) + 'KB)');
          } else {
            imageDataUrl = null;
          }
        } else {
          imageDataUrl = null;
        }
      } catch (e) {
        msaLog_('📸 [Image] TIFF thumbnail failed: ' + e.message);
        imageDataUrl = null;
      }
    } else {
      // For other image types (PNG, JPG, etc.):
      // If the file is large (>500KB), use a Drive thumbnail URL instead of base64
      // to keep the return payload under google.script.run's size limit (~1-2MB).
      // Use file.getSize() to avoid the expensive blob read just for a size check.
      var fileSizeKB = Math.round(file.getSize() / 1024);

      if (fileSizeKB > 500) {
        msaLog_('📸 [Image] Original too large for base64 (' + fileSizeKB + 'KB). Fetching server-side thumbnail at s800 for browser preview…');
        try {
          var token = ScriptApp.getOAuthToken();
          var metaUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink';
          var metaResp = UrlFetchApp.fetch(metaUrl, {
            headers: { Authorization: 'Bearer ' + token }
          });
          var metaData = JSON.parse(metaResp.getContentText());
          if (metaData.thumbnailLink) {
            // Fetch the actual thumbnail bytes so we can return base64.
            // The raw thumbnailLink URL requires Google auth cookies that
            // the browser doesn't have in the Apps Script web app context.
            var thumbFetchUrl = metaData.thumbnailLink.replace('=s220', '=s800');
            var thumbBlobResp = UrlFetchApp.fetch(thumbFetchUrl, {
              headers: { Authorization: 'Bearer ' + token },
              muteHttpExceptions: true
            });
            if (thumbBlobResp.getResponseCode() === 200) {
              var thumbBytes = thumbBlobResp.getContent();
              var thumbB64 = Utilities.base64Encode(thumbBytes);
              var thumbMime = thumbBlobResp.getHeaders()['Content-Type'] || 'image/png';
              imageDataUrl = 'data:' + thumbMime + ';base64,' + thumbB64;
              msaLog_('📸 [Image] Thumbnail fetched OK (' + Math.round(thumbBytes.length / 1024) + 'KB → ' + Math.round(thumbB64.length / 1024) + 'KB base64)');
            } else {
              msaLog_('📸 [Image] Thumbnail fetch returned HTTP ' + thumbBlobResp.getResponseCode());
              imageDataUrl = null;
            }
          } else {
            msaLog_('📸 [Image] No thumbnailLink in Drive metadata');
            imageDataUrl = null;
          }
        } catch (thumbErr) {
          msaLog_('📸 [Image] Thumbnail fallback failed: ' + thumbErr.message);
          imageDataUrl = null;
        }
      } else {
        const base64Image = Utilities.base64Encode(file.getBlob().getBytes());
        imageDataUrl = `data:${mimeType};base64,${base64Image}`;
      }
    }
    
    msaLog_('� [6/7 IMAGE] Preview ready: ' + (imageDataUrl ? (imageDataUrl.startsWith('data:') ? Math.round(imageDataUrl.length / 1024) + 'KB base64' : 'URL') : 'unavailable') + ', elapsed ' + (Date.now() - t0) + 'ms');

    msaLog_('───────────────────────────────────────────');
    msaLog_('📦 [7/7 PACKAGE] Building return payload');

    // Calculate confidence from OCR result
    // Mathpix confidence is often very low for handwritten content (like 0.02)
    // because it's trained primarily on printed math
    // We'll use a composite confidence based on multiple factors
    let rawConfidence = ocrResult.confidence || 0;
    let confidence = calculateCompositeConfidence_(ocrResult, rawConfidence);
    msaLog_('  Mathpix raw confidence: ' + (rawConfidence * 100).toFixed(1) + '% → Composite: ' + (confidence * 100).toFixed(1) + '%');
    msaLog_('  OCR text: ' + (ocrResult.text || '').length + ' chars, ' + ((ocrResult.text || '').includes('\\') ? 'math detected' : 'no math'));
    
    // Check for Mathpix errors
    if (ocrResult.error) {
      msaErr_('Mathpix API Error: ' + ocrResult.error);
      msaErr_('Error Info: ' + JSON.stringify(ocrResult.error_info || {}));
      // Return error to UI
      return {
        status: 'error',
        message: 'Mathpix OCR failed: ' + ocrResult.error + ' - ' + JSON.stringify(ocrResult.error_info || {})
      };
    }
    
    // Detect if math is present
    const mathDetected = (ocrResult.text || '').includes('\\') || (ocrResult.latex_styled || '').includes('\\');

    var returnPayload = {
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
      detectedQuestionCode: detectedQuestionCode,  // Question code from QR or input
      detectedStudentId: detectedStudentId,          // Student ID from QR
      detectedExamName: detectedExamName,            // Exam name from QR
      detectedPosition: detectedPosition,  // Q1 or Q2+ 
      crossedOff: {
        flaggedLines: crossedOffResult.flaggedLines,
        stats: crossedOffResult.stats,
        lineAnnotations: crossedOffResult.lineAnnotations
      },
      cleanedOcrText: studentProfileResult.text,
      learnedCorrections: {
        applied: learnedResult.applied,
        stats: learnedResult.stats
      },
      studentProfile: {
        applied: studentProfileResult.applied,
        stats: studentProfileResult.stats,
        summary: studentProfileSummary
      },
      metadata: {
        width: ocrResult.image_width || null,
        height: ocrResult.image_height || null,
        lineCount: (ocrResult.line_data || []).length
      }
    };

    // ── Return as JSON STRING, not object ──
    // google.script.run silently returns null when it can't serialize
    // complex nested objects. Returning a string and JSON.parse on the
    // client side is the reliable workaround.
    var payloadJson = JSON.stringify(returnPayload);
    msaLog_('═══════════════════════════════════════════');
    msaLog_('✅ PIPELINE COMPLETE in ' + (Date.now() - t0) + 'ms');
    msaLog_('  Payload: ' + Math.round(payloadJson.length / 1024) + 'KB JSON string');
    msaLog_('  Question: ' + (detectedQuestionCode || '(unknown)') + ' | Student: ' + (detectedStudentId || '(unknown)') + ' | Position: ' + (detectedPosition || '(unknown)'));
    msaLog_('  Image: ' + (imageDataUrl ? (imageDataUrl.length > 200 ? Math.round(imageDataUrl.length / 1024) + 'KB base64' : 'URL') : 'none') + ' | Cropped: ' + (markersDetected ? 'yes' : 'no'));
    msaLog_('═══════════════════════════════════════════');

    return payloadJson;
  } catch (e) {
    msaErr_(`Error in testStudentWorkOcr: ${e.message}`);
    return JSON.stringify({
      status: 'error',
      message: e.message
    });
  }
}

/**
 * Detect and flag lines that are likely crossed-off student work.
 * Looks for CJK characters (Chinese/Japanese/Korean), symbol gibberish,
 * and very low-confidence lines that OCR produces when reading scribbles/cross-outs.
 *
 * @param {object} ocrResult The OCR result with line_data array from Mathpix
 * @returns {object} { cleanedText, flaggedLines[], stats, lineAnnotations[] }
 */
function flagCrossedOffLines_(ocrResult) {
  // CONSERVATIVE approach: Only strip CJK characters that are clearly isolated
  // garbage inside \text{} wrappers (e.g. \text { 演 } from misread scribbles).
  // Mathpix intentionally uses full-width characters （）＋＝ etc. — never touch those.

  // Pattern: \text { <CJK char(s)> } — isolated CJK inside \text wrappers
  var TEXT_CJK_RE = /\\text\s*\{\s*[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\uAC00-\uD7AF]+\s*\}/g;

  var lineData = ocrResult.line_data || [];
  var lineAnnotations = [];
  var flaggedLines = [];
  var stats = { total: lineData.length, flagged: 0, kept: 0, cjkTextBlocks: 0 };

  msaLog_('=== CROSSED-OFF DETECTION (conservative) ===');
  msaLog_('Scanning ' + lineData.length + ' lines for isolated CJK in \\text{} blocks');

  // Scan line_data for logging purposes only
  for (var i = 0; i < lineData.length; i++) {
    var line = lineData[i];
    var text = (line.text || '').trim();

    if (TEXT_CJK_RE.test(text)) {
      TEXT_CJK_RE.lastIndex = 0; // reset regex
      var matches = text.match(TEXT_CJK_RE) || [];
      stats.cjkTextBlocks += matches.length;
      msaLog_('  LINE ' + i + ' [CJK \\text block] "' + matches.join(', ') + '" in: "' + text.substring(0, 80) + '"');
      lineAnnotations.push({ status: 'cleaned', flags: ['cjk_text_stripped'], original: text });
    } else {
      lineAnnotations.push({ status: 'ok' });
      stats.kept++;
    }
  }

  // Build cleanedText: only strip \text{<CJK>} blocks from the ORIGINAL full text
  // This preserves ALL LaTeX formatting, full-width chars, math expressions, etc.
  var fullText = ocrResult.text || '';
  var cleanedFullText = fullText.replace(TEXT_CJK_RE, '');

  // Clean up any double-spaces or trailing whitespace left behind
  cleanedFullText = cleanedFullText.replace(/  +/g, ' ');

  if (fullText !== cleanedFullText) {
    stats.cjkTextBlocks = stats.cjkTextBlocks || 1;
    msaLog_('Full text cleaned: ' + fullText.length + ' → ' + cleanedFullText.length + ' chars (' +
            (fullText.length - cleanedFullText.length) + ' chars removed)');
  } else {
    msaLog_('No CJK \\text{} blocks found — text unchanged');
  }

  msaLog_('Crossed-off scan complete: ' + stats.cjkTextBlocks + ' CJK \\text{} block(s) stripped');

  return {
    cleanedText: cleanedFullText,
    flaggedLines: flaggedLines,
    lineAnnotations: lineAnnotations,
    stats: stats
  };
}

/**
 * Calculate a composite confidence score for OCR results.
 * Mathpix raw confidence is often very low (1-5%) for handwritten content
 * because it's trained on printed math. This function provides a more
 * meaningful confidence based on multiple quality indicators.
 * 
 * @param {object} ocrResult The OCR result object from Mathpix
 * @param {number} rawConfidence The raw confidence from Mathpix (0-1)
 * @returns {number} Composite confidence score (0-1)
 */
function calculateCompositeConfidence_(ocrResult, rawConfidence) {
  var score = 0;
  var factors = 0;
  
  // Factor 1: Did we get any text at all?
  var text = ocrResult.text || '';
  if (text.length > 10) {
    score += 0.3;  // 30% for having substantial text
  } else if (text.length > 0) {
    score += 0.1;  // 10% for having some text
  }
  factors++;
  
  // Factor 2: Does the text contain math notation?
  var hasMath = text.includes('\\') || text.includes('=') || /\d+/.test(text);
  if (hasMath) {
    score += 0.25;  // 25% for containing math-like content
  }
  factors++;
  
  // Factor 3: Line data quality - do we have structured line data?
  var lineData = ocrResult.line_data || [];
  if (lineData.length > 3) {
    score += 0.2;  // 20% for multiple lines detected
  } else if (lineData.length > 0) {
    score += 0.1;  // 10% for some lines
  }
  factors++;
  
  // Factor 4: Mathpix raw confidence (weighted lower since it's often inaccurate for handwriting)
  // Scale it to contribute up to 25%
  score += rawConfidence * 0.25;
  factors++;
  
  // Ensure we return a value between 0 and 1
  var composite = Math.min(1.0, Math.max(0, score));
  
  return composite;
}

/**
 * Save corrected OCR text for a student work file.
 * @param {string} fileId The Google Drive File ID.
 * @param {string} correctedText The corrected OCR text.
 * @returns {object} Success status.
 */
function saveStudentOcrCorrection(fileId, correctedText, originalText, questionCode, studentId, examName) {
  try {
    const cfg = msaGetConfig_();
    const file = DriveApp.getFileById(fileId);
    
    // Save to a designated folder for OCR corrections
    const parentFolderId = cfg.MSA_PARENT_FOLDER_ID || DriveApp.getRootFolder().getId();
    const parentFolder = DriveApp.getFolderById(parentFolderId);
    
    // Create or get OCR corrections root folder
    var correctionsFolderIterator = parentFolder.getFoldersByName('_OCR_Corrections');
    var correctionsFolder;
    if (correctionsFolderIterator.hasNext()) {
      correctionsFolder = correctionsFolderIterator.next();
    } else {
      correctionsFolder = parentFolder.createFolder('_OCR_Corrections');
    }
    
    // ── Organize by student + question ──
    // Structure: _OCR_Corrections / {studentId} / {questionCode} / corrected_ocr.txt
    // If no studentId from QR, fall back to file-name-based storage
    var targetFolder = correctionsFolder;
    var correctionFileName;
    
    if (studentId && questionCode) {
      // Create student subfolder
      var studentFolderIter = correctionsFolder.getFoldersByName(studentId);
      var studentFolder;
      if (studentFolderIter.hasNext()) {
        studentFolder = studentFolderIter.next();
      } else {
        studentFolder = correctionsFolder.createFolder(studentId);
      }
      // Create question subfolder
      var questionFolderIter = studentFolder.getFoldersByName(questionCode);
      var questionFolder;
      if (questionFolderIter.hasNext()) {
        questionFolder = questionFolderIter.next();
      } else {
        questionFolder = studentFolder.createFolder(questionCode);
      }
      targetFolder = questionFolder;
      correctionFileName = 'corrected_ocr.txt';
      
      // Also save metadata JSON
      var metaJson = JSON.stringify({
        studentId: studentId,
        questionCode: questionCode,
        examName: examName || '',
        sourceFileId: fileId,
        sourceFileName: file.getName(),
        savedAt: new Date().toISOString(),
        textLength: correctedText.length
      }, null, 2);
      msaUpsertTextFile_(targetFolder, 'metadata.json', metaJson);
      msaLog_('Saved corrected OCR for student ' + studentId + ' / question ' + questionCode);
    } else {
      // No QR data — fall back to flat file with filename
      correctionFileName = file.getName() + '_corrected.txt';
      msaLog_('No QR data — saving as ' + correctionFileName);
    }
    
    // Save/update the corrected text
    var existingFiles = targetFolder.getFilesByName(correctionFileName);
    if (existingFiles.hasNext()) {
      existingFiles.next().setContent(correctedText);
    } else {
      targetFolder.createFile(correctionFileName, correctedText);
    }
    
    // ── LEARNING: Extract and save correction patterns ──
    var learnResult = { saved: 0, updated: 0, total: 0 };
    var studentLearnResult = { saved: 0, updated: 0, total: 0 };
    var diagnostics = { correctionsExtracted: 0, correctionsFiltered: 0 };
    if (originalText && originalText.trim() !== correctedText.trim()) {
      try {
        var corrections = extractCorrections_(originalText, correctedText);
        diagnostics.correctionsExtracted = corrections.length;
        msaLog_('📊 Diff engine found ' + corrections.length + ' correction(s) from user edits');
        if (corrections.length > 0) {
          // Log each extracted correction for debugging
          corrections.forEach(function(c, idx) {
            msaLog_('  [' + idx + '] ' + c.type + ': "' + (c.original || '').substring(0, 60) + '" → "' + (c.corrected || '').substring(0, 60) + '"');
          });
          // 1. Global learning (class-wide patterns)
          learnResult = saveLearnedCorrections_(corrections, {
            fileId: fileId,
            questionCode: questionCode || '',
            studentId: studentId || ''
          });
          diagnostics.correctionsFiltered = corrections.length - learnResult.saved - learnResult.updated;
          msaLog_('🧠 Global: ' + corrections.length + ' patterns (' +
                  learnResult.saved + ' new, ' + learnResult.updated + ' reinforced, ' +
                  diagnostics.correctionsFiltered + ' filtered)');

          // 2. Per-student profile (writer-adaptive)
          if (studentId) {
            try {
              studentLearnResult = saveStudentCorrections_(studentId, corrections, {
                fileId: fileId,
                questionCode: questionCode || ''
              });
              msaLog_('👤 [' + studentId + '] Profile: ' + corrections.length + ' patterns (' +
                      studentLearnResult.saved + ' new, ' + studentLearnResult.updated + ' reinforced)');
            } catch (profileErr) {
              msaWarn_('Student profile save failed (non-fatal): ' + profileErr.message);
            }
          }
        }
      } catch (learnErr) {
        msaWarn_('Learning pass failed (non-fatal): ' + learnErr.message);
      }
    }
    
    return {
      status: 'success',
      studentId: studentId || null,
      questionCode: questionCode || null,
      learned: learnResult,
      studentLearned: studentLearnResult,
      diagnostics: diagnostics
    };
  } catch (e) {
    msaErr_('Error saving OCR correction: ' + e.message);
    throw new Error('Failed to save correction: ' + e.message);
  }
}

/**
 * Find corner markers in OCR detection result
 * Looks for text markers: «TL», «TR», «BL», «BR» (or variations like TL, TR, BL, BR)
 * @param {object} ocrResult The OCR detection result
 * @returns {Array} Array of marker positions {x, y, corner}
 */
function findCornerMarkersInOcrResult(ocrResult) {
  var markers = [];
  
  // Look for text markers in OCR line data
  if (ocrResult.line_data && Array.isArray(ocrResult.line_data)) {
    msaLog_('=== SCANNING ' + ocrResult.line_data.length + ' LINES FOR MARKERS ===');
    
    // Log ALL detected text for debugging
    ocrResult.line_data.forEach(function(line, idx) {
      var text = (line.text || '').trim();
      var bbox = line.bbox || line.bounding_box;
      var pos = bbox ? ' @ (' + bbox[0].toFixed(0) + ',' + bbox[1].toFixed(0) + ')' : '';
      msaLog_('Line ' + idx + ': "' + text.substring(0, 50).replace(/\n/g, '\\n') + '"' + pos);
    });
    
    msaLog_('=== END LINE DUMP ===');
    
    ocrResult.line_data.forEach(function(line, idx) {
      var bbox = line.bbox || line.bounding_box;
      if (!bbox || bbox.length < 4) return;
      
      var width = bbox[2] - bbox[0];
      var height = bbox[3] - bbox[1];
      var rawText = (line.text || '');
      
      // Remove ALL whitespace and newlines, convert to uppercase
      var cleanText = rawText.replace(/[\n\r\s]+/g, '').toUpperCase();
      
      // Simple check: text containing TL, TR, BL, or BR (allow up to 20 chars for brackets/special chars)
      var foundLabel = null;
      if (cleanText.length <= 20) {
        if (cleanText.indexOf('TL') !== -1) foundLabel = 'TL';
        else if (cleanText.indexOf('TR') !== -1) foundLabel = 'TR';
        else if (cleanText.indexOf('BL') !== -1) foundLabel = 'BL';
        else if (cleanText.indexOf('BR') !== -1) foundLabel = 'BR';
        
        if (foundLabel) {
          msaLog_('Marker candidate line ' + idx + ': clean="' + cleanText + '" len=' + cleanText.length + ' -> ' + foundLabel);
        }
      }
      
      if (foundLabel) {
        var centerX = (bbox[0] + bbox[2]) / 2;
        var centerY = (bbox[1] + bbox[3]) / 2;
        
        markers.push({
          x: centerX,
          y: centerY,
          bbox: bbox,
          width: width,
          height: height,
          text: foundLabel,
          rawText: cleanText,
          detectedAs: 'text-marker'
        });
        
        msaLog_('✅ MARKER FOUND: ' + foundLabel + ' at (' + centerX.toFixed(0) + ',' + centerY.toFixed(0) + ')');
      }
    });
  } else {
    msaLog_('⚠️ No line_data in OCR result! Keys: ' + Object.keys(ocrResult).join(', '));
  }
  
  msaLog_('Found ' + markers.length + ' potential markers');
  
  // If we didn't find all 4 in line_data, search the raw text
  if (markers.length < 4 && ocrResult.text) {
    msaLog_('Searching raw OCR text for markers (found ' + markers.length + ' so far)...');
    var rawTextClean = ocrResult.text.replace(/[\n\r\s]+/g, '').toUpperCase();
    msaLog_('Raw text (cleaned) preview: ' + rawTextClean.substring(0, 300));
    
    var markerLabels = ['TL', 'TR', 'BL', 'BR'];
    markerLabels.forEach(function(label) {
      // Skip if we already found this marker
      var alreadyFound = markers.some(function(m) { return m.text === label; });
      if (alreadyFound) return;
      
      if (rawTextClean.indexOf(label) !== -1) {
        msaLog_('Found ' + label + ' in raw text (no position data available)');
      }
    });
  }
  
  // FALLBACK: If we found only BL and BR (bottom markers), estimate TL and TR
  // This works because answer boxes have consistent height ratios
  if (markers.length === 2) {
    var hasbl = markers.some(function(m) { return m.text === 'BL'; });
    var hasbr = markers.some(function(m) { return m.text === 'BR'; });
    
    if (hasbl && hasbr) {
      msaLog_('Only BL and BR found - estimating TL and TR from image dimensions');
      var bl = markers.find(function(m) { return m.text === 'BL'; });
      var br = markers.find(function(m) { return m.text === 'BR'; });
      
      // Estimate top Y as roughly 40% from top of image (answer box typically starts there)
      var imageHeight = ocrResult.image_height || 1000;
      var estimatedTopY = imageHeight * 0.35;
      
      markers.push({
        x: bl.x,
        y: estimatedTopY,
        text: 'TL',
        estimated: true
      });
      markers.push({
        x: br.x,
        y: estimatedTopY,
        text: 'TR',
        estimated: true
      });
      msaLog_('Estimated TL at (' + bl.x.toFixed(0) + ',' + estimatedTopY.toFixed(0) + ')');
      msaLog_('Estimated TR at (' + br.x.toFixed(0) + ',' + estimatedTopY.toFixed(0) + ')');
    }
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
  
  // Markers are now INSIDE the corners, so the bounding box is the marker area
  // Add small padding to include the marker text itself
  var padding = 5;
  
  var x1 = Math.round(minX - padding);
  var y1 = Math.round(minY - padding);
  var x2 = Math.round(maxX + padding);
  var y2 = Math.round(maxY + padding);
  
  return {
    x1: Math.max(0, x1),
    y1: Math.max(0, y1),
    x2: x2,
    y2: y2,
    width: x2 - x1,
    height: y2 - y1
  };
}

/**
 * Filter OCR results to only include content inside a region
 * @param {object} ocrResult Full OCR result from Mathpix
 * @param {object} region {x1, y1, x2, y2} bounding box
 * @returns {object} Filtered OCR result
 */
function filterOcrResultsByRegion(ocrResult, region) {
  var filtered = {
    text: '',
    latex_styled: ocrResult.latex_styled || '',
    confidence: ocrResult.confidence,
    image_width: ocrResult.image_width,
    image_height: ocrResult.image_height,
    line_data: []
  };
  
  if (!ocrResult.line_data || !Array.isArray(ocrResult.line_data)) {
    msaLog_('No line_data to filter');
    return ocrResult;
  }
  
  // Debug: Log the region and some sample lines
  msaLog_('Filter region: X=' + region.x1 + '-' + region.x2 + ', Y=' + region.y1 + '-' + region.y2);
  msaLog_('Image size: ' + ocrResult.image_width + 'x' + ocrResult.image_height);
  msaLog_('line_data length: ' + ocrResult.line_data.length);
  
  // Debug: Log first line's keys to see bbox structure
  if (ocrResult.line_data.length > 0) {
    var firstLine = ocrResult.line_data[0];
    msaLog_('First line keys: ' + Object.keys(firstLine).join(', '));
    msaLog_('First line bbox: ' + JSON.stringify(firstLine.bbox));
    msaLog_('First line cnt: ' + JSON.stringify(firstLine.cnt));
  }
  
  var textParts = [];
  var insideCount = 0;
  var outsideCount = 0;
  
  ocrResult.line_data.forEach(function(line, idx) {
    // Mathpix returns coordinates in 'cnt' as a polygon array: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
    // Convert to bounding box
    var x1, y1, x2, y2;
    
    if (line.cnt && Array.isArray(line.cnt) && line.cnt.length >= 4) {
      // Extract min/max from polygon points
      var xs = line.cnt.map(function(p) { return p[0]; });
      var ys = line.cnt.map(function(p) { return p[1]; });
      x1 = Math.min.apply(null, xs);
      x2 = Math.max.apply(null, xs);
      y1 = Math.min.apply(null, ys);
      y2 = Math.max.apply(null, ys);
    } else if (line.bbox && line.bbox.length >= 4) {
      // Fallback to bbox if present
      x1 = line.bbox[0];
      y1 = line.bbox[1];
      x2 = line.bbox[2];
      y2 = line.bbox[3];
    } else {
      // No coordinates available, skip this line
      return;
    }
    
    // Get center of the line
    var centerX = (x1 + x2) / 2;
    var centerY = (y1 + y2) / 2;
    
    // Debug first few lines
    if (idx < 5) {
      msaLog_('Line ' + idx + ': center=(' + centerX.toFixed(0) + ',' + centerY.toFixed(0) + ') region=(' + region.x1 + '-' + region.x2 + ',' + region.y1 + '-' + region.y2 + ') text="' + (line.text || '').substring(0, 30) + '"');
    }
    
    // Check if center is inside the region
    if (centerX >= region.x1 && centerX <= region.x2 &&
        centerY >= region.y1 && centerY <= region.y2) {
      insideCount++;
      
      // Skip marker labels themselves
      var text = (line.text || '').trim();
      if (/^\[?(TL|TR|BL|BR)\]?$/i.test(text)) {
        return; // Skip marker text
      }
      
      filtered.line_data.push(line);
      if (line.text) {
        textParts.push(line.text);
      }
    } else {
      outsideCount++;
    }
  });
  
  msaLog_('Filter result: ' + insideCount + ' inside, ' + outsideCount + ' outside');
  filtered.text = textParts.join('\n');
  msaLog_('Filtered from ' + ocrResult.line_data.length + ' to ' + filtered.line_data.length + ' lines');
  
  return filtered;
}

/**
 * Look up stored box coordinates from the database
 * @param {string} questionCode The question code (e.g., "14M.2.AHL.TZ2.H_1")
 * @param {string} position "Q1" or "Q2+" (defaults to "Q2+" if not specified)
 * @returns {object|null} Coordinates {xPct, yPct, widthPct, heightPct} or null if not found
 */
function lookupBoxCoordinates(questionCode, position) {
  if (!questionCode) return null;
  position = position || "Q2+"; // Default to Q2+ since most questions aren't Q1
  
  try {
    var dbSS = SpreadsheetApp.openById(MSA_QUESTION_META_SPREADSHEET_ID);
    var sheet = dbSS.getSheetByName("BoxCoordinates");
    
    if (!sheet) {
      msaLog_('BoxCoordinates sheet not found in database');
      return null;
    }
    
    var data = sheet.getDataRange().getValues();
    // Headers: QuestionCode, Position, X_Pct, Y_Pct, Width_Pct, Height_Pct, ...
    
    // First try exact match (questionCode + position)
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] == questionCode && data[i][1] == position) {
        var coords = {
          questionCode: data[i][0],
          position: data[i][1],
          xPct: parseFloat(data[i][2]),
          yPct: parseFloat(data[i][3]),
          widthPct: parseFloat(data[i][4]),
          heightPct: parseFloat(data[i][5])
        };
        msaLog_('Found stored coordinates for ' + questionCode + ' (' + position + '): ' + JSON.stringify(coords));
        return coords;
      }
    }
    
    // If exact position not found, try the other position as fallback
    var fallbackPosition = (position === "Q1") ? "Q2+" : "Q1";
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] == questionCode && data[i][1] == fallbackPosition) {
        var coords = {
          questionCode: data[i][0],
          position: data[i][1],
          xPct: parseFloat(data[i][2]),
          yPct: parseFloat(data[i][3]),
          widthPct: parseFloat(data[i][4]),
          heightPct: parseFloat(data[i][5])
        };
        msaLog_('Found fallback coordinates for ' + questionCode + ' (' + fallbackPosition + ' instead of ' + position + ')');
        return coords;
      }
    }
    
    msaLog_('No stored coordinates found for ' + questionCode);
    return null;
  } catch (e) {
    msaLog_('Error looking up box coordinates: ' + e.message);
    return null;
  }
}

/**
 * Decode QR code from an image using free QR API (api.qrserver.com)
 * Resizes large images first to improve QR detection reliability.
 * @param {string} fileId The Google Drive File ID of the image
 * @returns {object|null} Decoded QR data {studentId, questionCode, examName} or null
 */
function decodeQrFromImage(fileId) {
  // ── Cache check: same file always has the same QR code ──
  var cacheKey = 'qr_decode_' + fileId;
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) {
      msaLog_('QR decode: cache HIT for ' + fileId);
      return JSON.parse(cached);
    }
  } catch (cacheErr) {
    // cache miss or parse error — proceed
  }

  try {
    var file = DriveApp.getFileById(fileId);
    // Use file.getSize() instead of blob.getBytes().length to avoid reading
    // the full blob into memory just for a size check (saves ~1s on 2.5MB images)
    var fileSize = file.getSize();
    msaLog_('QR decode: fileId=' + fileId + ', file size=' + fileSize + ', mimeType=' + file.getMimeType());
    
    // If image is larger than 500KB, get a smaller version for QR scanning
    // Large images overwhelm the free QR API (returns HTTP 400)
    var sendBlob = null;
    if (fileSize > 500000) {
      msaLog_('QR decode: Image too large (' + Math.round(fileSize/1024) + 'KB), getting thumbnail for QR scan...');
      try {
        // Use Drive REST API v3 via UrlFetchApp (no advanced service needed)
        var token = ScriptApp.getOAuthToken();
        var metaUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink';
        var metaResp = UrlFetchApp.fetch(metaUrl, {
          headers: { 'Authorization': 'Bearer ' + token },
          muteHttpExceptions: true
        });
        
        if (metaResp.getResponseCode() === 200) {
          var meta = JSON.parse(metaResp.getContentText());
          msaLog_('QR decode: Got metadata, thumbnailLink=' + (meta.thumbnailLink ? 'yes' : 'no'));
          
          if (meta.thumbnailLink) {
            // Try progressively smaller thumbnails until one fits under 1MB
            // s2000 is almost always >1MB for large images, so start at s1600
            var sizes = ['s1600', 's1200', 's800'];
            for (var si = 0; si < sizes.length; si++) {
              var thumbUrl = meta.thumbnailLink.replace('=s220', '=' + sizes[si]);
              msaLog_('QR decode: Trying thumbnail at ' + sizes[si] + '...');
              var thumbResponse = UrlFetchApp.fetch(thumbUrl, {
                headers: { 'Authorization': 'Bearer ' + token },
                muteHttpExceptions: true
              });
              if (thumbResponse.getResponseCode() === 200) {
                var thumbBlob = thumbResponse.getBlob().setName('thumb.png');
                var thumbSize = thumbBlob.getBytes().length;
                msaLog_('QR decode: Got thumbnail at ' + sizes[si] + ' (' + Math.round(thumbSize/1024) + 'KB)');
                // Only use if under 1MB (QR API limit)
                if (thumbSize < 1000000) {
                  sendBlob = thumbBlob;
                  break;
                } else {
                  msaLog_('QR decode: Thumbnail too large (' + Math.round(thumbSize/1024) + 'KB), trying smaller...');
                }
              }
            }
          }
        } else {
          msaLog_('QR decode: Drive metadata request returned HTTP ' + metaResp.getResponseCode());
        }
      } catch (thumbErr) {
        msaLog_('QR decode: Thumbnail fallback failed: ' + thumbErr.message + ', using original blob');
      }
    }
    
    // If no thumbnail was obtained (small image or all fallbacks failed), load the actual blob
    if (!sendBlob) {
      if (fileSize <= 500000) {
        msaLog_('QR decode: Small image (' + Math.round(fileSize/1024) + 'KB), using original blob');
      } else {
        msaLog_('QR decode: All thumbnail attempts failed, falling back to original blob');
      }
      sendBlob = file.getBlob();
    }
    
    // Use free QR decoding API: api.qrserver.com
    var qrApiUrl = 'https://api.qrserver.com/v1/read-qr-code/';
    
    var response = UrlFetchApp.fetch(qrApiUrl, {
      method: 'post',
      payload: {
        file: sendBlob
      },
      muteHttpExceptions: true
    });
    
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();
    msaLog_('QR decode: API response code=' + responseCode);
    msaLog_('QR decode: API response (first 500 chars)=' + responseText.substring(0, 500));
    
    // Check for non-200 responses
    if (responseCode !== 200) {
      msaLog_('QR decode: API returned HTTP ' + responseCode + ', skipping QR detection');
      return null;
    }
    
    // Safely parse the response
    var result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      msaLog_('QR decode: API response is not valid JSON: ' + responseText.substring(0, 200));
      return null;
    }
    
    msaLog_('QR API parsed response: ' + JSON.stringify(result).substring(0, 500));
    
    // Response format: [{"type":"qrcode","symbol":[{"data":"...","error":null}]}]
    if (result && result[0] && result[0].symbol && result[0].symbol[0]) {
      var qrContent = result[0].symbol[0].data;
      var qrError = result[0].symbol[0].error;
      
      if (qrError) {
        msaLog_('QR decode: symbol error: ' + qrError);
        return null;
      }
      
      if (qrContent) {
        msaLog_('QR decode: raw content: ' + qrContent);
        
        // Parse the JSON content: {"s":"studentId","q":"questionCode","e":"examName"}
        try {
          var qrData = JSON.parse(qrContent);
          msaLog_('QR decode: parsed data: ' + JSON.stringify(qrData));
          var qrResult = {
            studentId: qrData.s || qrData.studentId,
            questionCode: qrData.q || qrData.questionCode,
            examName: qrData.e || qrData.examName,
            raw: qrData
          };
          // Cache for 6 hours
          try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(qrResult), 21600); } catch(ce) {}
          return qrResult;
        } catch (e) {
          msaLog_('QR decode: content is not JSON, treating as raw question code: ' + qrContent);
          var qrResult = { questionCode: qrContent };
          try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(qrResult), 21600); } catch(ce) {}
          return qrResult;
        }
      }
    }
    
    msaLog_('QR decode: No QR code found in image');
    return null;
  } catch (e) {
    msaLog_('QR decode: FAILED: ' + e.message);
    return null;
  }
}

/**
 * Determine if page is Q1 (first question) based on "Section A" header presence
 * @param {object} ocrResult The OCR result with text
 * @returns {boolean} True if this appears to be Q1 (has Section A header)
 */
function detectIfQ1FromOcr(ocrResult) {
  var text = (ocrResult.text || '').toLowerCase();
  // Q1 pages have "Section A" header and instruction text
  if (text.includes('section a') && text.includes('answer all questions')) {
    msaLog_('Detected Q1 (Section A header found)');
    return true;
  }
  msaLog_('Detected Q2+ (no Section A header)');
  return false;
}

/**
 * Grade student work against a mark scheme.
 * This function takes the student's OCR text and compares it to the pre-parsed
 * markscheme points to assign marks.
 * 
 * @param {string} studentOcrText The OCR text from the student's handwritten work.
 * @param {string} questionCode The question code (e.g., "14M.2.AHL.TZ2.H_1").
 * @param {string} [studentId] Optional student ID from QR for per-student corrections.
 * @returns {object} Grading result with scores and detailed feedback.
 */
function gradeStudentWork(studentOcrText, questionCode, studentId) {
  const t0 = Date.now();
  msaLog_('=== GRADING STUDENT WORK ===');
  msaLog_('Question code: ' + questionCode);
  
  try {
    const cfg = msaGetConfig_();
    
    // 1. Find the mark scheme data for this question
    const markschemePoints = loadMarkschemePoints_(questionCode);
    if (!markschemePoints || markschemePoints.length === 0) {
      return {
        status: 'error',
        message: 'Could not find mark scheme data for question: ' + questionCode
      };
    }
    
    msaLog_('Loaded ' + markschemePoints.length + ' markscheme points');
    
    // 1b. Auto-flag crossed-off / CJK garbage lines
    var crossedOffScan = flagCrossedOffLines_({ text: studentOcrText, line_data: studentOcrText.split('\n').map(function(t) { return { text: t }; }) });
    if (crossedOffScan.stats.flagged > 0) {
      msaLog_('Pre-grade crossed-off scan: removed ' + crossedOffScan.stats.flagged + ' garbage lines');
      studentOcrText = crossedOffScan.cleanedText;
    }

    // 2. Clean the student text - remove printed question content
    var cleanedStudentText = cleanStudentOcrText_(studentOcrText);
    msaLog_('Student text length (cleaned): ' + cleanedStudentText.length);
    
    // 2a. Apply per-student corrections (writer-adaptive)
    //     These are safe to apply pre-grading because they are teacher-verified
    //     patterns specific to THIS student's handwriting (unlike OCR Verify
    //     which auto-corrects toward mark-scheme answers).
    var preGradeStudentProfile = null;
    if (studentId) {
      try {
        preGradeStudentProfile = applyStudentCorrections_(
          studentId, cleanedStudentText,
          { minFrequency: (typeof MSA_STUDENT_OCR_MIN_FREQUENCY !== 'undefined') ? MSA_STUDENT_OCR_MIN_FREQUENCY : 1 }
        );
        if (preGradeStudentProfile.stats.rulesApplied > 0) {
          cleanedStudentText = preGradeStudentProfile.text;
          msaLog_('👤 [' + studentId + '] Pre-grade: applied ' + preGradeStudentProfile.stats.rulesApplied +
            ' personal rules (' + preGradeStudentProfile.stats.totalReplacements + ' replacements)');
        }
      } catch (profileErr) {
        msaLog_('Student profile pre-grade pass skipped: ' + profileErr.message);
      }
    }
    
    // 2b. OCR Verification Pass — cross-check numbers against mark-scheme
    //     using glyph-confusion matrix to catch common handwriting OCR errors.
    //
    //     IMPORTANT: We run in DRY-RUN / flag-only mode. The verified text is
    //     NOT passed to the grader because auto-correcting numbers toward the
    //     mark scheme answer would inflate scores — the grader would "find"
    //     numbers the student never wrote. Instead, we surface the near-misses
    //     in the UI for teacher review.
    var ocrVerification = null;
    var verifiedStudentText = cleanedStudentText;  // grader always uses the original
    try {
      ocrVerification = ocrVerifyStudentWork(
        cleanedStudentText,
        null,  // latexStyledText — pass if available
        markschemePoints,
        { autoCorrectThreshold: 0.55, dryRun: true }  // flag only, never rewrite
      );
      // NOTE: we intentionally do NOT use ocrVerification.verifiedText here
      if (ocrVerification.stats.corrected > 0 || ocrVerification.stats.flagged > 0) {
        msaLog_('OCR Verify (flag-only): ' + ocrVerification.stats.corrected + ' would-correct, ' +
          ocrVerification.stats.flagged + ' flagged for review');
      }
    } catch (verifyErr) {
      msaWarn_('OCR verification pass failed (non-fatal): ' + verifyErr.message);
    }
    
    // 3. Grade each point using the AI system with implied marks
    // The gradeWithImpliedMarks function handles:
    //   - First pass: grade each point normally
    //   - Second pass: check implied marks (parenthesized marks) for implication awards
    //   - Third pass: apply any learned rules from corrections database
    const results = gradeWithImpliedMarks(verifiedStudentText, markschemePoints, {
      questionCode: questionCode,
      enableLearning: true
    });
    
    // 4. Calculate total scores
    const possibleScore = msaCalculateTotalPossibleScore_(markschemePoints);
    const awardedScore = srgCalculateAwardedScore_(results);
    
    const processingTime = Date.now() - t0;
    msaLog_('Grading complete in ' + processingTime + 'ms');
    msaLog_('Score: ' + awardedScore.total + ' / ' + possibleScore.total);
    
    return {
      status: 'success',
      questionCode: questionCode,
      score: {
        awarded: awardedScore.total,
        possible: possibleScore.total,
        percentage: Math.round((awardedScore.total / possibleScore.total) * 100)
      },
      results: results,
      breakdown: awardedScore.breakdown,
      processingTime: processingTime,
      ocrVerification: ocrVerification ? {
        corrected: ocrVerification.stats.corrected,
        flagged: ocrVerification.stats.flagged,
        corrections: ocrVerification.corrections,
        originalText: ocrVerification.originalText,
        verifiedText: ocrVerification.verifiedText
      } : null,
      studentProfile: preGradeStudentProfile ? {
        applied: preGradeStudentProfile.applied,
        stats: preGradeStudentProfile.stats
      } : null
    };
    
  } catch (e) {
    msaErr_('Error grading student work: ' + e.message);
    return {
      status: 'error',
      message: e.message
    };
  }
}

/**
 * Load markscheme points for a question from the stored JSON file.
 * @param {string} questionCode The question code.
 * @returns {Array|null} Array of point objects or null if not found.
 */
function loadMarkschemePoints_(questionCode) {
  const cfg = msaGetConfig_();
  
  // Try to find the question folder by searching for the question code
  const parentFolder = DriveApp.getFolderById(cfg.MSA_PARENT_FOLDER_ID);
  
  // Search for a folder containing this question code (searches all subfolders)
  // Use Drive advanced search to search recursively
  var folderIterator = parentFolder.searchFolders('title contains "' + questionCode + '"');
  
  if (folderIterator.hasNext()) {
    const folder = folderIterator.next();
    msaLog_('Found folder directly: ' + folder.getName());
    return loadPointsFromFolder_(folder);
  }
  
  // If not found directly, search in common subfolders like "mark schemes"
  var subfolderNames = ['mark schemes', 'Mark Schemes', 'markschemes', 'MarkSchemes'];
  for (var s = 0; s < subfolderNames.length; s++) {
    var subIter = parentFolder.getFoldersByName(subfolderNames[s]);
    if (subIter.hasNext()) {
      var subfolder = subIter.next();
      msaLog_('Searching in subfolder: ' + subfolderNames[s]);
      var subFolderIterator = subfolder.searchFolders('title contains "' + questionCode + '"');
      if (subFolderIterator.hasNext()) {
        const folder = subFolderIterator.next();
        msaLog_('Found folder in ' + subfolderNames[s] + ': ' + folder.getName());
        return loadPointsFromFolder_(folder);
      }
    }
  }
  
  // Try searching for a doc with this title to get its folder
  const docIterator = parentFolder.getFilesByName(questionCode);
  if (docIterator.hasNext()) {
    const doc = docIterator.next();
    const docId = doc.getId();
    const folder = msaFindQuestionFolderByDocId_(cfg, docId);
    if (folder) {
      return loadPointsFromFolder_(folder);
    }
  }
  
  msaLog_('No folder found for question: ' + questionCode);
  return null;
}

/**
 * Load points from a question folder.
 * @param {DriveApp.Folder} folder The question output folder.
 * @returns {Array|null} Array of point objects.
 */
function loadPointsFromFolder_(folder) {
  // Try to load the best points JSON (best > Pass 3 > Pass 2 > Pass 1)
  const fileNames = [
    'markscheme_points_best.json',
    'markscheme_points_pass3.json',
    'markscheme_points_pass2.json', 
    'markscheme_points.json'
  ];
  
  msaLog_('Searching folder: ' + folder.getName());
  
  for (var i = 0; i < fileNames.length; i++) {
    var fileIterator = folder.getFilesByName(fileNames[i]);
    if (fileIterator.hasNext()) {
      var file = fileIterator.next();
      var content = file.getBlob().getDataAsString();
      try {
        var data = JSON.parse(content);
        msaLog_('Loaded points from ' + fileNames[i]);
        return data.points || data;
      } catch (e) {
        msaLog_('Error parsing ' + fileNames[i] + ': ' + e.message);
      }
    }
  }
  
  msaLog_('No markscheme points file found in folder');
  return null;
}

/**
 * Clean student OCR text by removing printed question content.
 * Removes question numbers, mark allocations, and instruction text.
 * @param {string} text Raw OCR text from student work.
 * @returns {string} Cleaned text with only student's handwritten content.
 */
function cleanStudentOcrText_(text) {
  if (!text) return '';
  
  var lines = text.split('\n');
  var cleanedLines = [];
  var inQuestionHeader = false;
  
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // Skip question number headers (e.g., "5. [Maximum mark: 6]", "1. [Maximum mark: 14]")
    if (/^\d+\.\s*\[Maximum mark:\s*\d+\]/.test(line)) {
      inQuestionHeader = true;
      continue;
    }
    
    // Skip Section A header
    if (/^Section\s+A/i.test(line)) continue;
    
    // Skip "Answer all questions" instruction
    if (/Answer all questions/i.test(line)) continue;
    
    // Skip mark allocations like "[4]" or "[2]" on their own line
    if (/^\[\d+\]$/.test(line)) continue;
    
    // Skip lines that look like printed question text (common patterns)
    // - Lines starting with "(a)", "(b)", etc. followed by question text
    if (/^\([a-z]\)\s+(?:Find|Express|Calculate|Determine|Show|Prove|State|Write|An arithmetic|The sum)/i.test(line)) {
      continue;
    }
    
    // Skip lines with instruction patterns (find, express, etc.)
    if (inQuestionHeader && /^(?:Find|Express|Calculate|Determine|Show|Prove|State|Write)/i.test(line)) {
      continue;
    }
    
    // Reset question header flag after a few lines or when we hit student work
    if (inQuestionHeader && (i > 10 || /^[a-z]\s*[=]|^\d+[\s+\-\*\/]|^S_|^a_/.test(line))) {
      inQuestionHeader = false;
    }
    
    // Keep lines that look like student work (calculations, equations, etc.)
    cleanedLines.push(line);
  }
  
  return cleanedLines.join('\n');
}

/**
 * Quick test function to grade student work from the UI.
 * @param {string} studentOcrText The student's OCR text.
 * @param {string} questionCode The question code.
 * @returns {object} Grading results formatted for UI display.
 */
function testGradeStudentWork(studentOcrText, questionCode) {
  return gradeStudentWork(studentOcrText, questionCode);
}

/**
 * Grade student work and also return the mark scheme HTML for display.
 * This is the enhanced version for the full grading UI.
 * @param {string} studentOcrText The student's OCR text.
 * @param {string} questionCode The question code.
 * @param {string} [studentId] Optional student ID from QR for per-student corrections.
 * @returns {object} Grading results with mark scheme HTML.
 */
function gradeStudentWorkWithMarkscheme(studentOcrText, questionCode, studentId) {
  // First, do the grading
  var result = gradeStudentWork(studentOcrText, questionCode, studentId);
  
  if (result.status !== 'success') {
    return result;
  }
  
  // Now try to get the mark scheme preview HTML
  try {
    var markschemeHtml = loadMarkschemePreview_(questionCode);
    result.markschemeHtml = markschemeHtml;
  } catch (e) {
    msaLog_('Could not load mark scheme preview: ' + e.message);
    result.markschemeHtml = null;
  }
  
  return result;
}

/**
 * Load the mark scheme preview HTML for a question.
 * @param {string} questionCode The question code.
 * @returns {string|null} HTML content or null.
 */
function loadMarkschemePreview_(questionCode) {
  const cfg = msaGetConfig_();
  const parentFolder = DriveApp.getFolderById(cfg.MSA_PARENT_FOLDER_ID);
  
  // Search for a folder containing this question code (same logic as loadMarkschemePoints_)
  var folder = null;
  
  // Try direct search first
  var folderIterator = parentFolder.searchFolders('title contains "' + questionCode + '"');
  if (folderIterator.hasNext()) {
    folder = folderIterator.next();
  }
  
  // If not found, search in subfolders
  if (!folder) {
    var subfolderNames = ['mark schemes', 'Mark Schemes', 'markschemes', 'MarkSchemes'];
    for (var s = 0; s < subfolderNames.length; s++) {
      var subIter = parentFolder.getFoldersByName(subfolderNames[s]);
      if (subIter.hasNext()) {
        var subfolder = subIter.next();
        var subFolderIterator = subfolder.searchFolders('title contains "' + questionCode + '"');
        if (subFolderIterator.hasNext()) {
          folder = subFolderIterator.next();
          break;
        }
      }
    }
  }
  
  if (!folder) {
    msaLog_('No folder found for mark scheme preview: ' + questionCode);
    return null;
  }
  
  // Try to load the structured preview first, then the regular preview
  var previewFiles = ['markscheme_structured_preview.html', 'markscheme_preview.html'];
  
  for (var i = 0; i < previewFiles.length; i++) {
    var fileIterator = folder.getFilesByName(previewFiles[i]);
    if (fileIterator.hasNext()) {
      var file = fileIterator.next();
      var html = file.getBlob().getDataAsString();
      msaLog_('Loaded mark scheme preview from ' + previewFiles[i]);
      return html;
    }
  }
  
  msaLog_('No mark scheme preview file found in folder');
  return null;
}


/**
 * Generate an AI-powered suggestion for a grading run.
 * Calls the Anthropic Claude API with a concise summary of the grading results.
 * Returns JSON string: { text: "..." } or { error: "..." }
 *
 * @param {string} summaryJson - JSON string with grading summary
 * @return {string} JSON string with suggestion
 */
function getAiSuggestion(summaryJson) {
  try {
    var props = PropertiesService.getScriptProperties();
    var apiKey = props.getProperty('ANTHROPIC_API_KEY');
    
    if (!apiKey) {
      // Fall back to a rule-based suggestion if no API key configured
      return JSON.stringify(generateRuleBasedSuggestion_(summaryJson));
    }
    
    var summary = JSON.parse(summaryJson);
    
    // Build a focused prompt
    var prompt = buildSuggestionPrompt_(summary);
    
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: prompt
        }]
      }),
      muteHttpExceptions: true
    });
    
    var code = response.getResponseCode();
    if (code !== 200) {
      Logger.log('Anthropic API error: ' + code + ' ' + response.getContentText().substring(0, 500));
      // Fall back to rule-based suggestion
      return JSON.stringify(generateRuleBasedSuggestion_(summaryJson));
    }
    
    var body = JSON.parse(response.getContentText());
    var text = body.content && body.content[0] && body.content[0].text;
    if (text) {
      return JSON.stringify({ text: text.trim() });
    }
    
    return JSON.stringify({ error: 'AI returned empty response.' });
  } catch (e) {
    Logger.log('getAiSuggestion error: ' + e);
    // Fall back to rule-based on any error
    try {
      return JSON.stringify(generateRuleBasedSuggestion_(summaryJson));
    } catch (e2) {
      return JSON.stringify({ error: 'Could not generate suggestion.' });
    }
  }
}


/**
 * Build the prompt sent to Claude for generating a suggestion.
 */
function buildSuggestionPrompt_(summary) {
  var lines = [];
  lines.push('You are an expert IB Mathematics exam grading assistant. Analyze this automated grading result and provide ONE concise, actionable suggestion to improve the grading accuracy or the student\'s understanding. Keep it under 2 sentences.');
  lines.push('');
  lines.push('Question: ' + (summary.questionCode || 'unknown'));
  lines.push('Score: ' + summary.score.awarded + '/' + summary.score.possible);
  lines.push('');
  lines.push('Point-by-point results:');
  
  (summary.results || []).forEach(function(r) {
    var status = r.awarded ? '✅' : '❌';
    var strategy = r.strategy || 'none';
    var found = (r.found || []).join(', ') || 'nothing';
    var missing = (r.missing || []).join(', ') || 'none';
    var extras = [];
    if (r.awardedByImplication) extras.push('implied');
    if (r.excludedByMethod) extras.push('method-excluded');
    lines.push(status + ' ' + r.point_id + ' (' + (r.part || '') + ') ' + (r.marks || []).join('') + 
               ' — strategy: ' + strategy + ', found: [' + found + '], missing: [' + missing + ']' +
               (extras.length ? ' [' + extras.join(', ') + ']' : ''));
  });
  
  if (summary.ocrVerification) {
    lines.push('');
    lines.push('OCR: ' + summary.ocrVerification.correctionsMade + ' corrections applied');
  }
  
  lines.push('');
  lines.push('Respond with just the suggestion text — no preamble, no bullet points, no markdown. One practical observation or tip.');
  
  return lines.join('\n');
}


/**
 * Generate a rule-based suggestion when no AI API key is configured.
 * Analyzes the grading patterns to produce a useful observation.
 */
function generateRuleBasedSuggestion_(summaryJson) {
  try {
    var summary = typeof summaryJson === 'string' ? JSON.parse(summaryJson) : summaryJson;
    var results = summary.results || [];
    var score = summary.score || { awarded: 0, possible: 0 };
    
    // Count different patterns
    var strategies = {};
    var missingCount = 0;
    var impliedCount = 0;
    var excludedCount = 0;
    var globalMatchCount = 0;
    
    results.forEach(function(r) {
      var s = r.strategy || 'none';
      strategies[s] = (strategies[s] || 0) + 1;
      if (r.missing && r.missing.length > 0) missingCount++;
      if (r.awardedByImplication) impliedCount++;
      if (r.excludedByMethod) excludedCount++;
      if (s === 'numeric' && r.awarded) globalMatchCount++;
    });
    
    // Generate the most relevant suggestion
    if (score.possible > 0 && score.awarded === score.possible) {
      return { text: 'Perfect score — all marks awarded. Verify that global numeric matches (Strategy 3) found values from the correct part of the student\'s work, not coincidental numbers.' };
    }
    
    if (globalMatchCount > 2) {
      return { text: 'Multiple marks were awarded by global numeric search (Strategy 3), which scans the entire student response. Check that these numbers actually came from the relevant part — the same value might appear in a different context.' };
    }
    
    if (impliedCount > 0 && missingCount > 0) {
      return { text: impliedCount + ' mark(s) were awarded by implication while ' + missingCount + ' point(s) had missing values. Review the implied marks — a correct final answer doesn\'t always mean every intermediate step was understood.' };
    }
    
    if (strategies['none'] && strategies['none'] > 2) {
      return { text: strategies['none'] + ' marking points had no matching strategy. This may indicate OCR quality issues or mark scheme requirements that need keyword/regex patterns added to the grading engine.' };
    }
    
    if (missingCount > results.length / 2) {
      return { text: 'Over half the marking points are missing required values. The student may have used a completely different method — consider checking if an alternative method branch better matches their work.' };
    }
    
    if (excludedCount > 0) {
      return { text: 'The grader selected the best-scoring method branch, excluding ' + excludedCount + ' point(s) from alternative methods. Click ? on the excluded (grey) rows to verify the method selection was correct.' };
    }
    
    // Default
    var pct = score.possible > 0 ? Math.round(100 * score.awarded / score.possible) : 0;
    return { text: 'Score: ' + pct + '%. Click the ? button on any marking point to see exactly which strategy was used and what evidence was found in the student\'s work.' };
    
  } catch (e) {
    return { error: 'Could not analyze grading results.' };
  }
}