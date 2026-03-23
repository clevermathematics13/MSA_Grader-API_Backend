// --- GLOBAL CONFIGURATION ---
var SLIDE_TEMPLATE_ID = "1NHn0YHpXI2vSe93Eb5ZqjpOOrja7bIk7RWIQ04YghJM"; 
var DATABASE_SS_ID = "1fc7cWtM83oxQ8rMIX8F_sgjN1xCkLpqdbeTzIG33kPU"; // Audit Sheet
var STUDENT_SOURCE_ID = "1bQoToVwjbszmmsoQNmPrpNpb0dT3ZNJTBM6sS49slXU"; // Student Source
var FIDUCIAL_IMAGE_ID = "1DRw6kSFZA4oHNC527_dwrV30Lr2eIxQY"; // ⬛ Anchor Image

// ==========================================
// 🔗 MAIN COMMAND
// ==========================================
function createTestInSlides() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mainFolder = getOrCreateFolder(parentFolder, testName);
  
  // 1. Generate the MASTER Template
  ss.toast("Step 1/3: Building Master Template...", "Working", -1);
  var masterDeckFile = createMasterSlideDeck(mainFolder);
  
  if (!masterDeckFile) {
    ss.toast("Failed to build master deck.", "Error");
    return;
  }

  // 2. Export Master PDF
  ss.toast("Step 2/4: Exporting Master PDF...", "Working", -1);
  var masterPdf = masterDeckFile.getAs(MimeType.PDF);
  mainFolder.createFile(masterPdf).setName(testName + " [Master].pdf");
  
  // 3. Build Mark Scheme PDF
  ss.toast("Step 3/4: Building Mark Scheme...", "Working", -1);
  buildMarkSchemePDF(mainFolder);

  // 4. Class Batch - controlled by checkbox in L1
  var ppqSheet = ss.getSheetByName("PPQselector");
  var doBatch = ppqSheet.getRange("L1").getValue();
  if (doBatch === true) {
    ss.toast("Step 4/4: Processing Class Batch...", "Working", -1);
    processClassBatch(ss, mainFolder, masterDeckFile);
  } else {
    ss.toast("Skipped class batch (L1 unchecked).", "Info", 3);
  }
  
  // 5. Cleanup
  masterDeckFile.setTrashed(true); 
  ss.toast("All tasks complete!", "Success", 5);
  return mainFolder;
}

// ==========================================
// 🏗️ PHASE 1: BUILD MASTER TEMPLATE
// ==========================================
function createMasterSlideDeck(folder) {
  var templateFile = DriveApp.getFileById(SLIDE_TEMPLATE_ID);
  var newFile = templateFile.makeCopy(testName + " [TEMP_MASTER]", folder);
  var deck = SlidesApp.openById(newFile.getId());
  
  var qDocs = getRowDataClean(7); 
  var qCodes = getRowDataClean(6); 
  var layoutMap = fetchLayoutCodesFromDatabase(null); 
  var hasSectionBStarted = false;

  var allBoxCoords = [];
  for (var i = 0; i < qDocs.length; i++) {
    var slide = deck.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    var docId = qDocs[i];
    var questionCode = (i < qCodes.length) ? qCodes[i] : "";

    var code = layoutMap[docId] || layoutMap[questionCode] || "";
    var doc = DocumentApp.openById(docId);
    var body = doc.getBody();
    var firstText = body.getText().substring(0, 500); 
    
    // Detect Section B content - override layout codes if Section B keywords found
    if (firstText.includes("Section B") || firstText.includes("Do not write solutions")) {
      code = "B_DETECTED"; 
    }

    var headerType = "NONE";
    var isTypeB = (code.toString().toUpperCase().startsWith("B"));
    if (isTypeB) {
      if (!hasSectionBStarted) { headerType = "SECTION_B_START"; hasSectionBStarted = true; }
      else { headerType = "SECTION_B_CONTINUED"; }
    }

    var coords = renderSlideContent(slide, doc, i + 1, (i === 0), code, headerType);
    if (coords) {
      coords.questionCode = questionCode;
      coords.position = "Q" + (i + 1);
      allBoxCoords.push(coords);
    }
  }
  
  // Write box coordinates to audit spreadsheet
  if (allBoxCoords.length > 0) {
    writeBoxCoordinates(allBoxCoords);
  }

  updateCoverSlide(deck, null);
  deck.saveAndClose();
  return newFile;
}

