/********************************
 * Launcher.js
 * Simple launcher to open the UI from the standalone script
 ********************************/

/**
 * Run this function to launch the Exam Management UI
 * No spreadsheet needed - opens directly
 */
function launchExamUI() {
  const html = HtmlService.createHtmlOutputFromFile('ExamUI')
    .setWidth(1400)
    .setHeight(900);
  
  // Try to find an open spreadsheet, or create a temporary one
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    // Create a temporary spreadsheet if none is open
    const ss = SpreadsheetApp.create('Exam System Launcher');
    const url = ss.getUrl();
    
    // Add instructions to the sheet
    const sheet = ss.getSheets()[0];
    sheet.getRange('A1').setValue('✅ Exam System is ready to use!');
    sheet.getRange('A2').setValue('Run launchExamUI() again from the Apps Script editor to open the interface.');
    sheet.getRange('A3').setValue('You can bookmark this sheet and use it as your control panel.');
    
    // Open the sheet in browser so user can run from there
    Logger.log('Created control sheet. Opening in browser...');
    Logger.log('Sheet URL: ' + url);
    Logger.log('Please open the sheet and run Extensions > Apps Script, then run launchExamUI() again.');
    
    return 'Control sheet created. Please open it: ' + url;
  }
  
  ui.showModalDialog(html, 'Exam Management System');
}

/**
 * Same for MSA Validation UI
 */
function launchMSAUI() {
  const html = HtmlService.createHtmlOutputFromFile('Index')
    .setWidth(1200)
    .setHeight(800);
  
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    const ss = SpreadsheetApp.create('MSA Validation Launcher');
    const url = ss.getUrl();
    
    const sheet = ss.getSheets()[0];
    sheet.getRange('A1').setValue('✅ MSA Validation is ready to use!');
    sheet.getRange('A2').setValue('Run launchMSAUI() again from the Apps Script editor to open the interface.');
    
    Logger.log('Created control sheet: ' + url);
    return 'Control sheet created. Please open it: ' + url;
  }
  
  ui.showModalDialog(html, 'MSA Validation & Repair');
}
