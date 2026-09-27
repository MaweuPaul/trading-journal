'use client';

import { FormEvent, KeyboardEvent, MouseEvent, useEffect, useRef, useState } from 'react';
import { Icon } from '../backtest/BacktestShell';

interface DrawingTextEditorProps {
  drawingName: string;
  initialValue: string;
  isNew?: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}

export default function DrawingTextEditor({
  drawingName,
  initialValue,
  isNew = false,
  onSave,
  onCancel,
}: DrawingTextEditorProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(value.trim().slice(0, 160));
  };

  const stopChartInteraction = (event: MouseEvent) => {
    event.stopPropagation();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave(value.trim().slice(0, 160));
    }
  };

  return (
    <div className="tw:absolute tw:inset-0 tw:z-50 tw:flex tw:items-start tw:justify-center tw:px-3 tw:pt-3">
      <button
        type="button"
        aria-label="Close text editor"
        onMouseDown={event => {
          event.preventDefault();
          onCancel();
        }}
        className="tw:absolute tw:inset-0 tw:cursor-default"
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawing-text-title"
        onSubmit={submit}
        onMouseDown={stopChartInteraction}
        onClick={stopChartInteraction}
        className="tw:relative tw:w-full tw:max-w-md tw:rounded-xl tw:border tw:border-outline-variant tw:bg-surface-container/95 tw:p-3 tw:shadow-xl tw:backdrop-blur-md"
      >
        <div className="tw:mb-2 tw:flex tw:items-start tw:justify-between tw:gap-3">
          <div>
            <h3 id="drawing-text-title" className="tw:font-label-action tw:text-label-action tw:font-semibold tw:text-on-surface">
              {isNew ? 'Add text' : 'Edit text'}
            </h3>
            <p className="tw:mt-0.5 tw:text-xs tw:text-on-surface-variant">
              {drawingName} - Ctrl/Cmd + Enter to save
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close text editor"
            className="tw:flex tw:h-7 tw:w-7 tw:items-center tw:justify-center tw:rounded-md tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface"
          >
            <Icon name="close" className="tw:text-[18px]" />
          </button>
        </div>
        <textarea
          ref={inputRef}
          value={value}
          maxLength={160}
          rows={3}
          aria-label={'Text for ' + drawingName}
          placeholder="Add a setup note, level, or reminder..."
          onChange={event => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          className="tw:w-full tw:resize-none tw:rounded-lg tw:border tw:border-outline-variant tw:bg-surface-container-lowest tw:px-3 tw:py-2 tw:text-sm tw:text-on-surface tw:caret-primary tw:outline-none tw:transition tw:placeholder:text-on-surface-variant/70 focus:tw:border-primary focus:tw:ring-2 focus:tw:ring-primary/20"
        />
        <div className="tw:mt-2 tw:flex tw:items-center tw:justify-between tw:gap-3">
          <span className="tw:text-xs tw:text-on-surface-variant">{value.length}/160</span>
          <div className="tw:flex tw:items-center tw:gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="tw:rounded-lg tw:px-3 tw:py-1.5 tw:text-sm tw:font-medium tw:text-on-surface-variant tw:hover:bg-surface-container-high tw:hover:text-on-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="tw:rounded-lg tw:bg-primary tw:px-3 tw:py-1.5 tw:text-sm tw:font-semibold tw:text-on-primary tw:shadow-sm tw:hover:brightness-105"
            >
              {value.trim() ? 'Save text' : isNew ? 'Discard' : 'Remove text'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}