// ==========================================
// 📝 PHASE 1B: BUILD MARK SCHEME (Google Doc)
// ==========================================
function buildMarkSchemePDF(folder) {
  var msDocs = getRowDataClean(8); // Row 8 = Google Doc ms IDs
  Logger.log("[MS] Row 8 IDs: " + JSON.stringify(msDocs));
  if (!msDocs || msDocs.length === 0) {
    Logger.log("[MS] No mark scheme docs found (row 8 empty).");
    return;
  }

  try {
    // Create a combined Google Doc for the mark scheme
    var msDoc = DocumentApp.create(testName + " [Mark Scheme]");
    var msBody = msDoc.getBody();
    msBody.setMarginTop(36);
    msBody.setMarginBottom(36);
    msBody.setMarginLeft(36);
    msBody.setMarginRight(36);

    for (var i = 0; i < msDocs.length; i++) {
      Logger.log("[MS] Processing Doc " + i + ": " + msDocs[i]);
      try {
        var srcDoc = DocumentApp.openById(msDocs[i]);
        var srcBody = srcDoc.getBody();
        var questionNumber = i + 1;

        // Add page break before each question (except the first)
        if (i > 0) {
          msBody.appendPageBreak();
        }

        // Add question header
        var header = msBody.appendParagraph("— Q" + questionNumber + " Mark Scheme —");
        header.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
        header.setAttributes({
          FONT_SIZE: 12,
          BOLD: true,
          FONT_FAMILY: "Arial"
        });
        msBody.appendParagraph(""); // spacer

        // Copy all elements from the source doc
        for (var j = 0; j < srcBody.getNumChildren(); j++) {
          var element = srcBody.getChild(j);
          var elType = element.getType();

          if (elType == DocumentApp.ElementType.PARAGRAPH) {
            var srcPara = element.asParagraph();
            var newPara = msBody.appendParagraph("");
            // Copy text runs with their formatting
            for (var k = 0; k < srcPara.getNumChildren(); k++) {
              var child = srcPara.getChild(k);
              if (child.getType() == DocumentApp.ElementType.TEXT) {
                var textEl = child.asText();
                var text = textEl.getText();
                if (text.length > 0) {
                  var appended = newPara.appendText(text);
                  // Copy character-level attributes
                  for (var c = 0; c < text.length; c++) {
                    var attrs = textEl.getAttributes(c);
                    appended.setAttributes(c, c, attrs);
                  }
                }
              } else if (child.getType() == DocumentApp.ElementType.INLINE_IMAGE) {
                var img = child.asInlineImage();
                var blob = img.getBlob();
                var inlineImg = newPara.appendInlineImage(blob);
                var w = img.getWidth();
                var h = img.getHeight();
                if (w && h) {
                  // Scale down if wider than ~500pt content area
                  if (w > 500) {
                    var scale = 500 / w;
                    inlineImg.setWidth(Math.round(w * scale));
                    inlineImg.setHeight(Math.round(h * scale));
                  } else {
                    inlineImg.setWidth(w);
                    inlineImg.setHeight(h);
                  }
                }
              }
            }
            // Copy paragraph attributes, then force center alignment
            try {
              var paraAttrs = srcPara.getAttributes();
              if (paraAttrs) newPara.setAttributes(paraAttrs);
            } catch(attrErr) {} // Some attributes may not transfer
            newPara.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

          } else if (elType == DocumentApp.ElementType.TABLE) {
            var srcTable = element.asTable();
            var numRows = srcTable.getNumRows();
            var numCols = srcTable.getRow(0).getNumCells();
            // Build cell text array for table creation
            var cells = [];
            for (var r = 0; r < numRows; r++) {
              var row = [];
              for (var c = 0; c < numCols; c++) {
                row.push(srcTable.getRow(r).getCell(c).getText());
              }
              cells.push(row);
            }
            var newTable = msBody.appendTable(cells);
            // Copy cell formatting
            for (var r = 0; r < numRows; r++) {
              for (var c = 0; c < numCols; c++) {
                try {
                  var srcCell = srcTable.getRow(r).getCell(c);
                  var dstCell = newTable.getRow(r).getCell(c);
                  dstCell.getChild(0).asParagraph().editAsText().setAttributes(
                    srcCell.getChild(0).asParagraph().editAsText().getAttributes()
                  );
                } catch(cellErr) {}
              }
            }

          } else if (elType == DocumentApp.ElementType.LIST_ITEM) {
            var srcItem = element.asListItem();
            var listItem = msBody.appendListItem(srcItem.getText());
            listItem.setGlyphType(srcItem.getGlyphType());
            listItem.setNestingLevel(srcItem.getNestingLevel());
            listItem.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
            try {
              listItem.setAttributes(srcItem.getAttributes());
            } catch(liErr) {}
          }
        }
      } catch(e) {
        Logger.log("[MS] ⚠️ MS Doc error Q" + (i+1) + ": " + e.message);
        msBody.appendParagraph("⚠️ Error loading Q" + (i+1) + ": " + e.message);
      }
    }

    msDoc.saveAndClose();

    // Move the doc into the exam folder
    var msFile = DriveApp.getFileById(msDoc.getId());
    folder.addFile(msFile);
    DriveApp.getRootFolder().removeFile(msFile);

    Logger.log("[MS] ✅ Mark Scheme Google Doc created: " + msDoc.getId());
  } catch (e) {
    Logger.log("[MS] ❌ Mark Scheme build failed: " + e.message);
  }
}

