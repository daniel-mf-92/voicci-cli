#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class TextCleanerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TextCleanerError';
    this.code = code;
    this.details = details;
  }
}

class TextCleaner {
  constructor(options = {}) {
    this.chapterPatterns = [
      /^Chapter\s+(\d+|[IVXLCDM]+)[\s:\.]/i,
      /^CHAPTER\s+(\d+|[IVXLCDM]+)[\s:\.]/,
      /^(\d+|[IVXLCDM]+)\.\s+[A-Z]/,
      /^\d+\s*$/
    ];

    // Resource limits
    this.maxFileSize = options.maxFileSize || 100 * 1024 * 1024; // 100MB
    this.maxTextLength = options.maxTextLength || 50 * 1024 * 1024; // 50MB text
    this.maxChapters = options.maxChapters || 1000;
    this.pdfTimeout = options.pdfTimeout || 60000; // 60 seconds

    // Supported formats
    this.supportedFormats = ['.pdf', '.txt', '.epub', '.md'];
  }

  async processFile(filePath) {
    // Validate file path
    this.validateFilePath(filePath);

    try {
      // Extract text
      const text = await this.extractText(filePath);

      // Validate extracted text
      this.validateText(text);

      // Clean text
      const cleaned = await this.cleanText(text);

      // Detect chapters
      const chapters = await this.detectChapters(cleaned);

      // Validate chapters
      this.validateChapters(chapters);

      return {
        originalText: text,
        cleanedText: cleaned,
        chapters: chapters,
        stats: {
          originalLength: text.length,
          cleanedLength: cleaned.length,
          reductionPercent: text.length > 0
            ? ((1 - cleaned.length / text.length) * 100).toFixed(2)
            : '0.00',
          chapterCount: chapters.length,
          avgChapterLength: chapters.length > 0
            ? Math.round(cleaned.length / chapters.length)
            : 0
        }
      };
    } catch (error) {
      if (error instanceof TextCleanerError) {
        throw error;
      }

      throw new TextCleanerError(
        'Failed to process file',
        'PROCESS_FAILED',
        { filePath, error: error.message }
      );
    }
  }

  validateFilePath(filePath) {
    // Check if path is provided
    if (!filePath || typeof filePath !== 'string') {
      throw new TextCleanerError(
        'File path must be a string',
        'INVALID_PATH',
        { filePath }
      );
    }

    // Check for path traversal attempts
    const normalized = path.normalize(filePath);
    if (normalized.includes('..')) {
      throw new TextCleanerError(
        'Path traversal detected',
        'SECURITY_ERROR',
        { filePath }
      );
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new TextCleanerError(
        'File does not exist',
        'FILE_NOT_FOUND',
        { filePath }
      );
    }

    // Check if it's a file (not directory)
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      throw new TextCleanerError(
        'Path is not a file',
        'NOT_A_FILE',
        { filePath }
      );
    }

    // Check file size
    if (stats.size === 0) {
      throw new TextCleanerError(
        'File is empty',
        'EMPTY_FILE',
        { filePath }
      );
    }

    if (stats.size > this.maxFileSize) {
      throw new TextCleanerError(
        `File too large (max ${this.maxFileSize / (1024 * 1024)}MB)`,
        'FILE_TOO_LARGE',
        { size: stats.size, maxSize: this.maxFileSize }
      );
    }

