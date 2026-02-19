/*******************
 * MSA_Preview.js
 * 
 * Generates self-contained HTML files for previewing:
 * 1. markscheme_preview.html: A layout-focused view from raw OCR.
 * 2. markscheme_structured_preview.html: A data-focused view from parsed points.
 *******************/

/**
 * Builds the original preview HTML that attempts to replicate the visual layout from OCR text.
 * @param {string} title The title of the source document.
 * @param {string} docId The ID of the source document.
 * @param {Array<Object>} ocrPages The array of OCR page objects from Mathpix.
 * @returns {string} A string containing the full HTML for the preview file.
 */
function msaBuildPreviewHtml_(title, docId, ocrPages) {
  const content = ocrPages.map(p => {
    let renderableContent = p.latex_styled || p.text || '';
    const sanitized = _sanitizeForMathJax_(renderableContent);
    return _buildStructuredHtmlFromText_(sanitized);
  }).join('<hr style="border-top: 1px dashed #ccc;">');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Preview: ${title}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>
    MathJax = {
      tex: {
        inlineMath: [['\\\\(', '\\\\)']],
        displayMath: [['\\\\[', '\\\\]']],
        processEscapes: true
      },
      svg: { fontCache: 'global', displayAlign: 'left', displayIndent: '2em' }
    };
  </script>
  <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f0f0f0; display: flex; justify-content: center; }
    .page-container { background-color: #fff; padding: 40px; margin: 20px; max-width: 950px; width: 100%; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
    hr { margin: 2em 0; }
    .row { display: grid; grid-template-columns: 40px 1fr 90px; column-gap: 18px; align-items: start; margin: 8px 0; }
    .row--new-part { margin-top: 1.8em; }
    .primary-part-label { text-align: left; }
    .main { font-size: 15px; }
    .secondary-part-label { display: inline-block; width: 45px; }
    .mark { text-align: right; white-space: nowrap; color: #333; }
    .mark .paren { font-style: italic; }
    .mark .plain { font-style: normal; }
    .row--heading .main { font-weight: 700; margin-top: 1em; }
    .row--displaymath .mark { align-self: center; }
    .row--equalsline .main { padding-left: 2.2em; }
    .note-box { border: 1px solid #333; padding: 10px 12px; margin: 10px 0 12px 0; font-size: 0.95em; }
    mjx-container[display="true"] { margin: 0.3em 0 !important; }
  </style>
</head>
<body>
  <div class="page-container">
    <h3>${title}</h3>
    <hr>
    ${content}
  </div>
</body>
</html>`;
  return html.trim();
}

/**
 * Builds a structured HTML preview that explicitly links requirements to marks.
 * This renders the final 'points' data directly.
 * @param {string} title The title of the source document.
 * @param {string} docId The ID of the source document.
 * @param {Array<Object>} points The array of structured point objects from the atomizer.
 * @returns {string} A string containing the full HTML for the structured preview file.
 */
function msaBuildStructuredPreviewHtml_(title, docId, points) {
  const content = _buildStructuredHtmlFromPoints_(points);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Structured Preview: ${title}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>
    MathJax = {
      tex: {
        inlineMath: [['\\\\(', '\\\\)']],
        displayMath: [['\\\\[', '\\\\]']],
        processEscapes: true
      },
      svg: { fontCache: 'global', displayAlign: 'left', displayIndent: '2em' }
    };
  </script>
  <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f0f0f0; display: flex; justify-content: center; }
    .page-container { background-color: #fff; padding: 40px; margin: 20px; max-width: 950px; width: 100%; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
    .point-row { display: grid; grid-template-columns: 120px 1fr 100px; gap: 15px; padding: 12px 5px; border-bottom: 1px solid #eee; align-items: start; }
    .point-row:first-child { border-top: 1px solid #eee; }
    .branch-label { font-style: italic; color: #888; margin-top: 5px; }
    .requirement { white-space: pre-wrap; }
    .mark { font-weight: bold; font-family: monospace; text-align: right; color: #d9534f; font-size: 1.1em; }
    .notes { grid-column: 2 / 4; background-color: #f9f9f9; border-left: 3px solid #ccc; padding: 8px 12px; margin-top: 5px; font-size: 0.9em; white-space: pre-wrap; }
    .section-header { margin-top: 2em; padding-bottom: 0.5em; border-bottom: 2px solid #333; font-size: 1.2em; font-weight: bold; grid-column: 1 / -1; }
    mjx-container[display="true"] { margin: 0.3em 0 !important; }
  </style>
</head>
<body>
  <div class="page-container">
    <h3>Structured Preview: ${title}</h3>
    <p style="font-size: 0.9em; color: #555;">This view shows exactly how the system has associated requirement text with marks. It is a direct rendering of the final structured data used for grading.</p>
    <hr>
    ${content}
  </div>
</body>
</html>`;
  return html.trim();
}

/**
 * Sanitizes a string containing mixed text and LaTeX to fix common OCR errors.
 * @param {string} text The raw string from the OCR service.
 * @returns {string} The sanitized string, ready for rendering.
 */
function _sanitizeForMathJax_(text) {
  if (!text) return "";
  let sanitized = text;
  sanitized = sanitized.replace(/\\(A\d+|M\d+|R\d+|N\d+|AG)\b/g, '$1');
  sanitized = sanitized.replace(/\\(METHOD|NOTE|EITHER|OR|THEN)\b/g, '$1');
  sanitized = sanitized.replace(/(\\sum)(?!\\limits)/g, '$1\\limits');
  return sanitized;
}

/**
 * Renders the final structured points into an HTML table-like structure.
 * @param {Array<Object>} points The array of point objects from the atomizer.
 * @returns {string} The generated HTML content.
 */
function _buildStructuredHtmlFromPoints_(points) {
  if (!points || points.length === 0) {
    return "<p>No markscheme points were extracted.</p>";
  }
  let html = '';
  let lastPart = null;
  let lastBranch = null; // Track the last branch
  for (const point of points) {
    const currentPart = point.part || 'unknown';
    if (currentPart !== lastPart) {
      html += `<div class="point-row"><div class="section-header">Question Part: ${currentPart}</div></div>`;
      lastPart = currentPart;
      lastBranch = null; // Reset branch when part changes
    }

    html += '<div class="point-row">';
    
    // Display branch label only if it's different from the previous point
    let branchLabel = '';
    if (point.branch && point.branch !== lastBranch) {
      branchLabel = `<div class="branch-label">${point.branch}</div>`;
    }
    html += `<div>${branchLabel}</div>`;

    const sanitizedRequirement = _sanitizeForMathJax_(point.requirement);
    html += `<div class="requirement">${sanitizedRequirement}</div>`;
    html += `<div class="mark">${(point.marks || []).join(' ')}</div>`;
    html += '</div>';

    if (point.notes && point.notes.length > 0) {
      const sanitizedNotes = _sanitizeForMathJax_(point.notes.join('\n'));
      html += `<div class="point-row"><div class="notes">${sanitizedNotes}</div></div>`;
    }

    lastBranch = point.branch; // Update lastBranch for the next iteration
  }
  return html;
}

/**
 * Parses a block of sanitized text into a two-column HTML structure for the original preview.
 * @param {string} text The sanitized text for one page.
 * @returns {string} The generated HTML rows for the page.
 */
function _buildStructuredHtmlFromText_(text) {
  if (!text) return "";
  const displayMathRegex = /(\\\[[\s\S]*?\\\])/g;
  const displayMathBlocks = [];
  const textWithPlaceholders = text.replace(displayMathRegex, (match) => {
    displayMathBlocks.push(match);
    return `\n@@MJX_BLOCK_${displayMathBlocks.length - 1}@@\n`;
  });
  const allTokens = textWithPlaceholders.split(/\r?\n/).filter(line => line.trim() !== '');
  const rows = [];
  let pendingMarks = []; // NEW: Hold marks for the next line.
  const markRegex = /(\(\s*\b[AMRGN]\d+\b\s*\)|\b[AMRGN]\d+\b|\[\s*(?:Total\s*)?\d+\s*marks?\s*\]|AG|\(AG\))/g;
  
  const isMarkOnly = (line) => {
    if (!line) return false;
    const marks = line.match(markRegex);
    if (!marks) return false;
    const stripped = line.replace(markRegex, '').replace(/[\s,;()]/g, '');
    return stripped === '';
  };

  const isAnswerLike = (line) => {
    const normalized = (line || "").replace(/^\\\(\s*|\s*\\\)$/g, '').trim();
    return /^\s*=?\s*([nx]\s*=|=|\d)/.test(normalized);
  };

  for (let i = 0; i < allTokens.length; i++) {
    const line = allTokens[i];
    const methodMatch = line.match(/^METHOD\s+(\d+)$/i);
    if (methodMatch) {
      rows.push({ main: `METHOD ${methodMatch[1]}`, marks: [], primaryPart: '', secondaryPart: '&nbsp;', type: 'heading', isMarkable: false });
      continue;
    }
    if (isMarkOnly(line)) {
      const marks = line.match(markRegex) || [];
      let nextContentLine = '';
      for (let j = i + 1; j < Math.min(i + 3, allTokens.length); j++) {
        if (allTokens[j]) {
          nextContentLine = allTokens[j];
          break;
        }
      }
      if (isAnswerLike(nextContentLine)) {
        pendingMarks.push(...marks);
      } else {
        let lastMarkableRow = rows.slice().reverse().find(r => r.isMarkable);
        if (lastMarkableRow) lastMarkableRow.marks.push(...marks);
      }
      continue;
    }
    if (/^Note:/i.test(line)) {
      let noteContent = [line];
      while (i + 1 < allTokens.length) {
        const nextLine = allTokens[i + 1];
        if (/^\s*\(?[a-z]\)/i.test(nextLine) || /^METHOD/i.test(nextLine) || isMarkOnly(nextLine)) break;
        i++;
        noteContent.push(allTokens[i]);
      }
      rows.push({ main: `<div class="note-box">${noteContent.join('<br>')}</div>`, marks: [], partLabels: [], type: 'note', isMarkable: true });
      continue;
    }
    let main = line;
    let currentMarks = [...pendingMarks];
    pendingMarks = [];
    let primaryPart = '';
    let secondaryPart = '';
    let isNewMainPart = false;
    const primaryPartRegex = /^\s*(\(\s*[a-z]\s*\))/i;
    const primaryMatch = main.match(primaryPartRegex);
    if (primaryMatch) {
      primaryPart = primaryMatch[1];
      main = main.substring(primaryMatch[0].length).trim();
      if (primaryPart && /^\([b-z]\)$/i.test(primaryPart)) isNewMainPart = true;
    }
    const secondaryPartRegex = /^\s*(\(\s*[ivx]+\s*\))/i;
    const secondaryMatch = main.match(secondaryPartRegex);
    if (secondaryMatch) {
      secondaryPart = secondaryMatch[1];
      main = main.substring(secondaryMatch[0].length).trim();
    }
    if (!primaryPart && secondaryPart) primaryPart = '&nbsp;';
    main = main.replace(markRegex, (match) => {
      currentMarks.push(match.trim());
      return '';
    }).trim();
    const newRow = { main, marks: currentMarks, primaryPart, secondaryPart, type: 'text', isMarkable: true, isNewMainPart };
    if (/^@@MJX_BLOCK_\d+@@$/.test(main)) {
      const blockIndex = parseInt(main.match(/@@MJX_BLOCK_(\d+)@@/)[1], 10);
      newRow.main = displayMathBlocks[blockIndex];
      newRow.type = 'display-math';
      if (newRow.main.trim().startsWith('\\[=')) newRow.type = 'equals-line';
    }
    rows.push(newRow);
  }
  return rows.map(row => {
    let rowClasses = ['row'];
    if (row.isNewMainPart) rowClasses.push('row--new-part');
    if (row.type === 'heading') rowClasses.push('row--heading');
    if (row.type === 'display-math' || row.type === 'equals-line') rowClasses.push('row--displaymath');
    if (row.type === 'equals-line') rowClasses.push('row--equalsline');
    if (row.type === 'note') rowClasses.push('row--note');
    const primaryPartDiv = `<div class="primary-part-label">${row.primaryPart || ''}</div>`;
    const marksHtml = row.marks.map(m => `<div><span class="${m.startsWith('(') ? 'paren' : 'plain'}">${m}</span></div>`).join('');
    const marksDiv = `<div class="mark">${marksHtml}</div>`;
    const secondaryPartSpan = row.secondaryPart ? `<span class="secondary-part-label">${row.secondaryPart}</span>` : '';
    const mainContentDiv = `<div class="main">${secondaryPartSpan}${row.main}</div>`;
    return `<div class="${rowClasses.join(' ')}">${primaryPartDiv}${mainContentDiv}${marksDiv}</div>`;
  }).join('');
}