// ==========================================
// ⚡ PHASE 2: BATCH PROCESS (SPEED MODE)
// ==========================================
function processClassBatch(ss, mainFolder, masterDeckFile) {
  syncStudentNames(ss);
  var namesSheet = ss.getSheetByName("Names");
  if (namesSheet.getLastRow() < 2) { Logger.log("❌ Names tab empty."); return; }
  
  var data = namesSheet.getRange(2, 1, namesSheet.getLastRow() - 1, 3).getValues();
  var generatedBlobs = []; 
  var batchFolder = getOrCreateFolder(mainFolder, "Class Batch");
  var qCodes = getRowDataClean(6); 

  // Calculate base time for accommodation comparisons
  var marksData = getRowDataClean(2);
  var baseTotalMarks = marksData.reduce(function(a, b) { return a + Number(b); }, 0);
  var baseMinutes = Math.ceil(baseTotalMarks * 12 / 11);

  // ⚡ PRE-FETCH ALL QR CODES IN ONE BATCH (instead of 1 HTTP call per slide per student)
  var validStudents = data.filter(function(row) { return row[0] && row[1]; });
  ss.toast("Pre-fetching " + (validStudents.length * qCodes.length) + " QR codes...", "Batching", -1);
  var qrRequests = [];
  var qrKeyMap = {};
  for (var vi = 0; vi < validStudents.length; vi++) {
    var sid = validStudents[vi][0].split('@')[0];
    for (var q = 0; q < qCodes.length; q++) {
      var payload = JSON.stringify({ s: sid, q: qCodes[q], e: testName });
      qrKeyMap[vi + "_" + q] = qrRequests.length;
      qrRequests.push({ url: "https://quickchart.io/qr?size=150&text=" + encodeURIComponent(payload), muteHttpExceptions: true });
    }
  }
  var qrResponses = qrRequests.length > 0 ? UrlFetchApp.fetchAll(qrRequests) : [];

  // Build QR blob lookup: qrBlobs[studentIdx][questionIdx]
  var qrBlobs = [];
  for (var vi = 0; vi < validStudents.length; vi++) {
    qrBlobs[vi] = [];
    for (var q = 0; q < qCodes.length; q++) {
      var resp = qrResponses[qrKeyMap[vi + "_" + q]];
      qrBlobs[vi][q] = (resp && resp.getResponseCode() === 200) ? resp.getBlob() : null;
    }
  }
  Logger.log("✅ QR batch fetched: " + qrRequests.length + " codes");

  // Create combined deck upfront — append slides inline during loop
  var combinedFile = masterDeckFile.makeCopy(testName + " [TEMP_ALL]", batchFolder);
  var combinedDeck = SlidesApp.openById(combinedFile.getId());
  var initSlides = combinedDeck.getSlides();
  for (var r = initSlides.length - 1; r >= 0; r--) { initSlides[r].remove(); }

  // Process each student
  var studentIdx = 0;
  for (var i = 0; i < data.length; i++) {
    var email = data[i][0];
    var name = data[i][1];
    var extraTimePct = data[i][2]; // Column C: extra time percentage (e.g. 25 for 25%)
    
    if (name && email) {
      ss.toast("Stamping: " + name + " (" + (studentIdx+1) + "/" + validStudents.length + ")", "Batching", -1);
      
      var tempFile = masterDeckFile.makeCopy(testName + " - " + name, batchFolder);
      var tempDeck = SlidesApp.openById(tempFile.getId());
      
      stampStudentData(tempDeck, name, email.split('@')[0], qCodes, qrBlobs[studentIdx]);

      // Apply extra time accommodation on cover slide if applicable
      if (extraTimePct && Number(extraTimePct) > 0) {
        // Sheets stores 10% as 0.1; if value < 1 treat as decimal, else as integer %
        var pct = Number(extraTimePct);
        var multiplier = (pct < 1) ? pct : pct / 100;
        var adjustedMinutes = Math.ceil(baseMinutes * (1 + multiplier));
        tempDeck.replaceAllText(baseMinutes + " minutes", adjustedMinutes + " minutes (including accommodations)");
      }

      // Append to combined deck BEFORE closing (avoids re-opening later)
      var studentSlides = tempDeck.getSlides();
      for (var si = 0; si < studentSlides.length; si++) {
        combinedDeck.appendSlide(studentSlides[si]);
      }

      tempDeck.saveAndClose();
      
      var pdfBlob = tempFile.getAs(MimeType.PDF);
      pdfBlob.setName(testName + " - " + name + ".pdf");
      batchFolder.createFile(pdfBlob); 
      generatedBlobs.push(pdfBlob);
      
      tempFile.setTrashed(true);
      studentIdx++;
    }
  }
  
  // ZIP individual PDFs
  if (generatedBlobs.length > 0) {
    try {
      var zipBlob = Utilities.zip(generatedBlobs, testName + " - Class Batch.zip");
      mainFolder.createFile(zipBlob);
      Logger.log("✅ ZIP created with " + generatedBlobs.length + " PDFs");
    } catch(e) {
      Logger.log("ZIP Error: " + e.message);
      ss.toast("ZIP failed (too large), but PDFs are saved.", "Warning");
    }
  }

  // Export combined "All Students" PDF (best-effort)
  try {
    ss.toast("Exporting combined PDF...", "Batching", -1);
    combinedDeck.saveAndClose();
    var allPdf = combinedFile.getAs(MimeType.PDF);
    allPdf.setName(testName + " - All Students.pdf");
    mainFolder.createFile(allPdf);
    combinedFile.setTrashed(true);
    Logger.log("✅ All Students PDF created");
  } catch(e) {
    Logger.log("⚠️ Combined PDF skipped: " + e.message);
    ss.toast("Individual PDFs + ZIP saved. Combined PDF skipped (time limit).", "Info", 5);
  }
}

