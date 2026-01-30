#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

// Create client subpath
mkdirSync(`${root}/client`, { recursive: true });
writeFileSync(`${root}/client/index.js`, `export * from '../dist/client.js';\n`);
writeFileSync(`${root}/client/index.d.ts`, `export * from '../dist/client';\n`);
writeFileSync(`${root}/client/package.json`, `{"type":"module"}\n`);

// Create server subpath
mkdirSync(`${root}/server`, { recursive: true });
writeFileSync(`${root}/server/index.js`, `export * from '../dist/server.js';\n`);
writeFileSync(`${root}/server/index.d.ts`, `export * from '../dist/server';\n`);
writeFileSync(`${root}/server/package.json`, `{"type":"module"}\n`);

console.log('✓ Generated client and server subpath exports');
