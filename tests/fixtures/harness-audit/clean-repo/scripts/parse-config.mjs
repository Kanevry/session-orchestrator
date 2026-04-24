#!/usr/bin/env node
// Fixture parse-config stub — delegates to lib/platform.mjs for env-var resolution.
import { detectPlatform } from './lib/platform.mjs';
const platform = detectPlatform();
process.stdout.write(JSON.stringify({ platform }));
