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
  ss.toast("Step 2/3: Exporting Master PDF...", "Working", -1);
  var masterPdf = masterDeckFile.getAs(MimeType.PDF);
  mainFolder.createFile(masterPdf).setName(testName + " [Master].pdf");
  
  // 3. Class Batch (Speed Mode)
  ss.toast("Step 3/3: Processing Class Batch...", "Working", -1);
  processClassBatch(ss, mainFolder, masterDeckFile);
  
  // 4. Cleanup
  masterDeckFile.setTrashed(true); 
  ss.toast("All tasks complete!", "Success", 5);
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

  // 🔥 FETCH FIDUCIAL MARKER ONCE
  var fiducialBlob = null;
  try {
    fiducialBlob = DriveApp.getFileById(FIDUCIAL_IMAGE_ID).getBlob();
  } catch(e) {
    Logger.log("⚠️ Error loading Fiducial Image: " + e.message);
  }

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

    renderSlideContent(slide, doc, i + 1, (i === 0), code, headerType, fiducialBlob);
  }
  
  updateCoverSlide(deck, null);
  deck.saveAndClose();
  return newFile;
}

// ==========================================
// ⚡ PHASE 2: BATCH PROCESS (SPEED MODE)
// ==========================================
function processClassBatch(ss, mainFolder, masterDeckFile) {
  syncStudentNames(ss);
  var namesSheet = ss.getSheetByName("Names");
  if (namesSheet.getLastRow() < 2) { Logger.log("❌ Names tab empty."); return; }
  
  var data = namesSheet.getRange(2, 1, namesSheet.getLastRow() - 1, 2).getValues();
  var generatedBlobs = []; 
  var batchFolder = getOrCreateFolder(mainFolder, "Class Batch");
  var qCodes = getRowDataClean(6); 

  for (var i = 0; i < data.length; i++) {
    var email = data[i][0];
    var name = data[i][1];
    
    if (name && email) {
      ss.toast("Stamping: " + name + " (" + (i+1) + "/" + data.length + ")", "Batching", -1);
      
      var tempFile = masterDeckFile.makeCopy(testName + " - " + name, batchFolder);
      var tempDeck = SlidesApp.openById(tempFile.getId());
      var studentId = email.split('@')[0];
      
      stampStudentData(tempDeck, name, studentId, qCodes);
      
      tempDeck.saveAndClose();
      
      var pdfBlob = tempFile.getAs(MimeType.PDF);
      pdfBlob.setName(testName + " - " + name + ".pdf");
      batchFolder.createFile(pdfBlob); 
      generatedBlobs.push(pdfBlob);    
      
      tempFile.setTrashed(true);
    }
  }
  
  if (generatedBlobs.length > 0) {
    try {
      var zipBlob = Utilities.zip(generatedBlobs, testName + " - Class Batch.zip");
      mainFolder.createFile(zipBlob);
    } catch(e) {
      Logger.log("ZIP Error: " + e.message);
      ss.toast("ZIP failed (too large), but PDFs are saved.", "Warning");
    }
  }
}

// ==========================================
// 🖊️ STAMP ENGINE
// ==========================================
function stampStudentData(deck, name, studentId, qCodes) {
  var slides = deck.getSlides();
  var PAGE_HEIGHT = 842; PAGE_WIDTH = 595;
  var qrSize = 60; 
  var qrX = (PAGE_WIDTH - qrSize) / 2; 
  var qrY = PAGE_HEIGHT - qrSize - 10; 

  drawStudentHeader(slides[0], name);
  
  for (var s = 1; s < slides.length; s++) {
    var slide = slides[s];
    var qIndex = s - 1;
    var currentQCode = (qIndex < qCodes.length) ? qCodes[qIndex] : "UNKNOWN_Q";
    
    try {
      var qrPayload = JSON.stringify({ 
        s: studentId, 
        q: currentQCode,
        e: testName
      });
      var qrUrl = "https://quickchart.io/qr?size=150&text=" + encodeURIComponent(qrPayload);
      var resp = UrlFetchApp.fetch(qrUrl);
      
      if (resp.getResponseCode() === 200) {
        var qrBlob = resp.getBlob();
        var img = slide.insertImage(qrBlob);
        img.setLeft(qrX).setTop(qrY).setWidth(qrSize).setHeight(qrSize);
        
        // Z-Order: Transparent Box on Top
        var shapes = slide.getShapes();
        for (var k = 0; k < shapes.length; k++) {
          var shape = shapes[k];
          if (shape.getShapeType() == SlidesApp.ShapeType.RECTANGLE && shape.getHeight() > 40) {
            shape.getFill().setTransparent();
            shape.bringToFront();
          }
        }
      }
    } catch(e) {
      Logger.log("QR Fail Slide " + s + ": " + e.message);
    }
  }
}

