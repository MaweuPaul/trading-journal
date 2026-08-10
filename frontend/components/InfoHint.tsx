'use client';

import { CircleHelp } from 'lucide-react';

export default function InfoHint({ text, label = 'More information' }: { text: string; label?: string }) {
  return (
    <span className="info-hint">
      <span className="info-hint-trigger" aria-label={label} tabIndex={0}>
        <CircleHelp size={14} aria-hidden="true" />
      </span>
      <span className="info-hint-tooltip" role="tooltip">{text}</span>
    </span>
  );
}
