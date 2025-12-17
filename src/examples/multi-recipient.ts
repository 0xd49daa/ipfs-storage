/**
 * Multi-Recipient Example
 *
 * Demonstrates uploading with multiple recipients:
 * 1. Create multiple recipient key pairs (simulating different devices)
 * 2. Upload with labels for each recipient
 * 3. Show each recipient retrieving the manifest independently
 *
 * Run: bun run src/examples/multi-recipient.ts
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
  type X25519KeyPair,
  type ContentHash,
} from '@0xd49daa/safecrypt';

// Test mnemonic for demonstration - DO NOT use in production
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function main() {
  await preloadSodium();
  const seed = await deriveSeed(TEST_MNEMONIC);

  // Create sender key pair
  const senderKeyPair = await deriveEncryptionKeyPair(seed, 0);

  // Create multiple recipient key pairs (simulating different devices)
  const devices = [
    { name: 'MacBook Pro', keyPair: await deriveEncryptionKeyPair(seed, 1) },
    { name: 'iPhone', keyPair: await deriveEncryptionKeyPair(seed, 2) },
    { name: 'iPad', keyPair: await deriveEncryptionKeyPair(seed, 3) },
  ];

  // Create module
  const ipfsClient = new MockIpfsClient();
  const storage = createIpfsStorageModule({ ipfsClient });

  // Create a file
  const content = new TextEncoder().encode('Shared document content');
  const fileInput: FileInput = {
    file: new File([content as BlobPart], 'shared.txt'),
    path: '/shared.txt',
    contentHash: (await hashBlake2b(content, 32)) as ContentHash,
  };

  // Upload with multiple recipients (each with a label)
  console.log('Uploading to', devices.length, 'recipients...');
  const result = await storage.uploadBatch([fileInput], {
    senderKeyPair,
    recipients: devices.map((d) => ({
      publicKey: d.keyPair.publicKey,
      label: d.name,
    })),
  });
  console.log('  Batch CID:', result.cid);

  // Each recipient retrieves the manifest independently
  console.log('\nEach recipient retrieving manifest:');
  for (const device of devices) {
    try {
      const manifest = await storage.getManifest(result.cid, {
        recipientKeyPair: device.keyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });
      console.log(`  ${device.name}: Success - found ${manifest.files.length} file(s)`);
    } catch (error) {
      console.log(`  ${device.name}: Failed -`, (error as Error).message);
    }
  }

  // Demonstrate that a non-recipient cannot access
  console.log('\nNon-recipient attempting access:');
  const nonRecipient = await deriveEncryptionKeyPair(seed, 99);
  try {
    await storage.getManifest(result.cid, {
      recipientKeyPair: nonRecipient,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });
    console.log('  Unexpected success!');
  } catch (error) {
    console.log('  Correctly rejected: No matching recipient');
  }

  console.log('\nDone!');
}

main().catch(console.error);
