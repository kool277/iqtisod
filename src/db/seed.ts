import type { SqlDatabase } from './sqlite'
import { permissionsForRole } from '../rbac'

const ROLES = ['Admin', 'Manager', 'Viewer'] as const

type CategorySeed = {
  type: 'INCOME' | 'EXPENSE'
  icon: string
  en: string
  uzLatn: string
  uzCyrl: string
  ru: string
}

const CATEGORIES: CategorySeed[] = [
  { type: 'INCOME', icon: 'banknote', en: 'Salary', uzLatn: 'Maosh', uzCyrl: 'Маош', ru: 'Зарплата' },
  { type: 'INCOME', icon: 'laptop', en: 'Freelance', uzLatn: 'Frilanserlik', uzCyrl: 'Фрилансерлик', ru: 'Фриланс' },
  { type: 'INCOME', icon: 'trending-up', en: 'Investment', uzLatn: 'Investitsiya', uzCyrl: 'Инвестиция', ru: 'Инвестиции' },
  { type: 'INCOME', icon: 'gift', en: 'Gift', uzLatn: 'Sovgʻa', uzCyrl: 'Совға', ru: 'Подарок' },
  { type: 'INCOME', icon: 'circle', en: 'Other income', uzLatn: 'Boshqa daromad', uzCyrl: 'Бошқа даромад', ru: 'Прочий доход' },
  { type: 'EXPENSE', icon: 'utensils', en: 'Food', uzLatn: 'Oziq-ovqat', uzCyrl: 'Озиқ-овқат', ru: 'Еда' },
  { type: 'EXPENSE', icon: 'bus', en: 'Transport', uzLatn: 'Transport', uzCyrl: 'Транспорт', ru: 'Транспорт' },
  { type: 'EXPENSE', icon: 'home', en: 'Housing', uzLatn: 'Uy-joy', uzCyrl: 'Уй-жой', ru: 'Жильё' },
  { type: 'EXPENSE', icon: 'zap', en: 'Utilities', uzLatn: 'Kommunal', uzCyrl: 'Коммунал', ru: 'Коммунальные' },
  { type: 'EXPENSE', icon: 'heart', en: 'Health', uzLatn: 'Sogʻliq', uzCyrl: 'Соғлиқ', ru: 'Здоровье' },
  { type: 'EXPENSE', icon: 'graduation-cap', en: 'Education', uzLatn: 'Taʼlim', uzCyrl: 'Таълим', ru: 'Образование' },
  { type: 'EXPENSE', icon: 'clapperboard', en: 'Entertainment', uzLatn: 'Koʻngilochar', uzCyrl: 'Кўнгилочар', ru: 'Развлечения' },
  { type: 'EXPENSE', icon: 'shopping-bag', en: 'Shopping', uzLatn: 'Xaridlar', uzCyrl: 'Харидлар', ru: 'Покупки' },
  { type: 'EXPENSE', icon: 'circle', en: 'Other expense', uzLatn: 'Boshqa xarajat', uzCyrl: 'Бошқа харажат', ru: 'Прочий расход' },
]

export function seedRoles(db: SqlDatabase): void {
  for (const role of ROLES) {
    db.exec('INSERT INTO roles (name, permissions) VALUES (?, ?)', [
      role,
      JSON.stringify(permissionsForRole(role)),
    ])
  }
}

export function seedCategories(db: SqlDatabase): void {
  for (const category of CATEGORIES) {
    db.exec(
      `INSERT INTO categories (name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [category.en, category.uzLatn, category.uzCyrl, category.ru, category.type, category.icon],
    )
  }
}
