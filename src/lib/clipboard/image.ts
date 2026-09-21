import { execFile } from 'node:child_process';

export type ClipboardImageReadFailureReason =
  | 'no-image'
  | 'too-large'
  | 'unsupported-platform'
  | 'unavailable'
  | 'cancelled';

export type ClipboardImageReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: ClipboardImageReadFailureReason };

const READ_TIMEOUT_MS = 2000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readImageScript(maxBytes: number): string {
  return `
ObjC.import('AppKit');
function run() {
  const board = $.NSPasteboard.generalPasteboard;
  const version = Number(board.changeCount);
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
  if (request.matchingText !== undefined) {
    const text = board.stringForType($.NSPasteboardTypeString);
    if (text.isNil() || ObjC.unwrap(text) !== request.matchingText) return 'no-image';
  }
  let data = board.dataForType($.NSPasteboardTypePNG);
  if (data.isNil()) {
    const image = $.NSImage.alloc.initWithPasteboard(board);
    if (image.isNil()) return 'no-image';
    const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
    if (bitmap.isNil()) return 'no-image';
    data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  }
  if (data.isNil() || Number(data.length) === 0) return 'no-image';
  if (Number(data.length) > ${maxBytes}) return 'too-large';
  if (Number(board.changeCount) !== version) return 'no-image';
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`;
}

function readMacImage(
  signal: AbortSignal,
  matchingText: string | undefined,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', readImageScript(maxBytes)],
      {
        encoding: 'utf8',
        timeout: READ_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: Math.ceil(maxBytes / 3) * 4 + 1024,
        signal,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(JSON.stringify({ matchingText }));
  });
}

/** Reads a bounded PNG from the platform clipboard without owning any application paths. */
export async function readClipboardImageData({
  signal,
  matchingText,
  maxBytes,
}: {
  signal: AbortSignal;
  matchingText?: string | undefined;
  maxBytes: number;
}): Promise<ClipboardImageReadResult> {
  if (signal.aborted) return { ok: false, reason: 'cancelled' };
  if (process.platform !== 'darwin') return { ok: false, reason: 'unsupported-platform' };
  try {
    const output = await readMacImage(signal, matchingText, maxBytes);
    signal.throwIfAborted();
    if (output === 'no-image' || output === 'too-large') return { ok: false, reason: output };
    const bytes = Buffer.from(output, 'base64');
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { ok: false, reason: 'unavailable' };
    }
    if (bytes.length > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'unavailable' };
  }
}
