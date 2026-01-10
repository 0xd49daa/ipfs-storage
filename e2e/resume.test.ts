
import { describe, test, expect } from 'bun:test';
import {
    createTestClient,
    createTestKeyPair,
    createStreamingFileInput,
    HttpIpfsClient,
    IPFS_API_URL,
} from './setup.ts';
import { createIpfsStorageModule, asAsyncIterable } from '../src/index.ts';
import { IpfsUploadError } from '../src/ipfs-client.ts';

// Fault Injecting Client
class FaultyIpfsClient extends HttpIpfsClient {
    private callCount = 0;
    private failOnCall: number;

    constructor(apiUrl: string, failOnCall: number) {
        super(apiUrl);
        this.failOnCall = failOnCall;
    }

    override async uploadCar(car: AsyncIterable<Uint8Array>): Promise<string> {
        this.callCount++;
        console.log(`FaultyClient: uploadCar call #${this.callCount}`);

        if (this.callCount === this.failOnCall) {
            throw new IpfsUploadError('Simulated Network Failure');
        }

        return super.uploadCar(car);
    }
}

describe('E2E Resumable Upload', () => {
    test('resume upload after interruption', async () => {
        // We need enough files to create multiple segments.
        // Default segment size is 10 chunks.
        // We'll use 15 small files to ensure at least 2 segments (segment 0: 0-9, segment 1: 10-14 + manifest)

        const files = [];
        for (let i = 0; i < 15; i++) {
            const content = new TextEncoder().encode(`File ${i}`);
            files.push(await createStreamingFileInput(content, `/file_${i}.txt`));
        }

        const senderKeys = await createTestKeyPair(20);
        const recipientKeys = await createTestKeyPair(21);

        // 1. Attempt upload that fails on 2nd chunk upload (call #2)
        const faultyClient = new FaultyIpfsClient(IPFS_API_URL, 2);
        const faultyModule = createIpfsStorageModule({ ipfsClient: faultyClient });

        console.log('Starting failing upload...');
        try {
            await faultyModule.uploadBatch(asAsyncIterable(files), {
                senderKeyPair: senderKeys,
                recipients: [{ publicKey: recipientKeys.publicKey }],
            });
            throw new Error('Upload should have failed!');
        } catch (err: unknown) {
            console.log('Upload failed as expected:', (err as Error).message);
            expect(err).toBeInstanceOf(IpfsUploadError);
        }

        // 2. Retry upload with healthy client
        console.log('Retrying upload...');
        const healthyClient = createTestClient();
        const healthyModule = createIpfsStorageModule({ ipfsClient: healthyClient });

        const result = await healthyModule.uploadBatch(asAsyncIterable(files), {
            senderKeyPair: senderKeys,
            recipients: [{ publicKey: recipientKeys.publicKey }],
        });

        console.log('Retry complete, CID:', result.cid);

        // 3. Verify
        // Manifest should contain all 15 files
        const manifest = await healthyModule.getManifest(result.cid, {
            recipientKeyPair: recipientKeys,
            expectedSenderPublicKey: senderKeys.publicKey,
        });

        expect(manifest.files.length).toBe(15);
        const paths = manifest.files.map((file) => file.path);
        expect(paths).toContain('/file_14.txt');
    });
});
