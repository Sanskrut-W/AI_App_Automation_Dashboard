'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  automationDir: '',
  port: 4000,
  appiumPort: 4723,
  adbPath: 'adb',
  nodePath: 'node',
};

/**
 * Loads config.json, with environment overrides.
 *
 * The path to the automation platform is configuration, never a constant: the dashboard is a
 * separate application that drives the platform from outside, so it has to be pointable at any
 * checkout without editing code. Environment variables win over the file so a different platform
 * copy can be used for one run without touching the saved settings.
 */
function loadConfig() {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`config.json is not valid JSON: ${error.message}`);
    }
  }
  const config = { ...DEFAULTS, ...fromFile };
  if (process.env.AUTOMATION_DIR) config.automationDir = process.env.AUTOMATION_DIR;
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.APPIUM_PORT) config.appiumPort = Number(process.env.APPIUM_PORT);

  // Normalise to forward slashes so comparisons and display are consistent on Windows.
  config.automationDir = String(config.automationDir).replace(/\\/g, '/').replace(/\/+$/, '');
  return config;
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH };
