// Single source of truth for cashflow category slugs and Slovak labels.
// Server uses ALL_CATEGORY_SLUGS for zod validation; the admin frontend
// duplicates this list (admin/pages/cashflow.js) for the dropdown UI —
// keep both in sync when adding/removing categories.

export const INCOME_CATEGORIES = [
  { slug: 'shisha_cash',   label: 'Shisha (hotovosť)' },
  { slug: 'tip',           label: 'Tringelt' },
  { slug: 'deposit',       label: 'Vklad do pokladne' },
  { slug: 'event',         label: 'Akcia / event' },
  { slug: 'sponsorship',   label: 'Sponzorstvo' },
  { slug: 'refund',        label: 'Vrátenie od dodávateľa' },
  { slug: 'other_income',  label: 'Iný príjem' },
];

export const EXPENSE_CATEGORIES = [
  { slug: 'rent',          label: 'Nájom' },
  { slug: 'utilities',     label: 'Energie / voda / internet' },
  { slug: 'salary',        label: 'Mzdy / odmeny' },
  { slug: 'supplier',      label: 'Dodávatelia' },
  { slug: 'maintenance',   label: 'Údržba / opravy' },
  { slug: 'marketing',     label: 'Marketing / reklama' },
  { slug: 'taxes',         label: 'Dane a odvody' },
  { slug: 'fees',          label: 'Bankové poplatky' },
  { slug: 'equipment',     label: 'Vybavenie' },
  { slug: 'cleaning',      label: 'Čistenie / hygiena' },
  { slug: 'other_expense', label: 'Iný výdavok' },
];

export const ALL_CATEGORY_SLUGS = new Set(
  [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES].map((c) => c.slug),
);
