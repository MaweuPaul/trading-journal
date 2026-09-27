// Validates chartAnnotations for a backtest trade once its drawing tools
// moved to the lightweight-charts-drawing library (68 tool types, each with
// its own anchor count and style/option shape). Re-implementing per-type
// geometry validation for all 68 isn't practical or necessary -- this
// instead validates the generic SerializedDrawing envelope every tool
// shares ({id, type, anchors, style, options}) and caps every primitive
// field, which is enough to stop abuse (oversized payloads, non-primitive
// injection) without needing to know each tool's specific schema.
function normalizeBacktestDrawings(input) {
  if (!Array.isArray(input)) throw new Error('chartAnnotations must be an array');
  if (input.length > 200) throw new Error('A backtest chart can have at most 200 drawings');
  const ids = new Set();

  return input.map((drawing, index) => {
    const out = normalizeDrawing(drawing, index);
    if (ids.has(out.id)) throw new Error(`Drawing ID ${out.id} is duplicated`);
    ids.add(out.id);
    return out;
  });
}

const safePrimitives = (obj, stringCap) => {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') out[key] = value.slice(0, stringCap);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).filter(v => typeof v === 'number' && Number.isFinite(v));
  }
  return out;
};

/** One SerializedDrawing (the shared chart drawing tools' saved form). */
function normalizeDrawing(drawing, index = 0) {
  {
    const id = String(drawing?.id || '').trim();
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(id)) throw new Error(`Drawing ${index + 1} has an invalid ID`);

    const type = String(drawing?.type || '').trim();
    if (!type || type.length > 60) throw new Error(`Drawing ${index + 1} has an invalid type`);

    if (!Array.isArray(drawing?.anchors) || drawing.anchors.length === 0 || drawing.anchors.length > 10) {
      throw new Error(`Drawing ${index + 1} has invalid anchors`);
    }
    const anchors = drawing.anchors.map((anchor, anchorIndex) => {
      const time = Number(anchor?.time);
      const price = Number(anchor?.price);
      if (!Number.isFinite(time) || !Number.isFinite(price)) throw new Error(`Drawing ${index + 1}, anchor ${anchorIndex + 1} is invalid`);
      return { time, price };
    });

    return {
      id, type, anchors,
      style: safePrimitives(drawing.style, 200),
      options: safePrimitives(drawing.options, 500), // options can carry longer text (e.g. TextAnnotation content)
    };
  }
}

module.exports = { normalizeBacktestDrawings, normalizeDrawing };
