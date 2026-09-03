export interface PlaybookRule {
  ruleId: string;
  label: string;
  inputType: 'boolean' | 'single_choice' | 'multi_choice' | 'number' | 'percentage' | 'currency' | 'price' | 'duration' | 'risk_reward' | 'rating' | 'text' | 'long_text' | 'date' | 'time';
  options: string[];
  required: boolean;
  order?: number;
  helpText?: string;
  placeholder?: string;
  unit?: string;
  defaultValue?: string | number | boolean | null;
  validation?: { min?: number | null; max?: number | null; minLength?: number | null; maxLength?: number | null };
  examples?: Array<{ evidenceId: string; url: string; caption: string; kind: 'reference' | 'valid' | 'invalid' }>;
  exampleRequirement?: { required: boolean; minimumImages: number; maximumImages: number };
  toolRole?: 'observation' | 'confirmation' | 'trigger' | 'decision_gate' | 'invalidation' | 'risk_limit' | 'management_action' | 'exit_signal' | 'review_prompt';
  timeframes?: string[];
  failureAction?: 'none' | 'warn' | 'skip_trade' | 'stop_session';
  failureMessage?: string;
}

export interface PlaybookBlock {
  blockId: string;
  name: string;
  category: string;
  order?: number;
  rules: PlaybookRule[];
  evidence?: Array<{ evidenceId: string; url: string; caption: string; kind: 'reference' | 'valid' | 'invalid'; linkedRuleId?: string }>;
}

export interface PlaybookSnapshot {
  playbookId: string;
  name: string;
  description?: string;
  versionId: string;
  versionNumber: number;
  schemaVersion?: number;
  publishedAt: string;
  blocks: PlaybookBlock[];
}

export interface Playbook {
  playbookId: string;
  name: string;
  description: string;
  archived: boolean;
  versions: Array<{ versionId: string; versionNumber: number; schemaVersion?: number; publishedAt: string; blocks: PlaybookBlock[] }>;
}

export const PLAN_PHASE_CATEGORIES = ['concept', 'context', 'setup', 'entry', 'risk', 'pre_trade'];
