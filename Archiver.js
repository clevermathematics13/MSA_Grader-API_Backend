/**
 * 📦 EXAM ARCHIVER (Final: Blue Links Added)
 * - Row 1: F1 -> A1 (Minutes), G1 -> B1, I1 -> C1 (Date), J1 -> D1 (Time).
 * - Row 2: F2 -> A2 (Marks), Full copy across.
 * - Row 3: A30 -> A3, G3 -> B3 (conditional).
 * - Body: Scans Src Rows 5-40 (includes stripped codes in row 5).
 * - Styling: 
 * - Global: White, Size 10, Black, No borders.
 * - Center Align: B2:End.
 * - Blue Text: B5:End7 (Stripped Codes/Question Codes/IDs).
 * - Pink Buffer: A:L.
 */
function archiveCurrentExam() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var srcSheet = ss.getSheetByName("PPQselector");
  var destSheet = ss.getSheetByName("archive");

  if (!srcSheet || !destSheet) {
    SpreadsheetApp.getUi().alert("❌ Error: Sheets not found.");
    return;
  }

  // --- CONFIGURATION ---
  var startCol = 6; // Column F (Data starts here)
  var scanWidth = 20; // Scan F to Y
  var scanRows = 40; // Scan down to row 40
  var pinkLimit = 12; // Buffer width (A:L)
  
  // 1. Calculate Exact Data Width
  var maxSheetCol = srcSheet.getLastColumn();
  var checkRange = srcSheet.getRange(6, startCol, 1, maxSheetCol - startCol + 1).getValues()[0];
  var validWidth = 0;
  
  for (var c = 0; c < checkRange.length; c++) {
    if (checkRange[c] !== "" && checkRange[c] !== null) {
      validWidth++;
    } else {
      break; 
    }
  }
  if (validWidth === 0) validWidth = 10;

  // 2. Fetch Source Data
  var range = srcSheet.getRange(1, startCol, scanRows, validWidth);
  var srcValues = range.getValues(); 
  var srcRichText = range.getRichTextValues(); 
  
  var labelG1 = srcSheet.getRange("G1").getValue();
  var labelI1 = srcSheet.getRange("I1").getValue();
  var labelJ1 = srcSheet.getRange("J1").getValue();
  var labelA30 = srcSheet.getRange("A30").getValue();
  
  var archiveRows = [];

  // Helper
  function createCell(val, richVal) {
    if (richVal && richVal.getLinkUrl && richVal.getLinkUrl()) {
      return richVal; 
    }
    var str = (val === null || val === undefined) ? "" : String(val);
    return SpreadsheetApp.newRichTextValue().setText(str).build();
  }

  // ==========================================
  // PHASE 1: BUILD ARCHIVE ROWS
  // ==========================================
  
  // Row 1 (F1 -> A1, G1 -> B1, I1 -> C1, J1 -> D1)
  var row1 = [createCell(srcValues[0][0], srcRichText[0][0])]; 
  row1.push(createCell(labelG1, null)); 
  row1.push(createCell(labelI1, null)); 
  row1.push(createCell(labelJ1, null)); 
  archiveRows.push(row1); 
  
  // Row 2 (Full Width)
  var row2 = [];
  for (var c = 0; c < validWidth; c++) {
    row2.push(createCell(srcValues[1][c], srcRichText[1][c]));
  }
  archiveRows.push(row2);
  
  // Row 3 (A30 -> A3, Copy G3 if G2 has data)
  var row3 = [];
  row3.push(createCell(labelA30, null));
  for (var c = 1; c < validWidth; c++) {
    var checkVal = srcValues[1][c]; 
    if (checkVal !== "" && checkVal !== null) {
      row3.push(createCell(srcValues[2][c], srcRichText[2][c])); 
    } else {
      row3.push(createCell("", null)); 
    }
  }
  archiveRows.push(row3); 

  // Body (Src 5+, includes stripped codes row)
  for (var i = 4; i < scanRows; i++) { // i=4 is Row 5 (stripped codes)
    var rowVals = srcValues[i];
    var rowRich = srcRichText[i];

    var hasData = rowVals.some(function(c) { return c !== "" && c !== null; });
    var isHeader = (i <= 9); 
    
    if (isHeader || hasData) {
      var newRow = [];
      for (var k = 0; k < validWidth; k++) {
        newRow.push(createCell(rowVals[k], rowRich[k]));
      }
      archiveRows.push(newRow);
    }
  }

  // ==========================================
  // PHASE 2: WRITE TO ARCHIVE
  // ==========================================

  // 1. Insert Space
  var totalRows = archiveRows.length + 1; 
  destSheet.insertRowsBefore(1, totalRows);

  // 2. Pad & Paste
  for (var i = 0; i < archiveRows.length; i++) {
    while (archiveRows[i].length < validWidth) {
      archiveRows[i].push(SpreadsheetApp.newRichTextValue().setText("").build());
    }
  }

  if (archiveRows.length > 0) {
    var destRange = destSheet.getRange(1, 1, archiveRows.length, validWidth);
    destRange.setRichTextValues(archiveRows);
  }

  // 3. Style Block (Global)
  var fullBlock = destSheet.getRange(1, 1, totalRows, destSheet.getLastColumn());
  fullBlock.setBackground("white");
  fullBlock.setBorder(false, false, false, false, false, false);
  fullBlock.setFontSize(10);
  fullBlock.setFontColor("black");
  fullBlock.setVerticalAlignment("middle");
  fullBlock.setFontWeight("normal");

  // 4. Bold Headers (Col A, Rows 4-8)
  destSheet.getRange(4, 1, 5, 1).setFontWeight("bold");

  // 5. 🔵 Blue Text for Rows 5, 6 & 7 (B5:End7 — stripped codes, question codes, doc IDs)
  if (validWidth > 1) {
    destSheet.getRange(5, 2, 3, validWidth - 1).setFontColor("#1155CC");
  }

  // 6. Dynamic Styling (Size 8 for Parts)
  var colAVals = destSheet.getRange(1, 1, totalRows, 1).getValues().flat();
  var syllabusRow = -1;
  for (var r = 0; r < colAVals.length; r++) {
    if (String(colAVals[r]).toLowerCase().includes("syllabus")) {
      syllabusRow = r + 1; 
      break;
    }
  }
  var endStyleRow = (syllabusRow > 0) ? (syllabusRow - 1) : 8;
  var rowsToStyle = endStyleRow - 9 + 1; 

  if (rowsToStyle > 0 && validWidth > 1) {
    var partsRange = destSheet.getRange(9, 2, rowsToStyle, validWidth - 1);
    partsRange.setFontSize(8);
    partsRange.setFontWeight("normal");
  }

  // 7. ↔️ Center Align (B2 to End)
  if (validWidth > 1) {
    destSheet.getRange(2, 2, totalRows - 1, validWidth - 1)
             .setHorizontalAlignment("center");
  }

  // 8. Pink Buffer Row
  var sepRow = totalRows;
  var pinkRange = destSheet.getRange(sepRow, 1, 1, pinkLimit); 
  pinkRange.setBackground("#F4CCCC");
  pinkRange.clearContent();

  // 9. FINAL STEP: A1/A2 Values
  var cellA1 = destSheet.getRange("A1");
  var cellA2 = destSheet.getRange("A2");
  var valA1 = cellA1.getValue();
  var valA2 = cellA2.getValue();
  
  if (typeof valA1 === 'number') {
    cellA1.setValue(Math.ceil(valA1) + " minutes");
  }
  if (typeof valA2 === 'number') {
    cellA2.setValue(Math.round(valA2) + " marks");
  }
  
  // Format as Integer
  destSheet.getRange("A1:A2").setNumberFormat("0");

  SpreadsheetApp.getActiveSpreadsheet().toast("Archived: Blue links applied.", "✅ Done");
}

