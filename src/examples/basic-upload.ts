/**
 * Basic Upload Example
 *
 * Demonstrates the simplest upload workflow:
 * 1. Create module with MockIpfsClient
 * 2. Create a FileInput from content
 * 3. Upload batch with single recipient
 * 4. Log result
 *
 * Run: bun run src/examples/basic-upload.ts
 */

import {
  createIpfsStorageModule,
  MockIpfsClient,
  type FileInput,
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
  // Initialize libsodium
  await preloadSodium();

  // Create key pairs for sender and recipient
  const seed = await deriveSeed(TEST_MNEMONIC);
  const senderKeyPair = await deriveEncryptionKeyPair(seed, 0);
  const recipientKeyPair = await deriveEncryptionKeyPair(seed, 1);

  // Create the module with mock IPFS client
  const ipfsClient = new MockIpfsClient();
  const storage = createIpfsStorageModule({ ipfsClient });

  // Create file content
  const content = new TextEncoder().encode('Hello, IPFS!');
  const contentHash = (await hashBlake2b(content, 32)) as ContentHash;

  // Create FileInput
  const fileInput: FileInput = {
    file: new File([content as BlobPart], 'hello.txt', { type: 'text/plain' }),
    path: '/hello.txt',
    contentHash,
  };

  // Upload the batch
  const result = await storage.uploadBatch([fileInput], {
    senderKeyPair,
    recipients: [{ publicKey: recipientKeyPair.publicKey }],
  });

  // Log results
  console.log('Upload successful!');
  console.log('  Batch CID:', result.cid);
  console.log('  Total size:', result.totalSize, 'bytes');
  console.log('  Chunk count:', result.chunkCount);
  console.log('  Files:', result.manifest.files.map((f) => f.path).join(', '));
}

main().catch(console.error);