// ==========================================
// 🖊️ STAMP ENGINE
// ==========================================
function stampStudentData(deck, name, studentId, qCodes, qrBlobArray) {
  var slides = deck.getSlides();
  var PAGE_HEIGHT = 842; PAGE_WIDTH = 595;
  var qrSize = 60; 
  var qrX = (PAGE_WIDTH - qrSize) / 2; 
  var qrY = PAGE_HEIGHT - qrSize - 30; 

  // Replace placeholder name on cover (set by master's updateCoverSlide)
  deck.replaceAllText("{StudentName}", name);
  
  for (var s = 1; s < slides.length; s++) {
    var qIndex = s - 1;
    var qrBlob = (qrBlobArray && qIndex < qrBlobArray.length) ? qrBlobArray[qIndex] : null;
    
    if (qrBlob) {
      try {
        var slide = slides[s];
        var img = slide.insertImage(qrBlob);
        img.setLeft(qrX).setTop(qrY).setWidth(qrSize).setHeight(qrSize);
        img.sendToBack(); // Push QR behind answer box border
      } catch(e) {
        Logger.log("QR Fail Slide " + s + ": " + e.message);
      }
    }
  }
}

// ==========================================
// 🖼️ RENDER ENGINE (MASTER)
// ==========================================
function renderSlideContent(slide, doc, qNum, isFirstPage, layoutCode, headerType) {
  var body = doc.getBody();
  var numChildren = body.getNumChildren();
  var PAGE_HEIGHT = 842; PAGE_WIDTH = 595;
  var MARGIN_TOP = 50; MARGIN_BOTTOM = 70; MARGIN_LEFT = 50; CONTENT_WIDTH = 500; 
  var currentY = MARGIN_TOP;

  var pageNumBox = slide.insertShape(SlidesApp.ShapeType.TEXT_BOX, 0, 25, PAGE_WIDTH, 20);
  pageNumBox.getText().setText("— " + qNum + " —").getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
  pageNumBox.getText().getTextStyle().setFontSize(10).setFontFamily("Arial");

  if (isFirstPage) {
    addTextShape(slide, "Section A", 14, true, "CENTER");
    var instruct = "Answer all questions. Answers must be written within the answer boxes provided. Working may be continued below the lines, if necessary.";
    addTextShapeWithBold(slide, instruct, 12, "all");
    currentY += 15; 
  }
  else if (headerType === "SECTION_B_START") {
    addTextShapeWithBold(slide, "Do not write solutions on this page.", 12, "not");
    currentY += 20;
    addTextShape(slide, "Section B", 14, true, "CENTER");
    var instB = "Answer all questions in the answer booklet provided. Please start each question on a new page.";
    addTextShapeWithBold(slide, instB, 12, "all");
    currentY += 15;
  }
  else if (headerType === "SECTION_B_CONTINUED") {
    addTextShapeWithBold(slide, "Do not write solutions on this page.", 12, "not");
    currentY += 25;
  }

  var needsBox = (layoutCode && layoutCode.toString().trim().toUpperCase() === "A1");
  var hasAddedNumber = false; 

  for (var i = 0; i < numChildren; i++) {
    var element = body.getChild(i);
    if (element.getType() == DocumentApp.ElementType.PARAGRAPH) {
      var p = element.asParagraph();
      var text = p.getText();
      var cleanText = text.trim();
      if (cleanText === "Section B" || cleanText.startsWith("Do not write solutions") || cleanText.startsWith("Answer all questions") || cleanText.includes("!@#")) continue; 

      if (cleanText.length > 0) {
        if (!hasAddedNumber) {
          text = qNum + ". " + text.replace(/^[\d#]+\.?\s*/, "");
          hasAddedNumber = true; 
        }
        var shape = slide.insertShape(SlidesApp.ShapeType.TEXT_BOX, MARGIN_LEFT, currentY, CONTENT_WIDTH, 20);
        shape.getText().setText(text).getTextStyle().setFontSize(11).setFontFamily("Arial").setForegroundColor("#000000");
        var lines = Math.ceil(text.length / 90) || 1;
        var h = Math.max(lines * 16, 20);
        shape.setHeight(h);
        currentY += h + 10; 
      }
      for (var k = 0; k < p.getNumChildren(); k++) {
        var child = p.getChild(k);
        if (child.getType() == DocumentApp.ElementType.INLINE_IMAGE) {
          var imgBlob = child.asInlineImage().getBlob();
          var slideImg = slide.insertImage(imgBlob);
          var w = child.asInlineImage().getWidth();
          var h = child.asInlineImage().getHeight();
          if (w > CONTENT_WIDTH) { h = h * (CONTENT_WIDTH / w); w = CONTENT_WIDTH; }
          slideImg.setLeft(MARGIN_LEFT).setTop(currentY).setWidth(w).setHeight(h);
          currentY += h + 10; 
        }
      }
    }
  }

  // DRAW ANSWER BOX + EXTERNAL FIDUCIALS
  var boxCoords = null;
  if (needsBox) {
    var footerBuffer = 90; 
    
    // 🔥 PADDING: Add 10px buffer above box so external markers don't hit text
    currentY += 10; 
    
    var boxH = (PAGE_HEIGHT - footerBuffer) - currentY;
    
    if (boxH > 40) {
      // 1. Draw the Main Box
      var box = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, MARGIN_LEFT, currentY, CONTENT_WIDTH, boxH);
      box.getFill().setTransparent();
      box.getBorder().setWeight(1).getLineFill().setSolidFill('#000000');
      
      // Record box coordinates (points and percentages)
      boxCoords = {
        x: MARGIN_LEFT,
        y: currentY,
        width: CONTENT_WIDTH,
        height: boxH,
        xPct: (MARGIN_LEFT / PAGE_WIDTH * 100),
        yPct: (currentY / PAGE_HEIGHT * 100),
        widthPct: (CONTENT_WIDTH / PAGE_WIDTH * 100),
        heightPct: (boxH / PAGE_HEIGHT * 100)
      };

      // 2. Draw Dotted Lines
      var lines = Math.min(Math.floor(boxH / 24), 12);
      for (var L = 1; L <= lines; L++) {
        var ly = currentY + (L * 24);
        var line = slide.insertLine(SlidesApp.LineCategory.STRAIGHT, MARGIN_LEFT+35, ly, MARGIN_LEFT+CONTENT_WIDTH-35, ly);
        line.getLineFill().setSolidFill('#999999');
        line.setDashStyle(SlidesApp.DashStyle.DOT).setWeight(1);
      }
      

    }
  }
  return boxCoords;

  function addTextShape(s, txt, size, bold, align) {
    var shape = s.insertShape(SlidesApp.ShapeType.TEXT_BOX, MARGIN_LEFT, currentY, CONTENT_WIDTH, size * 2);
    var r = shape.getText();
    r.setText(txt);
    r.getParagraphStyle().setParagraphAlignment(align === "CENTER" ? SlidesApp.ParagraphAlignment.CENTER : SlidesApp.ParagraphAlignment.START);
    r.getTextStyle().setFontSize(size).setFontFamily("Arial").setBold(bold);
    currentY += (size * 2.5);
  }
  function addTextShapeWithBold(s, txt, size, boldWord) {
    var shape = s.insertShape(SlidesApp.ShapeType.TEXT_BOX, MARGIN_LEFT, currentY, CONTENT_WIDTH, size * 2);
    var r = shape.getText();
    r.setText(txt);
    r.getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.START);
    r.getTextStyle().setFontSize(size).setFontFamily("Arial").setBold(false);
    var idx = txt.indexOf(boldWord);
    if (idx > -1) r.getRange(idx, idx + boldWord.length).getTextStyle().setBold(true);
    currentY += (size * 2);
  }
}

