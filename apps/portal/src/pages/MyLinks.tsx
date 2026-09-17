import { ExternalLink } from 'lucide-react'
import { Card } from '../components/ui'
import { HomeTabs } from '../components/HomeTabs'
import { PORTAL_LINKS } from '../app/externalLinks'

/**
 * «My Links» — быстрые ссылки на внешние инструменты (BAS-1529). Открываются в новой
 * вкладке обычным `<a>`: свой вход, без SSO-хэндоффа портала.
 */
export function MyLinksPage() {
  return (
    <>
      <HomeTabs />
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
        {PORTAL_LINKS.length === 0 ? (
          <div className="py-16 text-center text-gray-400">No links yet.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
            {PORTAL_LINKS.map((link) => (
              <Card key={link.id} className="flex flex-col justify-between gap-3 p-4 sm:p-5">
                <div>
                  <div className="text-sm font-semibold leading-snug text-gray-900 sm:text-base">{link.name}</div>
                  {link.detail && <div className="mt-1 text-xs text-gray-500">{link.detail}</div>}
                </div>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 sm:text-sm"
                >
                  Open
                  <ExternalLink size={14} />
                </a>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
