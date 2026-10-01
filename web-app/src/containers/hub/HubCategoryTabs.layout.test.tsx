import { render, screen } from '@testing-library/react'
import { describe, it } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameWidth,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { HubCategoryTabs } from './HubCategoryTabs'

for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
  describe(`${font} Hub category switch`, () => {
    it('fits three equal one-line tabs in the narrowest Hub list column', async () => {
      setFontSize(font)
      // The list column's minimum, less the filter block's padding.
      render(
        withTranslations(
          <div data-testid="column" className="p-3" style={{ width: 320 }}>
            <HubCategoryTabs value="image" onChange={() => {}} />
          </div>
        )
      )
      await settle()

      expectNoHorizontalOverflow(screen.getByTestId('column'))
      const tabs = screen.getAllByRole('tab')
      expectSameWidth(tabs)
      for (const tab of tabs) expectOneLine(tab.querySelector('span')!)
    })
  })
}