// ==========================================
// � BOX COORDINATE WRITER
// ==========================================
function writeBoxCoordinates(allBoxCoords) {
  try {
    var dbSS = SpreadsheetApp.openById(DATABASE_SS_ID);
    var sheet = dbSS.getSheetByName("BoxCoordinates");
    if (!sheet) {
      sheet = dbSS.insertSheet("BoxCoordinates");
      sheet.appendRow([
        "ExamName", "QuestionCode", "Position",
        "X_Pct", "Y_Pct", "Width_Pct", "Height_Pct",
        "X_Pts", "Y_Pts", "Width_Pts", "Height_Pts",
        "Timestamp"
      ]);
    }

    // Delete any existing rows for this exam (so re-runs update rather than duplicate)
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var examCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var r = examCol.length - 1; r >= 0; r--) {
        if (examCol[r][0] === testName) {
          sheet.deleteRow(r + 2);
        }
      }
    }

    var timestamp = new Date().toISOString();
    var rows = allBoxCoords.map(function(c) {
      return [
        testName,
        c.questionCode,
        c.position,
        Math.round(c.xPct * 100) / 100,
        Math.round(c.yPct * 100) / 100,
        Math.round(c.widthPct * 100) / 100,
        Math.round(c.heightPct * 100) / 100,
        Math.round(c.x * 100) / 100,
        Math.round(c.y * 100) / 100,
        Math.round(c.width * 100) / 100,
        Math.round(c.height * 100) / 100,
        timestamp
      ];
    });
    // Append rows (preserving other exams' data)
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log("[COORDS] Wrote " + rows.length + " box coordinates for exam: " + testName);
  } catch (e) {
    Logger.log("[COORDS] Failed to write box coordinates: " + e.message);
  }
}

