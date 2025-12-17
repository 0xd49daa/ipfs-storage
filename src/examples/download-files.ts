/**
 * Download Files Example
 *
 * Demonstrates the complete upload → retrieve manifest → download workflow:
 * 1. Upload multiple files
 * 2. Get manifest using recipient key pair
 * 3. Build FileDownloadRef from manifest
 * 4. Download single file with downloadFile()
 * 5. Download multiple files with downloadFiles()
 *
 * Run: bun run src/examples/download-files.ts
 */

import {
  createIpfsStorageModule,
  MockIpfsClient,
  type FileInput,
  type FileDownloadRef,
} from '../index.ts';
import {
  preloadSodium,
  deriveSeed,
  deriveEncryptionKeyPair,
  hashBlake2b,
  type ContentHash,
} from '@0xd49daa/safecrypt';

// Test mnemonic for demonstration - DO NOT use in production
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function main() {
  await preloadSodium();

  // Create key pairs
  const seed = await deriveSeed(TEST_MNEMONIC);
  const senderKeyPair = await deriveEncryptionKeyPair(seed, 0);
  const recipientKeyPair = await deriveEncryptionKeyPair(seed, 1);

  // Create module
  const ipfsClient = new MockIpfsClient();
  const storage = createIpfsStorageModule({ ipfsClient });

  // Create multiple files
  const files: FileInput[] = [];
  for (const name of ['readme.txt', 'data.json', 'config.yaml']) {
    const content = new TextEncoder().encode(`Content of ${name}`);
    files.push({
      file: new File([content as BlobPart], name),
      path: `/${name}`,
      contentHash: (await hashBlake2b(content, 32)) as ContentHash,
    });
  }

  // Upload
  console.log('Uploading', files.length, 'files...');
  const uploadResult = await storage.uploadBatch(files, {
    senderKeyPair,
    recipients: [{ publicKey: recipientKeyPair.publicKey }],
  });
  console.log('  Batch CID:', uploadResult.cid);

  // Retrieve manifest
  console.log('\nRetrieving manifest...');
  const manifest = await storage.getManifest(uploadResult.cid, {
    recipientKeyPair,
    expectedSenderPublicKey: senderKeyPair.publicKey,
  });
  console.log('  Found', manifest.files.length, 'files');

  // Helper to build FileDownloadRef from manifest FileInfo
  function buildFileRef(fileInfo: (typeof manifest.files)[0]): FileDownloadRef {
    return {
      batchCid: manifest.cid,
      path: fileInfo.path,
      size: fileInfo.size,
      contentHash: fileInfo.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: fileInfo.chunks,
    };
  }

  // Download single file
  console.log('\nDownloading single file (readme.txt)...');
  const readmeInfo = manifest.files.find((f) => f.name === 'readme.txt')!;
  const readmeRef = buildFileRef(readmeInfo);

  const chunks: Uint8Array[] = [];
  for await (const chunk of storage.downloadFile(readmeRef)) {
    chunks.push(chunk);
  }
  const readmeContent = new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((c) => [...c]))
  );
  console.log('  Content:', readmeContent);

  // Download multiple files
  console.log('\nDownloading all files with downloadFiles()...');
  const allRefs = manifest.files.map(buildFileRef);

  for await (const file of storage.downloadFiles(allRefs)) {
    const contentChunks: Uint8Array[] = [];
    for await (const chunk of file.content) {
      contentChunks.push(chunk);
    }
    const content = new TextDecoder().decode(
      new Uint8Array(contentChunks.flatMap((c) => [...c]))
    );
    console.log(`  ${file.path}: "${content}"`);
  }

  console.log('\nDone!');
}

main().catch(console.error);
