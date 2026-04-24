#!/usr/bin/env node

import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Config {
  constructor() {
    this.platform = os.platform();
    this.homeDir = os.homedir();
    this.paths = this.initPaths();
    this.ensureDirectories();
  }

  initPaths() {
    const base = {
      data: process.env.XDG_DATA_HOME ||
            (this.platform === 'darwin'
              ? path.join(this.homeDir, 'Library', 'Application Support', 'voicci')
              : path.join(this.homeDir, '.local', 'share', 'voicci')),
      config: process.env.XDG_CONFIG_HOME ||
              (this.platform === 'darwin'
                ? path.join(this.homeDir, 'Library', 'Application Support', 'voicci', 'config')
                : path.join(this.homeDir, '.config', 'voicci')),
      cache: process.env.XDG_CACHE_HOME ||
             (this.platform === 'darwin'
               ? path.join(this.homeDir, 'Library', 'Caches', 'voicci')
               : path.join(this.homeDir, '.cache', 'voicci'))
    };

    return {
      ...base,
      audiobooks: path.join(base.data, 'audiobooks'),
      queue: path.join(base.data, 'queue.db'),
      temp: path.join(base.cache, 'temp'),
      models: path.join(base.cache, 'models'),
      logs: path.join(base.data, 'logs'),
      settings: path.join(base.config, 'settings.json')
    };
  }

  ensureDirectories() {
    Object.values(this.paths).forEach(p => {
      // Skip file paths (those with extensions)
      if (path.extname(p) === '') {
        fs.mkdirSync(p, { recursive: true });
      } else {
        // Ensure parent directory exists for files
        fs.mkdirSync(path.dirname(p), { recursive: true });
      }
    });
  }

  getSettings() {
    if (!fs.existsSync(this.paths.settings)) {
      const defaults = {
        voice: 'default',
        outputFormat: 'wav',
        sampleRate: 44100,
        batchSize: 5,
        maxConcurrentJobs: 1
      };
      this.saveSettings(defaults);
      return defaults;
    }
    return JSON.parse(fs.readFileSync(this.paths.settings, 'utf8'));
  }

  saveSettings(settings) {
    fs.writeFileSync(this.paths.settings, JSON.stringify(settings, null, 2));
  }
}

// Singleton instance
const config = new Config();

export default config;
