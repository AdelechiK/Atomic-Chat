import { memo, useState, type ComponentType } from 'react'
import { IconCheck, IconChevronDown, type IconProps } from '@tabler/icons-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type MediaMode<Id extends string> = {
  id: Id
  icon: ComponentType<IconProps>
  title: string
  hint: string
  /** Listed but not selectable yet; `badge` says why. */
  disabled?: boolean
  badge?: string
}

type MediaModeSelectProps<Id extends string> = {
  modes: readonly MediaMode<Id>[]
  value: Id
  onChange: (id: Id) => void
  /** Read before the title by screen readers, e.g. "Mode". */
  label: string
  /** `image` or `video`: prefixes the test ids. */
  testIdPrefix: string
}

/**
 * The heading of the Images and Video form columns: the active mode's icon,
 * title and hint, and the title opens the list of the page's modes. Both
 * pages use it, so a mode is always picked in the same place — the sidebar
 * only names the section.
 */
function MediaModeSelectInner<Id extends string>({
  modes,
  value,
  onChange,
  label,
  testIdPrefix,
}: MediaModeSelectProps<Id>) {
  const [open, setOpen] = useState(false)
  const active = modes.find((mode) => mode.id === value) ?? modes[0]
  const ActiveIcon = active.icon

  return (
    <div className="min-w-0 space-y-1">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <h2 className="flex min-w-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="-mx-1.5 -my-1 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left font-studio text-xl font-medium leading-none transition-colors duration-150 ease-out hover:bg-secondary/60 data-[state=open]:bg-secondary/60"
              data-mode={active.id}
              data-testid={`${testIdPrefix}-workflow-select`}
            >
              <ActiveIcon size={18} className="shrink-0" />
              <span className="sr-only">{label}: </span>
              {/* `truncate` clips at the box: a taller line keeps the
                  descenders, the negative margin keeps the heading's height. */}
              <span
                className="-my-[0.125em] truncate leading-tight"
                data-testid={`${testIdPrefix}-workflow-title`}
              >
                {active.title}
              </span>
              <IconChevronDown
                size={16}
                className={cn(
                  'shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                  open && 'rotate-180'
                )}
              />
            </button>
          </DropdownMenuTrigger>
        </h2>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-[300px] max-w-[calc(100vw-2rem)] rounded-xl bg-background/95 p-1.5 shadow-xl backdrop-blur-2xl"
          data-testid={`${testIdPrefix}-workflow-menu`}
        >
          {modes.map((mode) => {
            const Icon = mode.icon
            const selected = mode.id === active.id
            return (
              <DropdownMenuItem
                key={mode.id}
                disabled={mode.disabled}
                onSelect={() => {
                  if (!selected) onChange(mode.id)
                }}
                className="items-start gap-2.5 rounded-lg px-2 py-2"
                data-selected={selected}
                data-testid={`${testIdPrefix}-workflow-option-${mode.id}`}
              >
                <Icon size={16} className="mt-px shrink-0 text-foreground/70" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium leading-tight">
                    <span className="truncate">{mode.title}</span>
                    {mode.badge && (
                      <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {mode.badge}
                      </span>
                    )}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {mode.hint}
                  </span>
                </span>
                <IconCheck
                  size={16}
                  className={cn(
                    'mt-px shrink-0 text-foreground',
                    !selected && 'invisible'
                  )}
                />
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="text-xs leading-snug text-muted-foreground">
        {active.hint}
      </p>
    </div>
  )
}

export const MediaModeSelect = memo(
  MediaModeSelectInner
) as typeof MediaModeSelectInner
