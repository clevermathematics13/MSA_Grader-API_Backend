/******************
 * MSA_DocImages.gs
 ******************/

function msaExtractDocImages_(docId, folder) {
  const doc = DocumentApp.openById(docId);
  const body = doc.getBody();
  const images = body.getImages();

  // Save marker
  msaUpsertTextFile_(folder, MSA_FN_SOURCE_DOC_ID, docId);

  // Save a PDF snapshot too (useful for humans)
  try {
    const pdfBlob = DriveApp.getFileById(docId).getAs(MimeType.PDF);
    msaUpsertBlobFile_(folder, MSA_FN_SOURCE_PDF, pdfBlob);
  } catch (e) {
    msaWarn_("Could not export PDF (non-fatal): " + e.message);
  }

  const hashes = {};
  const saved = [];

  for (let i = 0; i < images.length; i++) {
    const blob = images[i].getBlob();
    const bytes = blob.getBytes();

    // Skip tiny inline images/icons
    if (bytes.length < MSA_MIN_IMAGE_BYTES) continue;

    const md5 = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
    if (hashes[md5]) continue;
    hashes[md5] = true;

    const idx = saved.length + 1;
    const fn = "markscheme_page_" + msaPad2_(idx) + ".png";

    // Ensure png mime if possible
    let outBlob = blob;
    try {
      outBlob = blob.getAs(MimeType.PNG);
    } catch (e) {
      // leave as-is
    }

    msaUpsertBlobFile_(folder, fn, outBlob);
    saved.push({ filename: fn, bytes: bytes.length });
  }

  // Create preview.png as the LARGEST saved image (better Drive quick-view)
  if (MSA_CREATE_PREVIEW_PNG && saved.length) {
    let best = saved[0];
    for (let k = 1; k < saved.length; k++) {
      if (saved[k].bytes > best.bytes) best = saved[k];
    }
    const fIt = folder.getFilesByName(best.filename);
    if (fIt.hasNext()) {
      const bestFile = fIt.next();
      const previewBlob = bestFile.getBlob().getAs(MimeType.PNG);
      msaUpsertBlobFile_(folder, MSA_FN_PREVIEW_PNG, previewBlob);
    }
  }

  return saved; // list of saved page images
}

function msaPad2_(n) {
  return (n < 10 ? "0" : "") + String(n);
}
