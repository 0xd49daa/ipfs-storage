
import { describe, test, expect } from 'bun:test';
import { createTestClient, createTestKeyPair, createStreamingFileInput } from './setup.ts';
import { createIpfsStorageModule, asAsyncIterable } from '../src/index.ts';
import type { BatchManifest, FileDownloadRef } from '../src/types.ts';

const client = createTestClient();
const module = createIpfsStorageModule({ ipfsClient: client });

function buildFileRef(manifest: BatchManifest, path: string): FileDownloadRef {
    const fileInfo = manifest.files.find((file) => file.path === path);
    if (!fileInfo) throw new Error(`File not found: ${path}`);
    return {
        batchCid: manifest.cid,
        path: fileInfo.path,
        size: fileInfo.size,
        contentHash: fileInfo.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: fileInfo.chunks,
    };
}

describe('E2E Basic Upload & Download', () => {
    test('upload and download a single small file', async () => {
        // 1. Prepare data
        const content = new TextEncoder().encode('Hello IPFS World ' + Date.now());
        const file = await createStreamingFileInput(content, '/hello.txt', Date.now());

        const senderKeys = await createTestKeyPair(0);
        const recipientKeys = await createTestKeyPair(1);

        // 2. Upload
        console.log('Uploading batch...');
        const result = await module.uploadBatch(asAsyncIterable([file]), {
            senderKeyPair: senderKeys,
            recipients: [{ publicKey: recipientKeys.publicKey }],
        });

        expect(result.cid).toBeDefined();
        expect(result.totalSize).toBeGreaterThan(0);
        console.log('Batch uploaded, CID:', result.cid);

        // 3. Get Manifest
        const manifest = await module.getManifest(result.cid, {
            recipientKeyPair: recipientKeys,
            expectedSenderPublicKey: senderKeys.publicKey,
        });

        expect(manifest.files.length).toBe(1);
        expect(manifest.files[0]!.path).toBe('/hello.txt');

        // 4. Download
        const downloadRef = buildFileRef(manifest, '/hello.txt');

        const chunks: Uint8Array[] = [];
        for await (const chunk of module.downloadFile(downloadRef)) {
            chunks.push(chunk);
        }

        // 5. Verify Content
        const downloadedContent = new Uint8Array(
            chunks.reduce((acc, c) => acc + c.length, 0)
        );
        let offset = 0;
        for (const chunk of chunks) {
            downloadedContent.set(chunk, offset);
            offset += chunk.length;
        }

        const decoded = new TextDecoder().decode(downloadedContent);
        expect(decoded).toBe(new TextDecoder().decode(content));
        console.log('Download verified successfully.');
    });

    test('upload and download a directory structure', async () => {
        // Structure:
        // /photos/vacation/beach.jpg
        // /photos/me.jpg
        const beachContent = new Uint8Array([1, 2, 3, 4]);
        const meContent = new Uint8Array([5, 6, 7, 8]);

        const files = [
            await createStreamingFileInput(beachContent, '/photos/vacation/beach.jpg'),
            await createStreamingFileInput(meContent, '/photos/me.jpg'),
        ];

        const senderKeys = await createTestKeyPair(2);
        const recipientKeys = await createTestKeyPair(3);

        const result = await module.uploadBatch(asAsyncIterable(files), {
            senderKeyPair: senderKeys,
            recipients: [{ publicKey: recipientKeys.publicKey }],
        });

        const manifest = await module.getManifest(result.cid, {
            recipientKeyPair: recipientKeys,
            expectedSenderPublicKey: senderKeys.publicKey,
        });

        expect(manifest.files.length).toBe(2);
        // Sort verification can be tricky, but manifest files are sorted by path
        const paths = manifest.files.map((file) => file.path);
        expect(paths).toContain('/photos/vacation/beach.jpg');
        expect(paths).toContain('/photos/me.jpg');

        // Verify directories in manifest
        const dirPaths = manifest.directories.map((directory) => directory.path);
        expect(dirPaths).toContain('/photos');
        expect(dirPaths).toContain('/photos/vacation');
    });
});
