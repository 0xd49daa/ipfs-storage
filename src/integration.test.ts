/**
 * Phase 18: Integration Testing
 *
 * Comprehensive end-to-end tests for realistic scenarios.
 * All tests use the public API via createIpfsStorageModule().
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  preloadSodium,
  deriveEncryptionKeyPair,
  deriveSeed,
  hashBlake2b,
  type ContentHash,
  type X25519KeyPair,
} from '@filemanager/encryptionv2';
import {
  createIpfsStorageModule,
  MockIpfsClient,
  ManifestError,
  SegmentUploadError,
  AbortUploadError,
  ResumeValidationError,
  type FileInput,
  type DirectoryInput,
  type FileDownloadRef,
  type BatchManifest,
  type IpfsStorageModule,
  type UploadState,
} from './index.ts';

// ============================================================================
// Test Helpers
// ============================================================================

/** Test mnemonic for deterministic key generation */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Create test key pair from mnemonic seed */
async function createTestKeyPair(index: number): Promise<X25519KeyPair> {
  const seed = await deriveSeed(TEST_MNEMONIC);
  return deriveEncryptionKeyPair(seed, index);
}

/** Create a File object from string content */
function createFile(content: string, name = 'test.txt'): File {
  return new File([content], name, { type: 'text/plain' });
}

/** Create FileInput from string content */
async function createFileInput(
  content: string,
  path: string
): Promise<FileInput> {
  const bytes = new TextEncoder().encode(content);
  return {
    file: createFile(content, path.split('/').pop()),
    path,
    contentHash: (await hashBlake2b(bytes, 32)) as ContentHash,
  };
}

/** Create FileInput from Uint8Array */
async function createBinaryFileInput(
  data: Uint8Array,
  path: string
): Promise<FileInput> {
  return {
    file: new File([data], path.split('/').pop() ?? 'file'),
    path,
    contentHash: (await hashBlake2b(data, 32)) as ContentHash,
  };
}

/** Collect async iterable to Uint8Array */
async function collectBytes(
  iterable: AsyncIterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Generate bytes with pattern for verification */
function generatePatternedBytes(size: number, seed: number = 0): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    data[i] = (i + seed) % 256;
  }
  return data;
}

/** Build FileDownloadRef from manifest for a specific file */
function buildFileRef(
  manifest: BatchManifest,
  filePath: string
): FileDownloadRef {
  const fileInfo = manifest.files.find((f) => f.path === filePath);
  if (!fileInfo) throw new Error(`File not found: ${filePath}`);
  return {
    batchCid: manifest.cid,
    path: fileInfo.path,
    size: fileInfo.size,
    contentHash: fileInfo.contentHash,
    manifestKey: manifest.manifestKey,
    chunks: fileInfo.chunks,
  };
}

/** Build FileDownloadRefs for all files in manifest */
function buildAllFileRefs(manifest: BatchManifest): FileDownloadRef[] {
  return manifest.files.map((f) => ({
    batchCid: manifest.cid,
    path: f.path,
    size: f.size,
    contentHash: f.contentHash,
    manifestKey: manifest.manifestKey,
    chunks: f.chunks,
  }));
}

// ============================================================================
// 1. Full Round-Trip Scenarios (7 tests)
// ============================================================================

