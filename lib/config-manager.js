import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// XDG Base Directory Specification
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const CONFIG_DIR = path.join(XDG_CONFIG_HOME, 'voicci');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

/**
 * Memory profiles for different system capabilities
 *
 * - low: 2-4GB RAM (budget laptops, older machines)
 * - medium: 4-8GB RAM (typical consumer laptops)
 * - high: 8GB+ RAM (modern machines, workstations)
 */
export const MEMORY_PROFILES = {
  low: {
    name: 'Low Memory (2-4GB RAM)',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    maxConcurrentJobs: 1,
    chunkSize: 2000, // words per chunk
    enableMemoryMonitoring: true,
    memoryThreshold: 0.85, // Warn at 85% usage
    gcInterval: 30000, // Force GC every 30s
    description: 'For systems with 2-4GB RAM. Processes one job at a time with aggressive memory management.'
  },
  medium: {
    name: 'Medium Memory (4-8GB RAM)',
    maxFileSize: 100 * 1024 * 1024, // 100MB
    maxConcurrentJobs: 2,
    chunkSize: 5000,
    enableMemoryMonitoring: true,
    memoryThreshold: 0.90,
    gcInterval: 60000, // Force GC every 60s
    description: 'Balanced profile for typical laptops. Can handle 2 jobs simultaneously.'
  },
  high: {
    name: 'High Memory (8GB+ RAM)',
    maxFileSize: 500 * 1024 * 1024, // 500MB
    maxConcurrentJobs: 5,
    chunkSize: 10000,
    enableMemoryMonitoring: false, // Disabled by default on high-memory systems
    memoryThreshold: 0.95,
    gcInterval: 120000, // Force GC every 120s
    description: 'For powerful machines with 8GB+ RAM. Maximum performance with 5 concurrent jobs.'
  }
};

/**
 * Quality presets for TTS generation
 *
 * - fast: Quick generation, lower quality
 * - balanced: Good quality/speed trade-off (recommended)
 * - best: Maximum quality, slower generation
 */
export const QUALITY_PRESETS = {
  fast: {
    name: 'Fast',
    ttsSpeed: 1.0, // Normal speed
    temperature: 0.75, // Higher = more variation, less consistent
    topP: 0.85,
    repetitionPenalty: 10.0,
    description: 'Quick generation with acceptable quality. Good for testing or drafts.'
  },
  balanced: {
    name: 'Balanced (Recommended)',
    ttsSpeed: 0.85, // Slightly slower for better quality
    temperature: 0.65,
    topP: 0.8,
    repetitionPenalty: 5.0,
    description: 'Best balance between quality and speed. Recommended for most users.'
  },
  best: {
    name: 'Best Quality',
    ttsSpeed: 0.75, // Slower, more careful generation
    temperature: 0.55,
    topP: 0.75,
    repetitionPenalty: 2.0,
    description: 'Maximum quality with careful pronunciation. Takes longer to generate.'
  }
};

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  version: '1.0.0',
  memoryProfile: 'medium', // Auto-detected on first run
  qualityPreset: 'balanced',
  autoDetectProfile: true, // Automatically set profile based on system RAM
  enableMemoryMonitoring: null, // null = use profile default
  customSettings: {
    // Users can override specific settings here
  }
};

/**
 * Configuration Manager
 * Handles loading, saving, and applying configuration settings
 */
class ConfigManager {
  constructor() {
    this.config = null;
    this.systemInfo = null;
  }

  /**
   * Initialize configuration
   * Loads from file or creates default based on system capabilities
   */
  async init() {
    // Gather system information
    this.systemInfo = this.detectSystemCapabilities();

    // Load or create config
    this.config = this.loadConfig();

    // Auto-detect profile if enabled and not manually set
    if (this.config.autoDetectProfile && !this.isProfileManuallySet()) {
      const recommended = this.getRecommendedProfile();
      if (recommended !== this.config.memoryProfile) {
        console.log(`Auto-detected memory profile: ${recommended}`);
        this.config.memoryProfile = recommended;
        this.saveConfig();
      }
    }

    return this.config;
  }

  /**
   * Detect system capabilities
   */
  detectSystemCapabilities() {
    const totalMemGB = os.totalmem() / (1024 ** 3);
    const freeMemGB = os.freemem() / (1024 ** 3);
    const cpus = os.cpus().length;
    const platform = os.platform();
    const arch = os.arch();

    return {
      totalMemGB,
      freeMemGB,
      cpus,
      platform,
      arch,
      node: process.version
    };
  }

  /**
   * Get recommended profile based on system RAM
   */
  getRecommendedProfile() {
    const { totalMemGB } = this.systemInfo;

    if (totalMemGB < 4) {
      return 'low';
    } else if (totalMemGB < 8) {
      return 'medium';
    } else {
      return 'high';
    }
  }

  /**
   * Check if profile was manually set by user
   */
  isProfileManuallySet() {
    if (!fs.existsSync(CONFIG_FILE)) {
      return false;
    }

    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return savedConfig.profileManuallySet === true;
  }

  /**
   * Load configuration from file or return default
   */
  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

