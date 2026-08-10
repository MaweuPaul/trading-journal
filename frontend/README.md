# TradeJournal Frontend

The frontend is a Next.js 15 application for building versioned visual strategy playbooks and completing trade journals generated from those published rules.

## Rule-driven journal model

The journal form is not hard-coded. A published playbook defines:

- Lifecycle stages: Concept, Context, Setup, Entry, Risk, Execution, Management, Exit, and Review.
- Rule labels, guidance, answer types, choices, units, defaults, and validation.
- Stage-level visual references.
- Rule-level reference, valid, and invalid example images.
- Which answers and instructional images are required.

When a playbook is attached to a trade, the frontend renders its fields in Plan, Manage, and Review tabs. The first save stores the complete published snapshot on that trade. Later playbook versions do not rewrite the journal, and an attached trade cannot switch to another version.

Rule-level instructional images are required by default for newly added rules. In **Field guidance and validation**, turn off **Require instructional image examples** when a rule does not need a chart example.

The Answer type selector contains only the primitive values Yes/No, Number, Text, Single choice, and Multiple choice. Semantic controls are configured separately as formats: Number supports Percentage, Currency, Price, Duration, R:R, and Rating; Text supports Short text, Long explanation, Date, and Time.

## Routes

| Route | Purpose |
|---|---|
| `/rules` | Build and publish immutable visual playbooks |
| `/rules/read` | Read a published playbook as a visual manual |
| `/trades` | Filter trades and complete the rule-generated journal |
| `/coach` | Compare versions, answers, stage compliance, and numeric evidence |
| `/signup` | Create the single owner on an empty installation |

## Local setup

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

Then run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Verification

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js app/rules/page.tsx app/rules/read/page.tsx
npm run build
```

The full credential-backed test procedure is in [`../TESTING.md`](../TESTING.md), and installation instructions are in [`../SETUP.md`](../SETUP.md).