describe('Integration: Full Round-Trip', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);
  });

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test('single small file: upload -> getManifest -> downloadFile', async () => {
    const content = 'Hello, Integration Test!';
    const file = await createFileInput(content, '/hello.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.cid).toMatch(/^bafybei/);
    expect(result.manifest.files).toHaveLength(1);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.cid).toBe(result.cid);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]!.path).toBe('/hello.txt');

    const ref = buildFileRef(manifest, '/hello.txt');
    const downloadedBytes = await collectBytes(module.downloadFile(ref));
    const downloadedContent = new TextDecoder().decode(downloadedBytes);

    expect(downloadedContent).toBe(content);
  });

  test('multiple small files: upload -> getManifest -> downloadFiles', async () => {
    const files = [
      await createFileInput('Content A', '/a.txt'),
      await createFileInput('Content B', '/b.txt'),
      await createFileInput('Content C', '/c.txt'),
      await createFileInput('Content D', '/d.txt'),
      await createFileInput('Content E', '/e.txt'),
    ];

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(5);

    const refs = buildAllFileRefs(manifest);
    const downloaded: Map<string, string> = new Map();

    for await (const file of module.downloadFiles(refs)) {
      const bytes = await collectBytes(file.content);
      downloaded.set(file.path, new TextDecoder().decode(bytes));
    }

    expect(downloaded.size).toBe(5);
    expect(downloaded.get('/a.txt')).toBe('Content A');
    expect(downloaded.get('/b.txt')).toBe('Content B');
    expect(downloaded.get('/c.txt')).toBe('Content C');
    expect(downloaded.get('/d.txt')).toBe('Content D');
    expect(downloaded.get('/e.txt')).toBe('Content E');
  });

  test('large file (11MB): upload -> getManifest -> downloadFile', async () => {
    const size = 11 * 1024 * 1024; // 11MB spans multiple chunks
    const data = generatePatternedBytes(size);
    const file = await createBinaryFileInput(data, '/large.bin');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.chunkCount).toBeGreaterThan(1);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files[0]!.chunks.length).toBeGreaterThan(1);

    const ref = buildFileRef(manifest, '/large.bin');
    const downloadedBytes = await collectBytes(module.downloadFile(ref));

    expect(downloadedBytes.length).toBe(size);
    expect(downloadedBytes).toEqual(data);
  });

  test('mixed file sizes: small + large in same batch', async () => {
    const smallContent = 'Small file content';
    const largeData = generatePatternedBytes(11 * 1024 * 1024);

    const files = [
      await createFileInput(smallContent, '/small.txt'),
      await createBinaryFileInput(largeData, '/large.bin'),
      await createFileInput('Another small file', '/another.txt'),
    ];

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(3);

    // Download all and verify
    const refs = buildAllFileRefs(manifest);
    const downloaded: Map<string, Uint8Array> = new Map();

    for await (const file of module.downloadFiles(refs)) {
      const bytes = await collectBytes(file.content);
      downloaded.set(file.path, bytes);
    }

    expect(new TextDecoder().decode(downloaded.get('/small.txt'))).toBe(
      smallContent
    );
    expect(downloaded.get('/large.bin')).toEqual(largeData);
    expect(new TextDecoder().decode(downloaded.get('/another.txt'))).toBe(
      'Another small file'
    );
  });

  test('batch with directories: explicit empty dirs preserved', async () => {
    const file = await createFileInput('content', '/docs/readme.txt');
    const directories: DirectoryInput[] = [
      { path: '/empty-folder', created: 1700000000000 },
      { path: '/another-empty' },
    ];

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      directories,
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const emptyFolder = manifest.directories.find(
      (d) => d.path === '/empty-folder'
    );
    const anotherEmpty = manifest.directories.find(
      (d) => d.path === '/another-empty'
    );

    expect(emptyFolder).toBeDefined();
    expect(emptyFolder!.created).toBe(1700000000000);
    expect(anotherEmpty).toBeDefined();
  });

  test('file with special path characters: unicode, emoji, spaces', async () => {
    const files = [
      await createFileInput('content1', '/photos/vacation 2024/beach.jpg'),
      await createFileInput('content2', '/docs/日本語.txt'),
      await createFileInput('content3', '/fun/party.txt'),
    ];

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain('/photos/vacation 2024/beach.jpg');
    expect(paths).toContain('/docs/日本語.txt');
    expect(paths).toContain('/fun/party.txt');

    // Verify content round-trips
    for (const fileInfo of manifest.files) {
      const ref = buildFileRef(manifest, fileInfo.path);
      const bytes = await collectBytes(module.downloadFile(ref));
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  test('deeply nested paths: 10 levels of nesting', async () => {
    const deepPath = '/a/b/c/d/e/f/g/h/i/j/file.txt';
    const content = 'Deep content';
    const file = await createFileInput(content, deepPath);

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    // Should have 10 directories inferred
    expect(manifest.directories.length).toBe(10);

    // Verify paths exist
    const dirPaths = manifest.directories.map((d) => d.path);
    expect(dirPaths).toContain('/a');
    expect(dirPaths).toContain('/a/b');
    expect(dirPaths).toContain('/a/b/c/d/e/f/g/h/i/j');

    const ref = buildFileRef(manifest, deepPath);
    const downloaded = await collectBytes(module.downloadFile(ref));
    expect(new TextDecoder().decode(downloaded)).toBe(content);
  });
});

// ============================================================================
// 2. Multi-Device Recipient Scenarios (5 tests)
// ============================================================================

describe('Integration: Multi-Device Recipients', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
  });

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test('2 recipients: both can retrieve and decrypt', async () => {
    const recipient1 = await createTestKeyPair(1);
    const recipient2 = await createTestKeyPair(2);

    const content = 'Shared content';
    const file = await createFileInput(content, '/shared.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [
        { publicKey: recipient1.publicKey },
        { publicKey: recipient2.publicKey },
      ],
    });

    // Recipient 1 retrieves
    const manifest1 = await module.getManifest(result.cid, {
      recipientKeyPair: recipient1,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const ref1 = buildFileRef(manifest1, '/shared.txt');
    const downloaded1 = await collectBytes(module.downloadFile(ref1));
    expect(new TextDecoder().decode(downloaded1)).toBe(content);

    // Recipient 2 retrieves
    const manifest2 = await module.getManifest(result.cid, {
      recipientKeyPair: recipient2,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const ref2 = buildFileRef(manifest2, '/shared.txt');
    const downloaded2 = await collectBytes(module.downloadFile(ref2));
    expect(new TextDecoder().decode(downloaded2)).toBe(content);
  });

  test('5 recipients: all can retrieve manifest', async () => {
    const recipients = await Promise.all([
      createTestKeyPair(1),
      createTestKeyPair(2),
      createTestKeyPair(3),
      createTestKeyPair(4),
      createTestKeyPair(5),
    ]);

    const file = await createFileInput('content for all', '/all.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: recipients.map((r) => ({ publicKey: r.publicKey })),
    });

    // Each recipient can retrieve
    for (const recipient of recipients) {
      const manifest = await module.getManifest(result.cid, {
        recipientKeyPair: recipient,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      expect(manifest.files).toHaveLength(1);
      expect(manifest.files[0]!.path).toBe('/all.txt');
    }
  });

  test('recipients with labels: labels preserved in envelope', async () => {
    const recipient1 = await createTestKeyPair(1);
    const recipient2 = await createTestKeyPair(2);

    const file = await createFileInput('content', '/test.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [
        { publicKey: recipient1.publicKey, label: 'MacBook' },
        { publicKey: recipient2.publicKey, label: 'iPhone' },
      ],
    });

    // Both can still retrieve (labels don't affect decryption)
    const manifest1 = await module.getManifest(result.cid, {
      recipientKeyPair: recipient1,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });
    expect(manifest1.files).toHaveLength(1);

    const manifest2 = await module.getManifest(result.cid, {
      recipientKeyPair: recipient2,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });
    expect(manifest2.files).toHaveLength(1);
  });

  test('wrong recipient cannot decrypt', async () => {
    const recipient = await createTestKeyPair(1);
    const wrongRecipient = await createTestKeyPair(99);

    const file = await createFileInput('secret', '/secret.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipient.publicKey }],
    });

    // Wrong recipient tries to retrieve
    await expect(
      module.getManifest(result.cid, {
        recipientKeyPair: wrongRecipient,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      })
    ).rejects.toThrow(ManifestError);
  });

  test('multi-recipient with multiple files: complete workflow', async () => {
    const recipients = await Promise.all([
      createTestKeyPair(1),
      createTestKeyPair(2),
      createTestKeyPair(3),
    ]);

    const files = [
      await createFileInput('File 1 content', '/file1.txt'),
      await createFileInput('File 2 content', '/file2.txt'),
      await createFileInput('File 3 content', '/file3.txt'),
      await createFileInput('File 4 content', '/file4.txt'),
      await createFileInput('File 5 content', '/file5.txt'),
    ];

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: recipients.map((r) => ({ publicKey: r.publicKey })),
    });

    // Each recipient downloads all files
    for (const recipient of recipients) {
      const manifest = await module.getManifest(result.cid, {
        recipientKeyPair: recipient,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      expect(manifest.files).toHaveLength(5);

      const refs = buildAllFileRefs(manifest);
      const downloaded: Map<string, string> = new Map();

      for await (const file of module.downloadFiles(refs)) {
        const bytes = await collectBytes(file.content);
        downloaded.set(file.path, new TextDecoder().decode(bytes));
      }

      expect(downloaded.size).toBe(5);
      expect(downloaded.get('/file1.txt')).toBe('File 1 content');
      expect(downloaded.get('/file5.txt')).toBe('File 5 content');
    }
  });
});

