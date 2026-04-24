#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';

const execAsync = promisify(exec);

class BookFinderError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BookFinderError';
    this.code = code;
    this.details = details;
  }
}

class BookFinder {
  constructor(options = {}) {
    this.sources = [
      {
        name: 'LibGen',
        searchUrl: 'http://libgen.rs/search.php',
        priority: 1,
        timeout: 30000,
        retries: 3
      },
      {
        name: 'AnnaArchive',
        searchUrl: 'https://annas-archive.org',
        priority: 2,
        timeout: 30000,
        retries: 3
      },
      {
        name: 'ZLib',
        searchUrl: 'https://z-lib.gs',
        priority: 3,
        timeout: 30000,
        retries: 2
      }
    ];

    this.downloadDir = path.join(config.paths.temp, 'downloads');
    this.maxFileSize = options.maxFileSize || 500 * 1024 * 1024; // 500MB default
    this.minFileSize = options.minFileSize || 1024; // 1KB minimum
    this.allowedExtensions = ['.pdf', '.epub', '.mobi', '.txt'];
    this.warningShown = false; // Track if copyright warning was shown
  }

  /**
   * Show copyright warning before searching
   * Returns true if user accepts, false if declined
   */
  async showCopyrightWarning() {
    // Only show once per session
    if (this.warningShown) {
      return true;
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('⚠️  COPYRIGHT WARNING');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('You are about to search for content from third-party sources.');
    console.log('');
    console.log('IMPORTANT:');
    console.log('  • Ensure you have the legal right to download and use');
    console.log('    any content in your jurisdiction');
    console.log('  • Do not use this feature to infringe on copyrights');
    console.log('  • Voicci is not responsible for your downloads');
    console.log('  • You accept full responsibility for your actions');
    console.log('');
    console.log('LEGAL USES:');
    console.log('  ✓ Public domain books');
    console.log('  ✓ Books you own (personal backups)');
    console.log('  ✓ Open access academic papers');
    console.log('  ✓ Creative Commons licensed content');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════\n');

    // In non-interactive mode (CI/scripts), skip warning
    if (!process.stdin.isTTY) {
      this.warningShown = true;
      return true;
    }

    // Prompt for consent
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('Do you understand and accept responsibility? (yes/no): ', (answer) => {
        rl.close();
        const accepted = answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';

        if (accepted) {
          this.warningShown = true;
          console.log('\n✓ Consent accepted. Proceeding with search...\n');
        } else {
          console.log('\n✗ Search cancelled.\n');
        }

        resolve(accepted);
      });
    });
  }


  ensureDownloadDir() {
    try {
      fs.mkdirSync(this.downloadDir, { recursive: true, mode: 0o755 });
    } catch (error) {
      throw new BookFinderError(
        'Failed to create download directory',
        'DIR_CREATE_FAILED',
        { path: this.downloadDir, error: error.message }
      );
    }
  }

  validateQuery(query) {
    if (!query || typeof query !== 'string') {
      throw new BookFinderError(
        'Query must be a non-empty string',
        'INVALID_QUERY',
        { query }
      );
    }

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new BookFinderError(
        'Query cannot be empty',
        'EMPTY_QUERY'
      );
    }

    if (trimmed.length > 500) {
      throw new BookFinderError(
        'Query too long (max 500 characters)',
        'QUERY_TOO_LONG',
        { length: trimmed.length }
      );
    }

    // Check for shell injection attempts
    const dangerousPatterns = [';', '&&', '||', '`', '$(',  '$()', '|', '>', '<', '\n', '\r'];
    for (const pattern of dangerousPatterns) {
      if (trimmed.includes(pattern)) {
        throw new BookFinderError(
          'Query contains potentially unsafe characters',
          'UNSAFE_QUERY',
          { pattern }
        );
      }
    }

    return trimmed;
  }

  sanitizeFilename(filename) {
    // Remove any path traversal attempts
    let safe = filename.replace(/\.\./g, '');

    // Remove dangerous characters
    safe = safe.replace(/[^a-z0-9_\-\.]/gi, '_');

    // Limit length
    if (safe.length > 200) {
      const ext = path.extname(safe);
      safe = safe.substring(0, 200 - ext.length) + ext;
    }

    // Ensure it's not empty
    if (safe.length === 0) {
      safe = 'download_' + Date.now();
    }

    return safe;
  }

  async retryWithBackoff(fn, retries = 3, baseDelay = 1000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === retries) {
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`  Retry ${attempt + 1}/${retries} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async search(query, limit = 5) {
    // Show copyright warning and get consent
    const consented = await this.showCopyrightWarning();
    if (!consented) {
      throw new BookFinderError(
        'Search cancelled by user',
        'USER_DECLINED',
        { reason: 'Copyright warning not accepted' }
      );
    }

    const validQuery = this.validateQuery(query);

    if (limit < 1 || limit > 100) {
      throw new BookFinderError(
        'Limit must be between 1 and 100',
        'INVALID_LIMIT',
        { limit }
      );
    }

    console.log(`Searching for: "${validQuery}"`);
    console.log(`Trying ${this.sources.length} sources...\n`);

    const errors = [];

    // Try each source in priority order
    for (const source of this.sources.sort((a, b) => a.priority - b.priority)) {
      try {
        console.log(`  [${source.name}] Searching...`);

        const results = await this.retryWithBackoff(
          () => this.searchSource(source, validQuery),
          source.retries
        );

        if (results && results.length > 0) {
          console.log(`  [${source.name}] ✓ Found ${results.length} results\n`);
          return results.slice(0, limit);
        } else {
          console.log(`  [${source.name}] No results found\n`);
        }
      } catch (error) {
        const errorMsg = error.message || 'Unknown error';
        console.log(`  [${source.name}] ✗ Failed: ${errorMsg}\n`);
        errors.push({ source: source.name, error: errorMsg });
        continue;
      }
    }

    // All sources failed
    throw new BookFinderError(
      'All search sources failed',
      'ALL_SOURCES_FAILED',
      { query: validQuery, errors }
    );
  }

  async searchSource(source, query) {
    const timeout = source.timeout || 30000;

    if (source.name === 'LibGen') {
      return await this.searchLibGen(query, timeout);
    } else if (source.name === 'AnnaArchive') {
      return await this.searchAnnaArchive(query, timeout);
    } else if (source.name === 'ZLib') {
      return await this.searchZLib(query, timeout);
    }

    throw new BookFinderError(
      `Unknown source: ${source.name}`,
      'UNKNOWN_SOURCE'
    );
  }

  async searchLibGen(query, timeout) {
    const searchQuery = encodeURIComponent(query);
    const url = `http://libgen.rs/search.php?req=${searchQuery}&res=100&view=simple&phrase=1&column=def`;

    try {
      // Add timeout and max size limit
      const { stdout, stderr } = await execAsync(
        `curl -s -L -m ${timeout / 1000} --max-filesize 10485760 "${url}"`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      if (stderr) {
        throw new Error(`curl stderr: ${stderr}`);
      }

      const results = this.parseLibGenHTML(stdout);
      return results.map(r => ({ ...r, source: 'LibGen' }));
    } catch (error) {
      throw new BookFinderError(
        'LibGen search failed',
        'LIBGEN_SEARCH_FAILED',
        { error: error.message }
      );
    }
  }

  parseLibGenHTML(html) {
    const results = [];

    try {
      // Simple regex parsing (robust against HTML variations)
      const rowPattern = /<tr[^>]*>.*?<\/tr>/gs;
      const rows = html.match(rowPattern) || [];

      for (const row of rows.slice(1, 21)) { // Max 20 results
        try {
          // Extract title
          const titleMatch = row.match(/<a[^>]*title="([^"]*)"[^>]*>([^<]+)<\/a>/);
          if (!titleMatch) continue;

          const title = (titleMatch[1] || titleMatch[2]).trim();
          if (!title || title.length === 0) continue;

          // Extract author (second <td> usually)
          const cellMatches = row.match(/<td[^>]*>(.*?)<\/td>/g);
          let author = 'Unknown';
          if (cellMatches && cellMatches.length > 1) {
            author = cellMatches[1]
              .replace(/<[^>]*>/g, '')
              .trim()
              .substring(0, 100);
          }

          // Extract download link
          const linkMatch = row.match(/href="([^"]*md5=[^"]*)"/);
          if (!linkMatch) continue;

          const downloadPage = linkMatch[1].startsWith('http')
            ? linkMatch[1]
            : `http://libgen.rs/${linkMatch[1]}`;

          // Extract file info if available
          const sizeMatch = row.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB)/i);
          const size = sizeMatch ? `${sizeMatch[1]}${sizeMatch[2]}` : null;

          results.push({
            title: title.substring(0, 200),
            author: author || 'Unknown',
            downloadUrl: downloadPage,
            format: 'pdf',
            size: size
          });
        } catch (e) {
          // Skip malformed rows
          continue;
        }
      }
    } catch (error) {
      throw new BookFinderError(
        'Failed to parse LibGen results',
        'PARSE_ERROR',
        { error: error.message }
      );
    }

    return results;
  }

  async searchAnnaArchive(query, timeout) {
    const searchQuery = encodeURIComponent(query);
    const url = `https://annas-archive.org/search?q=${searchQuery}`;

    try {
      const { stdout, stderr } = await execAsync(
        `curl -s -L -m ${timeout / 1000} --max-filesize 10485760 "${url}"`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      if (stderr) {
        throw new Error(`curl stderr: ${stderr}`);
      }

      const results = this.parseAnnaArchiveHTML(stdout);
      return results.map(r => ({ ...r, source: 'AnnaArchive' }));
    } catch (error) {
      throw new BookFinderError(
        "Anna's Archive search failed",
        'ANNA_SEARCH_FAILED',
        { error: error.message }
      );
    }
  }

  parseAnnaArchiveHTML(html) {
    const results = [];

    try {
      const linkPattern = /<a[^>]*href="\/md5\/([^"]*)"[^>]*>(.*?)<\/a>/gs;
      const matches = html.matchAll(linkPattern);

      let count = 0;
      for (const match of matches) {
        if (count >= 20) break; // Limit results

        const md5 = match[1];
        const title = match[2].replace(/<[^>]*>/g, '').trim();

        if (title && md5 && title.length > 0) {
          results.push({
            title: title.substring(0, 200),
            author: 'Unknown',
            downloadUrl: `https://annas-archive.org/md5/${md5}`,
            format: 'pdf'
          });
          count++;
        }
      }
    } catch (error) {
      throw new BookFinderError(
        "Failed to parse Anna's Archive results",
        'PARSE_ERROR',
        { error: error.message }
      );
    }

    return results;
  }

  async searchZLib(query, timeout) {
    // Z-Library often requires authentication
    // Return empty for now, can be implemented later
    return [];
  }

  async download(book) {
    if (!book || !book.downloadUrl) {
      throw new BookFinderError(
        'Invalid book object',
        'INVALID_BOOK',
        { book }
      );
    }

    console.log(`Downloading from ${book.source}...`);

    // Generate safe filename
    const baseFilename = this.sanitizeFilename(book.title);
    const filename = `${baseFilename}.pdf`;
    const outputPath = path.join(this.downloadDir, filename);

    // Check if file already exists
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      if (stats.size > this.minFileSize) {
        console.log(`File already exists: ${outputPath}`);
        return outputPath;
      }
    }

    try {
      if (book.source === 'LibGen') {
        return await this.downloadFromLibGen(book.downloadUrl, outputPath);
      } else if (book.source === 'AnnaArchive') {
        return await this.downloadFromAnnaArchive(book.downloadUrl, outputPath);
      } else {
        throw new BookFinderError(
          `Download not supported for source: ${book.source}`,
          'UNSUPPORTED_SOURCE'
        );
      }
    } catch (error) {
      // Clean up partial download
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      throw error;
    }
  }

  async downloadFromLibGen(pageUrl, outputPath) {
    try {
      // First, fetch the download page to get actual PDF link
      const { stdout: pageHtml } = await execAsync(
        `curl -s -L -m 30 --max-filesize 5242880 "${pageUrl}"`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      // Look for direct download link
      const linkMatch = pageHtml.match(/href="(https?:\/\/[^"]*\.pdf[^"]*)"/i);

      if (!linkMatch) {
        // Try alternative download sources
        const altMatch = pageHtml.match(/<a[^>]*href="([^"]*)"[^>]*>GET<\/a>/i);

        if (altMatch) {
          const downloadUrl = altMatch[1];
          await this.downloadFile(downloadUrl, outputPath);
          return outputPath;
        }

        throw new BookFinderError(
          'Could not find PDF download link',
          'NO_DOWNLOAD_LINK'
        );
      }

      const pdfUrl = linkMatch[1];
      await this.downloadFile(pdfUrl, outputPath);

      return outputPath;
    } catch (error) {
      throw new BookFinderError(
        'LibGen download failed',
        'LIBGEN_DOWNLOAD_FAILED',
        { error: error.message }
      );
    }
  }

  async downloadFromAnnaArchive(pageUrl, outputPath) {
    try {
      // Fetch download page
      const { stdout: pageHtml } = await execAsync(
        `curl -s -L -m 30 --max-filesize 5242880 "${pageUrl}"`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      // Look for download button/link
      const linkMatch = pageHtml.match(/href="([^"]*download[^"]*)"/i);

      if (!linkMatch) {
        throw new BookFinderError(
          'Could not find download link',
          'NO_DOWNLOAD_LINK'
        );
      }

      const downloadUrl = linkMatch[1].startsWith('http')
        ? linkMatch[1]
        : `https://annas-archive.org${linkMatch[1]}`;

      await this.downloadFile(downloadUrl, outputPath);

      return outputPath;
    } catch (error) {
      throw new BookFinderError(
        "Anna's Archive download failed",
        'ANNA_DOWNLOAD_FAILED',
        { error: error.message }
      );
    }
  }

  async downloadFile(url, outputPath) {
    // Validate URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new BookFinderError(
        'Invalid URL protocol',
        'INVALID_URL',
        { url }
      );
    }

    const maxSizeMB = Math.floor(this.maxFileSize / (1024 * 1024));

    try {
      // Download with size limit and timeout
      await execAsync(
        `curl -L -o "${outputPath}" -m 600 --max-filesize ${this.maxFileSize} "${url}"`,
        { maxBuffer: 100 * 1024 * 1024, timeout: 600000 }
      );

      // Verify download
      if (!fs.existsSync(outputPath)) {
        throw new Error('File was not created');
      }

      const stats = fs.statSync(outputPath);

      if (stats.size < this.minFileSize) {
        fs.unlinkSync(outputPath);
        throw new Error(`File too small (${stats.size} bytes)`);
      }

      if (stats.size > this.maxFileSize) {
        fs.unlinkSync(outputPath);
        throw new Error(`File too large (${stats.size} bytes, max ${this.maxFileSize})`);
      }

      console.log(`Downloaded: ${stats.size} bytes`);

    } catch (error) {
      throw new BookFinderError(
        'Download failed',
        'DOWNLOAD_FAILED',
        { error: error.message, url, outputPath }
      );
    }
  }

  async verify(filePath) {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      const stats = fs.statSync(filePath);

      if (stats.size < this.minFileSize) {
        return false;
      }

      // Try to verify it's a valid PDF
      const { stdout } = await execAsync(`pdfinfo "${filePath}" 2>&1`);
      return stdout.includes('Pages:');
    } catch (error) {
      // pdfinfo not available or file invalid
      return false;
    }
  }

  getStats() {
    const downloads = fs.readdirSync(this.downloadDir);
    const totalSize = downloads.reduce((sum, file) => {
      try {
        const stats = fs.statSync(path.join(this.downloadDir, file));
        return sum + stats.size;
      } catch (e) {
        return sum;
      }
    }, 0);

    return {
      downloads: downloads.length,
      totalSize,
      directory: this.downloadDir
    };
  }

  cleanup(daysOld = 7) {
    const now = Date.now();
    const maxAge = daysOld * 24 * 60 * 60 * 1000;

    try {
      const files = fs.readdirSync(this.downloadDir);
      let removed = 0;

      for (const file of files) {
        const filePath = path.join(this.downloadDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            removed++;
          }
        } catch (e) {
          // Skip files we can't access
          continue;
        }
      }

      return { removed, total: files.length };
    } catch (error) {
      throw new BookFinderError(
        'Cleanup failed',
        'CLEANUP_FAILED',
        { error: error.message }
      );
    }
  }
}

export default BookFinder;
export { BookFinderError };
