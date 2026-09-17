const fs = require('fs');

async function pdfToImages(filePath, maxPages = 4) {
  const canvas = require('@napi-rs/canvas');
  globalThis.DOMMatrix ||= canvas.DOMMatrix;
  globalThis.ImageData ||= canvas.ImageData;
  globalThis.Path2D ||= canvas.Path2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const document = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const pageCount = Math.min(document.numPages, maxPages);
  const images = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.5 });
    const output = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: output, canvasContext: output.getContext('2d'), viewport }).promise;
    images.push(`data:image/png;base64,${output.toBuffer('image/png').toString('base64')}`);
  }
  return { images, pageCount, totalPages: document.numPages };
}

module.exports = { pdfToImages };
