'use strict';

const { SCHEMA } = require('./schema');

function validate(rawEnv, schema) {
  const errors = [];
  const config = {};

  for (const [key, def] of Object.entries(schema)) {
    let val = rawEnv[key];

    if (val === undefined || val === '') {
      if (def.required) {
        errors.push(`Missing required config: ${key}`);
        continue;
      }
      val = def.default;
    }

    if (def.type === 'number') {
      val = Number(val);
      if (isNaN(val)) {
        errors.push(`Invalid number: ${key}=${rawEnv[key]}`);
        continue;
      }
      if (def.min !== undefined && val < def.min) {
        errors.push(`${key}=${val} below minimum ${def.min}`);
      }
      if (def.max !== undefined && val > def.max) {
        errors.push(`${key}=${val} above maximum ${def.max}`);
      }
    } else if (def.type === 'bool') {
      val = val === 'true' || val === '1' || val === true;
    } else {
      val = String(val);
    }

    if (def.enum && !def.enum.includes(val)) {
      errors.push(`${key}=${val} not in [${def.enum.join(', ')}]`);
    }

    config[key] = Object.freeze(def.type === 'number' ? val : val);
  }

  return { ok: errors.length === 0, config: Object.freeze(config), errors };
}

function loadConfig({ envOverrides } = {}) {
  const raw = { ...process.env, ...envOverrides };
  const result = validate(raw, SCHEMA);
  return result;
}

module.exports = { validate, loadConfig, SCHEMA };
