import { ValidationError } from "./errors.ts";
import { padme } from "./padme.ts";

const LENGTH_PREFIX_SIZE = 4;

function writeUint32Be(target: Uint8Array, value: number): void {
  target[0] = (value >>> 24) & 0xff;
  target[1] = (value >>> 16) & 0xff;
  target[2] = (value >>> 8) & 0xff;
  target[3] = value & 0xff;
}

function readUint32Be(source: Uint8Array): number {
  return ((source[0]! << 24) >>> 0) +
    (source[1]! << 16) +
    (source[2]! << 8) +
    source[3]!;
}

export function padManifestPlaintext(plaintext: Uint8Array): Uint8Array {
  const framedLength = LENGTH_PREFIX_SIZE + plaintext.length;
  const paddedLength = padme(framedLength);
  const result = new Uint8Array(paddedLength);
  writeUint32Be(result, plaintext.length);
  result.set(plaintext, LENGTH_PREFIX_SIZE);
  return result;
}

export function unpadManifestPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX_SIZE) {
    throw new ValidationError("Padded manifest plaintext is too short");
  }

  const plaintextLength = readUint32Be(padded);
  const end = LENGTH_PREFIX_SIZE + plaintextLength;
  if (end > padded.length) {
    throw new ValidationError(
      "Padded manifest plaintext length exceeds record",
    );
  }

  return padded.slice(LENGTH_PREFIX_SIZE, end);
}