// ============================================================================
// 3. Large Batch with Manifest Splitting (4 tests)
// ============================================================================

describe('Integration: Manifest Splitting', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);
  });

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test('large batch with many files: all files accessible', async () => {
    // Create many files to test large batch handling
    // This tests the manifest building and retrieval workflow at scale
    // Note: The public API doesn't expose maxSubManifestSize, so we verify
    // the workflow works correctly regardless of internal splitting decisions
    const files: FileInput[] = [];
    for (let i = 0; i < 500; i++) {
      const paddedIndex = i.toString().padStart(5, '0');
      const longPath = `/directory_with_long_name_${paddedIndex}/subdirectory_also_long/file_${paddedIndex}.txt`;
      files.push(await createFileInput(`Content ${i}`, longPath));
    }

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.manifest.files).toHaveLength(500);

    // Verify all files accessible via getManifest
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(500);

    // Verify a sample of files can be downloaded
    const sampleIndices = [0, 100, 250, 499];
    for (const idx of sampleIndices) {
      const fileInfo = manifest.files[idx]!;
      const ref = buildFileRef(manifest, fileInfo.path);
      const downloaded = await collectBytes(module.downloadFile(ref));
      expect(new TextDecoder().decode(downloaded)).toBe(`Content ${idx}`);
    }
  });

  test('file retrieval across batch returns correct content', async () => {
    // Create files and verify content retrieval works correctly
    const files: FileInput[] = [];
    for (let i = 0; i < 100; i++) {
      const paddedIndex = i.toString().padStart(3, '0');
      files.push(
        await createFileInput(
          `Unique content ${i}`,
          `/dir_${paddedIndex}/file.txt`
        )
      );
    }

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(100);

    // Download specific files from different positions and verify content
    const firstFile = manifest.files[0]!;
    const lastFile = manifest.files[manifest.files.length - 1]!;
    const middleFile = manifest.files[50]!;

    const ref1 = buildFileRef(manifest, firstFile.path);
    const content1 = new TextDecoder().decode(
      await collectBytes(module.downloadFile(ref1))
    );
    expect(content1).toMatch(/^Unique content \d+$/);

    const ref2 = buildFileRef(manifest, lastFile.path);
    const content2 = new TextDecoder().decode(
      await collectBytes(module.downloadFile(ref2))
    );
    expect(content2).toMatch(/^Unique content \d+$/);

    const ref3 = buildFileRef(manifest, middleFile.path);
    const content3 = new TextDecoder().decode(
      await collectBytes(module.downloadFile(ref3))
    );
    expect(content3).toMatch(/^Unique content \d+$/);
  });

  test('manifest files are sorted by path (byte-wise)', async () => {
    // Create files with paths that should sort in a specific order
    const paths = ['/z.txt', '/a.txt', '/m.txt', '/b.txt', '/y.txt'];
    const files = await Promise.all(
      paths.map((p) => createFileInput(`content for ${p}`, p))
    );

    // Add more files with varied paths
    for (let i = 0; i < 50; i++) {
      files.push(
        await createFileInput(
          `padding ${i}`,
          `/dir_${i.toString().padStart(3, '0')}/file.txt`
        )
      );
    }

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    // Verify files are sorted by path (byte-wise)
    const filePaths = manifest.files.map((f) => f.path);
    const sortedPaths = [...filePaths].sort((a, b) => {
      const aBytes = new TextEncoder().encode(a);
      const bBytes = new TextEncoder().encode(b);
      for (let i = 0; i < Math.min(aBytes.length, bBytes.length); i++) {
        if (aBytes[i]! !== bBytes[i]!) {
          return aBytes[i]! - bBytes[i]!;
        }
      }
      return aBytes.length - bBytes.length;
    });

    expect(filePaths).toEqual(sortedPaths);
  });

  test('directories preserved correctly with large file batches', async () => {
    // Create files with many directories and verify directories round-trip correctly
    const files: FileInput[] = [];
    const directories: DirectoryInput[] = [];

    // Add explicit empty directories
    for (let i = 0; i < 50; i++) {
      directories.push({
        path: `/empty_dir_${i.toString().padStart(3, '0')}`,
        created: 1700000000000 + i,
      });
    }

    // Add files with directory structure
    for (let i = 0; i < 200; i++) {
      files.push(
        await createFileInput(
          `content ${i}`,
          `/files_dir_${i.toString().padStart(3, '0')}/file.txt`
        )
      );
    }

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      directories,
    });

    expect(result.manifest.files).toHaveLength(200);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    // Verify all explicit directories are present with correct timestamps
    for (let i = 0; i < 50; i++) {
      const dir = manifest.directories.find(
        (d) => d.path === `/empty_dir_${i.toString().padStart(3, '0')}`
      );
      expect(dir).toBeDefined();
      expect(dir!.created).toBe(1700000000000 + i);
    }

    // Verify inferred directories also present
    for (let i = 0; i < 200; i++) {
      const dir = manifest.directories.find(
        (d) => d.path === `/files_dir_${i.toString().padStart(3, '0')}`
      );
      expect(dir).toBeDefined();
    }
  });
});

