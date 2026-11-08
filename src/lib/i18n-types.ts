export type Message = string | (Partial<Record<Intl.LDMLPluralRule, string>> & { other: string })
export type TranslationParams = Record<string, string | number>
