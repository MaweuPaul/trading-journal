const { normalizeDrawing } = require('./backtestDrawings');
// Same per-type validation as backend/lib/replayAnnotations.js, but for
// Pre-Trade Analysis charts: no "interval" keying (annotations use absolute
// time/price and stay meaningful across timeframe switches) and no 'event'
// type (timeline moments are a Trade Replay-only concept).
function normalizePretradeAnnotations(input) {
  if (!Array.isArray(input)) throw new Error('annotations must be an array');
  if (input.length > 300) throw new Error('A pre-trade chart can have at most 300 annotations');
  const ids = new Set();
  const number = (value, label) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
    return parsed;
  };
  return input.map((annotation, index) => {
    const type = String(annotation?.type || '');
    if (!['rect', 'line', 'horizontal', 'arrow', 'text', 'image', 'fib', 'drawing'].includes(type)) throw new Error(`Annotation ${index + 1} has an unsupported type`);
    const annotationId = String(annotation.id || '').trim();
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(annotationId)) throw new Error(`Annotation ${index + 1} has an invalid ID`);
    if (ids.has(annotationId)) throw new Error(`Annotation ID ${annotationId} is duplicated`);
    ids.add(annotationId);
    // A drawing from the shared chart drawing tools (components/chart-drawing), in the library's own format.
    if (type === 'drawing') {
      const drawing = normalizeDrawing({ ...annotation.drawing, id: annotationId }, index);
      return { id: annotationId, type, drawing };
    }
    const color = /^#[0-9a-fA-F]{6}$/.test(String(annotation.color || '')) ? String(annotation.color) : '#3b82f6';
    const lineStyle = annotation.lineStyle === 'dashed' ? 'dashed' : annotation.lineStyle === 'solid' ? 'solid' : undefined;
    if (type === 'text') {
      const text = String(annotation.text || '').trim().slice(0, 80);
      if (!text) throw new Error(`Text annotation ${index + 1} cannot be empty`);
      return { id: annotationId, type, time: number(annotation.time, 'time'), price: number(annotation.price, 'price'), text, color };
    }
    if (type === 'image') {
      const url = String(annotation.url || '').trim().slice(0, 2000);
      if (!url || !(/^(https?:\/\/|\/public\/screenshots\/)/i.test(url))) throw new Error(`Image annotation ${index + 1} has an invalid URL`);
      return {
        id: annotationId, type, time: number(annotation.time, 'time'), price: number(annotation.price, 'price'), url,
        caption: String(annotation.caption || '').trim().slice(0, 180), screenshotId: String(annotation.screenshotId || '').trim().slice(0, 100), color,
      };
    }
    if (type === 'horizontal') {
      return { id: annotationId, type, time: number(annotation.time, 'time'), price: number(annotation.price, 'price'), color, ...(lineStyle && { lineStyle }) };
    }
    return {
      id: annotationId, type, color, ...(lineStyle && { lineStyle }),
      time1: number(annotation.time1, 'time1'), time2: number(annotation.time2, 'time2'),
      price1: number(annotation.price1, 'price1'), price2: number(annotation.price2, 'price2'),
    };
  });
}

module.exports = { normalizePretradeAnnotations };
