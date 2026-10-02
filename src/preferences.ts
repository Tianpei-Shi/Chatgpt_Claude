/** 模型族由桌面当前可用选项解析成具体版本，不把过时版本写成永久默认。 */
export const defaultModel = 'Sonnet';
export const defaultEffort = 'medium';
export const modelPattern = /^(Opus|Sonnet|Haiku)(?: \d+(?:\.\d+)?)?$/;
export function modelMatches(requested: string, actual: unknown) {
  return typeof actual === 'string' && /^(Opus|Sonnet|Haiku) \d+(?:\.\d+)?$/.test(actual) &&
    (actual === requested || (!requested.includes(' ') && actual.startsWith(requested + ' ')));
}
