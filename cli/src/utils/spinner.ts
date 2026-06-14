import ora, { Ora } from 'ora'

export function createSpinner(text: string): Ora {
  return ora({ text, color: 'blue' })
}
