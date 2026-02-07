/**
 * File handling utilities
 */

// Maximum file size: 50MB
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Maximum text length to send to AI: 500KB
export const MAX_TEXT_LENGTH = 500 * 1024;

// Maximum batch files
export const MAX_BATCH_FILES = 5;

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Verify binary data is a valid ZIP (DOCX) file
 */
export function isValidZipFile(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return false;
  // ZIP files start with PK\x03\x04
  return bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
}

export function downloadFile(data, filename) {
  const blob = new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