        // Merge with defaults (in case new settings were added)
        return { ...DEFAULT_CONFIG, ...config };
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error.message);
    }

    return { ...DEFAULT_CONFIG };
  }

  /**
   * Save configuration to file
   */
  saveConfig() {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      // Write config
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
      return true;
    } catch (error) {
      console.error('Failed to save config:', error.message);
      return false;
    }
  }

  /**
   * Get current active settings (profile + quality + custom overrides)
   */
  getActiveSettings() {
    const profile = MEMORY_PROFILES[this.config.memoryProfile];
    const quality = QUALITY_PRESETS[this.config.qualityPreset];

    // Memory monitoring: use custom setting if set, otherwise use profile default
    const enableMemoryMonitoring =
      this.config.enableMemoryMonitoring !== null
        ? this.config.enableMemoryMonitoring
        : profile.enableMemoryMonitoring;

    return {
      // Memory settings
      maxFileSize: profile.maxFileSize,
      maxConcurrentJobs: profile.maxConcurrentJobs,
      chunkSize: profile.chunkSize,
      enableMemoryMonitoring,
      memoryThreshold: profile.memoryThreshold,
      gcInterval: profile.gcInterval,

      // Quality settings
      ttsSpeed: quality.ttsSpeed,
      temperature: quality.temperature,
      topP: quality.topP,
      repetitionPenalty: quality.repetitionPenalty,

      // Profile info
      memoryProfile: this.config.memoryProfile,
      qualityPreset: this.config.qualityPreset,

      // Apply custom overrides
      ...this.config.customSettings
    };
  }

  /**
   * Set memory profile
   */
  setMemoryProfile(profile) {
    if (!MEMORY_PROFILES[profile]) {
      throw new Error(`Invalid profile: ${profile}. Valid: ${Object.keys(MEMORY_PROFILES).join(', ')}`);
    }

    this.config.memoryProfile = profile;
    this.config.profileManuallySet = true;
    this.config.autoDetectProfile = false; // Disable auto-detect when manually set

    return this.saveConfig();
  }

  /**
   * Set quality preset
   */
  setQualityPreset(preset) {
    if (!QUALITY_PRESETS[preset]) {
      throw new Error(`Invalid preset: ${preset}. Valid: ${Object.keys(QUALITY_PRESETS).join(', ')}`);
    }

    this.config.qualityPreset = preset;
    return this.saveConfig();
  }

  /**
   * Enable or disable memory monitoring
   */
  setMemoryMonitoring(enabled) {
    this.config.enableMemoryMonitoring = enabled;
    return this.saveConfig();
  }

  /**
   * Reset to defaults
   */
  reset() {
    this.config = { ...DEFAULT_CONFIG };
    this.config.memoryProfile = this.getRecommendedProfile();
    return this.saveConfig();
  }

  /**
   * Get configuration summary for display
   */
  getSummary() {
    const profile = MEMORY_PROFILES[this.config.memoryProfile];
    const quality = QUALITY_PRESETS[this.config.qualityPreset];
    const settings = this.getActiveSettings();

    return {
      system: {
        ram: `${this.systemInfo.totalMemGB.toFixed(1)}GB total, ${this.systemInfo.freeMemGB.toFixed(1)}GB free`,
        cpus: this.systemInfo.cpus,
        platform: `${this.systemInfo.platform} (${this.systemInfo.arch})`,
        node: this.systemInfo.node
      },
      current: {
        memoryProfile: {
          name: this.config.memoryProfile,
          description: profile.description,
          manually: this.config.profileManuallySet || false
        },
        qualityPreset: {
          name: this.config.qualityPreset,
          description: quality.description
        }
      },
      settings: {
        maxFileSize: `${(settings.maxFileSize / (1024 * 1024)).toFixed(0)}MB`,
        maxConcurrentJobs: settings.maxConcurrentJobs,
        chunkSize: `${settings.chunkSize.toLocaleString()} words`,
        memoryMonitoring: settings.enableMemoryMonitoring ? 'Enabled' : 'Disabled',
        memoryThreshold: `${(settings.memoryThreshold * 100).toFixed(0)}%`,
        ttsSpeed: settings.ttsSpeed,
        temperature: settings.temperature
      },
      recommendations: this.getRecommendations()
    };
  }

  /**
   * Get recommendations based on system capabilities
   */
  getRecommendations() {
    const recommendations = [];
    const recommended = this.getRecommendedProfile();

    // Profile recommendations
    if (this.config.memoryProfile !== recommended) {
      recommendations.push({
        type: 'profile',
        current: this.config.memoryProfile,
        recommended,
        reason: `Your system has ${this.systemInfo.totalMemGB.toFixed(1)}GB RAM. ` +
                `The '${recommended}' profile is optimized for your hardware.`,
        command: `voicci config set-profile ${recommended}`
      });
    }

    // Memory monitoring recommendations
    const settings = this.getActiveSettings();
    if (recommended === 'high' && settings.enableMemoryMonitoring) {
      recommendations.push({
        type: 'monitoring',
        reason: 'You have plenty of RAM (8GB+). You can disable memory monitoring for better performance.',
        command: 'voicci config set-monitoring off'
      });
    } else if (recommended === 'low' && !settings.enableMemoryMonitoring) {
      recommendations.push({
        type: 'monitoring',
        reason: 'Your system has limited RAM (<4GB). Enabling memory monitoring can prevent crashes.',
        command: 'voicci config set-monitoring on'
      });
    }

    // Quality preset recommendations
    if (recommended === 'low' && this.config.qualityPreset === 'best') {
      recommendations.push({
        type: 'quality',
        reason: 'The "best" quality preset may be slow on your system. Consider "balanced" or "fast".',
        command: 'voicci config set-quality balanced'
      });
    }

    return recommendations;
  }

  /**
   * Get config file path for display
   */
  getConfigPath() {
    return CONFIG_FILE;
  }
}

// Export singleton instance
const configManager = new ConfigManager();
export default configManager;
