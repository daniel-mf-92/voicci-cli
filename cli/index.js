#!/usr/bin/env node

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import config from '../lib/config.js';
import configManager from '../lib/config-manager.js';
import MemoryMonitor from '../lib/memory-monitor.js';
import TextCleaner from '../lib/text-cleaner.js';
import Summarizer from '../lib/summarizer.js';
import Queue from '../lib/queue.js';
import pathValidator from '../lib/path-validator.js';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Cross-platform open command
function getOpenCommand() {
  const platform = process.platform;
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  return 'xdg-open'; // Linux
}

// Check if Python TTS dependencies are available
async function checkTTSDependencies() {
  try {
    await execFileAsync('python3', ['-c', 'from TTS.api import TTS; print("ok")']);
    return true;
  } catch {
    return false;
  }
}

// Check if input looks like a file path (has a supported extension)
function looksLikeFilePath(input) {
  const ext = path.extname(input).toLowerCase();
  return ['.pdf', '.txt'].includes(ext);
}

const program = new Command();

program
  .name('voicci')
  .description('AI Audiobook Generator using XTTS v2')
  .version(pkg.version);

program
  .argument('[input]', 'PDF/TXT file or book/paper name to convert')
  .option('-s, --status [jobId]', 'Check job status (all jobs if no ID)')
  .option('-l, --list', 'List all audiobooks')
  .option('-d, --delete <jobId>', 'Delete audiobook')
  .option('-o, --open [jobId]', 'Open audiobook folder')
  .option('--cancel <jobId>', 'Cancel running job')
  .option('--search <query>', 'Search for book/paper without downloading')
  .option('--summary', 'Generate text summary only (no audio)')
  .option('--with-summary', 'Generate both audiobook and summary')
  .action(async (input, options) => {
    try {
      // Status check
      if (options.status !== undefined) {
        await showStatus(options.status);
        return;
      }

      // List audiobooks
      if (options.list) {
        await listAudiobooks();
        return;
      }

      // Delete audiobook
      if (options.delete) {
        await deleteAudiobook(options.delete);
        return;
      }

      // Open audiobook folder
      if (options.open !== undefined) {
        await openAudiobook(options.open);
        return;
      }

      // Cancel job
      if (options.cancel) {
        await cancelJob(options.cancel);
        return;
      }

      // Search for book
      if (options.search) {
        await searchBook(options.search);
        return;
      }

      // Process file or search query
      if (input) {
        if (looksLikeFilePath(input)) {
          // Input has a recognized file extension — must exist
          if (!fs.existsSync(input)) {
            console.error(`Error: File not found: ${input}`);
            process.exit(1);
          }
          const validatedPath = pathValidator.validateFilePath(input, {
            mustExist: true,
            allowedExtensions: ['.pdf', '.txt']
          });
          await processFile(validatedPath, options);
        } else if (fs.existsSync(input)) {
          // Existing file without recognized extension
          const validatedPath = pathValidator.validateFilePath(input, {
            mustExist: true,
            allowedExtensions: ['.pdf', '.txt']
          });
          await processFile(validatedPath, options);
        } else {
          // Treat as search query
          console.log(`Searching for: "${input}"\n`);
          await searchAndDownload(input, options);
        }
      } else {
        program.help();
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

async function processFile(filePath, options = {}) {
  const summaryOnly = options.summary === true;
  const withSummary = options.withSummary === true;

  console.log(summaryOnly ? '📝 Voicci - Summary Generator\n' : '🎧 Voicci - Audiobook Generator\n');
  console.log(`Processing: ${path.basename(filePath)}\n`);

  // Initialize configuration
  await configManager.init();
  const settings = configManager.getActiveSettings();

  // Validate file
  const ext = filePath.toLowerCase().split('.').pop();
  if (!['pdf', 'txt'].includes(ext)) {
    throw new Error('Unsupported file type. Use PDF or TXT files.');
  }

  // Check file size
  const stats = fs.statSync(filePath);
  const fileSizeMB = stats.size / (1024 * 1024);
  const maxSizeMB = settings.maxFileSize / (1024 * 1024);

  if (stats.size > settings.maxFileSize) {
    console.error(`\n❌ File too large: ${fileSizeMB.toFixed(1)}MB (max: ${maxSizeMB.toFixed(0)}MB)`);
    console.log(`\nYour current memory profile (${settings.memoryProfile}) limits file size.`);
    console.log(`To process larger files, switch to a higher profile:\n`);
    console.log(`  voicci config set-profile high  # Supports up to 500MB files\n`);
    throw new Error('File exceeds size limit for current memory profile');
  }

  console.log(`File size: ${fileSizeMB.toFixed(1)}MB (within ${maxSizeMB.toFixed(0)}MB limit)`);
  console.log(`Memory profile: ${settings.memoryProfile}\n`);

  // Clean text
  console.log('📖 Extracting and cleaning text...');
  const cleaner = new TextCleaner();
  const result = await cleaner.processFile(filePath);

  console.log(`✓ Extracted ${result.stats.originalLength.toLocaleString()} characters`);
  console.log(`✓ Cleaned to ${result.stats.cleanedLength.toLocaleString()} characters (${result.stats.reductionPercent}% reduction)`);
  console.log(`✓ Detected ${result.chapters.length} chapters\n`);

  // If summary requested, generate it
  if (summaryOnly || withSummary) {
    await generateSummary(filePath, result.cleanedText, summaryOnly);
    if (summaryOnly) return; // Don't create audiobook job
  }

  // Check Python TTS dependencies before creating job
  const hasTTS = await checkTTSDependencies();
  if (!hasTTS) {
    console.error('\n❌ Python TTS dependencies not found.');
    console.error('\nTo generate audiobooks, install the required Python packages:');
    console.error('  pip3 install TTS torch torchaudio\n');
    console.error('This is a one-time setup (~2GB download).');
    console.error('After installing, run your command again.\n');
    throw new Error('Python TTS dependencies not installed');
  }

  // Create job
  console.log('📋 Creating job...');
  const queue = new Queue();
  const job = queue.createJob(filePath, result.chapters);

  console.log(`✓ Job created: ${job.jobId}`);
  console.log(`✓ Title: ${job.title}`);
  console.log(`✓ Chapters: ${job.chapters}`);
  console.log(`✓ Total words: ${job.totalWords.toLocaleString()}`);
  console.log(`✓ Estimated time: ~${job.estimatedMinutes} minutes\n`);

  // Start background worker
  console.log('🚀 Starting background worker...');
  await startWorker();

  console.log('\n✅ Job queued successfully!\n');
  console.log('Monitor progress:');
  console.log(`  voicci -s ${job.jobId}\n`);

  queue.close();
}

async function generateSummary(filePath, text, summaryOnly = false) {
  console.log('📝 Generating summary...\n');

  const summarizer = new Summarizer();
  const result = await summarizer.summarize(text);

  // Save summary to file
  const outputDir = path.join(
    config.paths.audiobooks,
    path.basename(filePath, path.extname(filePath)) + '-summary'
  );

  fs.mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'summary.txt');
  fs.writeFileSync(summaryPath, result.summary);

  // Save metadata
  const metadataPath = path.join(outputDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify({
    source: filePath,
    generated: new Date().toISOString(),
    stats: result.stats
  }, null, 2));

  console.log('✅ Summary generated!\n');
  console.log('📊 Statistics:');
  console.log(`  Original: ${result.stats.originalWords.toLocaleString()} words`);
  console.log(`  Summary: ${result.stats.summaryWords.toLocaleString()} words`);
  console.log(`  Ratio: ${result.stats.ratio}\n`);
  console.log(`📄 Saved to: ${summaryPath}\n`);

  if (summaryOnly) {
    console.log('Preview (first 500 chars):\n');
    console.log('─'.repeat(60));
    console.log(result.summary.substring(0, 500) + '...\n');
    console.log('─'.repeat(60));
    console.log(`\nOpen full summary: ${getOpenCommand()} "${summaryPath}"\n`);
  }
}

async function searchBook(query) {
  console.log(`🔍 Searching for: "${query}"\n`);

  // Import book finder
  const { default: BookFinder } = await import('../lib/book-finder.js');
  const finder = new BookFinder();

  const results = await finder.search(query);

  if (results.length === 0) {
    console.log('No results found.\n');
    return;
  }

  console.log(`Found ${results.length} results:\n`);

  results.forEach((book, i) => {
    console.log(`${i + 1}. ${book.title}`);
    if (book.author) console.log(`   Author: ${book.author}`);
    if (book.year) console.log(`   Year: ${book.year}`);
    if (book.pages) console.log(`   Pages: ${book.pages}`);
    if (book.size) console.log(`   Size: ${book.size}`);
    console.log(`   Source: ${book.source}`);
    console.log();
  });
}

async function searchAndDownload(query, options = {}) {
  console.log('📚 Book Finder Mode\n');

  // Import book finder
  const { default: BookFinder } = await import('../lib/book-finder.js');
  const finder = new BookFinder();

  // Search
  console.log(`🔍 Searching for: "${query}"`);
  const results = await finder.search(query);

  if (results.length === 0) {
    console.log('\n❌ No results found.\n');
    console.log('Try:');
    console.log('  - Different spelling');
    console.log('  - Author name');
    console.log('  - ISBN number\n');
    return;
  }

  // Show top result
  const book = results[0];
  console.log(`\n✓ Found: ${book.title}`);
  if (book.author) console.log(`  Author: ${book.author}`);
  if (book.year) console.log(`  Year: ${book.year}`);
  console.log(`  Source: ${book.source}\n`);

  // Download
  console.log('📥 Downloading...');
  const filePath = await finder.download(book);

  console.log(`✓ Downloaded to: ${filePath}\n`);

  // Process the file
  await processFile(filePath, options);
}

async function showStatus(jobId) {
  const queue = new Queue();

  if (jobId === true || !jobId) {
    // Show all jobs
    const jobs = queue.getAllJobs();

    if (jobs.length === 0) {
      console.log('No jobs found.\n');
      queue.close();
      return;
    }

    console.log('📊 All Jobs:\n');
    jobs.forEach(job => {
      const progress = job.total_chapters > 0
        ? ((job.completed_chapters / job.total_chapters) * 100).toFixed(0)
        : 0;

      console.log(`${getStatusIcon(job.status)} ${job.title}`);
      console.log(`   ID: ${job.id}`);
      console.log(`   Status: ${job.status} (${job.completed_chapters}/${job.total_chapters} chapters, ${progress}%)`);
      if (job.output_dir) {
        console.log(`   Output: ${job.output_dir}`);
      }
      console.log();
    });
  } else {
    // Show specific job with live UI
    const job = queue.getJob(jobId);

    if (!job) {
      console.log(`Job not found: ${jobId}\n`);
      queue.close();
      return;
    }

    // Launch progress UI
    const { default: renderProgressUI } = await import('./progress-ui.js');
    await renderProgressUI(jobId);
  }

  queue.close();
}

function getStatusIcon(status) {
  const icons = {
    pending: '⏳',
    processing: '🔄',
    completed: '✅',
    failed: '❌'
  };
  return icons[status] || '❓';
}

async function listAudiobooks() {
  const queue = new Queue();
  const jobs = queue.getAllJobs().filter(j => j.status === 'completed');

  if (jobs.length === 0) {
    console.log('No completed audiobooks.\n');
    queue.close();
    return;
  }

  console.log('🎧 Completed Audiobooks:\n');

  jobs.forEach((job, i) => {
    console.log(`${i + 1}. ${job.title}`);
    console.log(`   ID: ${job.id}`);
    console.log(`   Chapters: ${job.total_chapters}`);
    console.log(`   Location: ${job.output_dir}`);
    console.log(`   Completed: ${new Date(job.completed_at).toLocaleString()}`);
    console.log();
  });

  queue.close();
}

async function deleteAudiobook(jobId) {
  const queue = new Queue();
  const job = queue.getJob(jobId);

  if (!job) {
    console.log(`Job not found: ${jobId}\n`);
    queue.close();
    return;
  }

  // Delete files
  if (job.output_dir && fs.existsSync(job.output_dir)) {
    fs.rmSync(job.output_dir, { recursive: true, force: true });
    console.log(`✓ Deleted files: ${job.output_dir}`);
  }

  // Delete from database
  queue.deleteJob(jobId);
  console.log(`✓ Deleted job: ${job.title}\n`);

  queue.close();
}

async function openAudiobook(jobId) {
  const queue = new Queue();

  if (jobId === true || !jobId) {
    // Open audiobooks directory
    const audiobooksDir = config.paths.audiobooks;
    await execFileAsync(getOpenCommand(), [audiobooksDir]);
    console.log(`Opened: ${audiobooksDir}\n`);
  } else {
    // Open specific job
    const job = queue.getJob(jobId);

    if (!job) {
      console.log(`Job not found: ${jobId}\n`);
      queue.close();
      return;
    }

    if (!job.output_dir || !fs.existsSync(job.output_dir)) {
      console.log(`Output directory not found for job: ${jobId}\n`);
      queue.close();
      return;
    }

    await execFileAsync(getOpenCommand(), [job.output_dir]);
    console.log(`Opened: ${job.output_dir}\n`);
  }

  queue.close();
}

async function cancelJob(jobId) {
  const queue = new Queue();
  const job = queue.getJob(jobId);

  if (!job) {
    console.log(`Job not found: ${jobId}\n`);
    queue.close();
    return;
  }

  if (job.status === 'completed') {
    console.log(`Job already completed: ${jobId}\n`);
    queue.close();
    return;
  }

  queue.updateJobStatus(jobId, 'failed', 'Cancelled by user');
  console.log(`✓ Cancelled job: ${job.title}\n`);

  queue.close();
}

async function startWorker() {
  const workerPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../backend/worker.js');

  // Start detached worker process
  const worker = spawn('node', [workerPath], {
    detached: true,
    stdio: 'ignore'
  });

  worker.unref();

  console.log(`✓ Worker started (PID: ${worker.pid})`);
}

// ============================================================================
// Configuration Commands
// ============================================================================

const configCmd = program
  .command('config')
  .description('Manage Voicci configuration');

// Show current configuration
configCmd
  .command('show')
  .description('Show current configuration and system info')
  .action(async () => {
    await configManager.init();
    const summary = configManager.getSummary();

    console.log('\n📊 Voicci Configuration\n');
    console.log('═'.repeat(60));

    // System info
    console.log('\n🖥️  SYSTEM:');
    console.log(`  RAM: ${summary.system.ram}`);
    console.log(`  CPUs: ${summary.system.cpus} cores`);
    console.log(`  Platform: ${summary.system.platform}`);
    console.log(`  Node: ${summary.system.node}`);

    // Current settings
    console.log('\n⚙️  CURRENT PROFILE:');
    console.log(`  Memory: ${summary.current.memoryProfile.name} ${summary.current.memoryProfile.manually ? '(manually set)' : '(auto-detected)'}`);
    console.log(`  Quality: ${summary.current.qualityPreset.name}`);

    console.log('\n📝 ACTIVE SETTINGS:');
    console.log(`  Max file size: ${summary.settings.maxFileSize}`);
    console.log(`  Max concurrent jobs: ${summary.settings.maxConcurrentJobs}`);
    console.log(`  Chunk size: ${summary.settings.chunkSize}`);
    console.log(`  Memory monitoring: ${summary.settings.memoryMonitoring}`);
    console.log(`  Memory threshold: ${summary.settings.memoryThreshold}`);
    console.log(`  TTS speed: ${summary.settings.ttsSpeed}`);
    console.log(`  Temperature: ${summary.settings.temperature}`);

    // Recommendations
    if (summary.recommendations.length > 0) {
      console.log('\n💡 RECOMMENDATIONS:');
      summary.recommendations.forEach((rec, i) => {
        console.log(`\n  ${i + 1}. ${rec.reason}`);
        if (rec.command) {
          console.log(`     Run: ${rec.command}`);
        }
      });
    }

    console.log('\n═'.repeat(60));
    console.log(`Config file: ${configManager.getConfigPath()}`);
    console.log();
  });

// Set memory profile
configCmd
  .command('set-profile <profile>')
  .description('Set memory profile (low, medium, high)')
  .action(async (profile) => {
    try {
      await configManager.init();
      configManager.setMemoryProfile(profile);
      console.log(`✓ Memory profile set to: ${profile}\n`);

      // Show what changed
      const summary = configManager.getSummary();
      console.log('New settings:');
      console.log(`  Max file size: ${summary.settings.maxFileSize}`);
      console.log(`  Max concurrent jobs: ${summary.settings.maxConcurrentJobs}`);
      console.log(`  Memory monitoring: ${summary.settings.memoryMonitoring}\n`);
    } catch (error) {
      console.error('Error:', error.message);
      console.log('\nValid profiles: low, medium, high');
      console.log('Run "voicci config profiles" to see details\n');
      process.exit(1);
    }
  });

// Set quality preset
configCmd
  .command('set-quality <preset>')
  .description('Set quality preset (fast, balanced, best)')
  .action(async (preset) => {
    try {
      await configManager.init();
      configManager.setQualityPreset(preset);
      console.log(`✓ Quality preset set to: ${preset}\n`);

      const summary = configManager.getSummary();
      console.log('New settings:');
      console.log(`  TTS speed: ${summary.settings.ttsSpeed}`);
      console.log(`  Temperature: ${summary.settings.temperature}\n`);
    } catch (error) {
      console.error('Error:', error.message);
      console.log('\nValid presets: fast, balanced, best');
      console.log('Run "voicci config presets" to see details\n');
      process.exit(1);
    }
  });

// Set memory monitoring
configCmd
  .command('set-monitoring <state>')
  .description('Enable or disable memory monitoring (on/off)')
  .action(async (state) => {
    const enabled = state.toLowerCase() === 'on';

    if (!['on', 'off'].includes(state.toLowerCase())) {
      console.error('Error: State must be "on" or "off"\n');
      process.exit(1);
    }

    await configManager.init();
    configManager.setMemoryMonitoring(enabled);
    console.log(`✓ Memory monitoring ${enabled ? 'enabled' : 'disabled'}\n`);
  });

// Show recommendations
configCmd
  .command('recommend')
  .description('Show configuration recommendations for your system')
  .action(async () => {
    await configManager.init();
    const summary = configManager.getSummary();

    console.log('\n💡 Configuration Recommendations\n');
    console.log('═'.repeat(60));

    if (summary.recommendations.length === 0) {
      console.log('\n✅ Your configuration is optimized for your system!\n');
      return;
    }

    summary.recommendations.forEach((rec, i) => {
      console.log(`\n${i + 1}. ${rec.reason}`);
      if (rec.command) {
        console.log(`   Run: ${rec.command}`);
      }
    });

    console.log('\n═'.repeat(60));
    console.log();
  });

// List available profiles
configCmd
  .command('profiles')
  .description('List all available memory profiles')
  .action(async () => {
    const { MEMORY_PROFILES } = await import('../lib/config-manager.js');

    console.log('\n📊 Available Memory Profiles\n');
    console.log('═'.repeat(60));

    Object.entries(MEMORY_PROFILES).forEach(([key, profile]) => {
      console.log(`\n${key.toUpperCase()}: ${profile.name}`);
      console.log(`  ${profile.description}`);
      console.log(`  Max file: ${(profile.maxFileSize / (1024 * 1024)).toFixed(0)}MB`);
      console.log(`  Jobs: ${profile.maxConcurrentJobs} concurrent`);
      console.log(`  Monitoring: ${profile.enableMemoryMonitoring ? 'Enabled' : 'Disabled'} by default`);
    });

    console.log('\n═'.repeat(60));
    console.log('Set with: voicci config set-profile <profile>\n');
  });

// List available presets
configCmd
  .command('presets')
  .description('List all available quality presets')
  .action(async () => {
    const { QUALITY_PRESETS } = await import('../lib/config-manager.js');

    console.log('\n🎧 Available Quality Presets\n');
    console.log('═'.repeat(60));

    Object.entries(QUALITY_PRESETS).forEach(([key, preset]) => {
      console.log(`\n${key.toUpperCase()}: ${preset.name}`);
      console.log(`  ${preset.description}`);
      console.log(`  Speed: ${preset.ttsSpeed}`);
      console.log(`  Temperature: ${preset.temperature}`);
    });

    console.log('\n═'.repeat(60));
    console.log('Set with: voicci config set-quality <preset>\n');
  });

// Reset configuration
configCmd
  .command('reset')
  .description('Reset configuration to defaults')
  .action(async () => {
    await configManager.init();
    configManager.reset();
    console.log('✓ Configuration reset to defaults\n');

    const summary = configManager.getSummary();
    console.log('Current profile:', summary.current.memoryProfile.name);
    console.log('Current quality:', summary.current.qualityPreset.name);
    console.log();
  });

// ============================================================================
// Summary Command
// ============================================================================

program
  .command('summary <file>')
  .description('Generate analytical text summary (2-5% of original length)')
  .action(async (file) => {
    try {
      if (!fs.existsSync(file)) {
        console.error(`Error: File not found: ${file}\n`);
        process.exit(1);
      }

      await processFile(file, { summary: true });
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Memory Status Command
// ============================================================================

program
  .command('memory')
  .description('Show current memory status')
  .action(async () => {
    await configManager.init();
    const monitor = new MemoryMonitor();
    const stats = monitor.getMemoryStats();
    const settings = configManager.getActiveSettings();

    console.log('\n💾 Memory Status\n');
    console.log('═'.repeat(60));

    console.log('\n🖥️  SYSTEM MEMORY:');
    console.log(`  Total: ${monitor.formatBytes(stats.system.total)}`);
    console.log(`  Used: ${monitor.formatBytes(stats.system.used)} (${(stats.system.percent * 100).toFixed(1)}%)`);
    console.log(`  Free: ${monitor.formatBytes(stats.system.free)}`);

    console.log('\n📦 NODE.JS HEAP:');
    console.log(`  Used: ${monitor.formatBytes(stats.heap.used)}`);
    console.log(`  Total: ${monitor.formatBytes(stats.heap.total)}`);
    console.log(`  Limit: ${monitor.formatBytes(stats.heap.limit)}`);
    console.log(`  Usage: ${(stats.heap.percent * 100).toFixed(1)}%`);

    console.log('\n⚙️  SETTINGS:');
    console.log(`  Profile: ${configManager.config.memoryProfile}`);
    console.log(`  Monitoring: ${settings.enableMemoryMonitoring ? 'Enabled' : 'Disabled'}`);
    console.log(`  Threshold: ${(settings.memoryThreshold * 100).toFixed(0)}%`);

    // Status indicator
    let status = '✅ OK';
    if (stats.system.percent >= settings.memoryThreshold) {
      status = '⚠️  HIGH';
    }
    if (stats.system.percent >= 0.95) {
      status = '🚨 CRITICAL';
    }

    console.log(`\n  Status: ${status}`);

    console.log('\n═'.repeat(60));
    console.log();
  });

program
  .command('doctor')
  .description('Verify Node, Python, TTS, PyTorch, and AI-editor skill installation')
  .option('--json', 'Output machine-readable JSON')
  .action(async (options) => {
    const results = await runDoctor();
    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printDoctorReport(results);
    }
    const failed = results.checks.some(c => c.status === 'fail');
    process.exit(failed ? 1 : 0);
  });

async function runDoctor() {
  const os = await import('os');
  const checks = [];

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'Node.js ≥ 22',
    status: nodeMajor >= 22 ? 'pass' : 'fail',
    detail: `v${process.versions.node}`,
    fix: nodeMajor >= 22 ? null : 'Install Node 22+: https://nodejs.org/en/download',
  });

  let pythonCmd = null;
  let pythonVersion = null;
  for (const cand of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(cand, ['--version']);
      const m = stdout.match(/Python (\d+)\.(\d+)/);
      if (m) {
        pythonCmd = cand;
        pythonVersion = `${m[1]}.${m[2]}`;
        if (parseInt(m[1], 10) === 3 && parseInt(m[2], 10) >= 10) break;
      }
    } catch {}
  }
  const pyOk = pythonVersion && parseInt(pythonVersion.split('.')[0], 10) === 3 && parseInt(pythonVersion.split('.')[1], 10) >= 10;
  checks.push({
    name: 'Python ≥ 3.10',
    status: pyOk ? 'pass' : 'fail',
    detail: pythonVersion ? `${pythonCmd} ${pythonVersion}` : 'not found',
    fix: pyOk ? null : 'Install Python 3.10+: https://www.python.org/downloads/',
  });

  let torchOk = false, torchDetail = 'not importable';
  if (pythonCmd) {
    try {
      const { stdout } = await execFileAsync(pythonCmd, ['-c', 'import torch; print(torch.__version__)']);
      torchOk = true;
      torchDetail = `torch ${stdout.trim()}`;
    } catch {}
  }
  checks.push({
    name: 'PyTorch',
    status: torchOk ? 'pass' : 'fail',
    detail: torchDetail,
    fix: torchOk ? null : `${pythonCmd || 'pip3'} -m pip install torch torchaudio`,
  });

  let ttsOk = false, ttsDetail = 'not importable';
  if (pythonCmd) {
    try {
      const { stdout } = await execFileAsync(pythonCmd, ['-c', 'import TTS; print(TTS.__version__)']);
      ttsOk = true;
      ttsDetail = `TTS ${stdout.trim()}`;
    } catch {}
  }
  checks.push({
    name: 'TTS (XTTS v2)',
    status: ttsOk ? 'pass' : 'fail',
    detail: ttsDetail,
    fix: ttsOk ? null : `${pythonCmd || 'pip3'} -m pip install TTS`,
  });

  let accel = 'cpu';
  if (pythonCmd && torchOk) {
    try {
      const { stdout } = await execFileAsync(pythonCmd, ['-c',
        'import torch; print("mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu"))']);
      accel = stdout.trim();
    } catch {}
  }
  checks.push({
    name: 'Acceleration',
    status: accel === 'cpu' ? 'warn' : 'pass',
    detail: accel.toUpperCase(),
    fix: accel === 'cpu' ? 'CPU works but is slow. M-series/NVIDIA recommended.' : null,
  });

  const home = os.homedir();
  const skillPath = path.join(home, '.claude', 'skills', 'voicci', 'SKILL.md');
  const skillExists = fs.existsSync(skillPath);
  checks.push({
    name: 'Claude Code skill',
    status: skillExists ? 'pass' : 'warn',
    detail: skillExists ? skillPath : 'not installed (harmless if you do not use Claude Code)',
    fix: skillExists ? null : 'Re-run: npm install -g voicci',
  });

  return {
    voicciVersion: pkg.version,
    platform: process.platform,
    arch: process.arch,
    checks,
  };
}

function printDoctorReport(results) {
  console.log('\n🩺 Voicci Doctor\n');
  console.log(`   voicci@${results.voicciVersion}  ·  ${results.platform}/${results.arch}\n`);
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  for (const c of results.checks) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`   ${icon}  ${pad(c.name, 22)} ${c.detail}`);
    if (c.fix) console.log(`       ↳ ${c.fix}`);
  }
  const failed = results.checks.filter(c => c.status === 'fail');
  console.log('');
  if (failed.length === 0) {
    console.log('   🎉 All required prerequisites look good. You are ready to generate audiobooks.\n');
  } else {
    console.log(`   ${failed.length} check(s) failed. Fix them and re-run \`voicci doctor\`.\n`);
  }
}

program.parse();
