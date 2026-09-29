import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HubCategoryTabs } from '../HubCategoryTabs'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('HubCategoryTabs', () => {
  it('shows Chat, Images and Video with the current one selected', () => {
    render(<HubCategoryTabs value="image" onChange={vi.fn()} />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'hub:categoryChat',
      'hub:categoryImages',
      'hub:categoryVideo',
    ])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(screen.getByRole('tablist')).toHaveAccessibleName('hub:categories')
  })

  it('reports the category picked, and nothing for the one already open', async () => {
    const onChange = vi.fn()
    render(<HubCategoryTabs value="chat" onChange={onChange} />)

    await userEvent.click(screen.getByRole('tab', { name: 'hub:categoryChat' }))
    await userEvent.click(
      screen.getByRole('tab', { name: 'hub:categoryVideo' })
    )

    expect(onChange.mock.calls).toEqual([['video']])
  })
})
