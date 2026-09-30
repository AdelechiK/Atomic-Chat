import { memo, type ReactNode } from 'react'

type MediaPageHeadingProps = {
  title: string
  subtitle: string
  /** Sits at the heading's right edge, e.g. the form's Reset button. */
  action?: ReactNode
  /** `image` or `video`: prefixes the test ids. */
  testIdPrefix: string
}

/**
 * The top of the Images and Video form columns: the page's name and what it
 * does. The mode picker sits under it as a control of its own, so the
 * heading reads the same whichever mode is active.
 */
export const MediaPageHeading = memo(function MediaPageHeading({
  title,
  subtitle,
  action,
  testIdPrefix,
}: MediaPageHeadingProps) {
  return (
    <div
      className="flex items-start justify-between gap-3"
      data-testid={`${testIdPrefix}-page-heading`}
    >
      <div className="min-w-0 space-y-1">
        <h1
          className="font-studio text-xl font-medium leading-tight"
          data-testid={`${testIdPrefix}-page-title`}
        >
          {title}
        </h1>
        <p
          className="text-xs leading-snug text-muted-foreground"
          data-testid={`${testIdPrefix}-page-subtitle`}
        >
          {subtitle}
        </p>
      </div>
      {action}
    </div>
  )
})
