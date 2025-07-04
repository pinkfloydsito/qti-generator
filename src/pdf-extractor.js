// Use legacy build for Node.js environments to avoid browser-specific APIs like DOMMatrix
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs';

// Provide DOMMatrix polyfill for Windows environments where it might not be available
if (typeof globalThis.DOMMatrix === 'undefined' && typeof global !== 'undefined') {
  // Simple DOMMatrix polyfill for basic functionality
  global.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      if (init) {
        if (Array.isArray(init)) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        }
      }
    }
    translate(x, y) {
      return new DOMMatrix([this.a, this.b, this.c, this.d, this.e + x, this.f + y]);
    }
    scale(sx, sy = sx) {
      return new DOMMatrix([this.a * sx, this.b * sx, this.c * sy, this.d * sy, this.e, this.f]);
    }
  };
  console.log('DOMMatrix polyfill installed for Windows compatibility');
}

// Simple PDF text extraction for Electron
class PDFExtractor {
  constructor() {
    this.pdfjs = PDFJS;
    this.setupPDFJS();
  }

  setupPDFJS() {
    try {
      // For Electron, we need to properly disable workers
      // Setting workerSrc to false can cause issues on Windows
      if (typeof this.pdfjs.GlobalWorkerOptions !== 'undefined') {
        // Don't set workerSrc to false, just don't set it at all
        // The disableWorker: true option in getDocument is sufficient
        console.log('PDF.js configured for Electron environment (workers will be disabled per document)');
      }
    } catch (error) {
      console.warn('PDF.js setup warning:', error.message);
    }
  }

  // Quick validation to avoid processing clearly invalid data
  isValidPDFBuffer(buffer) {
    if (!buffer || buffer.length < 10) {
      return false;
    }

    // Check for PDF header (%PDF-)
    const header = buffer.toString('ascii', 0, 5);
    if (!header.startsWith('%PDF-')) {
      return false;
    }

    // Check for EOF marker (%%EOF) - this is a heuristic, not a strict validation
    const tail = buffer.toString('ascii', -10);
    if (!tail.includes('%%EOF')) {
      console.warn('PDF may be truncated or corrupted (no EOF marker)');
    }

    return true;
  }

  async extractText(pdfBuffer) {
    try {
      // Quick validation - check if buffer starts with PDF header
      if (!this.isValidPDFBuffer(pdfBuffer)) {
        throw new Error('Invalid PDF file format');
      }

      if (!this.pdfjs) {
        throw new Error('PDF.js library not initialized.');
      }

      // Convert Buffer to Uint8Array for PDF.js compatibility
      const uint8Array = new Uint8Array(pdfBuffer);

      const loadingTask = this.pdfjs.getDocument({
        data: uint8Array,
        disableWorker: true, // Crucial for Electron compatibility
        isEvalSupported: false,
        disableCreateObjectURL: true,
        stopAtErrors: false,
        verbosity: 0, // Reduce console output
        useSystemFonts: true, // Use system fonts instead of embedded fonts
        disableFontFace: true, // Disable font loading that might use DOM APIs
        cMapUrl: null, // Disable CMap loading
        cMapPacked: false
      });

      const pdf = await loadingTask.promise;
      let fullText = '';

      console.log(`Processing PDF with ${pdf.numPages} pages`);

      // Extract text from all pages (limit to first 20 pages for performance)
      const maxPages = Math.min(pdf.numPages, 20);
      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        try {
          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent();

          const pageText = textContent.items
            .map(item => item.str)
            .join(' ');

          fullText += pageText + '\n\n';

          // Clean up page resources
          page.cleanup();
        } catch (pageError) {
          console.warn(`Error processing page ${pageNum}:`, pageError.message);
          // Continue to next page even if one fails
        }
      }

      // Clean up PDF resources
      pdf.destroy();

      if (fullText.trim().length > 100) {
        console.log(`PDF extraction successful: ${fullText.length} characters`);
        return this.cleanupText(fullText);
      } else {
        throw new Error('No significant text content found in PDF.');
      }

    } catch (error) {
      throw new Error(this.getHelpfulErrorMessage(error));
    }
  }

  cleanupText(text) {
    return text
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      // Remove excessive newlines
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      // Clean up common PDF artifacts (e.g., camelCase words split by PDF)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Remove common page number patterns
      .replace(/^\d+\s*$/gm, '')
      .replace(/^Page \d+ of \d+\s*$/gm, '')
      .trim();
  }

  getHelpfulErrorMessage(error) {
    const message = error.message.toLowerCase();

    if (message.includes('worker')) {
      return 'PDF worker error. This might be due to environment limitations. Please copy and paste the text manually.';
    } else if (message.includes('invalid') || message.includes('corrupt') || message.includes('truncated')) {
      return 'Invalid or corrupted PDF file. Please try a different file.';
    } else if (message.includes('password') || message.includes('encrypted')) {
      return 'Password-protected PDF. Please unlock the PDF first or copy the text manually.';
    } else if (message.includes('no significant text') || message.includes('no text content')) {
      return 'No readable text found in the PDF. This might be a scanned PDF or an image-based PDF. Please copy the text manually.';
    } else {
      return `Could not extract text from PDF: ${error.message}. Please copy and paste the content manually into the text area.`;
    }
  }
}

export default PDFExtractor;
