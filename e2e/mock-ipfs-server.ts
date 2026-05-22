import {
  computeDagPbCid,
  computeRawCid,
  MockIpfsClient,
} from "../src/ipfs-client.ts";

export interface MockIpfsServer {
  url: string;
  client: MockIpfsClient;
  close(): Promise<void>;
}

function streamFromIterable(
  iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function splitIpfsPath(arg: string): { cid: string; path?: string } {
  const trimmed = arg.replace(/^\/+/, "");
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    return { cid: trimmed };
  }
  return {
    cid: trimmed.slice(0, slashIndex),
    path: trimmed.slice(slashIndex + 1),
  };
}

async function readMultipartFile(request: Request): Promise<Uint8Array> {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    throw new Error("Missing multipart file field");
  }
  return new Uint8Array(await file.arrayBuffer());
}

export function startMockIpfsServer(): MockIpfsServer {
  const client = new MockIpfsClient();

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);

      try {
        if (url.pathname === "/api/v0/id") {
          return Response.json({ ID: "mock-ipfs" });
        }

        if (url.pathname === "/api/v0/dag/import") {
          const carBytes = await readMultipartFile(request);
          const cid = await client.uploadCar((async function* () {
            yield carBytes;
          })());
          return new Response(
            `${JSON.stringify({ Root: { Cid: { "/": cid } } })}\n`,
            {
              headers: { "content-type": "application/x-ndjson" },
            },
          );
        }

        if (url.pathname === "/api/v0/block/put") {
          const bytes = await readMultipartFile(request);
          const format = url.searchParams.get("format");
          const cid = format === "dag-pb"
            ? await computeDagPbCid(bytes)
            : await computeRawCid(bytes);
          client.putBlock(cid.toString(), bytes, format === "dag-pb");
          return Response.json({ Key: cid.toString(), Size: bytes.length });
        }

        if (url.pathname === "/api/v0/cat") {
          const arg = url.searchParams.get("arg");
          if (!arg) return new Response("Missing arg", { status: 400 });

          const { cid, path } = splitIpfsPath(arg);
          return new Response(streamFromIterable(client.cat(cid, path)));
        }

        if (url.pathname === "/api/v0/block/stat") {
          const cid = url.searchParams.get("arg");
          if (!cid) return new Response("Missing arg", { status: 400 });
          if (!(await client.has(cid))) {
            return new Response("block not found", { status: 404 });
          }
          const block = client.getBlock(cid);
          return Response.json({ Key: cid, Size: block?.length ?? 0 });
        }

        return new Response("not found", { status: 404 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(message, { status: 500 });
      }
    },
  );

  const { hostname, port } = server.addr;
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;

  return {
    url: `http://${host}:${port}`,
    client,
    close: () => server.shutdown(),
  };
}
