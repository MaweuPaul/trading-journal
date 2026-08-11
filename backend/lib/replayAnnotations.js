const REPLAY_ANNOTATION_INTERVALS = new Set(['1min', '5min', '15min', '1h', '4h', '1day']);

function normalizeReplayAnnotations(interval, input) {
  if (!REPLAY_ANNOTATION_INTERVALS.has(interval)) throw new Error('Unsupported Replay annotation timeframe');
  if (!Array.isArray(input)) throw new Error('annotations must be an array');
  if (input.length > 300) throw new Error('A trade can have at most 300 annotations per timeframe');
  const ids = new Set();
  const number = (value, label) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
    return parsed;
  };
  return input.map((annotation, index) => {
    const type = String(annotation?.type || '');
    if (!['rect', 'line', 'text'].includes(type)) throw new Error(`Annotation ${index + 1} has an unsupported type`);
    const annotationId = String(annotation.id || '').trim();
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(annotationId)) throw new Error(`Annotation ${index + 1} has an invalid ID`);
    if (ids.has(annotationId)) throw new Error(`Annotation ID ${annotationId} is duplicated`);
    ids.add(annotationId);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(annotation.color || '')) ? String(annotation.color) : '#3b82f6';
    if (type === 'text') {
      const text = String(annotation.text || '').trim().slice(0, 80);
      if (!text) throw new Error(`Text annotation ${index + 1} cannot be empty`);
      return { id: annotationId, type, time: number(annotation.time, 'time'), price: number(annotation.price, 'price'), text, color };
    }
    return {
      id: annotationId, type, color,
      time1: number(annotation.time1, 'time1'), time2: number(annotation.time2, 'time2'),
      price1: number(annotation.price1, 'price1'), price2: number(annotation.price2, 'price2'),
    };
  });
}

module.exports = { REPLAY_ANNOTATION_INTERVALS, normalizeReplayAnnotations };
