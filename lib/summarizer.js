#!/usr/bin/env node

/**
 * Text Summarizer
 * Generates analytical summaries of documents
 * Target: 2-5% of original word count
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class Summarizer {
  constructor(options = {}) {
    this.targetRatio = options.targetRatio || 0.03; // 3% default
    this.minRatio = 0.02; // 2% minimum
    this.maxRatio = 0.05; // 5% maximum
    this.model = options.model || 'ollama'; // 'ollama' or 'python'
  }

  /**
   * Generate summary of text
   * @param {string} text - Full text to summarize
   * @param {object} options - Summary options
   * @returns {object} - Summary result
   */
  async summarize(text, options = {}) {
    const wordCount = this.countWords(text);

    // Determine target summary length based on document size
    const targetWords = this.calculateTargetLength(wordCount);

    console.log(`Original: ${wordCount.toLocaleString()} words`);
    console.log(`Target summary: ${targetWords.toLocaleString()} words (${(targetWords/wordCount*100).toFixed(1)}%)`);

    // Generate summary
    const summary = await this.generateSummary(text, targetWords, options);

    const summaryWords = this.countWords(summary);
    const ratio = (summaryWords / wordCount * 100).toFixed(1);

    return {
      original: text,
      summary,
      stats: {
        originalWords: wordCount,
        summaryWords,
        ratio: `${ratio}%`,
        targetWords
      }
    };
  }

  /**
   * Calculate target summary length based on document size
   */
  calculateTargetLength(wordCount) {
    let ratio;

    if (wordCount < 5000) {
      // Short documents: 5% (more detail needed)
      ratio = this.maxRatio;
    } else if (wordCount < 20000) {
      // Medium documents: 3-4%
      ratio = 0.035;
    } else if (wordCount < 50000) {
      // Long documents: 2.5-3%
      ratio = 0.028;
    } else {
      // Very long documents: 2% (books)
      ratio = this.minRatio;
    }

    return Math.round(wordCount * ratio);
  }

  /**
   * Count words in text
   */
  countWords(text) {
    return text.trim().split(/\s+/).length;
  }

  /**
   * Generate summary using available LLM
   */
  async generateSummary(text, targetWords, options = {}) {
    // Try Ollama first (local, fast)
    try {
      return await this.summarizeWithOllama(text, targetWords, options);
    } catch (error) {
      console.warn('Ollama not available, trying Python...');
    }

    // Fallback to Python summarization
    try {
      return await this.summarizeWithPython(text, targetWords, options);
    } catch (error) {
      console.warn('Python summarization failed, using extractive summary...');
    }

    // Final fallback: extractive summary (no LLM)
    return this.extractiveSummary(text, targetWords);
  }

  /**
   * Summarize using Ollama (local LLM)
   */
  async summarizeWithOllama(text, targetWords, options = {}) {
    // Check if Ollama is available
    try {
      await execAsync('which ollama');
    } catch {
      throw new Error('Ollama not available');
    }

    const model = options.model || 'llama3.2:latest'; // Fast, good quality
    const chunkSize = 8000; // Ollama context limit
    const chunks = this.chunkText(text, chunkSize);

    console.log(`Using Ollama (${model}) for summarization...`);

    // If text is short enough, summarize directly
    if (chunks.length === 1) {
      return await this.summarizeChunkOllama(text, targetWords, model);
    }

    // For long texts: summarize chunks, then summarize summaries
    console.log(`Processing ${chunks.length} chunks...`);
    const chunkSummaries = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkWords = Math.ceil(targetWords / chunks.length);
      console.log(`  Chunk ${i+1}/${chunks.length}...`);
      const summary = await this.summarizeChunkOllama(chunks[i], chunkWords, model);
      chunkSummaries.push(summary);
    }

    // Combine and final summarization
    const combined = chunkSummaries.join('\n\n');
    console.log('Generating final summary...');
    return await this.summarizeChunkOllama(combined, targetWords, model);
  }

  /**
   * Summarize a single chunk with Ollama
   */
  async summarizeChunkOllama(text, targetWords, model) {
    const prompt = this.buildSummaryPrompt(text, targetWords);

    // Create temp file for input (avoid shell escaping issues)
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const tempFile = join(tmpdir(), `voicci-summary-${Date.now()}.txt`);
    writeFileSync(tempFile, prompt);

    try {
      const { stdout } = await execAsync(
        `ollama run ${model} < "${tempFile}"`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );

      return stdout.trim();
    } finally {
      unlinkSync(tempFile);
    }
  }

  /**
   * Build summary prompt
   */
  buildSummaryPrompt(text, targetWords) {
    return `You are an expert at creating analytical summaries of documents.

Your task: Create a clean, analytical summary of the following text.

Requirements:
- Length: Approximately ${targetWords} words
- Style: Analytical and objective
- Vocabulary: Clear, non-specialized language
- Specificity: Retain key details, names, numbers, and facts
- Structure: Organize logically with clear flow
- Clarity: Explain complex concepts in simple terms

DO NOT:
- Add your own opinions or commentary
- Use phrases like "this document discusses" or "the author argues"
- Include meta-commentary about the summary itself
- Use overly academic or specialized jargon

FOCUS ON:
- Main arguments and conclusions
- Key facts and evidence
- Important concepts and their explanations
- Logical flow and structure

TEXT TO SUMMARIZE:
${text}

ANALYTICAL SUMMARY:`;
  }

  /**
   * Summarize using Python (alternative)
   */
  async summarizeWithPython(text, targetWords, options = {}) {
    // TODO: Implement Python-based summarization
    // Could use transformers library (BART, T5)
    throw new Error('Python summarization not yet implemented');
  }

  /**
   * Extractive summary (fallback - no LLM needed)
   * Selects most important sentences
   */
  extractiveSummary(text, targetWords) {
    console.log('Using extractive summarization (no LLM)...');

    // Split into sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    // Score sentences by importance
    const scored = sentences.map(sentence => {
      const score = this.scoreSentence(sentence, text);
      return { sentence: sentence.trim(), score };
    });

    // Sort by score and select top sentences
    scored.sort((a, b) => b.score - a.score);

    // Select sentences until target word count
    let wordCount = 0;
    const selected = [];

    for (const item of scored) {
      const words = this.countWords(item.sentence);
      if (wordCount + words <= targetWords * 1.2) { // Allow 20% overage
        selected.push(item);
        wordCount += words;
      }
      if (wordCount >= targetWords) break;
    }

    // Sort selected sentences by original order
    const sentenceOrder = new Map(sentences.map((s, i) => [s.trim(), i]));
    selected.sort((a, b) => {
      const orderA = sentenceOrder.get(a.sentence) || 0;
      const orderB = sentenceOrder.get(b.sentence) || 0;
      return orderA - orderB;
    });

    return selected.map(s => s.sentence).join(' ');
  }

  /**
   * Score sentence importance (simple heuristic)
   */
  scoreSentence(sentence, fullText) {
    let score = 0;

    // Length penalty (very short or very long sentences)
    const words = this.countWords(sentence);
    if (words < 5 || words > 40) {
      score -= 2;
    }

    // Position bonus (early sentences often important)
    const position = fullText.indexOf(sentence) / fullText.length;
    if (position < 0.2) score += 2; // Introduction
    if (position > 0.8) score += 1; // Conclusion

    // Keyword bonus (numbers, capitalized words)
    if (/\d+/.test(sentence)) score += 1; // Contains numbers
    if (/[A-Z][a-z]+/.test(sentence)) score += 1; // Proper nouns

    // Question/imperative penalty (usually not key info)
    if (/[?!]/.test(sentence)) score -= 1;

    return score;
  }

  /**
   * Chunk text into smaller pieces for LLM processing
   */
  chunkText(text, maxWords) {
    const words = text.split(/\s+/);
    const chunks = [];

    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords).join(' ');
      chunks.push(chunk);
    }

    return chunks;
  }

  /**
   * Check if Ollama is available
   */
  async checkOllama() {
    try {
      await execAsync('which ollama');
      const { stdout } = await execAsync('ollama list');
      return {
        available: true,
        models: stdout.split('\n')
          .slice(1)
          .filter(line => line.trim())
          .map(line => line.split(/\s+/)[0])
      };
    } catch {
      return { available: false, models: [] };
    }
  }
}

export default Summarizer;