// ==========================================
// �📂 HELPERS
// ==========================================
function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function fetchLayoutCodesFromDatabase() {
  var map = {};
  try {
    var dbSS = SpreadsheetApp.openById(DATABASE_SS_ID);
    var sheet = dbSS.getSheetByName("Sheet1") || dbSS.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var colB = data[i][1]; 
      var colF = data[i][5]; 
      if (colB && typeof colB === 'string' && colF) {
        var cleanKey = colB.trim();
        map[cleanKey] = colF; map[cleanKey + "a"] = colF; map[cleanKey + "b"] = colF;
      }
    }
  } catch (e) { Logger.log("DB Error: " + e.message); }
  return map;
}

function syncStudentNames(ss) {
  var namesSheet = ss.getSheetByName("Names");
  if (!namesSheet) { namesSheet = ss.insertSheet("Names"); }
  try {
    var sourceSS = SpreadsheetApp.openById(STUDENT_SOURCE_ID);
    var sourceSheet = sourceSS.getSheetByName("Students"); 
    if (sourceSheet) {
      var lastRow = sourceSheet.getLastRow();
      if (lastRow > 1) {
        var data = sourceSheet.getRange(1, 1, lastRow, 3).getValues();
        namesSheet.clear(); 
        namesSheet.getRange(1, 1, data.length, 3).setValues(data); 
      }
    }
  } catch(e) { Logger.log("Sync Error: " + e.message); }
}

