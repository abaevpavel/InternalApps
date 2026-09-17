/**
 * «My Links» — внешние инструменты, которые не являются приложениями портала,
 * но нужны команде под рукой (BAS-1529: не держать их в личных закладках).
 * Открываются в новой вкладке БЕЗ SSO-хэндоффа: это чужие домены со своим входом,
 * токены портала им передавать нельзя (см. lib/sso.ts).
 */
export interface PortalLink {
  id: string
  name: string
  /** Подпись под названием — что это за среда/экран. */
  detail?: string
  url: string
}

export const PORTAL_LINKS: PortalLink[] = [
  {
    id: 'pdf-builder-prod',
    name: 'PDF Builder — Prod',
    detail: 'Document Builder → Template Builder',
    url: 'https://pdfbuilder.basementremodeling.com/document-builder/template-builder',
  },
  {
    id: 'pdf-builder-stage',
    name: 'PDF Builder — Stage',
    detail: 'Staging environment — sign-in screen',
    url: 'https://basementremodeling.dev-stage.online/login',
  },
]
