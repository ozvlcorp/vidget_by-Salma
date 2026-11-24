import { todayStr } from '../components/grid'

/** Первый день текущего месяца в формате YYYY-MM-DD. */
export function monthStart(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** Дата n дней назад в формате YYYY-MM-DD. */
export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Быстрые периоды — общие для «Моих продаж» и списка заявок. */
export const PERIODS = [
  { id: 'today', label: 'Сегодня', from: () => todayStr() },
  { id: 'week', label: '7 дней', from: () => daysAgo(6) },
  { id: 'month', label: 'Этот месяц', from: () => monthStart() },
] as const