function updateCoverSlide(deck, studentName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var marksData = getRowDataClean(2);
  var marks = marksData.reduce((a, b) => a + Number(b), 0);
  var minutes = Math.ceil(marks * 12 / 11);
  var pages = deck.getSlides().length;
  
  var ppqSheet = ss.getSheetByName("PPQselector") || ss.getActiveSheet();
  var rawDate = ppqSheet.getRange("I1").getValue();
  var timeStr = ppqSheet.getRange("J1").getDisplayValue(); 
  var dateStr = Utilities.formatDate(new Date(rawDate), ss.getSpreadsheetTimeZone(), "EEEE, MMMM dd, yyyy");

  deck.replaceAllText("{TestName}", testName);
  deck.replaceAllText("{Marks}", marks);
  deck.replaceAllText("{Time}", minutes + " minutes");
  deck.replaceAllText("{Duration}", minutes + " minutes");
  deck.replaceAllText("{PageCount}", pages + " pages");
  deck.replaceAllText("{Date}", dateStr);
  deck.replaceAllText("{StartTime}", timeStr);
  deck.replaceAllText("{Name}", ""); 
  deck.replaceAllText("{ID}", "");
  
  var longInstructions = "Full marks are not necessarily awarded for a correct answer with no working. Answers must be supported by working and/or explanations. Solutions found from a graphic display calculator should be supported by suitable working. For example, if graphs are used to find a solution, you should sketch these as part of your answer. Where an answer is incorrect, some marks may be given for a correct method, provided this is shown by written working. You are therefore advised to show all working.";
  deck.replaceAllText("{Instructions}", longInstructions);
  
  drawStudentHeader(deck.getSlides()[0], studentName || "{StudentName}");
}

function drawStudentHeader(slide, studentName) {
  var boxX = 360; var boxY = 175; var boxWidth = 200; var boxHeight = 25;
  var nameLabel = slide.insertShape(SlidesApp.ShapeType.TEXT_BOX, boxX, boxY, boxWidth, 15);
  nameLabel.getText().setText("Candidate Name").getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
  nameLabel.getText().getTextStyle().setFontSize(9).setFontFamily("Arial").setBold(true);
  var nameBox = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, boxX, boxY + 18, boxWidth, boxHeight);
  nameBox.getFill().setSolidFill('#FFFFFF');
  nameBox.getBorder().setWeight(1).getLineFill().setSolidFill('#000000');
  
  if (studentName) {
    var textShape = slide.insertShape(SlidesApp.ShapeType.TEXT_BOX, boxX, boxY + 18, boxWidth, boxHeight);
    var t = textShape.getText();
    t.setText(studentName);
    t.getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
    t.getTextStyle().setFontSize(11).setFontFamily("Arial").setBold(false);
  }
}