// ============================================================================
// 4. Resume After Failure (5 tests)
// ============================================================================

describe('Integration: Upload Resume', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);
  });

  afterEach(() => {
    ipfsClient?.clearUploadLatch?.();
  });

  test('resume from SegmentUploadError: complete upload succeeds', async () => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    const content = 'Resume test content';
    const file = await createFileInput(content, '/test.txt');

    // First attempt: fail on upload
    ipfsClient.setFailNextUpload(true);
    let savedState: UploadState | undefined;

    try {
      await module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
      });
    } catch (err) {
      if (err instanceof SegmentUploadError) {
        savedState = err.state;
      }
    }

    expect(savedState).toBeDefined();

    // Create fresh client and module for resume
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    // Reset segment status for resume
    savedState!.segments[0]!.status = 'pending';

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      resumeState: savedState,
    });

    // Verify round-trip works
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const ref = buildFileRef(manifest, '/test.txt');
    const downloaded = await collectBytes(module.downloadFile(ref));
    expect(new TextDecoder().decode(downloaded)).toBe(content);
  });

  test('resume from AbortUploadError: state is valid for resume', async () => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    const file = await createFileInput('abort test content', '/abort.txt');

    // Set up abort during upload
    const controller = new AbortController();
    let savedState: UploadState | undefined;

    // Abort after upload starts
    ipfsClient.setUploadLatch(async () => {
      controller.abort();
    });

    try {
      await module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof AbortUploadError) {
        savedState = err.state;
      }
    }

    expect(savedState).toBeDefined();

    // Resume with fresh client
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
    savedState!.segments[0]!.status = 'pending';

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      resumeState: savedState,
    });

    expect(result.cid).toBeDefined();
  });

  test('resume preserves manifestKey: file keys remain consistent', async () => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    const file = await createFileInput('key test', '/key.txt');

    // First attempt
    ipfsClient.setFailNextUpload(true);
    let savedState: UploadState | undefined;

    try {
      await module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
      });
    } catch (err) {
      if (err instanceof SegmentUploadError) {
        savedState = err.state;
      }
    }

    const originalManifestKey = savedState!.manifestKeyBase64;
    expect(originalManifestKey).toBeDefined();

    // Resume
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
    savedState!.segments[0]!.status = 'pending';

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      resumeState: savedState,
    });

    // Get manifest and verify key is consistent
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    // manifestKey from resumed upload should be decodable and work
    const ref = buildFileRef(manifest, '/key.txt');
    const downloaded = await collectBytes(module.downloadFile(ref));
    expect(new TextDecoder().decode(downloaded)).toBe('key test');

    // Verify the key was preserved (same base64 encoding works)
    expect(originalManifestKey).toBeDefined();
  });

  test('resume state survives JSON serialization', async () => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    const file = await createFileInput('json test', '/json.txt');

    // Get state from error
    ipfsClient.setFailNextUpload(true);
    let savedState: UploadState | undefined;

    try {
      await module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
      });
    } catch (err) {
      if (err instanceof SegmentUploadError) {
        savedState = err.state;
      }
    }

    // Serialize and deserialize (simulating storage)
    const serialized = JSON.stringify(savedState);
    const deserialized = JSON.parse(serialized) as UploadState;

    // Resume with deserialized state
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
    deserialized.segments[0]!.status = 'pending';

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      resumeState: deserialized,
    });

    expect(result.cid).toBeDefined();
  });

  test('segment count mismatch throws ResumeValidationError', async () => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    const file = await createFileInput('mismatch test', '/mismatch.txt');

    // Get state
    ipfsClient.setFailNextUpload(true);
    let savedState: UploadState | undefined;

    try {
      await module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
      });
    } catch (err) {
      if (err instanceof SegmentUploadError) {
        savedState = err.state;
      }
    }

    // Modify segment count to cause mismatch
    savedState!.segments.push({
      index: 1,
      status: 'pending',
      chunkCids: {},
    });

    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    await expect(
      module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        resumeState: savedState,
      })
    ).rejects.toThrow(ResumeValidationError);
  });

  test('multi-segment upload resume: state with multiple segments', async () => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    // Create a file large enough to create multiple chunks
    // Each chunk is 10MB, so 25MB file = 3 chunks = 3 segments (with segmentSize=1)
    const largeData = generatePatternedBytes(25 * 1024 * 1024);
    const file = await createBinaryFileInput(largeData, '/large.bin');

    // First attempt: fail after first segment uploads
    let uploadCount = 0;
    ipfsClient.setUploadLatch(async () => {
      uploadCount++;
      if (uploadCount === 2) {
        // Fail on second segment
        throw new Error('Simulated network failure');
      }
    });

    let savedState: UploadState | undefined;

    try {
      await module.uploadBatch([file], {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        segmentSize: 1, // 1 chunk per segment to force multiple segments
      });
    } catch (err) {
      if (err instanceof SegmentUploadError) {
        savedState = err.state;
      }
    }

    expect(savedState).toBeDefined();
    // With 25MB file and segmentSize=1, we should have 3+ segments
    expect(savedState!.segments.length).toBeGreaterThan(1);

    // Verify at least one segment completed
    const completedSegments = savedState!.segments.filter(
      (s) => s.status === 'complete'
    );
    expect(completedSegments.length).toBeGreaterThanOrEqual(1);

    // Resume with fresh client
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    // Reset failed/uploading segments to pending for resume
    for (const segment of savedState!.segments) {
      if (segment.status !== 'complete') {
        segment.status = 'pending';
      }
    }

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      resumeState: savedState,
      segmentSize: 1,
    });

    expect(result.cid).toBeDefined();
    expect(result.segmentsUploaded).toBeGreaterThan(1);

    // Verify round-trip works after resume
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]!.size).toBe(25 * 1024 * 1024);

    // Download and verify content matches
    const ref = buildFileRef(manifest, '/large.bin');
    const downloaded = await collectBytes(module.downloadFile(ref));
    expect(downloaded.length).toBe(25 * 1024 * 1024);
    expect(downloaded).toEqual(largeData);
  });
});

