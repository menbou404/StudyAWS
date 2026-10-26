import { isIPv4 } from 'node:net';

export function parseAllowedCidrs(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== 'string') {
    throw new Error('allowedCidrs はカンマ区切りの IPv4 CIDR 文字列で指定してください');
  }

  const cidrs = value.replace(/\s/g, '').split(',').filter(Boolean);
  for (const cidr of cidrs) {
    const match = /^([^/]+)\/(\d|[12]\d|3[0-2])$/.exec(cidr);
    if (!match || !isIPv4(match[1])) {
      throw new Error('allowedCidrs に不正な IPv4 CIDR が含まれています');
    }
    // Phase 4 手順2：マイ IP の制限を保ち、別表記の /0 でも全世界公開させない。
    if (Number(match[2]) === 0) {
      throw new Error('allowedCidrs に /0 は指定できません');
    }
  }
  return [...new Set(cidrs)];
}
