#!/usr/bin/env node
// Full MongoDB backup using mongodump -- covers every collection (trades,
// accounts, credentials, journals, everything), unlike the in-app "Download
// JSON" export on the Backup page, which only covers trades/account
// events/Replay journals. Zips the dump and, if B2_* env vars are set,
// uploads it to a Backblaze B2 bucket so a local-disk failure doesn't take
// the backups with it. Restore with:
//   mongorestore --uri="<MONGODB_URI>" --drop <dump-folder>/trade_journal
//
// Usage:
//   node scripts/backup-database.js
//
// Requires the MongoDB Database Tools (mongodump) to be installed and on
// PATH -- https://www.mongodb.com/try/download/database-tools

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set in backend/.env -- nothing to back up.');
  process.exit(1);
}

const BACKUPS_ROOT = path.join(__dirname, '..', 'db-backups');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(BACKUPS_ROOT, timestamp);
fs.mkdirSync(outDir, { recursive: true });

function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function uploadToB2(zipPath) {
  const { B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APPLICATION_KEY } = process.env;
  if (!B2_ENDPOINT || !B2_BUCKET || !B2_KEY_ID || !B2_APPLICATION_KEY) {
    console.log('B2_* environment variables not set -- skipping cloud upload (backup stays local only).');
    console.log('See backend/.env.example for the variables needed to enable it.');
    return;
  }

  const client = new S3Client({
    endpoint: `https://${B2_ENDPOINT}`,
    region: B2_REGION || 'us-west-004',
    credentials: {
      accessKeyId: B2_KEY_ID,
      secretAccessKey: B2_APPLICATION_KEY,
    },
  });

  const key = `db-backups/${path.basename(zipPath)}`;
  console.log(`Uploading ${key} to Backblaze B2 bucket "${B2_BUCKET}"...`);
  await client.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: fs.createReadStream(zipPath),
  }));
  console.log('Upload complete.');
}

async function main() {
  console.log(`Backing up database to ${outDir} ...`);
  const result = spawnSync('mongodump', ['--uri', MONGODB_URI, '--out', outDir], {
    stdio: 'inherit',
  });

  if (result.error) {
    console.error('Could not run mongodump -- is it installed and on PATH?');
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`mongodump exited with code ${result.status}.`);
    process.exit(result.status || 1);
  }

  const zipPath = `${outDir}.zip`;
  console.log(`Zipping to ${zipPath} ...`);
  await zipDirectory(outDir, zipPath);

  try {
    await uploadToB2(zipPath);
  } catch (err) {
    console.error('Cloud upload failed (the local backup is still safe on disk):', err.message);
  }

  console.log(`Backup complete: ${zipPath}`);
}

main();
