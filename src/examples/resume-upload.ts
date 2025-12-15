/**
 * Resume Upload Example
 *
 * Demonstrates upload error handling and resume:
 * 1. Set up MockIpfsClient to fail after first segment
 * 2. Catch SegmentUploadError and extract resumeState
 * 3. Serialize state to JSON (for persistence)
 * 4. Resume upload with the saved state
 *
 * Run: bun run src/examples/resume-upload.ts
 */

import {
  createIpfsStorageModule,
  MockIpfsClient,
  SegmentUploadError,
  type FileInput,
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

async function main() {
  await preloadSodium();
  const seed = await deriveSeed(TEST_MNEMONIC);
  const senderKeyPair = await deriveEncryptionKeyPair(seed, 0);
  const recipientKeyPair = await deriveEncryptionKeyPair(seed, 1);

  // Create module with mock client
  const ipfsClient = new MockIpfsClient();
  const storage = createIpfsStorageModule({ ipfsClient });

  // Create a larger file that will span multiple segments
  // Using segmentSize=1 to force multiple segments for demonstration
  const content = new Uint8Array(1024 * 100); // 100KB
  for (let i = 0; i < content.length; i++) {
    content[i] = i % 256;
  }

  const fileInput: FileInput = {
    file: new File([content], 'large-file.bin'),
    path: '/large-file.bin',
    contentHash: await hashBlake2b(content, 32),
  };

  let savedState: string | null = null;

  // First attempt - will fail after first segment
  console.log('First upload attempt (will fail)...');
  ipfsClient.setFailNextUpload(new Error('Simulated network error'));

  try {
    await storage.uploadBatch([fileInput], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      segmentSize: 1, // Force multiple segments
      onSegmentComplete: (result) => {
        console.log(`  Segment ${result.index + 1}/${result.totalSegments} complete`);
        // Fail after first segment
        if (result.index === 0) {
          ipfsClient.setFailNextUpload(new Error('Simulated network error'));
        }
      },
    });
    console.log('  Unexpected success!');
  } catch (error) {
    if (error instanceof SegmentUploadError) {
      console.log('  Upload failed at segment:', error.state.segments.findIndex(s => s.status !== 'complete'));
      console.log('  Saving state for resume...');

      // Serialize state to JSON (for storage/persistence)
      savedState = JSON.stringify(error.state);
      console.log('  State saved (', savedState.length, 'bytes)');
    } else {
      throw error;
    }
  }

  if (!savedState) {
    console.log('No state to resume from');
    return;
  }

  // Resume attempt
  console.log('\nResuming upload...');
  const resumeState = JSON.parse(savedState);

  const result = await storage.uploadBatch([fileInput], {
    senderKeyPair,
    recipients: [{ publicKey: recipientKeyPair.publicKey }],
    segmentSize: 1,
    resumeState,
    onSegmentComplete: (result) => {
      console.log(`  Segment ${result.index + 1}/${result.totalSegments} complete`);
    },
  });

  console.log('\nUpload resumed successfully!');
  console.log('  Batch CID:', result.cid);
  console.log('  Segments uploaded:', result.segmentsUploaded);

  // Verify the upload by retrieving manifest
  console.log('\nVerifying upload...');
  const manifest = await storage.getManifest(result.cid, {
    recipientKeyPair,
    expectedSenderPublicKey: senderKeyPair.publicKey,
  });
  console.log('  File size:', manifest.files[0].size, 'bytes');
  console.log('  Chunks:', manifest.files[0].chunks.length);

  console.log('\nDone!');
}

main().catch(console.error);
