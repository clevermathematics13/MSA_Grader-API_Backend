/**
 * 📦 EXAM ARCHIVER (Final: Blue Links Added)
 * - Row 1: F1 -> A1 (Minutes), G1 -> B1.
 * - Row 2: F2 -> A2 (Marks), Full copy across.
 * - Row 3: A30 -> A3, G3 -> B3 (conditional).
 * - Body: Scans Src Rows 6-40.
 * - Styling: 
 * - Global: White, Size 10, Black, No borders.
 * - Center Align: B2:End.
 * - Blue Text: B5:End6 (Question Codes/IDs).
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
  
  // Row 1 (F1 -> A1, G1 -> B1)
  var row1 = [createCell(srcValues[0][0], srcRichText[0][0])]; 
  row1.push(createCell(labelG1, null)); 
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

  // Body (Src 6+)
  for (var i = 5; i < scanRows; i++) { // i=5 is Row 6
    var rowVals = srcValues[i];
    var rowRich = srcRichText[i];

    var hasData = rowVals.some(function(c) { return c !== "" && c !== null; });
    var isHeader = (i <= 8); 
    
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

  // 4. Bold Headers (Col A, Rows 4-7)
  destSheet.getRange(4, 1, 4, 1).setFontWeight("bold");

  // 5. 🔵 NEW: Blue Text for Rows 5 & 6 (B5:End6)
  if (validWidth > 1) {
    destSheet.getRange(5, 2, 2, validWidth - 1).setFontColor("#1155CC");
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
  var endStyleRow = (syllabusRow > 0) ? (syllabusRow - 1) : 7;
  var rowsToStyle = endStyleRow - 8 + 1; 

  if (rowsToStyle > 0 && validWidth > 1) {
    var partsRange = destSheet.getRange(8, 2, rowsToStyle, validWidth - 1);
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
