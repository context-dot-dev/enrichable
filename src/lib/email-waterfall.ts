import { DEFAULT_EMAIL_PROVIDERS, type Column, type ColumnOp, type EmailProvider } from './types';
import { roleColumn, type ColumnRole } from './column-roles';
export const EMAIL_PROVIDER_INFO: Record<EmailProvider, { name: string; baseUsd: number; logo: string }> = {
 quickenrich: { name: 'QuickEnrich', baseUsd: 0.0072, logo: '/providers/quickenrich.png' },
 hunter: { name: 'Hunter', baseUsd: 0.0245, logo: '/providers/hunter.png' },
 apollo: { name: 'Apollo', baseUsd: 0.026, logo: '/providers/apollo.svg' },
 prospeo: { name: 'Prospeo', baseUsd: 0.066, logo: '/providers/prospeo.png' },
 contactout: { name: 'ContactOut', baseUsd: 0.02, logo: '/providers/contactout.png' },
 // Own key only: no included credit, so no included price.
 leadmagic: { name: 'LeadMagic', baseUsd: 0, logo: '/providers/leadmagic.svg' },
};
export function defaultEmailWaterfall(columns: Column[]): Extract<ColumnOp, { kind: 'email-enrichment' }> {
 const ref = (role: ColumnRole) => { const column = roleColumn(columns, role); return column ? `{{${column.name}}}` : ''; };
 return { kind: 'email-enrichment', name: ref('person') || [ref('first-name'), ref('last-name')].filter(Boolean).join(' '), company: ref('company'), domain: ref('website'), profileUrl: ref('profile'), providers: [...DEFAULT_EMAIL_PROVIDERS] };
}
