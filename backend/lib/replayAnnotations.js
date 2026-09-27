const { normalizeDrawing } = require('./backtestDrawings');
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
    if (!['rect', 'line', 'horizontal', 'arrow', 'text', 'image', 'drawing'].includes(type)) throw new Error(`Annotation ${index + 1} has an unsupported type`);
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

const REPLAY_EVENT_TYPES = new Set(['observation', 'confirmation', 'entry', 'management', 'exit', 'emotion', 'mistake', 'violation', 'lesson', 'custom']);
const REPLAY_EVENT_SEVERITIES = new Set(['minor', 'important', 'critical']);

function normalizeReplayEvents(input) {
  if (!Array.isArray(input)) throw new Error('events must be an array');
  if (input.length > 300) throw new Error('A trade can have at most 300 timeline events');
  const ids = new Set();
  return input.map((event, index) => {
    const eventId = String(event?.eventId || '').trim();
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(eventId)) throw new Error(`Timeline event ${index + 1} has an invalid ID`);
    if (ids.has(eventId)) throw new Error(`Timeline event ID ${eventId} is duplicated`);
    ids.add(eventId);
    const timeframe = String(event.timeframe || '');
    if (!REPLAY_ANNOTATION_INTERVALS.has(timeframe)) throw new Error(`Timeline event ${index + 1} has an unsupported timeframe`);
    const eventType = String(event.eventType || '');
    if (!REPLAY_EVENT_TYPES.has(eventType)) throw new Error(`Timeline event ${index + 1} has an unsupported type`);
    const candleTime = Number(event.candleTime); const price = Number(event.price);
    if (!Number.isFinite(candleTime) || !Number.isFinite(price)) throw new Error(`Timeline event ${index + 1} has invalid chart coordinates`);
    const title = String(event.title || '').trim().slice(0, 100);
    if (!title) throw new Error(`Timeline event ${index + 1} needs a title`);
    const severity = REPLAY_EVENT_SEVERITIES.has(String(event.severity || '')) ? String(event.severity) : 'important';
    const visibilityScope = event.visibilityScope === 'all' ? 'all' : 'timeframe';
    const order = Number.isFinite(Number(event.order)) ? Number(event.order) : candleTime;
    return {
      eventId, timeframe, visibilityScope, order, candleTime, price, eventType,
      customType: eventType === 'custom' ? String(event.customType || '').trim().slice(0, 60) : '',
      title, note: String(event.note || '').trim().slice(0, 1000),
      emotion: String(event.emotion || '').trim().slice(0, 40), severity,
      playbookRuleId: String(event.playbookRuleId || '').trim().slice(0, 100),
      playbookVersionId: String(event.playbookVersionId || '').trim().slice(0, 100),
      screenshotIds: Array.isArray(event.screenshotIds) ? event.screenshotIds.map(value => String(value).slice(0, 100)).slice(0, 10) : [],
      createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
}

function normalizeQuickReview(input) {
  const review = input && typeof input === 'object' ? input : {};
  const followedPlan = typeof review.followedPlan === 'boolean' ? review.followedPlan : null;
  const processGrade = ['A', 'B', 'C', 'D', 'F'].includes(String(review.processGrade || '')) ? String(review.processGrade) : '';
  let completedAt = null;
  if (review.completedAt) {
    const parsed = new Date(review.completedAt);
    if (Number.isNaN(parsed.getTime())) throw new Error('Quick Review completion time is invalid');
    completedAt = parsed.toISOString();
  }
  const normalized = {
    followedPlan,
    primaryEmotion: String(review.primaryEmotion || '').trim().slice(0, 40),
    primaryMistake: String(review.primaryMistake || '').trim().slice(0, 100),
    primaryStrength: String(review.primaryStrength || '').trim().slice(0, 100),
    lesson: String(review.lesson || '').trim().slice(0, 500),
    processGrade,
    completedAt,
    updatedAt: new Date().toISOString(),
  };
  if (completedAt && followedPlan === null) throw new Error('Choose whether the trade followed the plan before completing Quick Review');
  if (completedAt && !processGrade) throw new Error('Choose a process grade before completing Quick Review');
  if (completedAt && !normalized.lesson) throw new Error('Write the main lesson before completing Quick Review');
  if (completedAt && followedPlan === false && !normalized.primaryMistake) throw new Error('Record the main mistake when the plan was not followed');
  if (completedAt && followedPlan === true && !normalized.primaryStrength) throw new Error('Record what should be repeated when the plan was followed');
  return normalized;
}

function normalizeReplayDraft(input) {
  const draft = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const interval = REPLAY_ANNOTATION_INTERVALS.has(String(draft.selectedInterval || '')) ? String(draft.selectedInterval) : '5min';
  const journalPhase = ['plan', 'manage', 'review'].includes(String(draft.journalPhase || '')) ? String(draft.journalPhase) : 'plan';
  const speed = [0.5, 1, 2, 5, 10].includes(Number(draft.speed)) ? Number(draft.speed) : 1;
  const replayIdx = Math.max(0, Math.min(100000, Math.floor(Number(draft.replayIdx) || 0)));
  const tags = Array.isArray(draft.tags) ? draft.tags.map(value => String(value).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [];
  const playbookResponses = draft.playbookResponses && typeof draft.playbookResponses === 'object' && !Array.isArray(draft.playbookResponses) ? draft.playbookResponses : {};
  if (JSON.stringify(playbookResponses).length > 100000) throw new Error('Replay draft playbook answers are too large');
  return {
    notes: String(draft.notes || '').slice(0, 10000), emotion: String(draft.emotion || '').slice(0, 40),
    grade: ['A', 'B', 'C', 'D', 'F'].includes(String(draft.grade || '')) ? String(draft.grade) : '', tags,
    playbookResponses, analysisGrade: ['A', 'B', 'C', 'D', 'F'].includes(String(draft.analysisGrade || '')) ? String(draft.analysisGrade) : '',
    executionGrade: ['A', 'B', 'C', 'D', 'F'].includes(String(draft.executionGrade || '')) ? String(draft.executionGrade) : '',
    plannedRR: draft.plannedRR === '' || draft.plannedRR == null ? '' : String(draft.plannedRR).slice(0, 30),
    confidenceRating: Number.isFinite(Number(draft.confidenceRating)) ? Math.max(1, Math.min(10, Number(draft.confidenceRating))) : null,
    exitReason: String(draft.exitReason || '').slice(0, 40), manuallyIntervened: typeof draft.manuallyIntervened === 'boolean' ? draft.manuallyIntervened : null,
    selectedInterval: interval, replayIdx, speed, journalPhase, updatedAt: new Date().toISOString(),
  };
}

module.exports = { REPLAY_ANNOTATION_INTERVALS, normalizeReplayAnnotations, normalizeReplayEvents, normalizeQuickReview, normalizeReplayDraft };
