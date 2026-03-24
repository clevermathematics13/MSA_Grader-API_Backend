// PURPOSE: Populates PPQselector when questions are checked in HL/SL List.
// The onEdit trigger fires when a checkbox is set to TRUE on "HL list" or "SL list",
// reads the question code via zone logic (merged cells in row 4), and writes
// code, marks, parts, and syllabus data into the next available PPQselector column.

// CONFIGURATION
var SYLLABUS_OFFSET = 1;
var MARKS_OFFSET = -1;

function onEdit(e) {
  var range = e.range;
  var curSheet = range.getSheet();
  var sheetName = curSheet.getName();

  if (sheetName !== 'HL list' && sheetName !== 'SL list') { return; }

  if (e.value == "TRUE" || e.value === true) {
    var clickCol = range.getColumn();
    var clickRow = range.getRow();

    try {
      // 1. Zone Logic — detect merged cells in row 4 to find the code column
      var inZone = curSheet.getRange(4, clickCol);
      var mergedRanges = inZone.getMergedRanges();
      var codeCol;

      if (mergedRanges.length == 0) {
        codeCol = clickCol + 1;
      } else {
        var zoneCell = mergedRanges[0].getCell(1, 1);
        codeCol = zoneCell.getColumn() + 1;
      }

      var codingCell = curSheet.getRange(clickRow, codeCol);
      var code = codingCell.getValue();

      // 2. Setup PPQselector Column
      var prevColIt = Number(ppqSelector.getRange(1, 2).getValue());
      var targetCol = prevColIt + 1;
      ppqSelector.getRange(1, 2).setValue(targetCol);
      ppqSelector.getRange(6, targetCol).setValue(code);

      // 3. Run the optimized list processor
      processQuestionParts(curSheet, clickRow, codeCol, targetCol, codingCell.getValue());

    } catch (error) {
      Logger.log("Error in onEdit: " + error.message);
    }
  }
}

function processQuestionParts(sourceSheet, startRow, codeCol, targetCol, fullCode) {
  var codeStripParts = fullCode;
  var codePartsEnd = fullCode.slice(-1);
  while (isNaN(parseFloat(codePartsEnd)) && !isFinite(codePartsEnd)) {
    codeStripParts = codeStripParts.slice(0, -1);
    codePartsEnd = codeStripParts.slice(-1);
  }
  var coreCode = codeStripParts;

  // Batch Read (20 rows): [marks, code, syllabus]
  var searchRange = sourceSheet.getRange(startRow, codeCol - 1, 20, 3).getValues();

  var partsData = [];
  var syllabusData = [];
  var marksData = [];
  var totalMarks = 0;

  for (var i = 0; i < searchRange.length; i++) {
    var rowData = searchRange[i];
    var currentCode = rowData[1].toString();

    if (!currentCode.includes(coreCode)) {
      break;
    }

    partsData.push([currentCode]);

    var mVal = rowData[0];
    marksData.push([mVal]);
    if (typeof mVal === 'number') {
      totalMarks += mVal;
    }

    syllabusData.push([rowData[2]]);
  }

  // Batch Write to PPQselector
  if (partsData.length > 0) {
    ppqSelector.getRange(9, targetCol, partsData.length, 1).setValues(partsData);
    ppqSelector.getRange(17, targetCol, syllabusData.length, 1).setValues(syllabusData);
    ppqSelector.getRange(25, targetCol, marksData.length, 1).setValues(marksData);
    ppqSelector.getRange(2, targetCol).setValue(totalMarks);
  }
}
