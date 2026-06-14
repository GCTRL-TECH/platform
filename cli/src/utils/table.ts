import Table from 'cli-table3'

export function makeTable(head: string[], rows: string[][]): string {
  const t = new Table({ head, style: { head: ['cyan'] } })
  rows.forEach(r => t.push(r))
  return t.toString()
}
