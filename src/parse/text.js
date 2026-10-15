// Turn raw file bytes into text, rejecting encodings and binary data the CAM formats never contain.

/**
 * @param {Uint8Array|string} input
 * @param {import('./diagnostics.js').Diagnostics} diag
 * @returns {string|null} text, or null if the bytes cannot be text (an error was reported)
 */
export function decodeText(input, diag) {
  if (typeof input === 'string') return checkText(input.charCodeAt(0) === 0xfeff ? bom(input, diag) : input, diag);
  const bytes = input;
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    diag.error('ENCODING_UTF16', 'File is UTF-16 encoded; Gerber and Excellon files must be ASCII/UTF-8', 1);
    return null;
  }
  let text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = bom(text, diag);
  return checkText(text, diag);
}

function bom(text, diag) {
  diag.warn('UTF8_BOM', 'File starts with a UTF-8 byte order mark (ignored)', 1);
  return text.slice(1);
}

function checkText(text, diag) {
  // Control characters other than TAB/LF/CR/FF never appear in valid files; U+FFFD means invalid UTF-8.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) || c === 0x7f || c === 0xfffd) {
      const line = lineAt(text, i);
      if (c === 0) diag.error('NUL_BYTE', `NUL byte in file (binary data?) at line ${line}`, line);
      else diag.error('BINARY_DATA', `File contains binary or invalid text data at line ${line}`, line);
      return null;
    }
  }
  return text;
}

export function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
