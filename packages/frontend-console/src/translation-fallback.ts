/** Runtime identifiers need useful copy even when the instance supplies no localization. */
export function humanizeConsoleKey(key: string, defaultValue?: string) {
  if (defaultValue && defaultValue !== key && !(key.startsWith('command_') && defaultValue === key.slice('command_'.length))) return defaultValue
  const name = key.replace(/^(entitySingular|entityObject|entity|listField|field|relation|commandName|command|workflowField|value|role)_/, '')
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_/-]+/g, ' ')
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}
