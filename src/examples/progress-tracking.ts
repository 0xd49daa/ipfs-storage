/**
 * Progress Tracking Example
 *
 * Demonstrates progress callbacks during upload and download:
 * 1. Upload with onProgress callback
 * 2. Download single file with onProgress callback
 * 3. Download multiple files with aggregate progress
 *
 * Run: bun run src/examples/progress-tracking.ts
 */

import {
  createIpfsStorageModule,
  MockIpfsClient,
  type FileInput,
  type FileDownloadRef,
  type UploadProgress,
  type DownloadProgress,
  type MultiDownloadProgress,
} from '../index.ts';
import {
  preloadSodium,
  deriveSeed,
  deriveEncryptionKeyPair,
  hashBlake2b,
} from '@filemanager/encryptionv2';

// Test mnemonic for demonstration - DO NOT use in production
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function formatPercent(current: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((current / total) * 100)}%`;
}

async function main() {
  await preloadSodium();
  const seed = await deriveSeed(TEST_MNEMONIC);
  const senderKeyPair = await deriveEncryptionKeyPair(seed, 0);
  const recipientKeyPair = await deriveEncryptionKeyPair(seed, 1);

  const ipfsClient = new MockIpfsClient();
  const storage = createIpfsStorageModule({ ipfsClient });

  // Create multiple files with varying sizes
  const files: FileInput[] = [];
  for (const [name, size] of [
    ['small.txt', 100],
    ['medium.txt', 5000],
    ['large.txt', 50000],
  ] as const) {
    const content = new Uint8Array(size);
    for (let i = 0; i < size; i++) content[i] = i % 256;
    files.push({
      file: new File([content], name),
      path: `/${name}`,
      contentHash: await hashBlake2b(content, 32),
    });
  }

  // Upload with progress tracking
  console.log('=== Upload Progress ===\n');
  const result = await storage.uploadBatch(files, {
    senderKeyPair,
    recipients: [{ publicKey: recipientKeyPair.publicKey }],
    onProgress: (progress: UploadProgress) => {
      const pct = formatPercent(progress.bytesProcessed, progress.totalBytes);
      console.log(
        `  [${progress.phase.padEnd(10)}] ` +
          `Files: ${progress.filesProcessed}/${progress.totalFiles} | ` +
          `Bytes: ${pct}`
      );
    },
  });
  console.log('\n  Upload complete! CID:', result.cid);

  // Get manifest for download
  const manifest = await storage.getManifest(result.cid, {
    recipientKeyPair,
    expectedSenderPublicKey: senderKeyPair.publicKey,
  });

  function buildFileRef(f: (typeof manifest.files)[0]): FileDownloadRef {
    return {
      batchCid: manifest.cid,
      path: f.path,
      size: f.size,
      contentHash: f.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: f.chunks,
    };
  }

  // Single file download with progress
  console.log('\n=== Single File Download Progress ===\n');
  const largeFile = manifest.files.find((f) => f.name === 'large.txt')!;
  const largeRef = buildFileRef(largeFile);

  const chunks: Uint8Array[] = [];
  for await (const chunk of storage.downloadFile(largeRef, {
    onProgress: (progress: DownloadProgress) => {
      const pct = formatPercent(progress.bytesDownloaded, progress.totalBytes);
      console.log(`  Downloaded: ${pct} (${progress.bytesDownloaded}/${progress.totalBytes} bytes)`);
    },
  })) {
    chunks.push(chunk);
  }
  console.log('  Complete!');

  // Multi-file download with aggregate progress
  console.log('\n=== Multi-File Download Progress ===\n');
  const allRefs = manifest.files.map(buildFileRef);

  for await (const file of storage.downloadFiles(allRefs, {
    onProgress: (progress: MultiDownloadProgress) => {
      const pct = formatPercent(progress.bytesDownloaded, progress.totalBytes);
      console.log(
        `  Files: ${progress.filesCompleted}/${progress.totalFiles} | ` +
          `Bytes: ${pct} | ` +
          `Current: ${progress.currentFile || 'none'}`
      );
    },
  })) {
    // Consume content
    for await (const _ of file.content) {
      // drain
    }
    console.log(`  -> Completed: ${file.path}`);
  }

  console.log('\nDone!');
}

main().catch(console.error);
