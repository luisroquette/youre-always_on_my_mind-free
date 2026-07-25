#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, resolve } from "node:path";
import { config } from "../src/config.mjs";

const FORMAT = "youre-always-on-my-mind-backup-v1";
const DEFAULT_PASSPHRASE_ENV = "YOURE_ALWAYS_ON_MY_MIND_BACKUP_PASSPHRASE";

function usage() {
  console.error("Usage: backup --output <file> [--data <file>] [--feedback <file>] [--passphrase-env <name>] [--dry-run] [--force] | backup --verify <file> [--passphrase-env <name>]");
  process.exit(1);
}

function optionsFrom(argv) {
  const options = { data: config.databasePath, feedback: config.feedbackPath, passphraseEnv: DEFAULT_PASSPHRASE_ENV, dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") options.output = resolve(argv[++index] ?? usage());
    else if (value === "--verify") options.verify = resolve(argv[++index] ?? usage());
    else if (value === "--data") options.data = resolve(argv[++index] ?? usage());
    else if (value === "--feedback") options.feedback = resolve(argv[++index] ?? usage());
    else if (value === "--passphrase-env") options.passphraseEnv = argv[++index] ?? usage();
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--force") options.force = true;
    else usage();
  }
  if (Boolean(options.output) === Boolean(options.verify)) usage();
  return options;
}

async function exists(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

function keyFor(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(payload, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return JSON.stringify({ format: FORMAT, cipher: "aes-256-gcm", kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

function decrypt(envelope, passphrase) {
  if (envelope.format !== FORMAT || envelope.cipher !== "aes-256-gcm" || envelope.kdf !== "scrypt") throw new Error("Unsupported backup format.");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(passphrase, Buffer.from(envelope.salt, "base64")), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
}

function passphraseFrom(options) {
  const passphrase = process.env[options.passphraseEnv];
  if (!passphrase || passphrase.length < 12) throw new Error(`Set ${options.passphraseEnv} to a passphrase of at least 12 characters.`);
  return passphrase;
}

async function inputFiles(options) {
  const candidates = [options.data, options.feedback];
  const files = [];
  for (const path of candidates) if (await exists(path)) files.push(path);
  if (!files.length) throw new Error("No configured data or feedback files found. Pass --data and/or --feedback explicitly.");
  return files;
}

const options = optionsFrom(process.argv.slice(2));
try {
  const passphrase = passphraseFrom(options);
  if (options.verify) {
    const payload = JSON.parse(decrypt(JSON.parse(await readFile(options.verify, "utf8")), passphrase).toString("utf8"));
    if (payload.format !== FORMAT || !Array.isArray(payload.files)) throw new Error("Backup payload is invalid.");
    console.log(JSON.stringify({ verified: true, file_count: payload.files.length, created_at: payload.created_at }, null, 2));
  } else {
    const files = await inputFiles(options);
    const inventory = await Promise.all(files.map(async (path) => ({ path, bytes: (await stat(path)).size })));
    if (options.dryRun) {
      console.log(JSON.stringify({ mode: "dry-run", output: options.output, encrypted: true, files: inventory }, null, 2));
      process.exit(0);
    }
    if (await exists(options.output) && !options.force) throw new Error(`Backup already exists: ${options.output}. Use --force only after confirming the target.`);
    const payload = { format: FORMAT, created_at: new Date().toISOString(), files: await Promise.all(files.map(async (path) => ({ name: basename(path), content: (await readFile(path)).toString("base64") }))) };
    await writeFile(options.output, `${encrypt(Buffer.from(JSON.stringify(payload)), passphrase)}\n`, { mode: 0o600, flag: options.force ? "w" : "wx" });
    console.log(JSON.stringify({ backed_up: true, output: options.output, encrypted: true, files: inventory }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