/**
 * 📥 RESTORE ARCHIVED EXAM
 * Reads the exam code from PPQselector G1, finds the matching block
 * in the archive sheet, and repopulates all exam data back into
 * PPQselector. The archive data is NOT removed.
 *
 * Archive block layout (per archiveCurrentExam):
 *   Row 1: A=duration, B=exam code, C=date (I1), D=time (J1)
 *   Row 2: marks per question (full width)
 *   Row 3: A30 label / conditional data
 *   Rows 4+: body (row 5 stripped codes, row 6 Q codes, row 7 doc IDs,
 *             row 8 MS doc IDs, rows 9+ parts, 17+ syllabus, 25+ marks)
 *   Pink separator row (#F4CCCC) at the end of each block
 */
function restoreArchivedExam() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var ppq = ss.getSheetByName("PPQselector");
  var archive = ss.getSheetByName("archive");

  if (!ppq || !archive) {
    ui.alert("❌ Error: PPQselector or archive sheet not found.");
    return;
  }

  // 1. Read search code from G1
  var searchCode = String(ppq.getRange("G1").getValue()).trim();
  if (!searchCode) {
    ui.alert("❌ No exam code found in PPQselector G1.\nEnter an exam code first.");
    return;
  }

  // 2. Fail if PPQselector already has exam data (check row 6, col F onward)
  var lastCol = ppq.getLastColumn();
  if (lastCol >= 6) {
    var existingData = ppq.getRange(6, 6, 1, lastCol - 5).getValues()[0];
    var hasData = existingData.some(function(c) { return c !== "" && c !== null; });
    if (hasData) {
      ui.alert("❌ PPQselector already has exam data.\nClear the workspace first (🧹 Clear Workspace).");
      return;
    }
  }

  // 3. Find the matching archive block
  var archiveLastRow = archive.getLastRow();
  var archiveLastCol = archive.getLastColumn();
  if (archiveLastRow === 0 || archiveLastCol === 0) {
    ui.alert("❌ Archive sheet is empty.");
    return;
  }

  // Read all backgrounds in column A to find pink separator rows
  var bgColors = archive.getRange(1, 1, archiveLastRow, 1).getBackgrounds().flat();
  var pinkRows = [];
  for (var r = 0; r < bgColors.length; r++) {
    if (bgColors[r].toUpperCase() === "#F4CCCC") {
      pinkRows.push(r + 1); // 1-indexed
    }
  }

  // Build block ranges: [startRow, endRow] for each block
  var blocks = [];
  var blockStart = 1;
  for (var p = 0; p < pinkRows.length; p++) {
    var blockEnd = pinkRows[p] - 1;
    if (blockEnd >= blockStart) {
      blocks.push([blockStart, blockEnd]);
    }
    blockStart = pinkRows[p] + 1;
  }
  // Handle trailing block (after last pink row, if any)
  if (blockStart <= archiveLastRow) {
    blocks.push([blockStart, archiveLastRow]);
  }

  // Search each block for matching exam code in B1
  var matchedBlock = null;
  for (var b = 0; b < blocks.length; b++) {
    var codeVal = String(archive.getRange(blocks[b][0], 2).getValue()).trim();
    if (codeVal.toLowerCase() === searchCode.toLowerCase()) {
      matchedBlock = blocks[b];
      break;
    }
  }

  if (!matchedBlock) {
    ui.alert("❌ Exam code \"" + searchCode + "\" not found in archive.");
    return;
  }

  // 4. Read the matched block
  var blockStartRow = matchedBlock[0];
  var blockEndRow = matchedBlock[1];
  var blockHeight = blockEndRow - blockStartRow + 1;
  var blockWidth = archiveLastCol;

  var blockValues = archive.getRange(blockStartRow, 1, blockHeight, blockWidth).getValues();
  var blockRichText = archive.getRange(blockStartRow, 1, blockHeight, blockWidth).getRichTextValues();

  // 5. Parse archive row 1 → metadata
  var durationVal = blockValues[0][0]; // A1 = duration
  // C1 = date (I1), D1 = time (J1) — may be blank in old archives
  var dateVal = blockValues[0].length > 2 ? blockValues[0][2] : "";
  var timeVal = blockValues[0].length > 3 ? blockValues[0][3] : "";

  // Parse duration: strip " minutes" suffix if present
  var durationNum = durationVal;
  if (typeof durationVal === "string") {
    var parsed = parseInt(durationVal, 10);
    if (!isNaN(parsed)) durationNum = parsed;
  }

  // Write duration to F1
  ppq.getRange("F1").setValue(durationNum);

  // Write date/time to I1, J1 (only if non-empty)
  if (dateVal !== "" && dateVal !== null) {
    ppq.getRange("I1").setValue(dateVal);
  }
  if (timeVal !== "" && timeVal !== null) {
    ppq.getRange("J1").setValue(timeVal);
  }

  // 6. Parse archive row 2 → marks (write to PPQ row 2, starting at col F)
  var marksRow = blockValues[1];
  var marksRich = blockRichText[1];
  // Determine data width from marks row (skip col A which is total marks label)
  var dataWidth = 0;
  for (var c = 1; c < marksRow.length; c++) {
    if (marksRow[c] !== "" && marksRow[c] !== null) {
      dataWidth = c + 1;
    }
  }
  if (dataWidth < 2) dataWidth = 2; // at least col A + B

  // Write marks: archive cols B onward → PPQ cols G onward (F=startCol, B=archive col 2)
  // Archive row 2: col A = total marks or label, cols B+ = per-question marks
  // PPQ row 2: col F = first data col (matches archive col A), cols G+ = per-question
  if (dataWidth > 0) {
    var marksRichOut = [];
    var rowOut = [];
    for (var c = 0; c < dataWidth; c++) {
      rowOut.push(marksRich[c] || SpreadsheetApp.newRichTextValue().setText(String(marksRow[c] || "")).build());
    }
    marksRichOut.push(rowOut);
    ppq.getRange(2, 6, 1, dataWidth).setRichTextValues(marksRichOut);
  }

  // 7. Skip archive row 3 (Row 3 in PPQ never changes)

  // 8. Parse body rows (archive rows 4+) → PPQ rows 5+
  // Body rows map: archive body row 1 → PPQ row 5, body row 2 → PPQ row 6, etc.
  var bodyStartIndex = 3; // 0-indexed: row 4 of block
  var bodyValues = [];
  var bodyRichText = [];
  for (var i = bodyStartIndex; i < blockHeight; i++) {
    bodyValues.push(blockValues[i]);
    bodyRichText.push(blockRichText[i]);
  }

  // Determine if this is an old-format archive (no row 5 stripped codes)
  // New format: body row 1 = stripped codes (row 5), body row 2 = full question codes (row 6)
  // Old format: body row 1 = full question codes (row 6) directly
  // Heuristic: in new format, stripped codes are shorter versions of full codes
  var isOldFormat = false;
  if (bodyValues.length >= 2) {
    // Compare body row 1 vs body row 2 — if row 1 looks like full codes
    // (contains trailing letter suffixes) and row 2 is different, it's new format.
    // If body row 1 and row 2 are the same type, check if body row 1 has
    // non-numeric trailing chars stripped vs body row 2.
    var sample1 = "";
    var sample2 = "";
    for (var c = 1; c < bodyValues[0].length; c++) {
      if (bodyValues[0][c] !== "" && bodyValues[0][c] !== null) { sample1 = String(bodyValues[0][c]); break; }
    }
    for (var c = 1; c < bodyValues[1].length; c++) {
      if (bodyValues[1][c] !== "" && bodyValues[1][c] !== null) { sample2 = String(bodyValues[1][c]); break; }
    }
    
    if (sample1 && sample2) {
      // If the first body row sample ends with a non-numeric character (like 'a','b'),
      // it's a full code = old format (body starts with row 6, no row 5)
      var lastChar = sample1.slice(-1);
      if (isNaN(parseFloat(lastChar))) {
        isOldFormat = true;
      }
    } else if (sample1 && !sample2) {
      // Only one row of code-like data — could be old format with single-part questions
      // Check if it looks like a full code
      var lastChar = sample1.slice(-1);
      if (isNaN(parseFloat(lastChar))) {
        isOldFormat = true;
      }
    }
  }

  if (isOldFormat) {
    // Old format: body starts at PPQ row 6 (skip row 5, then generate it)
    var ppqWriteStartRow = 6;
    
    // Write body to PPQ (row 6 onward)
    if (bodyValues.length > 0) {
      var richOut = [];
      for (var i = 0; i < bodyValues.length; i++) {
        var rowOut = [];
        for (var c = 0; c < dataWidth; c++) {
          rowOut.push(bodyRichText[i][c] || SpreadsheetApp.newRichTextValue().setText(String(bodyValues[i][c] || "")).build());
        }
        richOut.push(rowOut);
      }
      ppq.getRange(ppqWriteStartRow, 6, richOut.length, dataWidth).setRichTextValues(richOut);
    }

    // Generate row 5 (stripped codes) from row 6 data
    var row6Data = ppq.getRange(6, 7, 1, dataWidth - 1).getValues()[0];
    var row5Values = [];
    for (var c = 0; c < row6Data.length; c++) {
      var code = String(row6Data[c]);
      if (code && code !== "" && code !== "undefined") {
        // Strip trailing non-numeric characters (same logic as returnFileID)
        var stripped = code;
        var cEnd = stripped.slice(-1);
        while (isNaN(parseFloat(cEnd)) && !isFinite(cEnd) && stripped.length > 0) {
          stripped = stripped.slice(0, -1);
          cEnd = stripped.slice(-1);
        }
        row5Values.push([stripped]);
      } else {
        row5Values.push([""]);
      }
    }
    if (row5Values.length > 0) {
      ppq.getRange(5, 7, 1, row5Values.length).setValues([row5Values.map(function(r) { return r[0]; })]);
    }
  } else {
    // New format: body starts at PPQ row 5
    var ppqWriteStartRow = 5;
    
    if (bodyValues.length > 0) {
      var richOut = [];
      for (var i = 0; i < bodyValues.length; i++) {
        var rowOut = [];
        for (var c = 0; c < dataWidth; c++) {
          rowOut.push(bodyRichText[i][c] || SpreadsheetApp.newRichTextValue().setText(String(bodyValues[i][c] || "")).build());
        }
        richOut.push(rowOut);
      }
      ppq.getRange(ppqWriteStartRow, 6, richOut.length, dataWidth).setRichTextValues(richOut);
    }
  }

  // 9. Set B1 (column counter) to the last populated column in row 6
  var row6Check = ppq.getRange(6, 6, 1, Math.max(1, ppq.getLastColumn() - 5)).getValues()[0];
  var lastDataCol = 5; // default to col E (before F)
  for (var c = row6Check.length - 1; c >= 0; c--) {
    if (row6Check[c] !== "" && row6Check[c] !== null) {
      lastDataCol = c + 6; // convert back to 1-indexed column
      break;
    }
  }
  ppq.getRange(1, 2).setValue(lastDataCol); // B1 = column counter

  SpreadsheetApp.getActiveSpreadsheet().toast("Restored exam: " + searchCode, "✅ Done");
}
