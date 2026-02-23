/****************
 * MSA_Mathpix.gs
 ****************/

function msaGetMathpixCreds_() {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty("MATHPIX_APP_ID");
  const appKey = props.getProperty("MATHPIX_APP_KEY");
  if (!appId || !appKey) {
    throw new Error("Mathpix credentials missing. Set Script Properties MATHPIX_APP_ID and MATHPIX_APP_KEY.");
  }
  return { appId, appKey };
}

function msaMathpixOCR_(imageBlob, requestOptions) {
  const creds = msaGetMathpixCreds_();

  // Check image size and compress if needed (Mathpix limit is ~5MB)
  let processedBlob = imageBlob;
  const maxSizeBytes = 4 * 1024 * 1024; // 4MB to be safe
  
  if (imageBlob.getBytes().length > maxSizeBytes) {
    msaLog_('Image too large (' + Math.round(imageBlob.getBytes().length / 1024 / 1024) + 'MB), compressing...');
    processedBlob = compressImageBlob_(imageBlob, maxSizeBytes);
  }

  const url = "https://api.mathpix.com/v3/text";
  const payload = {
    src: "data:" + processedBlob.getContentType() + ";base64," + Utilities.base64Encode(processedBlob.getBytes()),
    formats: MSA_MATHPIX_FORMATS,
    ...requestOptions
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: {
      "app_id": creds.appId,
      "app_key": creds.appKey
    },
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  const text = resp.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error("Mathpix error " + code + ": " + text.slice(0, 400));
  }

  return JSON.parse(text);
}

/**
 * Compress an image blob to fit within size limit
 * Uses Google Drive's thumbnail API as a compression workaround
 */
function compressImageBlob_(imageBlob, maxSizeBytes) {
  try {
    // Create a temporary file in Drive
    const tempFile = DriveApp.createFile(imageBlob);
    const fileId = tempFile.getId();
    
    // Use Drive API to get a resized thumbnail
    // Try progressively smaller sizes until it fits
    const sizes = [1600, 1200, 1000, 800, 600];
    let compressedBlob = null;
    
    for (let i = 0; i < sizes.length; i++) {
      try {
        // Get thumbnail at this size
        const thumbnailUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + sizes[i];
        const response = UrlFetchApp.fetch(thumbnailUrl, {
          headers: {
            'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
          },
          muteHttpExceptions: true
        });
        
        if (response.getResponseCode() === 200) {
          const blob = response.getBlob();
          if (blob.getBytes().length <= maxSizeBytes) {
            compressedBlob = blob.setName('compressed_image.jpg');
            msaLog_('Compressed to ' + sizes[i] + 'px width, size: ' + Math.round(blob.getBytes().length / 1024) + 'KB');
            break;
          }
        }
      } catch (e) {
        msaLog_('Compression at ' + sizes[i] + 'px failed: ' + e.message);
      }
    }
    
    // Clean up temp file
    tempFile.setTrashed(true);
    
    if (compressedBlob) {
      return compressedBlob;
    }
    
    // If Drive API didn't work, try a different approach
    msaLog_('Drive thumbnail compression failed, returning original');
    return imageBlob;
    
  } catch (e) {
    msaLog_('Image compression error: ' + e.message);
    return imageBlob;
  }
}