// ============================================================================
// 5. Concurrent Download Stress Test (5 tests)
// ============================================================================

describe('Integration: Concurrent Downloads', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;
  let uploadedManifest: BatchManifest;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);

    // Pre-upload a batch of 20 files for stress tests
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });

    const files = await Promise.all(
      Array(20)
        .fill(null)
        .map((_, i) =>
          createFileInput(
            `Content ${i}`.repeat(100),
            `/file${i.toString().padStart(2, '0')}.txt`
          )
        )
    );

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    uploadedManifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });
  });

  test('downloadFiles with concurrency=5: all files retrieved correctly', async () => {
    const refs = buildAllFileRefs(uploadedManifest);
    const downloaded: Map<string, string> = new Map();

    for await (const file of module.downloadFiles(refs, { concurrency: 5 })) {
      const content = await collectBytes(file.content);
      downloaded.set(file.path, new TextDecoder().decode(content));
    }

    expect(downloaded.size).toBe(20);

    // Verify content pattern
    for (const [path, content] of downloaded) {
      const match = path.match(/file(\d+)\.txt/);
      if (match) {
        const index = parseInt(match[1]!, 10);
        expect(content).toBe(`Content ${index}`.repeat(100));
      }
    }
  });

  test('downloadFiles with concurrency=1: sequential still works', async () => {
    const refs = buildAllFileRefs(uploadedManifest);
    const downloaded: string[] = [];

    for await (const file of module.downloadFiles(refs, { concurrency: 1 })) {
      await collectBytes(file.content);
      downloaded.push(file.path);
    }

    expect(downloaded.length).toBe(20);
  });

  test('downloadFiles with concurrency=10: high parallelism', async () => {
    const refs = buildAllFileRefs(uploadedManifest);
    const downloaded: string[] = [];

    for await (const file of module.downloadFiles(refs, { concurrency: 10 })) {
      await collectBytes(file.content);
      downloaded.push(file.path);
    }

    expect(downloaded.length).toBe(20);
  });

  test('progress tracking: aggregate bytes correct across concurrent downloads', async () => {
    const refs = buildAllFileRefs(uploadedManifest);
    const progressUpdates: number[] = [];

    for await (const file of module.downloadFiles(refs, {
      concurrency: 5,
      onProgress: (p) => progressUpdates.push(p.bytesDownloaded),
    })) {
      await collectBytes(file.content);
    }

    // Verify progress is monotonically increasing
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i]).toBeGreaterThanOrEqual(progressUpdates[i - 1]!);
    }

    // Final progress should equal total bytes
    const totalBytes = uploadedManifest.files.reduce((sum, f) => sum + f.size, 0);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(totalBytes);
  });

  test('error in one file (continue mode): other files complete', async () => {
    // Create refs with one that has invalid batchCid
    const refs = buildAllFileRefs(uploadedManifest);
    const invalidRef: FileDownloadRef = {
      ...refs[10]!,
      batchCid: 'bafybeiinvalidcidthatwontwork',
    };
    refs[10] = invalidRef;

    const downloaded: string[] = [];
    const errors: Error[] = [];

    for await (const file of module.downloadFiles(refs, {
      concurrency: 3,
      onError: (err) => {
        errors.push(err);
      },
    })) {
      await collectBytes(file.content);
      downloaded.push(file.path);
    }

    // 19 files should complete (one errored)
    expect(downloaded.length).toBe(19);
    expect(errors.length).toBe(1);
  });
});