// ==========================================
// 🖼️ RENDER ENGINE (MASTER)
// ==========================================
function renderSlideContent(slide, doc, qNum, isFirstPage, layoutCode, headerType, fiducialBlob) {
  var body = doc.getBody();
  var numChildren = body.getNumChildren();
  var PAGE_HEIGHT = 842; PAGE_WIDTH = 595;
  var MARGIN_TOP = 40; MARGIN_BOTTOM = 50; MARGIN_LEFT = 50; CONTENT_WIDTH = 500; 
  var currentY = MARGIN_TOP;

  var pageNumBox = slide.insertShape(SlidesApp.ShapeType.TEXT_BOX, 0, 15, PAGE_WIDTH, 20);
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
  if (needsBox) {
    var footerBuffer = 70; 
    
    // 🔥 PADDING: Add 10px buffer above box so external markers don't hit text
    currentY += 10; 
    
    var boxH = (PAGE_HEIGHT - footerBuffer) - currentY;
    
    if (boxH > 40) {
      // 1. Draw the Main Box
      var box = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, MARGIN_LEFT, currentY, CONTENT_WIDTH, boxH);
      box.getFill().setTransparent();
      box.getBorder().setWeight(1).getLineFill().setSolidFill('#000000');
      
      // 2. Draw Dotted Lines
      var lines = Math.min(Math.floor(boxH / 24), 12);
      for (var L = 1; L <= lines; L++) {
        var ly = currentY + (L * 24);
        var line = slide.insertLine(SlidesApp.LineCategory.STRAIGHT, MARGIN_LEFT+35, ly, MARGIN_LEFT+CONTENT_WIDTH-35, ly);
        line.getLineFill().setSolidFill('#999999');
        line.setDashStyle(SlidesApp.DashStyle.DOT).setWeight(1);
      }
      
      // 3. 🔥 INSERT EXTERNAL FIDUCIAL MARKERS
      if (fiducialBlob) {
        var fSize = 6; // Tiny 6pt size
        var gap = 2;   // 2pt gap from corner
        
        // Coordinates: Diagonally Outside
        var corners = [
          // Top-Left: Left & Up
          { x: MARGIN_LEFT - fSize - gap, y: currentY - fSize - gap },
          
          // Top-Right: Right & Up
          { x: MARGIN_LEFT + CONTENT_WIDTH + gap, y: currentY - fSize - gap },
          
          // Bottom-Left: Left & Down
          { x: MARGIN_LEFT - fSize - gap, y: currentY + boxH + gap },
          
          // Bottom-Right: Right & Down
          { x: MARGIN_LEFT + CONTENT_WIDTH + gap, y: currentY + boxH + gap }
        ];
        
        corners.forEach(function(pos) {
          var img = slide.insertImage(fiducialBlob);
          img.setLeft(pos.x).setTop(pos.y).setWidth(fSize).setHeight(fSize);
          // Note: Since they are outside, Z-order matters less, but we leave it default
        });
      }
    }
  }

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
// 📂 HELPERS
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
        var data = sourceSheet.getRange(1, 1, lastRow, 2).getValues();
        namesSheet.clear(); 
        namesSheet.getRange(1, 1, data.length, 2).setValues(data); 
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
  var dateStr = Utilities.formatDate(new Date(rawDate), "GMT-5", "EEEE, MMMM dd, yyyy");

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
  
  drawStudentHeader(deck.getSlides()[0], studentName);
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