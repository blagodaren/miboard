// Use the same category controls as the user at desktop and mobile widths.
export async function chooseSettingsCategory(page, category) {
  const select = page.getByTestId('settings-category-select')
  const link = page.getByTestId(`settings-category-${category}`)
  await select.or(link).filter({ visible: true }).first().waitFor()
  if (await select.isVisible()) await select.selectOption(category)
  else await link.click()
  await page.waitForURL(url => (new URLSearchParams(url.hash.split('?')[1]).get('category') ?? 'appearance') === category)
  await page.getByTestId(`settings-category-panel-${category}`).waitFor()
}
