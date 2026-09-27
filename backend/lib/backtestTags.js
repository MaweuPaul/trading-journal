// Strategy tags on backtest trades, shared by the REST routes and the MCP
// agent tools so both store them the same way.

// "#ICT-SilverBullet" and "ICT-SilverBullet" are the same tag.
// Up to 10 per trade, de-duplicated case-insensitively, first one wins.
function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const tags = [];
  for (const raw of input) {
    const tag = String(raw || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 10) break;
  }
  return tags;
}

// Keep `strategy` (primary) and `tags` consistent: strategy is always tags[0].
function strategyAndTags(strategy, tags) {
  const normalized = normalizeTags(tags);
  const primary = String(strategy || '').trim().slice(0, 80);
  if (!primary) return { strategy: normalized[0] || '', tags: normalized };
  // Strategy names may be longer than ordinary tags (the MCP accepts 60
  // characters). Preserve that canonical name so get_metrics can query it.
  const extras = normalized.filter(tag => tag.toLowerCase() !== primary.toLowerCase());
  return { strategy: primary, tags: [primary, ...extras].slice(0, 10) };
}

module.exports = { normalizeTags, strategyAndTags };
