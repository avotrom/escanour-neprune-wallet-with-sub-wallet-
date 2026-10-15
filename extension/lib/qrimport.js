// Read a Neptune address from an imported file: a QR picture or a text file.
//
// Pictures go through the browser's own QR reader (BarcodeDetector) when it
// has one, and otherwise through the QR reader in the light wasm module, which
// loads only when needed. Errors use codes the popup translates:
//   NO_QR    the picture holds no readable QR code
//   NO_ADDR  nothing that looks like an address

let wasmModule = null;

async function wasmDecoder() {
  if (!wasmModule) {
    const m = await import('../pkg/light/light_wasm.js');
    await m.default();
    wasmModule = m;
  }
  return wasmModule;
}

/** The address in a piece of text: drops a "neptune:" prefix and surrounding words, lower-cases it. */
export function cleanAddress(text) {
  const raw = String(text || '').trim().replace(/^neptune:/i, '');
  const tokens = raw.split(/[\s,;"'<>()[\]]+/).filter(Boolean);
  // bech32m: a human-readable part, the separator "1", then the data alphabet.
  const bech = tokens.filter((x) => /^[a-z]{1,30}1[02-9ac-hj-np-z]{20,}$/i.test(x));
  const pick = bech.sort((a, b) => b.length - a.length)[0] || tokens[0] || '';
  return pick.toLowerCase();
}

function finish(text) {
  const a = cleanAddress(text);
  if (!a) throw new Error('NO_ADDR');
  return a;
}

async function withBrowserReader(bitmap) {
  if (!('BarcodeDetector' in globalThis)) return null;
  try {
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    const found = await new globalThis.BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
    return found[0]?.rawValue || null;
  } catch {
    return null;
  }
}

function lumaAt(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; // transparent pictures: read as white paper
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const luma = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < luma.length; i += 4, j++) {
    luma[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  }
  return { w, h, luma };
}

export async function readAddressFromImageBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const native = await withBrowserReader(bitmap);
    if (native) return finish(native);
    const m = await wasmDecoder();
    // Large codes (long post-quantum addresses) need detail; noisy photos read better smaller.
    for (const side of [1600, 1000, 600]) {
      const { w, h, luma } = lumaAt(bitmap, side);
      try {
        return finish(m.qrDecode(w, h, luma));
      } catch (e) {
        if (e.message === 'NO_ADDR') throw e;
      }
    }
    throw new Error('NO_QR');
  } finally {
    bitmap.close?.();
  }
}

export async function readAddressFromFile(file) {
  if (file.type.startsWith('image/')) return readAddressFromImageBlob(file);
  return finish(await file.text());
}