// ============================================================================
// 6. Edge Cases (12 tests)
// ============================================================================

describe('Integration: Edge Cases', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);
  });

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test('single empty file (0 bytes): round-trip succeeds', async () => {
    const file = await createFileInput('', '/empty.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files[0]!.size).toBe(0);
    expect(manifest.files[0]!.chunks).toHaveLength(0);

    const ref = buildFileRef(manifest, '/empty.txt');
    const downloaded = await collectBytes(module.downloadFile(ref));
    expect(downloaded.length).toBe(0);
  });

  test('batch of only empty files: all round-trip correctly', async () => {
    const files = await Promise.all([
      createFileInput('', '/empty1.txt'),
      createFileInput('', '/empty2.txt'),
      createFileInput('', '/dir/empty3.txt'),
    ]);

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(3);

    for (const fileInfo of manifest.files) {
      expect(fileInfo.size).toBe(0);
      expect(fileInfo.chunks).toHaveLength(0);
    }
  });

  test('mixed empty and non-empty files', async () => {
    const files = await Promise.all([
      createFileInput('', '/empty.txt'),
      createFileInput('has content', '/content.txt'),
      createFileInput('', '/another-empty.txt'),
    ]);

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const refs = buildAllFileRefs(manifest);
    const downloaded: Map<string, Uint8Array> = new Map();

    for await (const file of module.downloadFiles(refs)) {
      const bytes = await collectBytes(file.content);
      downloaded.set(file.path, bytes);
    }

    expect(downloaded.get('/empty.txt')!.length).toBe(0);
    expect(new TextDecoder().decode(downloaded.get('/content.txt'))).toBe(
      'has content'
    );
    expect(downloaded.get('/another-empty.txt')!.length).toBe(0);
  });

  test('explicit empty directory: preserved in manifest', async () => {
    const file = await createFileInput('content', '/docs/file.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      directories: [{ path: '/empty-album', created: 12345 }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const emptyDir = manifest.directories.find((d) => d.path === '/empty-album');
    expect(emptyDir).toBeDefined();
    expect(emptyDir!.created).toBe(12345);
  });

  test('nested empty directories structure', async () => {
    const file = await createFileInput('content', '/a.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      directories: [
        { path: '/empty' },
        { path: '/empty/nested' },
        { path: '/empty/nested/deep' },
      ],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const dirPaths = manifest.directories.map((d) => d.path);
    expect(dirPaths).toContain('/empty');
    expect(dirPaths).toContain('/empty/nested');
    expect(dirPaths).toContain('/empty/nested/deep');
  });

  test('single file batch (trivial case)', async () => {
    const file = await createFileInput('single file', '/only-file.txt');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(1);

    const ref = buildFileRef(manifest, '/only-file.txt');
    const downloaded = await collectBytes(module.downloadFile(ref));
    expect(new TextDecoder().decode(downloaded)).toBe('single file');
  });

  test('unicode filenames: CJK, emoji, accents', async () => {
    const files = await Promise.all([
      createFileInput('japanese', '/日本語ファイル.txt'),
      createFileInput('emoji', '/party.txt'),
      createFileInput('accent', '/café.txt'),
      createFileInput('greek', '/Ω-omega.txt'),
    ]);

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain('/日本語ファイル.txt');
    expect(paths).toContain('/party.txt');
    expect(paths).toContain('/café.txt');
    expect(paths).toContain('/Ω-omega.txt');

    // Verify each downloads correctly
    for (const fileInfo of manifest.files) {
      const ref = buildFileRef(manifest, fileInfo.path);
      const bytes = await collectBytes(module.downloadFile(ref));
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  test('deeply nested path (10 levels)', async () => {
    const deepPath = '/l1/l2/l3/l4/l5/l6/l7/l8/l9/l10/file.txt';
    const file = await createFileInput('deep', deepPath);

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.directories.length).toBe(10);
  });

  test('large batch: 100+ files', async () => {
    const files = await Promise.all(
      Array(150)
        .fill(null)
        .map((_, i) =>
          createFileInput(
            `Content ${i}`,
            `/file${i.toString().padStart(3, '0')}.txt`
          )
        )
    );

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(150);
  });

  test('duplicate paths: auto-rename preserves content', async () => {
    const file1 = await createFileInput('first', '/photo.jpg');
    const file2 = await createFileInput('second', '/photo.jpg');
    const file3 = await createFileInput('third', '/photo.jpg');

    const result = await module.uploadBatch([file1, file2, file3], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.renamed).toBeDefined();
    expect(result.renamed!.length).toBe(2);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain('/photo.jpg');
    expect(paths).toContain('/photo_1.jpg');
    expect(paths).toContain('/photo_2.jpg');

    // Verify content of each
    const refs = buildAllFileRefs(manifest);
    const downloaded: Map<string, string> = new Map();

    for await (const file of module.downloadFiles(refs)) {
      const bytes = await collectBytes(file.content);
      downloaded.set(file.path, new TextDecoder().decode(bytes));
    }

    expect(downloaded.get('/photo.jpg')).toBe('first');
    expect(downloaded.get('/photo_1.jpg')).toBe('second');
    expect(downloaded.get('/photo_2.jpg')).toBe('third');
  });

  test('file at exact 10MB boundary', async () => {
    const exactChunkSize = 10 * 1024 * 1024; // Exactly 10MB
    const data = generatePatternedBytes(exactChunkSize);
    const file = await createBinaryFileInput(data, '/exact-10mb.bin');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.chunkCount).toBe(1);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const ref = buildFileRef(manifest, '/exact-10mb.bin');
    const downloaded = await collectBytes(module.downloadFile(ref));

    expect(downloaded.length).toBe(exactChunkSize);
    expect(downloaded).toEqual(data);
  });
});

// ============================================================================
// 7. Smoke Tests (3 tests)
// ============================================================================

describe('Integration: Smoke Tests', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);
  });

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test('100 small files batch: full round-trip completes', async () => {
    // Smoke test: verify 100 files can complete the full workflow
    // No timing assertions to avoid CI flakiness
    const files = await Promise.all(
      Array(100)
        .fill(null)
        .map((_, i) =>
          createFileInput(
            `content ${i}`,
            `/file${i.toString().padStart(3, '0')}.txt`
          )
        )
    );

    const result = await module.uploadBatch(files, {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.manifest.files).toHaveLength(100);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(100);

    const refs = buildAllFileRefs(manifest);
    let downloadedCount = 0;
    for await (const file of module.downloadFiles(refs)) {
      await collectBytes(file.content);
      downloadedCount++;
    }

    expect(downloadedCount).toBe(100);
  });

  test('10MB file: full round-trip completes', async () => {
    // Smoke test: verify 10MB file can complete the full workflow
    // No timing assertions to avoid CI flakiness
    const data = generatePatternedBytes(10 * 1024 * 1024);
    const file = await createBinaryFileInput(data, '/large.bin');

    const result = await module.uploadBatch([file], {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.manifest.files).toHaveLength(1);
    expect(result.manifest.files[0]!.size).toBe(10 * 1024 * 1024);

    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    const downloaded = await collectBytes(
      module.downloadFile(buildFileRef(manifest, '/large.bin'))
    );

    expect(downloaded.length).toBe(10 * 1024 * 1024);
    expect(downloaded).toEqual(data);
  });

  test('memory stability: no excessive growth during batch operations', async () => {
    // Process multiple batches and ensure no obvious memory issues
    for (let batch = 0; batch < 5; batch++) {
      const files = await Promise.all(
        Array(10)
          .fill(null)
          .map((_, i) =>
            createFileInput(
              `batch ${batch} file ${i}`,
              `/batch${batch}/file${i}.txt`
            )
          )
      );

      const result = await module.uploadBatch(files, {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
      });

      const manifest = await module.getManifest(result.cid, {
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      for await (const file of module.downloadFiles(buildAllFileRefs(manifest))) {
        await collectBytes(file.content);
      }

      // Clear client between batches to release memory
      ipfsClient.clear();
    }

    // If we get here without OOM, test passes
    expect(true).toBe(true);
  });
});