    // Check file extension
    const ext = path.extname(filePath).toLowerCase();
    if (!this.supportedFormats.includes(ext)) {
      throw new TextCleanerError(
        `Unsupported file format: ${ext}`,
        'UNSUPPORTED_FORMAT',
        { ext, supported: this.supportedFormats }
      );
    }
  }

  validateText(text) {
    if (!text || typeof text !== 'string') {
      throw new TextCleanerError(
        'Extracted text must be a string',
        'INVALID_TEXT'
      );
    }

    if (text.length === 0) {
      throw new TextCleanerError(
        'Extracted text is empty',
        'EMPTY_TEXT'
      );
    }

    if (text.length > this.maxTextLength) {
      throw new TextCleanerError(
        `Text too long (max ${this.maxTextLength / (1024 * 1024)}MB)`,
        'TEXT_TOO_LONG',
        { length: text.length, maxLength: this.maxTextLength }
      );
    }

    // Check if text is mostly readable
    const printableChars = text.replace(/[\s\n\r\t]/g, '').length;
    const nonPrintable = text.length - printableChars;
    const nonPrintableRatio = nonPrintable / text.length;

    if (nonPrintableRatio > 0.5) {
      throw new TextCleanerError(
        'Text contains too many non-printable characters',
        'CORRUPTED_TEXT',
        { ratio: nonPrintableRatio.toFixed(2) }
      );
    }
  }

  validateChapters(chapters) {
    if (!Array.isArray(chapters)) {
      throw new TextCleanerError(
        'Chapters must be an array',
        'INVALID_CHAPTERS'
      );
    }

    if (chapters.length === 0) {
      throw new TextCleanerError(
        'No chapters detected',
        'NO_CHAPTERS'
      );
    }

    if (chapters.length > this.maxChapters) {
      throw new TextCleanerError(
        `Too many chapters detected (max ${this.maxChapters})`,
        'TOO_MANY_CHAPTERS',
        { count: chapters.length, max: this.maxChapters }
      );
    }

    // Validate each chapter
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];

      if (!chapter.text || chapter.text.trim().length === 0) {
        throw new TextCleanerError(
          `Chapter ${i + 1} has no text`,
          'EMPTY_CHAPTER',
          { chapterIndex: i }
        );
      }

      if (!chapter.title || chapter.title.trim().length === 0) {
        throw new TextCleanerError(
          `Chapter ${i + 1} has no title`,
          'NO_CHAPTER_TITLE',
          { chapterIndex: i }
        );
      }
    }
  }

  async extractText(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    try {
      if (ext === '.pdf') {
        return await this.extractFromPDF(filePath);
      } else if (ext === '.txt' || ext === '.md') {
        return await this.extractFromText(filePath);
      } else if (ext === '.epub') {
        return await this.extractFromEPUB(filePath);
      } else {
        throw new TextCleanerError(
          `Unsupported file type: ${ext}`,
          'UNSUPPORTED_TYPE',
          { ext }
        );
      }
    } catch (error) {
      if (error instanceof TextCleanerError) {
        throw error;
      }

      throw new TextCleanerError(
        'Text extraction failed',
        'EXTRACTION_FAILED',
        { filePath, error: error.message }
      );
    }
  }

  async extractFromPDF(filePath) {
    try {
      // Check if pdftotext is available
      try {
        await execAsync('which pdftotext');
      } catch (e) {
        throw new TextCleanerError(
          'pdftotext not found. Install poppler-utils.',
          'MISSING_DEPENDENCY',
          { tool: 'pdftotext' }
        );
      }

      // Extract with timeout and resource limits
      const { stdout, stderr } = await execAsync(
        `pdftotext -layout -nopgbrk "${filePath}" -`,
        {
          timeout: this.pdfTimeout,
          maxBuffer: this.maxTextLength
        }
      );

      if (stderr && stderr.trim().length > 0) {
        console.warn('pdftotext warning:', stderr);
      }

      if (!stdout || stdout.trim().length === 0) {
        throw new Error('PDF extraction returned empty text');
      }

      return stdout;
    } catch (error) {
      if (error.killed) {
        throw new TextCleanerError(
          'PDF extraction timed out',
          'TIMEOUT',
          { timeout: this.pdfTimeout }
        );
      }

      throw new TextCleanerError(
        'Failed to extract text from PDF',
        'PDF_EXTRACTION_FAILED',
        { error: error.message }
      );
    }
  }

  async extractFromText(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new TextCleanerError(
        'Failed to read text file',
        'READ_FAILED',
        { error: error.message }
      );
    }
  }

  async extractFromEPUB(filePath) {
    // EPUB support can be added later
    throw new TextCleanerError(
      'EPUB support not yet implemented',
      'NOT_IMPLEMENTED'
    );
  }

  async cleanText(text) {
    if (!text || text.length === 0) {
      return text;
    }

    try {
      let cleaned = text;

      // Remove table of contents
      cleaned = this.removeTOC(cleaned);

      // Remove copyright and publishing info
      cleaned = this.removeCopyright(cleaned);

      // Remove headers and footers
      cleaned = this.removeHeadersFooters(cleaned);

      // Remove page numbers
      cleaned = this.removePageNumbers(cleaned);

      // Fix hyphenated words at line breaks
      cleaned = this.fixHyphenation(cleaned);

      // Normalize whitespace
      cleaned = this.normalizeWhitespace(cleaned);

      return cleaned;
    } catch (error) {
      throw new TextCleanerError(
        'Text cleaning failed',
        'CLEANING_FAILED',
        { error: error.message }
      );
    }
  }

  removeTOC(text) {
    try {
      const tocPatterns = [
        // Match "TABLE OF CONTENTS" followed by chapter entries with dots
        /TABLE\s+OF\s+CONTENTS\s*\n+(?:Chapter.*?\.+.*?\d+\s*\n+){2,}/i,
        // Match any section with multiple lines ending in dots + page numbers
        /(?:^.*?\.{3,}\s*\d+\s*$\n){3,}/gm,
        // Match "Contents" section
        /^Contents\s*\n+(?:.*?\.{2,}.*?\d+\s*\n){2,}/im
      ];

      let result = text;
      tocPatterns.forEach(pattern => {
        result = result.replace(pattern, '\n\n');
      });

      return result;
    } catch (error) {
      console.warn('TOC removal failed, skipping:', error.message);
      return text;
    }
  }

  removeCopyright(text) {
    try {
      // Remove copyright notices, ISBN, publisher info at the beginning
      const copyrightPattern = /^.*?(?:copyright|©|isbn|published|all rights reserved).*?\n{2,}/ims;
      return text.replace(copyrightPattern, '');
    } catch (error) {
      console.warn('Copyright removal failed, skipping:', error.message);
      return text;
    }
  }

  removeHeadersFooters(text) {
    try {
      const lines = text.split('\n');

      if (lines.length < 100) {
        // Too short to detect patterns reliably
        return text;
      }

      const pageLength = 60; // Approximate lines per page
      const headerLines = 3;
      const footerLines = 3;

      const headerPatterns = new Map();
      const footerPatterns = new Map();

      // Sample headers and footers from multiple pages
      for (let i = 0; i < lines.length; i += pageLength) {
        // Headers (first few lines of page)
        for (let j = 0; j < headerLines && i + j < lines.length; j++) {
          const line = lines[i + j];
          if (line && line.trim().length > 0 && line.trim().length < 100) {
            headerPatterns.set(line.trim(), (headerPatterns.get(line.trim()) || 0) + 1);
          }
        }

        // Footers (last few lines of page)
        for (let j = 1; j <= footerLines && i + pageLength - j >= 0 && i + pageLength - j < lines.length; j++) {
          const line = lines[i + pageLength - j];
          if (line && line.trim().length > 0 && line.trim().length < 100) {
            footerPatterns.set(line.trim(), (footerPatterns.get(line.trim()) || 0) + 1);
          }
        }
      }

      // Find patterns that repeat at least 3 times
      const repeatThreshold = 3;
      const commonHeaders = Array.from(headerPatterns.entries())
        .filter(([_, count]) => count >= repeatThreshold)
        .map(([pattern, _]) => pattern);

      const commonFooters = Array.from(footerPatterns.entries())
        .filter(([_, count]) => count >= repeatThreshold)
        .map(([pattern, _]) => pattern);

      // Remove common headers and footers
      const filtered = lines.filter(line => {
        const trimmed = line.trim();
        return !commonHeaders.includes(trimmed) && !commonFooters.includes(trimmed);
      });

      return filtered.join('\n');
    } catch (error) {
      console.warn('Header/footer removal failed, skipping:', error.message);
      return text;
    }
  }

  removePageNumbers(text) {
    try {
      const patterns = [
        /^\s*\d+\s*$/gm,           // Just a number on a line
        /^\s*-\s*\d+\s*-\s*$/gm,   // - 42 -
        /^\s*\[\s*\d+\s*\]\s*$/gm, // [42]
        /^\s*Page\s+\d+\s*$/gmi    // Page 42
      ];

      let cleaned = text;
      patterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
      });

      return cleaned;
    } catch (error) {
      console.warn('Page number removal failed, skipping:', error.message);
      return text;
    }
  }

  fixHyphenation(text) {
    try {
      // Fix words split across lines with hyphens
      // "exam-\nple" -> "example"
      return text.replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2');
    } catch (error) {
      console.warn('Hyphenation fix failed, skipping:', error.message);
      return text;
    }
  }

  normalizeWhitespace(text) {
    try {
      return text
        .replace(/[ \t]+/g, ' ')        // Multiple spaces to single space
        .replace(/\n{3,}/g, '\n\n')     // Multiple newlines to double newline
        .trim();
    } catch (error) {
      console.warn('Whitespace normalization failed, skipping:', error.message);
      return text;
    }
  }

  async detectChapters(text) {
    try {
      const lines = text.split('\n');
      const chapters = [];
      let currentChapter = null;
      let chapterNum = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check if line matches chapter pattern
        const isChapter = this.chapterPatterns.some(pattern => pattern.test(line));

        // Filter out TOC entries (lines with dots followed by page numbers)
        const isTOCEntry = /\.{3,}\s*\d+$/.test(line);

        if (isChapter && line.length < 100 && !isTOCEntry) {
          // Save previous chapter
          if (currentChapter) {
            currentChapter.text = currentChapter.text.trim();
            currentChapter.wordCount = this.countWords(currentChapter.text);

            // Only add if chapter has substantial content
            if (currentChapter.wordCount > 10) {
              chapters.push(currentChapter);
            }
          }

          // Start new chapter
          chapterNum++;
          currentChapter = {
            number: chapterNum,
            title: line.substring(0, 200), // Limit title length
            text: '',
            startLine: i,
            wordCount: 0
          };
        } else if (currentChapter) {
          // Add line to current chapter
          currentChapter.text += line + '\n';
        } else if (chapterNum === 0 && line.length > 0) {
          // Before first chapter - create intro/prologue
          if (!currentChapter) {
            currentChapter = {
              number: 0,
              title: 'Introduction',
              text: '',
              startLine: 0,
              wordCount: 0
            };
          }
          currentChapter.text += line + '\n';
        }
      }

      // Save last chapter
      if (currentChapter) {
        currentChapter.text = currentChapter.text.trim();
        currentChapter.wordCount = this.countWords(currentChapter.text);

        if (currentChapter.wordCount > 10) {
          chapters.push(currentChapter);
        }
      }

      // If no chapters detected, treat entire text as one chapter
      if (chapters.length === 0) {
        const wordCount = this.countWords(text.trim());
        chapters.push({
          number: 1,
          title: 'Full Text',
          text: text.trim(),
          wordCount: wordCount,
          startLine: 0
        });
      }

      return chapters;
    } catch (error) {
      throw new TextCleanerError(
        'Chapter detection failed',
        'DETECTION_FAILED',
        { error: error.message }
      );
    }
  }

  countWords(text) {
    if (!text || text.trim().length === 0) {
      return 0;
    }

    return text.trim().split(/\s+/).length;
  }

  getStats() {
    return {
      maxFileSize: this.maxFileSize,
      maxTextLength: this.maxTextLength,
      maxChapters: this.maxChapters,
      supportedFormats: this.supportedFormats
    };
  }
}

export default TextCleaner;
export { TextCleanerError };
