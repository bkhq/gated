import { UAParser } from 'ua-parser-js'

const SAFE_CHARS = /^[\w/-]+$/
const SINGLE_QUOTE = /'/g
const EMPTY_QUOTES = /''/g
const DOUBLE_QUOTE = /"/g

function escapeUnix(arg: string): string {
  if (!SAFE_CHARS.test(arg)) {
    return (`'${arg.replace(SINGLE_QUOTE, '\'"\'"\'')}'`).replace(EMPTY_QUOTES, '')
  }
  return arg
}

function escapeWin(arg: string): string {
  if (!SAFE_CHARS.test(arg)) {
    return `"${arg.replace(DOUBLE_QUOTE, '""')}"`
  }
  return arg
}

const isWin = new UAParser().getOS().name === 'Windows'

export function shellEscape(stringOrArray: string[] | string): string {
  const escapePath = isWin ? escapeWin : escapeUnix

  if (typeof stringOrArray === 'string') {
    return escapePath(stringOrArray)
  }

  return stringOrArray.map(escapePath).join(' ')
}
