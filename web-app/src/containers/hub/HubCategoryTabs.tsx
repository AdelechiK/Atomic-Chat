import { useTranslation } from '@/i18n/react-i18next-compat'
import { HUB_CATEGORIES, type HubCategory } from '@/lib/hub-media'
import { cn } from '@/lib/utils'

const LABEL_KEYS: Record<HubCategory, string> = {
  chat: 'hub:categoryChat',
  image: 'hub:categoryImages',
  video: 'hub:categoryVideo',
}

export type HubCategoryTabsProps = {
  value: HubCategory
  onChange: (next: HubCategory) => void
  className?: string
}

/**
 * Chat / Images / Video switch above the Hub filters. A segmented control
 * rather than another dropdown: the category decides which list the column
 * shows at all, so every choice stays in sight.
 */
export function HubCategoryTabs({
  value,
  onChange,
  className,
}: HubCategoryTabsProps) {
  const { t } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={t('hub:categories')}
      className={cn(
        'grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5',
        className
      )}
    >
      {HUB_CATEGORIES.map((category) => {
        const selected = category === value
        return (
          <button
            key={category}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              if (!selected) onChange(category)
            }}
            className={cn(
              'flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected && 'bg-background text-foreground shadow-sm'
            )}
          >
            <span className="truncate">{t(LABEL_KEYS[category])}</span>
          </button>
        )
      })}
    </div>
  )
}
